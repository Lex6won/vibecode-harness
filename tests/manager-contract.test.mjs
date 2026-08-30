import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const manager = join(root, "manager.ps1");

function run(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("Harness Manager applies selected tools without collecting tool credentials", async () => {
  const source = await readFile(manager, "utf8");
  assert.match(source, /Get-ProjectLock/);
  assert.match(source, /configure/);
  assert.match(source, /typescript_postgres/);
  assert.match(source, /claude-desktop/);
  assert.match(source, /chatgpt-desktop/);
  assert.match(source, /lovable/);
  assert.match(source, /개발 도구 \(복수 선택 가능\)/);
  assert.match(source, /JavaScript · TypeScript · PostgreSQL \(자동 적용\)/);
  assert.match(source, /\$profile\.SelectedIndex = 1/);
  assert.match(source, /\$profile\.Visible = \$false/);
  assert.match(source, /\$top = 26 \+ \(31 \* \$index\)/);
  assert.doesNotMatch(source, /New-Object System\.Drawing\.Point\(16 \+/);
  assert.doesNotMatch(source, /ExecutionPolicy\s+Bypass/i);
  assert.doesNotMatch(source, /password|api[_-]?key|token/i);
});

test("Harness Manager visibly identifies an unsigned demonstration bundle", async () => {
  const source = await readFile(manager, "utf8");
  assert.match(source, /demo-release\.json/);
  assert.match(source, /UNSIGNED DEMONSTRATION BUILD/);
});

test("Harness Manager is valid PowerShell syntax", async () => {
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const escaped = manager.replace(/'/g, "''");
  const result = await run(executable, ["-NoProfile", "-NonInteractive", "-Command", `[void][scriptblock]::Create([IO.File]::ReadAllText('${escaped}')); Write-Output 'parsed'`]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /parsed/);
});
