import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const scriptName = process.argv[2];
const allowedScripts = new Set(["validate-design.ps1", "test-validate-design.ps1"]);

if (!allowedScripts.has(scriptName)) {
  console.error("허용되지 않은 PowerShell 검증 스크립트입니다.");
  process.exit(64);
}

const systemRoot = process.env.SystemRoot || "C:\\Windows";
const executable = resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const scriptPath = resolve(scriptsDirectory, scriptName);

if (!existsSync(executable)) {
  console.error("Windows PowerShell을 찾지 못했습니다. Windows 기본 구성 요소를 확인하세요.");
  process.exit(41);
}

const result = spawnSync(executable, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
  cwd: resolve(scriptsDirectory, ".."),
  stdio: "inherit",
  shell: false
});

process.exit(result.status ?? 1);
