#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createBundleManifest, readJson, signManifest, writeManifest } from "../lib/release-integrity.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`알 수 없는 인자입니다: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} 값이 필요합니다.`);
    options[name] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const name of ["bundle", "bundle-id", "version", "source-commit", "signer-key-id", "private-key", "components"]) {
    if (!options[name]) throw new Error(`--${name} 값이 필요합니다.`);
  }
  const bundleDir = resolve(options.bundle);
  const privateKeyPath = resolve(options["private-key"]);
  if (basename(privateKeyPath).includes("example")) throw new Error("예시 개인키는 서명에 사용할 수 없습니다.");
  const components = await readJson(resolve(options.components));
  const revokedBundleIds = options.revocations ? await readJson(resolve(options.revocations)) : [];
  if (!Array.isArray(revokedBundleIds)) throw new Error("폐기 목록은 JSON 배열이어야 합니다.");
  const manifest = await createBundleManifest({
    bundleDir,
    bundleId: options["bundle-id"],
    version: options.version,
    sourceCommit: options["source-commit"],
    minimumAllowedVersion: options.minimum || options.version,
    revokedBundleIds,
    components,
    signerKeyId: options["signer-key-id"]
  });
  const signed = signManifest(manifest, await readFile(privateKeyPath, "utf8"));
  const output = join(bundleDir, "bundle.manifest.json");
  await writeManifest(output, signed);
  process.stdout.write(`${JSON.stringify({ status: "signed", manifest: output, bundle_id: signed.bundle_id, version: signed.version }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`sign-release-bundle: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 64;
});
