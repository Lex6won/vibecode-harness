import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const MANIFEST_NAME = "bundle.manifest.json";
// The checker is executed by the Portal server; a user-facing Harness bundle
// contains only the Harness and its embedded Node runtime.
const REQUIRED_COMPONENTS = ["harness", "node_runtime"];

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function manifestPayload(manifest) {
  const { signature, ...payload } = manifest;
  return Buffer.from(canonicalJson(payload), "utf8");
}

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function normalizedRelative(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value.includes("/../") || value.startsWith("/")) throw new Error("번들 경로가 루트를 벗어났습니다.");
  return value;
}

function isSensitiveBundlePath(path) {
  const normalized = String(path).replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(?:private|secrets?)(?:\/|$)/.test(normalized)
    || /(?:^|\/)[^/]*(?:private|secret)[^/]*\.(?:pem|key|pfx|p12)$/i.test(normalized)
    || /\.(?:pem|key|pfx|p12)$/i.test(normalized);
}

// Inno Setup adds its uninstaller only after the signed bundle has been
// extracted. These files are not Harness payload and must not make a clean
// first installation appear tampered. Keep this allow-list deliberately
// narrow: every other extra file remains an integrity failure.
function isInstallerGeneratedPath(path) {
  return /^unins\d{3}\.(?:exe|dat|msg)$/i.test(String(path).replace(/\\/g, "/"));
}

async function collectFiles(root, current = root, files = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) await collectFiles(root, path, files);
    else if (entry.isFile()) {
      const relativePath = normalizedRelative(root, path);
      if (relativePath !== MANIFEST_NAME && !isInstallerGeneratedPath(relativePath)) files.push(path);
    }
  }
  return files;
}

function assertVersion(value, name) {
  if (!/^\d+\.\d+\.\d+$/.test(String(value || ""))) throw new Error(`${name}은 승인 배포용 안정 버전 x.y.z 형식이어야 합니다.`);
}

function versionParts(value) {
  return String(value).split(".").map(Number);
}

export function compareVersion(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function createBundleManifest({ bundleDir, bundleId, version, sourceCommit, minimumAllowedVersion, revokedBundleIds = [], components, signerKeyId }) {
  const root = resolve(bundleDir);
  assertVersion(version, "version");
  assertVersion(minimumAllowedVersion || version, "minimum_allowed_bundle_version");
  if (!/^[A-Za-z0-9._-]{3,120}$/.test(bundleId || "")) throw new Error("bundle_id 형식이 올바르지 않습니다.");
  if (!/^[0-9a-f]{7,64}$/i.test(sourceCommit || "")) throw new Error("source_commit은 Git commit 해시여야 합니다.");
  if (!/^[A-Za-z0-9._-]{3,120}$/.test(signerKeyId || "")) throw new Error("signer_key_id 형식이 올바르지 않습니다.");
  for (const required of REQUIRED_COMPONENTS) {
    if (!components?.[required]?.path || !components?.[required]?.version) throw new Error(`필수 구성요소 정보가 없습니다: ${required}`);
  }
  const files = [];
  for (const path of await collectFiles(root)) {
    const relativePath = normalizedRelative(root, path);
    if (isSensitiveBundlePath(relativePath)) throw new Error(`개인키 또는 비밀 파일은 승인 번들에 포함할 수 없습니다: ${relativePath}`);
    const size = (await stat(path)).size;
    files.push({ path: relativePath, sha256: await sha256File(path), size });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  for (const component of Object.values(components)) {
    const componentPath = String(component.path).replace(/\\/g, "/");
    if (!files.some((file) => file.path === componentPath)) throw new Error(`구성요소 파일이 번들에 없습니다: ${componentPath}`);
  }
  return {
    schema_version: 1,
    bundle_id: bundleId,
    version,
    source_commit: sourceCommit,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 90).toISOString(),
    minimum_allowed_bundle_version: minimumAllowedVersion || version,
    revoked_bundle_ids: [...new Set(revokedBundleIds)].sort(),
    components,
    files,
    artifact_sha256: createHash("sha256").update(canonicalJson(files)).digest("hex"),
    signer_key_id: signerKeyId,
    signature_algorithm: "ed25519",
    signature: null
  };
}

export function signManifest(manifest, privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  return { ...manifest, signature: sign(null, manifestPayload(manifest), privateKey).toString("base64") };
}

function validateManifestShape(manifest) {
  if (manifest?.schema_version !== 1) throw new Error("지원하지 않는 승인 번들 manifest 버전입니다.");
  assertVersion(manifest.version, "version");
  assertVersion(manifest.minimum_allowed_bundle_version, "minimum_allowed_bundle_version");
  if (!/^[A-Za-z0-9._-]{3,120}$/.test(manifest.bundle_id || "")) throw new Error("manifest bundle_id 형식이 올바르지 않습니다.");
  if (!/^[0-9a-f]{7,64}$/i.test(manifest.source_commit || "")) throw new Error("manifest source_commit 형식이 올바르지 않습니다.");
  if (!Number.isFinite(new Date(manifest.issued_at).getTime()) || !Number.isFinite(new Date(manifest.expires_at).getTime())) throw new Error("manifest 발급 또는 만료 시각 형식이 올바르지 않습니다.");
  if (!/^[a-f0-9]{64}$/i.test(manifest.artifact_sha256 || "")) throw new Error("manifest artifact 해시 형식이 올바르지 않습니다.");
  if (manifest.signature_algorithm !== "ed25519" || typeof manifest.signature !== "string") throw new Error("지원하지 않거나 누락된 manifest 서명입니다.");
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.revoked_bundle_ids)) throw new Error("manifest 파일 또는 폐기 목록 형식이 올바르지 않습니다.");
  const declaredPaths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !file.path || file.path.includes("\\") || file.path.startsWith("/") || file.path.includes("..") || file.path === MANIFEST_NAME) throw new Error("manifest 파일 경로가 안전하지 않습니다.");
    if (isSensitiveBundlePath(file.path)) throw new Error("manifest에 개인키 또는 비밀 파일이 포함되어 있습니다.");
    if (!/^[a-f0-9]{64}$/i.test(file.sha256 || "") || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("manifest 파일 해시 또는 크기 형식이 올바르지 않습니다.");
    if (declaredPaths.has(file.path)) throw new Error("manifest 파일 경로가 중복되었습니다.");
    declaredPaths.add(file.path);
  }
  for (const required of REQUIRED_COMPONENTS) {
    const component = manifest.components?.[required];
    if (!component?.path || typeof component.path !== "string" || component.path.includes("\\") || component.path.startsWith("/") || component.path.includes("..")) throw new Error(`manifest 필수 구성요소 경로가 올바르지 않습니다: ${required}`);
    assertVersion(component.version, `manifest ${required} version`);
    if (!declaredPaths.has(component.path)) throw new Error(`manifest 구성요소 파일이 목록에 없습니다: ${required}`);
  }
}

function signerFor(trust, keyId) {
  if (!Array.isArray(trust?.signers)) throw new Error("신뢰 키 목록 형식이 올바르지 않습니다.");
  const signer = trust.signers.find((entry) => entry.key_id === keyId && entry.status === "active");
  if (!signer?.public_key_pem) throw new Error(`승인되지 않았거나 비활성화된 서명 키입니다: ${keyId}`);
  return signer;
}

export async function verifyBundle({ bundleDir, trustPath, now = new Date() }) {
  const root = resolve(bundleDir);
  const manifestPath = join(root, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return { status: "repair_required", reason: "승인 번들 manifest가 없습니다." };
  try {
    const [manifest, trust] = await Promise.all([readJson(manifestPath), readJson(trustPath)]);
    validateManifestShape(manifest);
    const signer = signerFor(trust, manifest.signer_key_id);
    if (!verify(null, manifestPayload(manifest), createPublicKey(signer.public_key_pem), Buffer.from(manifest.signature, "base64"))) {
      return { status: "repair_required", reason: "승인 번들 manifest 서명이 일치하지 않습니다." };
    }
    if (new Date(manifest.expires_at).getTime() < now.getTime()) return { status: "unknown", reason: "승인 번들 manifest가 만료되었습니다." };
    if (manifest.revoked_bundle_ids.includes(manifest.bundle_id)) return { status: "repair_required", reason: "폐기된 승인 번들입니다." };
    const actualFiles = await collectFiles(root);
    const actual = [];
    for (const path of actualFiles) actual.push({ path: normalizedRelative(root, path), sha256: await sha256File(path), size: (await stat(path)).size });
    actual.sort((a, b) => a.path.localeCompare(b.path));
    if (canonicalJson(actual) !== canonicalJson(manifest.files)) return { status: "repair_required", reason: "승인 번들 파일 목록 또는 해시가 일치하지 않습니다." };
    const artifactHash = createHash("sha256").update(canonicalJson(manifest.files)).digest("hex");
    if (artifactHash !== manifest.artifact_sha256) return { status: "repair_required", reason: "승인 번들 artifact 해시가 일치하지 않습니다." };
    return { status: "verified", manifest, signer_key_id: signer.key_id };
  } catch (error) {
    return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function installationState({ installedDir, candidateDir, trustPath, now = new Date() }) {
  const installed = await verifyBundle({ bundleDir: installedDir, trustPath, now });
  if (installed.status !== "verified") return { state: installed.status, installed };
  if (!candidateDir) return { state: "current_unknown", installed, message: "로컬 승인 설치본은 확인됐지만 최신 승인 번들은 확인하지 않았습니다." };
  const candidate = await verifyBundle({ bundleDir: candidateDir, trustPath, now });
  if (candidate.status !== "verified") return { state: "unknown", installed, candidate };
  const revoked = new Set(candidate.manifest.revoked_bundle_ids);
  if (revoked.has(installed.manifest.bundle_id)) return { state: "update_available", installed, candidate, forced: true };
  if (compareVersion(installed.manifest.version, candidate.manifest.minimum_allowed_bundle_version) < 0) return { state: "update_available", installed, candidate, forced: true };
  if (compareVersion(candidate.manifest.version, installed.manifest.version) > 0) return { state: "update_available", installed, candidate, forced: false };
  return { state: "current", installed, candidate, forced: false };
}

export async function writeManifest(path, manifest) {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

export { MANIFEST_NAME };
