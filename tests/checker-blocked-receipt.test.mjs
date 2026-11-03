import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * 체커 판정 근거 영수증 — **실제 `gg verify` 흐름**으로 확인한다.
 *
 * 무엇이 잘못돼 있었나: `runChecker()` 가 체커의 차단 종료 코드를 보면 영수증을
 * 쓰기 **전에** 돌아갔다. 그래서 네 판정 중 근거가 가장 필요한 blocked 에서만
 * 영수증이 없었다. 순수 함수는 근거를 잘 만들고 있었지만 그 함수가 호출되지
 * 않았으므로, 순수 함수 테스트만으로는 이것을 잡을 수 없다.
 *
 * 판정 자체는 바뀌지 않는다 — blocked 는 blocked 로 남고, 하네스의
 * `final_verdict` 는 어떤 경우에도 review_required 다.
 */

const harnessRoot = resolve(import.meta.dirname, "..");
const gg = join(harnessRoot, "bin", "gg.mjs");
const EXIT_CHECKER_BLOCK = 40;

function runGg(project, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [gg, ...args, "--project", project], { shell: false, windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/**
 * 가짜 체커. gvskb.exe 자리에 node 를 놓고, 프로젝트의 `scan` 파일이 준비된
 * 보고서를 그대로 뱉는다. 종료 코드도 지정한 값으로 돌려준다 —
 * 차단 경로를 실제로 통과시켜야 하기 때문이다.
 */
async function fakeChecker(report, exitCode = 0) {
  const directory = await mkdtemp(join(tmpdir(), "vibecode-harness-fake-gvskb-"));
  const scripts = join(directory, "Python", "Python313", "Scripts");
  await mkdir(scripts, { recursive: true });
  await copyFile(process.execPath, join(scripts, "gvskb.exe"));
  return {
    directory,
    env: {
      ...process.env,
      APPDATA: directory,
      GG_TEST_CHECKER_REPORT: JSON.stringify(report),
      GG_TEST_CHECKER_EXIT: String(exitCode)
    }
  };
}

async function makeProject(env) {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-checker-"));
  const init = await runGg(project, ["init", "--tools", "both", "--runtime", "typescript_web", "--level", "L1"], env);
  assert.equal(init.code, 0, init.stderr || init.stdout);
  await writeFile(join(project, "package.json"), JSON.stringify({
    name: "checker-receipt-test", private: true, type: "module", scripts: { test: "node --test" }
  }, null, 2));
  await writeFile(join(project, "app.ts"), "export const add = (a: number, b: number) => a + b;\n");
  await writeFile(join(project, "app.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('works', () => assert.equal(1 + 1, 2));\n");
  await writeFile(join(project, "scan"),
    "process.stdout.write(process.env.GG_TEST_CHECKER_REPORT + '\\n');\n"
    + "process.exitCode = Number(process.env.GG_TEST_CHECKER_EXIT || 0);\n");
  // 47차 — 검사 전에 `status --json` 으로 버전·위협정보 상태를 묻는다.
  await writeFile(join(project, "status"), "process.stdout.write(JSON.stringify({ version: process.env.GG_TEST_CHECKER_VERSION || '0.6.1', intel: { state: 'ok' } }) + '\\n');\n");
  return project;
}

/** 영수증 파일을 **디스크에서** 읽는다 — 반환값이 아니라 남은 기록을 본다. */
async function checkerReceipt(project) {
  const directory = join(project, "evidence");
  const entries = await readdir(directory).catch(() => []);
  const receipts = entries.filter((name) => name.endsWith("-checker-evidence.json")).sort();
  if (receipts.length === 0) return null;
  return JSON.parse(await readFile(join(directory, receipts.at(-1)), "utf8"));
}

function reportWith(gate, extra = {}) {
  return {
    schema_version: 1,
    scanned_files: ["app.ts"],
    skipped_files: [],
    profile: "web-civil-service",
    summary: { finding_count: 2 },
    ...(gate ? { gate } : {}),
    ...extra
  };
}

async function verifyWith(report, exitCode) {
  const checker = await fakeChecker(report, exitCode);
  const project = await makeProject(checker.env);
  const run = await runGg(project, ["verify", "--local-checker", "--run-tests"], checker.env);
  return { checker, project, run, receipt: await checkerReceipt(project) };
}

async function cleanup({ checker, project }) {
  for (const directory of [project, checker?.directory]) {
    if (!directory) continue;
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 1. blocked — 근거가 가장 필요한 경우, 예전에는 여기서만 영수증이 없었다
// ---------------------------------------------------------------------------

test("blocked: 영수증이 남고 gate 근거가 모두 보존되며 전체 상태는 blocked 다", async () => {
  const blockReasons = [{
    package: "pyyaml",
    version: "5.3.1",
    criteria: ["critical"],
    labels: ["CVSS CRITICAL 취약점"],
    recommended_version: "5.4"
  }];
  const context = await verifyWith(reportWith({
    verdict: "blocked",
    reason: "배포 불가 — CVSS CRITICAL 취약점에 해당하는 패키지가 있습니다(pyyaml 5.3.1).",
    block_reasons: blockReasons
  }), 1);
  try {
    const { receipt, run } = context;
    assert.ok(receipt, "차단된 경우에도 영수증 파일이 있어야 한다");

    // 필수 근거 필드
    assert.equal(receipt.checker_gate_verdict, "blocked");
    assert.match(receipt.checker_gate_reason, /pyyaml/);
    assert.deepEqual(receipt.checker_block_reasons, blockReasons);
    assert.equal(receipt.checker_schema_version, 1);
    assert.match(receipt.report_sha256, /^[0-9a-f]{64}$/);
    assert.equal(receipt.scanned_file_count, 1);
    assert.equal(receipt.checker_exit_code, 1);
    assert.equal(receipt.checker_status, "blocked");

    // 판정은 완화되지 않는다
    assert.equal(receipt.final_verdict, "review_required");
    const printed = JSON.parse(run.stdout.slice(run.stdout.indexOf("{")));
    assert.equal(printed.status, "blocked");
    assert.equal(printed.checker.status, "blocked");
    assert.notEqual(printed.status, "review_required");
    assert.equal(run.code, EXIT_CHECKER_BLOCK);
    assert.ok(printed.checker.reportPath, "차단 결과도 영수증 경로를 가리켜야 한다");
  } finally {
    await cleanup(context);
  }
});

// ---------------------------------------------------------------------------
// 2~3. conditional · approved — 근거는 남고 하네스 판정은 그대로다
// ---------------------------------------------------------------------------

test("conditional: 차단은 없지만 확인 사유가 영수증에 남는다", async () => {
  const context = await verifyWith(reportWith({
    verdict: "conditional",
    reason: "차단 사유는 없습니다. 확인이 필요한 항목이 있습니다(소스 높은 위험 9건).",
    block_reasons: []
  }), 0);
  try {
    assert.ok(context.receipt);
    assert.equal(context.receipt.checker_gate_verdict, "conditional");
    assert.match(context.receipt.checker_gate_reason, /확인이 필요한/);
    assert.deepEqual(context.receipt.checker_block_reasons, []);
    assert.equal(context.receipt.checker_status, "review_required");
    assert.equal(context.receipt.final_verdict, "review_required");
  } finally {
    await cleanup(context);
  }
});

test("approved: 체커가 승인해도 하네스의 final_verdict 는 review_required 다", async () => {
  const context = await verifyWith(reportWith({
    verdict: "approved",
    reason: "조치할 항목이 없습니다.",
    block_reasons: []
  }), 0);
  try {
    assert.ok(context.receipt);
    // 체커가 무엇이라 했는지는 그대로 적는다.
    assert.equal(context.receipt.checker_gate_verdict, "approved");
    // 하네스가 무엇으로 처리했는지는 바뀌지 않는다.
    assert.equal(context.receipt.final_verdict, "review_required");
    const printed = JSON.parse(context.run.stdout.slice(context.run.stdout.indexOf("{")));
    assert.equal(printed.status, "review_required");
  } finally {
    await cleanup(context);
  }
});

// ---------------------------------------------------------------------------
// 4. 구버전 체커 — 없는 것을 통과로 바꿔 말하지 않는다
// ---------------------------------------------------------------------------

test("gate 가 없는 구버전 결과는 null 로 남고 approved 로 추론되지 않는다", async () => {
  const context = await verifyWith({
    scanned_files: ["app.ts"],
    skipped_files: [],
    profile: "web-civil-service",
    summary: { finding_count: 0 }
  }, 0);
  try {
    const { receipt } = context;
    assert.ok(receipt);
    assert.equal(receipt.checker_gate_verdict, null);
    assert.notEqual(receipt.checker_gate_verdict, "approved");
    assert.equal(receipt.checker_gate_reason, "");
    assert.deepEqual(receipt.checker_block_reasons, []);
    assert.equal(receipt.checker_schema_version, null);
    assert.equal(receipt.final_verdict, "review_required");
  } finally {
    await cleanup(context);
  }
});

// ---------------------------------------------------------------------------
// 완전성 검사를 통과하지 못한 결과까지 영수증으로 남기지는 않는다
// ---------------------------------------------------------------------------

test("검사 범위를 신뢰할 수 없으면 영수증을 남기지 않고 incomplete 로 끝난다", async () => {
  // 근거를 남기는 것과 근거가 되지 못하는 결과를 기록하는 것은 다르다.
  const context = await verifyWith(reportWith({ verdict: "blocked", reason: "r", block_reasons: [] }, {
    profile_fallback: "web-civil-service"
  }), 1);
  try {
    assert.equal(context.receipt, null, "프로필 fallback 결과를 근거로 남기지 않는다");
    const printed = JSON.parse(context.run.stdout.slice(context.run.stdout.indexOf("{")));
    assert.equal(printed.status, "incomplete");
  } finally {
    await cleanup(context);
  }
});
