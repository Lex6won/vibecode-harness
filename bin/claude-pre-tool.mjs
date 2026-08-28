#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDirectPackageInstall, languageFailureForPath, runtimeFailureForCommand } from "../lib/policy-engine.mjs";

function block(message) {
  process.stderr.write(`바이브코드 하네스 차단: ${message}\n`);
  process.exitCode = 2;
}

function policyProfileFromProject() {
  let directory = resolve(process.cwd());
  while (true) {
    const lock = resolve(directory, ".vibecode-harness", "harness.lock.json");
    if (existsSync(lock)) {
      try { return JSON.parse(readFileSync(lock, "utf8")).policy_profile || "general"; } catch { return "general"; }
    }
    const parent = dirname(directory);
    if (parent === directory) return "general";
    directory = parent;
  }
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
if (!raw.trim()) process.exit(0);

try {
  const event = JSON.parse(raw);
  const input = event.tool_input || event.toolInput || {};
  const filePath = String(input.file_path || input.path || input.file || "");
  const profile = policyProfileFromProject();
  const languageFailure = languageFailureForPath(profile, filePath);
  if (languageFailure) {
    block(languageFailure);
  } else {
    const command = String(input.command || "").replace(/\\/g, "/").toLowerCase();
    const runtimeFailure = runtimeFailureForCommand(profile, command);
    if (runtimeFailure) {
      block(runtimeFailure);
    } else if (isDirectPackageInstall(command)) {
      block("새 패키지는 직접 설치하지 않습니다. 먼저 gg package check로 체커 검토와 기관 패키지 정책을 확인하세요.");
    }
  }
} catch {
  // A malformed hook payload must not be treated as a safety approval.
  block("Claude Code 훅 입력을 읽을 수 없습니다. 도구 작업을 다시 시도하거나 Git 검증을 실행하세요.");
}
