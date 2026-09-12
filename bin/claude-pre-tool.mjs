#!/usr/bin/env node
import { isDirectPackageInstall, languageFailureForPath, resolvePolicyProfile, runtimeFailureForCommand } from "../lib/policy-engine.mjs";

function block(message) {
  process.stderr.write(`바이브코드 하네스 차단: ${message}\n`);
  process.exitCode = 2;
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
if (!raw.trim()) process.exit(0);

try {
  const event = JSON.parse(raw);
  const input = event.tool_input || event.toolInput || {};
  const filePath = String(input.file_path || input.path || input.file || "");
  const profile = resolvePolicyProfile({ filePath, cwd: event.cwd });
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
