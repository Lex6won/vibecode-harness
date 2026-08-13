import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("installer fails closed when bundle verification fails", async () => {
  const installer = await readFile(join(root, "installer", "vibecode-harness.iss"), "utf8");
  assert.match(installer, /\[Code\]/);
  assert.match(installer, /bundle verify --bundle/);
  assert.match(installer, /RaiseException/);
  assert.doesNotMatch(installer, /\[Run\]/);
});

test("installer build contract requires bundled runtimes and code signing", async () => {
  const build = await readFile(join(root, "scripts", "build-windows-installer.ps1"), "utf8");
  assert.match(build, /runtime\\node\.exe/);
  assert.match(build, /runtime\\python\.exe/);
  assert.match(build, /checker\\gvskb\.exe/);
  assert.match(build, /signtool\.exe/);
  assert.match(build, /signtool sign/);
  assert.match(build, /signtool verify/);
});
