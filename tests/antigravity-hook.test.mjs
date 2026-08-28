import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const hook = resolve(import.meta.dirname, "..", "bin", "antigravity-pre-tool.mjs");

function invoke(payload) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [hook], { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test("Antigravity hook denies a blocked source file", async () => {
  const result = await invoke({ toolCall: { name: "create_file", args: { path: "service.go" } } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { decision: "deny", reason: "Go 파일은 기관 기본 언어 정책에서 허용하지 않습니다: service.go" });
});

test("Antigravity hook allows a supported source file", async () => {
  const result = await invoke({ toolCall: { name: "edit_file", args: { filePath: "service.ts" } } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, "allow");
});

test("Antigravity hook denies unapproved runtimes and direct package installs", async () => {
  const runtime = await invoke({ toolCall: { name: "run_command", args: { CommandLine: "cargo build" } } });
  assert.equal(JSON.parse(runtime.stdout).decision, "deny");
  const packageInstall = await invoke({ toolCall: { name: "run_command", args: { CommandLine: "npm install firebase" } } });
  const decision = JSON.parse(packageInstall.stdout);
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /gg package check/);
  const npx = await invoke({ toolCall: { name: "run_command", args: { CommandLine: "npx create-vite@latest" } } });
  assert.equal(JSON.parse(npx.stdout).decision, "deny");
});

test("Antigravity hook denies malformed payloads instead of approving them", async () => {
  const child = spawn(process.execPath, [hook], { shell: false, windowsHide: true });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.end("not-json");
  await new Promise((resolvePromise) => child.on("close", resolvePromise));
  assert.equal(JSON.parse(stdout).decision, "deny");
});
