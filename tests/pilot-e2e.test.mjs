import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * 시험운영 E2E 스크립트가 **실제로 끝까지 돌고 0 으로 끝나는지** 확인한다.
 *
 * 스크립트 안의 개별 판정은 스크립트가 표로 찍는다. 여기서는 그 표가 "실패: 0" 을
 * 말하는지, 그리고 하네스 혼자 확인할 수 없는 항목을 통과로 적지 않고 포털 측
 * 스크립트 이름으로 넘기는지만 본다. 자식 프로세스로 띄우는 이유는 스크립트가
 * 직접 실행 시 process.exitCode 를 세팅하기 때문이다 — 그 종료 코드가 계약이다.
 */

const harnessRoot = resolve(import.meta.dirname, "..");
const script = join(harnessRoot, "scripts", "pilot-e2e.mjs");

function runScript() {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [script], { shell: false, windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("pilot-e2e 스크립트는 임시 폴더에서 끝까지 돌고 exit 0 으로 끝난다", async () => {
  const result = await runScript();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /실패: 0/);
  assert.match(result.stdout, /\.go 차단 \| 통과/);
  assert.match(result.stdout, /\.tsx 허용 \| 통과/);
  assert.match(result.stdout, /lock\.tools 가 정확히 다섯 도구 \| 통과/);
  assert.match(result.stdout, /직접 설치 차단: pip install requests \| 통과/);
  // 하네스 혼자 확인할 수 없는 것은 통과가 아니라 포털 측 스크립트 이름으로 남는다.
  assert.match(result.stdout, /포털 측 테스트에서 검증: scripts\/package-gate-smoke-test\.mjs/);
  assert.match(result.stdout, /포털 측 테스트에서 검증: scripts\/report-naming-test\.mjs/);
  assert.match(result.stdout, /포털 측 테스트에서 검증: scripts\/portal-scenario-test\.mjs/);
  // 다섯 도구의 강제 지점 표와 공통 최종 강제 지점 문장.
  for (const tool of ["codex", "claude-code", "claude-desktop", "chatgpt-codex-desktop", "lovable-github"]) {
    assert.match(result.stdout, new RegExp(`\\| ${tool} \\|`));
  }
  assert.match(result.stdout, /공통 최종 강제 지점은 Git 훅 \/ PR \/ CI/);
  assert.doesNotMatch(result.stdout, /google-antigravity/);
});
