import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("pilot portal labels a PEM-verified unsigned demonstration installer separately", async () => {
  const index = JSON.parse(await readFile(join(root, "public", "releases", "release-index.json"), "utf8"));
  const app = await readFile(join(root, "public", "demo-app.js"), "utf8");
  assert.equal(index.status, "demo_installer_published");
  assert.equal(index.installer.signature_status, "pem_bundle_verified_unsigned_demo");
  assert.match(index.installer.download_url, /\/v0\.2\.0-demo\.\d+\//);
  assert.deepEqual(index.capabilities.supported_tools, ["codex", "claude-code", "claude-desktop", "chatgpt-codex-desktop", "lovable-github"]);
  // 폐기된 도구가 어떤 키 아래로도 되살아나지 않는다 — 포털은 이 파일로 지원 도구를 그린다.
  assert.equal(index.capabilities.supported_tools.includes("google-antigravity"), false);
  assert.ok(index.capabilities.supported_tools.includes("lovable-github"));
  assert.doesNotMatch(JSON.stringify(index), /antigravity/i);
  assert.match(index.capabilities.update_policy, /does not update automatically/);
  assert.match(app, /installer_published/);
  assert.match(app, /demo_installer_published/);
  assert.match(app, /authenticode_verified/);
  assert.match(app, /pem_bundle_verified_unsigned_demo/);
  assert.match(app, /setDownloadUnavailable/);
  assert.doesNotMatch(app, /google-antigravity/);
  assert.match(app, /lovable-github/);
});

test("pilot deployment configuration serves only static portal assets", async () => {
  const pages = await readFile(join(root, ".github", "workflows", "deploy-pages.yml"), "utf8");
  const vercel = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));
  assert.match(pages, /path: public/);
  assert.match(pages, /contents: read/);
  assert.match(pages, /actions\/deploy-pages@v4/);
  assert.equal(vercel.cleanUrls, true);
  assert.equal(vercel.headers[0].headers[0].value, "no-store");
});
