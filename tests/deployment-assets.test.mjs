import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("pilot portal keeps downloads closed until an approved installer is published", async () => {
  const index = JSON.parse(await readFile(join(root, "public", "releases", "release-index.json"), "utf8"));
  const app = await readFile(join(root, "public", "app.js"), "utf8");
  assert.equal(index.status, "installer_not_published");
  assert.equal(index.installer, null);
  assert.match(app, /installer_published/);
  assert.match(app, /authenticode_verified/);
  assert.match(app, /setDownloadUnavailable/);
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
