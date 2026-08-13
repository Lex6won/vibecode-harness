#!/usr/bin/env node
import { extname } from "node:path";

const blockedExtensions = new Map([
  [".java", "Java"], [".go", "Go"], [".php", "PHP"], [".rb", "Ruby"],
  [".cs", "C#"], [".rs", "Rust"]
]);

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
  const extension = extname(filePath).toLowerCase();
  if (blockedExtensions.has(extension)) {
    block(`${blockedExtensions.get(extension)} 파일은 기관 기본 언어 정책의 예외 검토 대상입니다: ${filePath}`);
  } else {
    const command = String(input.command || "").replace(/\\/g, "/").toLowerCase();
    if (/(^|[\s;&|])(?:go|java|php|ruby|dotnet|cargo)(?:[\s;&|]|$)/.test(command)) {
      block("승인되지 않은 언어 또는 런타임 명령입니다. Python, JavaScript, TypeScript 트랙을 사용하세요.");
    }
  }
} catch {
  // A malformed hook payload must not be treated as a safety approval.
  block("Claude Code 훅 입력을 읽을 수 없습니다. 도구 작업을 다시 시도하거나 Git 검증을 실행하세요.");
}
