import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const preflight = join(root, "scripts", "release-preflight.mjs");

function run(args = []) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [preflight, ...args], { cwd: root, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("release preflight accepts the matching release tag and leaves publishing manual", async () => {
  const result = await run(["--tag", "v0.2.0"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "source_preflight_passed");
  assert.equal(report.portal_status, "demo_installer_published");
  assert.match(report.required_manual_gates.join(" "), /Authenticode/);
});

test("release preflight rejects a tag that does not match the package version", async () => {
  const result = await run(["--tag", "v9.9.9"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /does not match/);
});

test("demonstration preflight only accepts an explicitly labelled demonstration tag", async () => {
  const result = await run(["--tag", "v0.2.0-demo.1", "--channel", "demonstration"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "demonstration_source_preflight_passed");
  assert.match(report.required_manual_gates.join(" "), /unsigned demonstration EXE/);
});
