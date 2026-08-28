#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { sha256File, verifyBundle } from "../lib/release-integrity.mjs";

const root = resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    options[name] = value;
    index += 1;
  }
  return options;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function fail(message) {
  process.stderr.write(`release-preflight: ${message}\n`);
  process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const installerSpec = await readFile(join(root, "installer", "vibecode-harness.iss"), "utf8");
  const releaseIndex = JSON.parse(await readFile(join(root, "public", "releases", "release-index.json"), "utf8"));
  const version = packageInfo.version;
  const expectedTag = `v${version}`;
  const channel = options.channel || "production";
  const errors = [];

  if (!/^\d+\.\d+\.\d+$/.test(version)) errors.push("package.json version must use x.y.z.");
  if (!installerSpec.includes(`#define AppVersion "${version}"`)) errors.push("Inno Setup AppVersion must match package.json version.");
  if (!(await exists(join(root, "gg.cmd")))) errors.push("gg.cmd is required for the signed Windows bundle.");
  if (!(await exists(join(root, "manager.ps1")))) errors.push("manager.ps1 is required for the signed Windows bundle.");
  if (!(await exists(join(root, "adapters", "antigravity", "plugin.json")))) errors.push("Google Antigravity adapter is missing.");
  const supported = releaseIndex.capabilities?.supported_tools || [];
  for (const tool of ["codex", "claude-code", "google-antigravity", "claude-desktop", "chatgpt-codex-desktop", "lovable-github"]) {
    if (!supported.includes(tool)) errors.push(`portal capabilities is missing ${tool}.`);
  }
  if (!new Set(["production", "demonstration"]).has(channel)) errors.push(`unsupported release channel: ${channel}.`);
  if (options.tag && channel === "production" && options.tag !== expectedTag) errors.push(`tag ${options.tag} does not match ${expectedTag}.`);
  if (options.tag && channel === "demonstration" && !new RegExp(`^v${version.replaceAll(".", "\\.")}-demo\\.\\d+$`).test(options.tag)) {
    errors.push(`demonstration tag ${options.tag} must use v${version}-demo.N.`);
  }

  const result = {
    status: channel === "production" ? "source_preflight_passed" : "demonstration_source_preflight_passed",
    version,
    expected_tag: expectedTag,
    channel,
    portal_status: releaseIndex.status,
    required_manual_gates: channel === "production"
      ? [
        "approved embedded Node runtime (no local checker or Python)",
        "signed bundle manifest verified with the institutional trust list",
        "Authenticode-signed installer verified",
        "fresh Windows installation test",
        "release approval record completed"
      ]
      : [
        "PEM-signed bundle verified with the demonstration trust list",
        "unsigned demonstration EXE labelled separately from production",
        "fresh Windows installation test",
        "demonstration validation record completed"
      ]
  };

  if (options.bundle) {
    const bundle = resolve(options.bundle);
    const trust = resolve(options.trust || join(root, "shared", "trust", "approved-signers.json"));
    const verified = await verifyBundle({ bundleDir: bundle, trustPath: trust });
    if (verified.status !== "verified") errors.push(`bundle verification failed: ${verified.reason || verified.status}.`);
    else {
      if (verified.manifest.version !== version) errors.push(`bundle version ${verified.manifest.version} does not match ${version}.`);
      if (!verified.manifest.files.some((file) => file.path === "gg.cmd")) errors.push("signed bundle manifest is missing gg.cmd.");
      result.bundle = { status: verified.status, bundle_id: verified.manifest.bundle_id, version: verified.manifest.version, signer_key_id: verified.signer_key_id };
    }
  }

  if (options.installer) {
    const installer = resolve(options.installer);
    if (!(await exists(installer))) errors.push(`installer does not exist: ${installer}.`);
    else {
      result.installer = { path: installer, sha256: await sha256File(installer) };
    }
  }

  if (errors.length) throw new Error(errors.join(" "));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
