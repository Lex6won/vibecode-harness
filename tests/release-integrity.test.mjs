import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  createBundleManifest,
  installationState,
  signManifest,
  verifyBundle,
  writeManifest
} from "../lib/release-integrity.mjs";

const harnessRoot = join(import.meta.dirname, "..");
const ggPath = join(harnessRoot, "bin", "gg.mjs");

function runGg(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [ggPath, ...args], { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function makeBundle({ version = "1.0.0", minimum = version, expiresAt = null, revokedBundleIds = [], keyPair = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vibecode-release-bundle-"));
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "runtime"), { recursive: true });
  await mkdir(join(root, "checker"), { recursive: true });
  await writeFile(join(root, "bin", "gg.mjs"), "export {};\n");
  await writeFile(join(root, "runtime", "node.exe"), "approved-node-runtime\n");
  await writeFile(join(root, "runtime", "python.exe"), "approved-python-runtime\n");
  await writeFile(join(root, "checker", "gvskb.exe"), "approved-checker-runtime\n");

  const keys = keyPair || generateKeyPairSync("ed25519");
  const trustPath = `${root}-approved-signers.json`;
  await writeFile(trustPath, `${JSON.stringify({
    schema_version: 1,
    signers: [{
      key_id: "gg-release-1",
      status: "active",
      public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" })
    }]
  }, null, 2)}\n`);
  const manifest = await createBundleManifest({
    bundleDir: root,
    bundleId: `bundle-${version.replaceAll(".", "-")}`,
    version,
    minimumAllowedVersion: minimum,
    sourceCommit: "0123456789abcdef",
    revokedBundleIds,
    signerKeyId: "gg-release-1",
    components: {
      harness: { path: "bin/gg.mjs", version },
      node_runtime: { path: "runtime/node.exe", version: "22.0.0" },
      python_runtime: { path: "runtime/python.exe", version: "3.13.0" },
      checker: { path: "checker/gvskb.exe", version: "1.0.0" }
    }
  });
  if (expiresAt) manifest.expires_at = expiresAt;
  await writeManifest(join(root, "bundle.manifest.json"), signManifest(manifest, keys.privateKey.export({ type: "pkcs8", format: "pem" })));
  return { root, trustPath };
}

test("approved signed bundle verifies before installation", async () => {
  const fixture = await makeBundle();
  try {
    const result = await verifyBundle({ bundleDir: fixture.root, trustPath: fixture.trustPath });
    assert.equal(result.status, "verified");
    assert.equal(result.manifest.version, "1.0.0");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.trustPath, { force: true });
  }
});

test("gg bundle verify exposes only the verified result to callers", async () => {
  const fixture = await makeBundle();
  try {
    const result = await runGg(["bundle", "verify", "--bundle", fixture.root, "--trust", fixture.trustPath]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "verified");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.trustPath, { force: true });
  }
});

test("a changed bundle file requires repair instead of passing", async () => {
  const fixture = await makeBundle();
  try {
    await writeFile(join(fixture.root, "checker", "gvskb.exe"), "tampered\n");
    const result = await verifyBundle({ bundleDir: fixture.root, trustPath: fixture.trustPath });
    assert.equal(result.status, "repair_required");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.trustPath, { force: true });
  }
});

test("bundle creation refuses to include a private key", async () => {
  const fixture = await makeBundle();
  try {
    await writeFile(join(fixture.root, "release-private.pem"), "not-a-real-key\n");
    await assert.rejects(
      createBundleManifest({
        bundleDir: fixture.root,
        bundleId: "bundle-private-key",
        version: "1.0.0",
        sourceCommit: "0123456789abcdef",
        signerKeyId: "gg-release-1",
        components: {
          harness: { path: "bin/gg.mjs", version: "1.0.0" },
          node_runtime: { path: "runtime/node.exe", version: "22.0.0" },
          python_runtime: { path: "runtime/python.exe", version: "3.13.0" },
          checker: { path: "checker/gvskb.exe", version: "1.0.0" }
        }
      }),
      /개인키 또는 비밀 파일/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.trustPath, { force: true });
  }
});

test("expired or unknown signer bundles are never treated as current", async () => {
  const fixture = await makeBundle({ expiresAt: "2000-01-01T00:00:00.000Z" });
  try {
    const result = await verifyBundle({ bundleDir: fixture.root, trustPath: fixture.trustPath });
    assert.equal(result.status, "unknown");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.trustPath, { force: true });
  }
});

test("a bundle signed by an untrusted key is not accepted", async () => {
  const fixture = await makeBundle();
  try {
    await writeFile(fixture.trustPath, `${JSON.stringify({ schema_version: 1, signers: [] }, null, 2)}\n`);
    const result = await verifyBundle({ bundleDir: fixture.root, trustPath: fixture.trustPath });
    assert.equal(result.status, "unknown");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.trustPath, { force: true });
  }
});

test("new approved bundle requests update and honours minimum version", async () => {
  const keys = generateKeyPairSync("ed25519");
  const installed = await makeBundle({ version: "1.0.0", keyPair: keys });
  const candidate = await makeBundle({ version: "1.1.0", minimum: "1.1.0", keyPair: keys });
  try {
    const state = await installationState({
      installedDir: installed.root,
      candidateDir: candidate.root,
      trustPath: installed.trustPath
    });
    assert.equal(state.state, "update_available");
    assert.equal(state.forced, true);
  } finally {
    await rm(installed.root, { recursive: true, force: true });
    await rm(candidate.root, { recursive: true, force: true });
    await rm(installed.trustPath, { force: true });
    await rm(candidate.trustPath, { force: true });
  }
});
