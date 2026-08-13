import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const hook = resolve(import.meta.dirname, "..", "bin", "claude-pre-tool.mjs");

function invoke(payload) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [hook], { shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test("Claude hook blocks denied source files", async () => {
  const result = await invoke({ tool_name: "Write", tool_input: { file_path: "server.go" } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Go 파일/);
});

test("Claude hook allows supported source files", async () => {
  const result = await invoke({ tool_name: "Write", tool_input: { file_path: "server.ts" } });
  assert.equal(result.code, 0, result.stderr);
});

test("Claude hook blocks denied runtime commands", async () => {
  const result = await invoke({ tool_name: "Bash", tool_input: { command: "cargo build" } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /승인되지 않은 언어/);
});
