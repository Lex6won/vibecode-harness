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
  assert.match(installer, /\[Run\]/);
  assert.match(installer, /manager\.ps1/);
  assert.match(installer, /-WindowStyle Hidden -File/);
});

test("installer build contract embeds only the Harness runtime and code signing", async () => {
  const build = await readFile(join(root, "scripts", "build-windows-installer.ps1"), "utf8");
  assert.match(build, /runtime\\node\.exe/);
  assert.doesNotMatch(build, /runtime\\python\.exe/);
  assert.doesNotMatch(build, /checker\\gvskb\.exe/);
  assert.match(build, /server-side Portal components/);
  assert.match(build, /gg\.cmd/);
  assert.match(build, /manager\.ps1/);
  assert.match(build, /UTF-8 with BOM/);
  assert.match(build, /signtool\.exe/);
  assert.match(build, /signtool sign/);
  assert.match(build, /signtool verify/);
});

test("demonstration installer is separately named, verifies the PEM-signed bundle, and never claims production signing", async () => {
  const demoBuild = await readFile(join(root, "scripts", "build-windows-demo-installer.ps1"), "utf8");
  const demoBundle = await readFile(join(root, "scripts", "prepare-windows-demo-bundle.ps1"), "utf8");
  const installer = await readFile(join(root, "installer", "vibecode-harness.iss"), "utf8");
  assert.match(demoBuild, /bundle verify --bundle/);
  assert.match(demoBuild, /Demo-Unsigned-Setup\.exe/);
  assert.match(demoBuild, /unsigned demonstration installer/);
  assert.doesNotMatch(demoBuild, /signtool sign/);
  assert.match(demoBundle, /sign-release-bundle\.mjs/);
  assert.match(demoBundle, /demo-release\.json/);
  assert.match(demoBundle, /UTF8Encoding\(\$false\)/);
  assert.match(demoBundle, /UTF8Encoding\(\$true\)/);
  assert.match(demoBundle, /WriteAllText\(\(Join-Path \$output "manager\.ps1"\)/);
  assert.doesNotMatch(demoBundle, /Set-Content.*-Encoding UTF8/);
  assert.match(installer, /DemoBuild/);
  assert.match(installer, /Gyeonggi-VibeCode-Harness-Demo-Unsigned-Setup/);
});

test("test installers use a separate identity and never replace a user demonstration installation", async () => {
  const installer = await readFile(join(root, "installer", "vibecode-harness.iss"), "utf8");
  assert.match(installer, /#ifdef TestBuild/);
  assert.match(installer, /VibeCodeHarness-Test/);
  assert.match(installer, /8A4A22CD-C161-4082-8EA4-18C5D2CB3EF5/);
});
