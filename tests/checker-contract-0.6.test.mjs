import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  CHECKER_STATUS_BY_VERDICT,
  EXIT_CODE_TO_VERDICT,
  MIN_CHECKER_VERSION,
  buildCheckerEvidence,
  checkerVersionSatisfies,
  dependencyCheckEvidence,
  parseCheckerVersion,
  resolveCheckerStatus
} from "../lib/checker-evidence.mjs";

/**
 * 47차 — 체커 0.6 계약 정렬.
 *
 * 무엇이 잘못돼 있었나: `checker_status` 를 종료코드 하나로 정했다(0 이 아니면 전부 blocked).
 * 체커가 "위협정보가 없어 패키지를 보지 못했다"(종료코드 3, verdict undetermined)고 말해도
 * 영수증은 '차단'이라 적었다. 검사하지 못한 것과 막힌 것은 다른 사실이다 — 같은 말로 적으면
 * 담당자는 엉뚱한 곳을 고친다. 또 `--check-deps` 를 박아 두어 0.6 의 로컬 기본값과 위협정보
 * 신선도 게이트를 우회했고, 0.6 아래 체커(패키지 검사가 옵션인 버전)도 그대로 썼다.
 */

const harnessRoot = resolve(import.meta.dirname, "..");
const gg = join(harnessRoot, "bin", "gg.mjs");
const EXIT = { PACKAGE: 20, CHECKER_BLOCK: 40, CHECKER_INCOMPLETE: 41, POLICY: 10 };
const BSLASH = String.fromCharCode(92);

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

function printed(run) {
  return JSON.parse(run.stdout.slice(run.stdout.indexOf("{")));
}

/** node 를 gvskb.exe 자리에 두고, 프로젝트의 `scan`·`status`·`version`·`check-package` 파일이 하위 명령 역할을 한다. */
async function fakeChecker({ report, scanExit = 0, version = "0.6.1", intelState = "ok", packageResult = null, noStatus = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "vibecode-harness-fake-gvskb-"));
  const scripts = join(directory, "Python", "Python313", "Scripts");
  await mkdir(scripts, { recursive: true });
  await copyFile(process.execPath, join(scripts, "gvskb.exe"));
  return {
    directory,
    env: {
      ...process.env,
      APPDATA: directory,
      GG_TEST_CHECKER_REPORT: JSON.stringify(report || {}),
      GG_TEST_CHECKER_EXIT: String(scanExit),
      GG_TEST_CHECKER_VERSION: version,
      GG_TEST_INTEL_STATE: intelState,
      GG_TEST_PACKAGE_RESULT: JSON.stringify(packageResult || {}),
      GG_TEST_NO_STATUS: noStatus ? "1" : ""
    }
  };
}

async function makeProject(env, { tools = "both", runtime = "typescript_web" } = {}) {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-contract-"));
  const init = await runGg(project, ["init", "--tools", tools, "--runtime", runtime, "--level", "L1"], env);
  assert.equal(init.code, 0, init.stderr || init.stdout);
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "contract-test", private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
  await writeFile(join(project, "app.ts"), "export const add = (a: number, b: number) => a + b;\n");
  await writeFile(join(project, "app.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('works', () => assert.equal(1 + 1, 2));\n");
  await writeFile(join(project, "scan"),
    "process.stdout.write(process.env.GG_TEST_CHECKER_REPORT + '\\n');\n"
    + "process.exitCode = Number(process.env.GG_TEST_CHECKER_EXIT || 0);\n");
  if (!env.GG_TEST_NO_STATUS) {
    await writeFile(join(project, "status"),
      "process.stdout.write(JSON.stringify({ version: process.env.GG_TEST_CHECKER_VERSION, intel: { state: process.env.GG_TEST_INTEL_STATE, as_of: '2026-11-03T00:00:00+00:00', age_days: 0, max_age_days: 2, missing: [], stale: [], signature: { required: false, trusted_keys: 1 } }, install_identity: { commit_id: 'fake' } }) + '\\n');\n");
  }
  await writeFile(join(project, "version"), "process.stdout.write('vibecode-checker (gvskb) ' + process.env.GG_TEST_CHECKER_VERSION + '\\n');\n");
  await writeFile(join(project, "check-package"),
    "process.stdout.write(process.env.GG_TEST_PACKAGE_RESULT + '\\n');\n"
    + "const r = JSON.parse(process.env.GG_TEST_PACKAGE_RESULT); process.exitCode = r.exit_code ?? 0;\n");
  return project;
}

async function latestReceipt(project, suffix) {
  const entries = await readdir(join(project, "evidence")).catch(() => []);
  const names = entries.filter((name) => name.endsWith(suffix)).sort();
  if (!names.length) return null;
  return JSON.parse(await readFile(join(project, "evidence", names.at(-1)), "utf8"));
}

async function cleanup(...directories) {
  for (const directory of directories) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

const report = (gate, extra = {}) => ({
  schema_version: 1,
  engine_version: "0.6.1",
  scanned_files: ["app.ts"],
  skipped_files: [],
  profile: "web-civil-service",
  summary: { finding_count: 0 },
  dependency_check: { mode: "local", requested_mode: null, packages_parsed: 3, intel: { state: "ok", as_of: "2026-11-03T00:00:00+00:00", age_days: 0 }, auto_refresh: { ok: true } },
  ...(gate ? { gate } : {}),
  ...extra
});

// ---------------------------------------------------------------------------
// 1. 표 자체 — 체커 gate_contract().consumer_mapping.harness 와 같아야 한다(체커 저장소 테스트가 대조)
// ---------------------------------------------------------------------------

test("표: 승인·조건부는 사람 검토, 차단은 차단, 판정 불가는 판정 불가", () => {
  assert.deepEqual(CHECKER_STATUS_BY_VERDICT, { approved: "review_required", conditional: "review_required", blocked: "blocked", undetermined: "undetermined" });
  assert.deepEqual(EXIT_CODE_TO_VERDICT, { 0: "approved", 1: "conditional", 2: "blocked", 3: "undetermined" });
  assert.equal(MIN_CHECKER_VERSION, "0.6.0");
});

test("상태는 verdict 가 1차, 종료코드는 교차 확인 — 어긋나면 더 나쁜 쪽과 충돌 기록", () => {
  assert.deepEqual(resolveCheckerStatus({ verdict: "undetermined", exitCode: 3 }), { status: "undetermined", conflict: null });
  // --fail-on block 아래에서 conditional 은 0 으로 온다 — 모순이 아니다.
  assert.deepEqual(resolveCheckerStatus({ verdict: "conditional", exitCode: 0 }), { status: "review_required", conflict: null });
  assert.deepEqual(resolveCheckerStatus({ verdict: "conditional", exitCode: 1 }), { status: "review_required", conflict: null });
  // verdict approved 인데 종료코드 2 — 더 나쁜 blocked 를 쓰고 충돌을 남긴다.
  assert.deepEqual(resolveCheckerStatus({ verdict: "approved", exitCode: 2 }), { status: "blocked", conflict: { exit_code: 2, verdict: "approved" } });
  // verdict blocked 인데 종료코드 0 — 역시 blocked.
  assert.equal(resolveCheckerStatus({ verdict: "blocked", exitCode: 0 }).status, "blocked");
  // 모르는 verdict 는 통과가 아니다.
  assert.equal(resolveCheckerStatus({ verdict: "approved_with_notes", exitCode: 0 }).status, "undetermined");
  // 구버전(verdict 없음)은 종료코드로만 — 3 은 undetermined, 2 는 blocked, 모르는 코드는 null.
  assert.equal(resolveCheckerStatus({ verdict: null, exitCode: 3 }).status, "undetermined");
  assert.equal(resolveCheckerStatus({ verdict: null, exitCode: 2 }).status, "blocked");
  assert.equal(resolveCheckerStatus({ verdict: null, exitCode: 7 }).status, null);
});

test("영수증은 0.6 필드(intel_gap · dependency_check · conditional_criteria · version)를 보존한다", () => {
  const evidence = buildCheckerEvidence({
    checker: "system_gvskb",
    report: report({ verdict: "conditional", reason: "r", block_reasons: [], conditional_criteria: ["intel_stale", "unpinned"], intel_gap: "stale" }),
    scannedFileCount: 1, declaredDependencyCount: 3, reportSha256: "a".repeat(64), exitCode: 0
  });
  assert.equal(evidence.checker_status, "review_required");
  assert.deepEqual(evidence.checker_conditional_criteria, ["intel_stale", "unpinned"]);
  assert.equal(evidence.checker_intel_gap, "stale");
  assert.equal(evidence.checker_version, "0.6.1");
  assert.deepEqual(evidence.checker_dependency_check, { mode: "local", requested_mode: null, packages_parsed: 3, intel_state: "ok", intel_as_of: "2026-11-03T00:00:00+00:00", intel_age_days: 0, auto_refresh_ok: true });
  assert.equal(evidence.final_verdict, "review_required");
  assert.equal(dependencyCheckEvidence({}), null);
});

test("버전 비교 — 못 읽으면 통과가 아니다", () => {
  assert.deepEqual([...parseCheckerVersion("vibecode-checker (gvskb) 0.6.1")], [0, 6, 1]);
  assert.equal(parseCheckerVersion("0.6.0rc1").prerelease, true);
  assert.equal(checkerVersionSatisfies("0.6.0"), true);
  assert.equal(checkerVersionSatisfies("0.6.1"), true);
  assert.equal(checkerVersionSatisfies("1.0.0"), true);
  assert.equal(checkerVersionSatisfies("0.5.15"), false);
  assert.equal(checkerVersionSatisfies(null), false);
  assert.equal(checkerVersionSatisfies("latest"), false);
  // M4 — 느슨한 정규식이 집던 것들: 다른 버전 문자열, pre-release.
  assert.equal(parseCheckerVersion("Python 3.11.9 / gvskb 0.5.3"), null);
  assert.equal(checkerVersionSatisfies("Python 3.11.9 / gvskb 0.5.3"), false);
  assert.equal(checkerVersionSatisfies("0.6.0rc1"), false);
  assert.equal(checkerVersionSatisfies("0.6.0.dev1"), false);
  assert.equal(checkerVersionSatisfies("0.6.1rc1"), true, "0.6.1 의 pre-release 는 0.6.0 보다 크다");
  assert.equal(checkerVersionSatisfies("vibecode-checker (gvskb) 0.6.1"), true);
});

// ---------------------------------------------------------------------------
// 2. 실제 gg verify 흐름
// ---------------------------------------------------------------------------

test("판정 불가(종료 3·undetermined·intel missing)는 차단이 아니라 incomplete(41) 다", async () => {
  const checker = await fakeChecker({ report: report({ verdict: "undetermined", reason: "위협정보 없음", block_reasons: [], conditional_criteria: [], intel_gap: "missing" }, { dependency_check: { mode: "local", packages_parsed: 2, intel: { state: "missing" } } }), scanExit: 3 });
  const project = await makeProject(checker.env);
  try {
    const run = await runGg(project, ["verify", "--local-checker", "--run-tests"], checker.env);
    assert.equal(run.code, EXIT.CHECKER_INCOMPLETE, run.stdout + run.stderr);
    const out = printed(run);
    assert.equal(out.status, "incomplete");
    assert.notEqual(out.checker.status, "blocked");
    assert.match(out.checker.reason, /위협정보 캐시 없음/);
    assert.match(out.checker.reason, /GVSKB_INTEL_DIR/);
    const receipt = await latestReceipt(project, "-checker-evidence.json");
    assert.ok(receipt, "판정 불가도 영수증을 남긴다");
    assert.equal(receipt.checker_status, "undetermined");
    assert.equal(receipt.checker_intel_gap, "missing");
    assert.equal(receipt.checker_dependency_check.intel_state, "missing");
    assert.equal(receipt.final_verdict, "review_required");
  } finally {
    await cleanup(project, checker.directory);
  }
});

test("차단(verdict blocked · 종료 2)은 40 으로 끝나고 사유가 보인다", async () => {
  const checker = await fakeChecker({ report: report({ verdict: "blocked", reason: "배포 불가 — CISA KEV 패키지(kevpkg 1.0.0)", block_reasons: [{ package: "kevpkg", version: "1.0.0", criteria: ["kev"] }], conditional_criteria: [], intel_gap: "" }), scanExit: 2 });
  const project = await makeProject(checker.env);
  try {
    const run = await runGg(project, ["verify", "--local-checker", "--run-tests"], checker.env);
    assert.equal(run.code, EXIT.CHECKER_BLOCK, run.stdout + run.stderr);
    const out = printed(run);
    assert.equal(out.status, "blocked");
    assert.match(out.checker.reason, /KEV/);
    const receipt = await latestReceipt(project, "-checker-evidence.json");
    assert.equal(receipt.checker_status, "blocked");
    assert.equal(receipt.checker_status_conflict, null);
  } finally {
    await cleanup(project, checker.directory);
  }
});

test("조건부(종료 0)는 review_required 이고 조건부 사유가 영수증에 남는다", async () => {
  const checker = await fakeChecker({ report: report({ verdict: "conditional", reason: "확인 필요", block_reasons: [], conditional_criteria: ["intel_stale", "source"], intel_gap: "stale" }), scanExit: 0 });
  const project = await makeProject(checker.env);
  try {
    const run = await runGg(project, ["verify", "--local-checker", "--run-tests"], checker.env);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const out = printed(run);
    assert.equal(out.status, "review_required");
    assert.deepEqual(out.checker.conditional_criteria, ["intel_stale", "source"]);
    const receipt = await latestReceipt(project, "-checker-evidence.json");
    assert.deepEqual(receipt.checker_conditional_criteria, ["intel_stale", "source"]);
    assert.equal(receipt.checker_dependency_check.mode, "local");
  } finally {
    await cleanup(project, checker.directory);
  }
});

test("체커 호출에 --check-deps 가 없다(0.6 에서 online 별칭) — 호출 인자 기록으로 확인", async () => {
  const checker = await fakeChecker({ report: report({ verdict: "approved", reason: "", block_reasons: [], conditional_criteria: [], intel_gap: "" }) });
  const project = await makeProject(checker.env);
  // 프로젝트가 type:module 이라 확장자 없는 스크립트도 ESM 으로 읽힌다 — require 대신 동적 import.
  await writeFile(join(project, "scan"),
    "import('node:fs').then((fs) => { fs.writeFileSync('scan-args.json', JSON.stringify(process.argv.slice(2))); process.stdout.write(process.env.GG_TEST_CHECKER_REPORT + '\\n'); });\n");
  try {
    const run = await runGg(project, ["verify", "--local-checker", "--run-tests"], checker.env);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const args = JSON.parse(await readFile(join(project, "scan-args.json"), "utf8"));
    assert.ok(!args.includes("--check-deps"), `--check-deps 가 남아 있다: ${args.join(" ")}`);
    assert.ok(!args.includes("--deps"), "하네스는 --deps 를 정하지 않는다(체커 기본 local · 기관 GVSKB_DEPS_MODE)");
    assert.ok(args.includes("--include-installed") && args.includes("--fail-on") && args[args.indexOf("--fail-on") + 1] === "block");
  } finally {
    await cleanup(project, checker.directory);
  }
});

test("0.6.0 보다 오래된 체커는 검사하지 않고 incomplete(41) 다", async () => {
  const checker = await fakeChecker({ report: report({ verdict: "approved", reason: "", block_reasons: [] }), version: "0.5.15" });
  const project = await makeProject(checker.env);
  try {
    const run = await runGg(project, ["verify", "--local-checker", "--run-tests"], checker.env);
    assert.equal(run.code, EXIT.CHECKER_INCOMPLETE, run.stdout + run.stderr);
    assert.match(printed(run).checker.reason, /0\.6\.0 이상이 필요합니다\(현재 0\.5\.15\)/);
    assert.equal(await latestReceipt(project, "-checker-evidence.json"), null, "검사를 돌리지 않았으므로 증적도 없다");
    const doctor = await runGg(project, ["doctor"], checker.env);
    assert.equal(doctor.code, EXIT.CHECKER_INCOMPLETE);
    const out = printed(doctor);
    assert.equal(out.checker.status, "version_too_old");
    assert.equal(out.status, "checker_update_required");
  } finally {
    await cleanup(project, checker.directory);
  }
});

test("status 가 없는 체커는 version 출력으로 폴백한다", async () => {
  const checker = await fakeChecker({ report: report({ verdict: "approved", reason: "", block_reasons: [] }), version: "0.6.0", noStatus: true });
  const project = await makeProject(checker.env);
  try {
    const run = await runGg(project, ["verify", "--local-checker", "--run-tests"], checker.env);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const receipt = await latestReceipt(project, "-checker-evidence.json");
    assert.equal(receipt.checker_status_source, "version");
  } finally {
    await cleanup(project, checker.directory);
  }
});

test("doctor 는 위협정보 상태를 보이고 없으면 경고한다", async () => {
  const checker = await fakeChecker({ report: {}, intelState: "missing" });
  const project = await makeProject(checker.env);
  try {
    const doctor = await runGg(project, ["doctor"], checker.env);
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
    const out = printed(doctor);
    assert.equal(out.checker.version, "0.6.1");
    assert.equal(out.checker.intel.state, "missing");
    assert.ok(out.warnings.some((line) => /판정 불가/.test(line)), JSON.stringify(out.warnings));
  } finally {
    await cleanup(project, checker.directory);
  }
});

// ---------------------------------------------------------------------------
// 3. gg package check — 종료코드가 아니라 JSON 으로 나눈다
// ---------------------------------------------------------------------------

async function packageCheck(packageResult) {
  const checker = await fakeChecker({ report: {}, packageResult });
  const project = await makeProject(checker.env);
  try {
    const run = await runGg(project, ["package", "check", "--ecosystem", "npm", "--name", "left-pad", "--version", "1.3.0"], checker.env);
    return { run, out: printed(run), receipt: await latestReceipt(project, "-package-check.json") };
  } finally {
    await cleanup(project, checker.directory);
  }
}

test("package check: checked=false(위협정보 없음)는 차단이 아니라 incomplete(41)", async () => {
  const { run, out, receipt } = await packageCheck({ verdict: "review_required", checked: false, requires_review: true, vulnerability_count: 0, check_mode: "local", exit_code: 1 });
  assert.equal(run.code, EXIT.CHECKER_INCOMPLETE, run.stdout + run.stderr);
  assert.equal(out.status, "incomplete");
  assert.match(out.reason, /판정하지 못했습니다/);
  assert.equal(receipt.check_mode, "local");
  assert.equal(receipt.checker_version, "0.6.1");
});

test("package check: 취약·KEV·악성은 차단(20)", async () => {
  for (const result of [
    { verdict: "vulnerable", checked: true, vulnerability_count: 2, exit_code: 1 },
    { verdict: "ok", checked: true, in_kev: true, exit_code: 2 },
    { verdict: "malicious", checked: true, is_malicious_package: true, exit_code: 2 }
  ]) {
    const { run, out } = await packageCheck(result);
    assert.equal(run.code, EXIT.PACKAGE, JSON.stringify(result) + run.stderr);
    assert.equal(out.status, "blocked");
  }
});

test("package check: 깨끗하면 passed(0), 검토 필요면 review_required(0)", async () => {
  const clean = await packageCheck({ verdict: "ok", checked: true, vulnerability_count: 0, requires_review: false, check_mode: "local", exit_code: 0 });
  assert.equal(clean.run.code, 0, clean.run.stdout + clean.run.stderr);
  assert.equal(clean.out.status, "passed");
  const review = await packageCheck({ verdict: "review_required", checked: true, vulnerability_count: 0, requires_review: true, exit_code: 1 });
  assert.equal(review.run.code, 0, review.run.stdout + review.run.stderr);
  assert.equal(review.out.status, "review_required");
});

// ---------------------------------------------------------------------------
// 4. lock 무결성 — 지문이 없으면 통과가 아니다
// ---------------------------------------------------------------------------

test("lock 에서 지문 필드를 지우면 verify 가 '구버전 lock' 으로 막고 gg update 가 되살린다", async () => {
  const checker = await fakeChecker({ report: report({ verdict: "approved", reason: "", block_reasons: [] }) });
  const project = await makeProject(checker.env);
  try {
    const lockPath = join(project, ".vibecode-harness", "harness.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(lock.checker_machine_verdict, "gate_v1");
    assert.deepEqual(lock.checker_status_by_verdict, CHECKER_STATUS_BY_VERDICT);
    delete lock.checker_evidence_sha256;
    delete lock.policy_engine_sha256;
    await writeFile(lockPath, JSON.stringify(lock, null, 2));
    const blocked = await runGg(project, ["verify", "--run-tests"], checker.env);
    assert.equal(blocked.code, EXIT.POLICY, blocked.stdout + blocked.stderr);
    const failures = printed(blocked).policy_failures.join("\n");
    assert.match(failures, /구버전입니다.*checker_evidence_sha256/);
    assert.match(failures, /구버전입니다.*policy_engine_sha256/);
    // policy_profile 을 손으로 바꿔도 잡힌다.
    lock.policy_profile = "general";
    await writeFile(lockPath, JSON.stringify(lock, null, 2));
    const tampered = await runGg(project, ["verify", "--run-tests"], checker.env);
    assert.match(printed(tampered).policy_failures.join("\n"), /policy_profile\(general\)이 runtime_profile\(typescript_web\)과 맞지 않습니다/);
    lock.policy_profile = "typescript_web";
    await writeFile(lockPath, JSON.stringify(lock, null, 2));
    const update = await runGg(project, ["update"], checker.env);
    assert.equal(update.code, 0, update.stdout + update.stderr);
    const restored = JSON.parse(await readFile(lockPath, "utf8"));
    assert.ok(restored.checker_evidence_sha256 && restored.policy_engine_sha256);
    const ok = await runGg(project, ["verify", "--run-tests"], checker.env);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  } finally {
    await cleanup(project, checker.directory);
  }
});

// ---------------------------------------------------------------------------
// 5. Claude 훅 matcher — 옛 등록은 migrated 로 넓힌다
// ---------------------------------------------------------------------------

test("옛 matcher(Write|Edit|MultiEdit|Bash) 로 남은 등록은 gg update 가 넓힌다", async () => {
  const checker = await fakeChecker({ report: {} });
  const project = await makeProject(checker.env, { tools: "claude" });
  try {
    const settingsPath = join(project, ".claude", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.hooks.PreToolUse[0].matcher, "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell");
    settings.hooks.PreToolUse[0].matcher = "Write|Edit|MultiEdit|Bash";
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
    const update = await runGg(project, ["update"], checker.env);
    assert.equal(update.code, 0, update.stdout + update.stderr);
    assert.equal(printed(update).claude_hook, "migrated");
    const after = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(after.hooks.PreToolUse[0].matcher, "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell");
    const again = await runGg(project, ["update"], checker.env);
    assert.equal(printed(again).claude_hook, "already_configured");
  } finally {
    await cleanup(project, checker.directory);
  }
});

// ---------------------------------------------------------------------------
// 6. 47차 적대적 리뷰 반영 — 실측 케이스
// ---------------------------------------------------------------------------

test("M2: verdict blocked 는 파일 상한·의존성 미파싱 같은 미완 사유가 있어도 40 이다", async () => {
  const checker = await fakeChecker({ report: report({ verdict: "blocked", reason: "KEV", block_reasons: [{ package: "kevpkg" }], conditional_criteria: [], intel_gap: "" }, {
    skipped_files: [{ path: "x.ts", reason: "max_files=1 초과" }],
    dependency_audit: { audits: [{ verdict: "unparsed", requires_review: true, parsed_count: 0 }] }
  }), scanExit: 2 });
  const project = await makeProject(checker.env);
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "x", private: true, type: "module", scripts: { test: "node --test" }, dependencies: { zod: "3.24.0" } }));
  try {
    const run = await runGg(project, ["verify", "--local-checker", "--run-tests"], checker.env);
    assert.equal(run.code, EXIT.CHECKER_BLOCK, run.stdout + run.stderr);
    assert.equal(printed(run).status, "blocked");
    const receipt = await latestReceipt(project, "-checker-evidence.json");
    assert.equal(receipt.checker_status, "blocked");
    // 2차 리뷰 L2 — 차단을 먼저 내되 범위 결손 사유는 영수증에 남는다.
    assert.deepEqual(receipt.coverage_incomplete_reasons, ["file_limit_truncated", "dependency_audit_unparsed"]);
  } finally {
    await cleanup(project, checker.directory);
  }
});

test("2차 리뷰 M4: 하네스 Git 훅이 설치됐는데 core.hooksPath 가 풀리면 verify 가 막는다", async () => {
  const checker = await fakeChecker({ report: report({ verdict: "approved", reason: "", block_reasons: [], conditional_criteria: [], intel_gap: "" }) });
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-hookspath-"));
  const git = (args) => new Promise((resolvePromise) => {
    const child = spawn("git", args, { cwd: project, shell: false, windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout }));
  });
  try {
    const initGit = await git(["init", "-q"]);
    if (initGit.code !== 0) return; // git 이 없는 환경 — 이 검사는 해당 없음
    const init = await runGg(project, ["init", "--tools", "codex", "--runtime", "typescript_web", "--level", "L1"], checker.env);
    assert.equal(init.code, 0, init.stderr || init.stdout);
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "hp", private: true, type: "module", scripts: { test: "node --test" } }));
    await writeFile(join(project, "app.ts"), "export const ok = true;\n");
    assert.equal((await git(["config", "--get", "core.hooksPath"])).stdout.trim(), ".githooks");
    const before = await runGg(project, ["verify", "--no-tests"], checker.env);
    assert.equal(before.code, 0, before.stdout + before.stderr);
    await git(["config", "--unset", "core.hooksPath"]);
    const after = await runGg(project, ["verify", "--no-tests"], checker.env);
    assert.equal(after.code, EXIT.POLICY, after.stdout + after.stderr);
    assert.match(printed(after).policy_failures.join("\n"), /core\.hooksPath/);
  } finally {
    await cleanup(project, checker.directory);
  }
});

test("L3·L5: 패키지 검사 생략(mode=off)과 비판정 종료코드(64·66)는 incomplete 다", async () => {
  const off = await fakeChecker({ report: report({ verdict: "approved", reason: "", block_reasons: [], conditional_criteria: [], intel_gap: "" }, { dependency_check: { mode: "off", packages_parsed: 0, intel: null } }) });
  const offProject = await makeProject(off.env);
  try {
    const run = await runGg(offProject, ["verify", "--local-checker", "--run-tests"], off.env);
    assert.equal(run.code, EXIT.CHECKER_INCOMPLETE, run.stdout + run.stderr);
    assert.match(printed(run).checker.reason, /mode=off/);
  } finally {
    await cleanup(offProject, off.directory);
  }
  const usage = await fakeChecker({ report: report({ verdict: "approved", reason: "", block_reasons: [] }), scanExit: 64 });
  const usageProject = await makeProject(usage.env);
  try {
    const run = await runGg(usageProject, ["verify", "--local-checker", "--run-tests"], usage.env);
    assert.equal(run.code, EXIT.CHECKER_INCOMPLETE, run.stdout + run.stderr);
    assert.match(printed(run).checker.reason, /종료코드 64/);
    assert.equal(await latestReceipt(usageProject, "-checker-evidence.json"), null);
  } finally {
    await cleanup(usageProject, usage.directory);
  }
});

test("M5: package check 는 종료코드와 교차 확인한다 — JSON 통과·종료 2 는 차단, 충돌 기록", async () => {
  const { run, out, receipt } = await packageCheck({ verdict: "ok", checked: true, vulnerability_count: 0, requires_review: false, exit_code: 2 });
  assert.equal(run.code, EXIT.PACKAGE, run.stdout + run.stderr);
  assert.equal(out.status, "blocked");
  assert.deepEqual(receipt.checker_exit_conflict, { exit_code: 2, json_status: "passed" });
  // 취약(JSON)·종료 1 은 정상 조합 — 충돌 아님. severity 는 영수증에 남는다.
  const vulnerable = await packageCheck({ verdict: "vulnerable", verdict_severity: "high", checked: true, vulnerability_count: 1, exit_code: 1 });
  assert.equal(vulnerable.receipt.checker_exit_conflict, null);
  assert.equal(vulnerable.receipt.severity, "high");
  const suspicious = await packageCheck({ verdict: "suspicious_name", verdict_severity: "medium", checked: true, vulnerability_count: 0, requires_review: true, exit_code: 1 });
  assert.equal(suspicious.out.status, "review_required");
  assert.equal(suspicious.receipt.severity, "medium");
});

test("H4: checker_env 는 GVSKB_* 만 받고, 지문이 깨진 사본의 env 는 doctor 가 쓰지 않는다", async () => {
  const checker = await fakeChecker({ report: report({ verdict: "approved", reason: "", block_reasons: [], conditional_criteria: [], intel_gap: "" }) });
  const project = await makeProject(checker.env);
  // 가짜 status 가 받은 환경변수를 되돌려 주게 한다.
  await writeFile(join(project, "status"), "process.stdout.write(JSON.stringify({ version: '0.6.1', intel: { state: 'ok' }, install_identity: { commit_id: process.env.PYTHONPATH || process.env.GVSKB_MODE || 'none' } }) + '\\n');\n");
  try {
    const profilePath = join(project, ".vibecode-harness", "policy", "institution-profile.yaml");
    const original = await readFile(profilePath, "utf8");
    // 사본을 변조해 PYTHONPATH 와 GVSKB_MODE 를 넣는다 → 지문 불일치.
    await writeFile(profilePath, original.replace("checker_env: {}", "checker_env:\n    PYTHONPATH: C:/evil\n    GVSKB_MODE: offline"));
    const doctor = await runGg(project, ["doctor"], checker.env);
    const out = printed(doctor);
    assert.ok(out.policy_failures.some((line) => /기관 프로파일이 초기화 이후 변경/.test(line)), JSON.stringify(out.policy_failures));
    assert.equal(out.checker.checker_env_source, "harness_default", "지문이 깨진 사본의 env 는 쓰지 않는다");
    assert.deepEqual(out.checker.checker_env, {});
    assert.equal(out.checker.commit, "none", "변조된 PYTHONPATH·GVSKB_MODE 가 체커에 전달되면 안 된다");
    assert.ok(out.warnings.some((line) => /checker_env 를 적용하지 않았습니다/.test(line)), JSON.stringify(out.warnings));
    const verify = await runGg(project, ["verify", "--local-checker", "--run-tests"], checker.env);
    assert.equal(verify.code, EXIT.POLICY, "지문이 깨졌으므로 verify 는 정책 단계에서 막힌다");
    await writeFile(profilePath, original);
    const ok = await runGg(project, ["doctor"], checker.env);
    assert.equal(printed(ok).checker.checker_env_source, "project_snapshot");
  } finally {
    await cleanup(project, checker.directory);
  }
});

test("M6: checker_env 인라인 맵·허용되지 않은 키는 조용히 비우지 않고 incomplete/경고다", async () => {
  const checker = await fakeChecker({ report: report({ verdict: "approved", reason: "", block_reasons: [], conditional_criteria: [], intel_gap: "" }) });
  const project = await makeProject(checker.env);
  try {
    const profilePath = join(project, ".vibecode-harness", "policy", "institution-profile.yaml");
    const lockPath = join(project, ".vibecode-harness", "harness.lock.json");
    const original = await readFile(profilePath, "utf8");
    const rehash = async () => {
      const { createHash } = await import("node:crypto");
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      lock.institution_profile_sha256 = createHash("sha256").update(await readFile(profilePath)).digest("hex");
      await writeFile(lockPath, JSON.stringify(lock, null, 2));
    };
    await writeFile(profilePath, original.replace("checker_env: {}", "checker_env: { GVSKB_MODE: offline }"));
    await rehash(); // 기관이 배포한 프로파일이 인라인 맵이었다고 가정(지문은 맞음)
    const verify = await runGg(project, ["verify", "--local-checker", "--run-tests"], checker.env);
    assert.equal(verify.code, EXIT.CHECKER_INCOMPLETE, verify.stdout + verify.stderr);
    assert.match(printed(verify).checker.reason, /인라인 맵/);
    const doctor = await runGg(project, ["doctor"], checker.env);
    assert.ok(printed(doctor).warnings.some((line) => /인라인 맵/.test(line)));
    // 허용되지 않은 키(PYTHONPATH)는 거부 사유가 된다.
    await writeFile(profilePath, original.replace("checker_env: {}", "checker_env:\n    PYTHONPATH: C:/evil"));
    await rehash();
    const rejected = await runGg(project, ["verify", "--local-checker", "--run-tests"], checker.env);
    assert.equal(rejected.code, EXIT.CHECKER_INCOMPLETE);
    assert.match(printed(rejected).checker.reason, /허용되지 않은 키.*PYTHONPATH/);
    // 큰따옴표 값은 이스케이프가 풀리고, 허용된 블록은 그대로 적용된다.
    const unc = BSLASH + BSLASH + "fileserver" + BSLASH + "gvskb-intel";
    await writeFile(profilePath, original.replace("checker_env: {}", "checker_env:\n    GVSKB_INTEL_DIR: " + JSON.stringify(unc) + "\n    GVSKB_MODE: offline"));
    await rehash();
    const ok = await runGg(project, ["doctor"], checker.env);
    assert.deepEqual(printed(ok).checker.checker_env, { GVSKB_INTEL_DIR: unc, GVSKB_MODE: "offline" });
  } finally {
    await cleanup(project, checker.directory);
  }
});

test("M1: settings.json 에서 훅 등록을 지우거나 matcher 를 좁히면 verify 가 막고 doctor 는 update_required 다", async () => {
  const checker = await fakeChecker({ report: report({ verdict: "approved", reason: "", block_reasons: [], conditional_criteria: [], intel_gap: "" }) });
  const project = await makeProject(checker.env, { tools: "claude" });
  try {
    const settingsPath = join(project, ".claude", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.hooks.PreToolUse[0].matcher = "Write|Edit|MultiEdit|Bash";
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
    const narrowed = await runGg(project, ["verify", "--run-tests"], checker.env);
    assert.equal(narrowed.code, EXIT.POLICY, narrowed.stdout + narrowed.stderr);
    assert.match(printed(narrowed).policy_failures.join("\n"), /훅 등록.*구형/);
    assert.equal(printed(await runGg(project, ["doctor"], checker.env)).adapters.claude_code, "update_required");
    await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2));
    const removed = await runGg(project, ["verify", "--run-tests"], checker.env);
    assert.equal(removed.code, EXIT.POLICY);
    assert.match(printed(removed).policy_failures.join("\n"), /훅 등록.*없거나 구형/);
    const update = await runGg(project, ["update"], checker.env);
    assert.equal(update.code, 0, update.stdout + update.stderr);
    const restored = await runGg(project, ["verify", "--run-tests"], checker.env);
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
  } finally {
    await cleanup(project, checker.directory);
  }
});

test("M10: 옛 등록이 둘이거나 혼합 항목과 현행이 공존해도 우리 훅은 한 번만 남는다", async () => {
  const checker = await fakeChecker({ report: {} });
  const project = await makeProject(checker.env, { tools: "claude" });
  try {
    const settingsPath = join(project, ".claude", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const current = settings.hooks.PreToolUse[0];
    const legacy = { matcher: "Write|Edit|MultiEdit|Bash", hooks: [{ type: "command", command: "node .vibecode-harness/bin/claude-pre-tool.mjs" }] };
    const mixed = { matcher: "Bash", hooks: [{ type: "command", command: "echo other" }, { type: "command", command: "node .vibecode-harness/bin/claude-pre-tool.mjs" }] };
    settings.hooks.PreToolUse = [legacy, mixed, current, JSON.parse(JSON.stringify(legacy))];
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
    const update = await runGg(project, ["update"], checker.env);
    assert.equal(update.code, 0, update.stdout + update.stderr);
    const after = JSON.parse(await readFile(settingsPath, "utf8"));
    const ours = after.hooks.PreToolUse.flatMap((entry) => entry.hooks.filter((hook) => JSON.stringify(hook).includes("claude-pre-tool.mjs")));
    assert.equal(ours.length, 1, JSON.stringify(after.hooks.PreToolUse));
    assert.ok(after.hooks.PreToolUse.some((entry) => entry.matcher === "Bash" && entry.hooks.some((hook) => hook.command === "echo other")), "남의 훅은 보존된다");
    assert.ok(after.hooks.PreToolUse.some((entry) => entry.matcher === "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell"));
  } finally {
    await cleanup(project, checker.directory);
  }
});

test("L8: policy_profile 이 어긋난 lock 은 gg update 가 복구한다(migrate 는 같은 트랙이면 unchanged)", async () => {
  const checker = await fakeChecker({ report: {} });
  const project = await makeProject(checker.env);
  try {
    const lockPath = join(project, ".vibecode-harness", "harness.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.policy_profile = "general";
    await writeFile(lockPath, JSON.stringify(lock, null, 2));
    const migrate = await runGg(project, ["migrate", "--runtime", "typescript_web"], checker.env);
    assert.equal(printed(migrate).status, "unchanged");
    const update = await runGg(project, ["update"], checker.env);
    assert.equal(update.code, 0, update.stdout + update.stderr);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).policy_profile, "typescript_web");
    assert.equal((await runGg(project, ["verify", "--run-tests"], checker.env)).code, 0);
  } finally {
    await cleanup(project, checker.directory);
  }
});
