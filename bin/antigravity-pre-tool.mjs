#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDirectPackageInstall, languageFailureForPath, runtimeFailureForCommand } from "../lib/policy-engine.mjs";

function respond(decision, reason) {
  process.stdout.write(`${JSON.stringify({ decision, reason })}\n`);
}

function commandFrom(input) {
  return String(input.CommandLine || input.command || input.cmd || "").replace(/\\/g, "/").toLowerCase();
}

function pathFrom(input) {
  return String(input.file_path || input.filePath || input.path || input.file || input.target_path || input.targetPath || "");
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

try {
  const event = JSON.parse(raw || "{}");
  const input = event.toolCall?.args || event.tool_input || event.toolInput || {};
  const filePath = pathFrom(input);
  const profile = policyProfileFromProject();
  const languageFailure = languageFailureForPath(profile, filePath);
  if (languageFailure) {
    respond("deny", languageFailure);
  } else {
    const command = commandFrom(input);
    const runtimeFailure = runtimeFailureForCommand(profile, command);
    if (runtimeFailure) {
      respond("deny", runtimeFailure);
    } else if (isDirectPackageInstall(command)) {
      respond("deny", "새 패키지를 직접 설치할 수 없습니다. 먼저 gg package check로 체커와 기관 패키지 정책을 확인하세요.");
    } else {
      respond("allow", "VibeCode Harness pre-tool check passed.");
    }
  }
} catch {
  // A malformed hook payload must never become a safety approval.
  respond("deny", "Antigravity 훅 입력을 읽을 수 없습니다. 작업을 다시 시도하거나 gg verify를 실행하세요.");
}
