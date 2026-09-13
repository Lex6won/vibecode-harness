#!/usr/bin/env node
/**
 * 시험운영 E2E — 하네스가 스스로 확인할 수 있는 것만, 임시 폴더에서만.
 *
 * 실행: `node scripts/pilot-e2e.mjs`
 * 결과: 한국어 표를 출력하고, 실패가 하나라도 있으면 0 이 아닌 코드로 끝난다.
 *
 * 왜 이 스크립트인가: 서버 설치 전 "하네스가 정책을 실제로 강제하는가"를 사람이
 * 손으로 재현하다 보면 매번 다른 폴더·다른 도구 조합으로 확인하게 되고, 그 결과는
 * 남지 않는다. 여기서는 **실제 CLI 와 실제 정책 엔진**을 그대로 써서 같은 시나리오를
 * 같은 순서로 돌린다. `bin/gg.mjs` 는 import 시점에 main() 을 실행하므로 내부 함수
 * (runStandardTests 등)를 직접 부를 수 없다 — 그래서 CLI 를 자식 프로세스로 띄우고
 * 그 출력(JSON)을 판정 근거로 삼는다. 정책 엔진(lib/policy-engine.mjs)은 import 한다.
 *
 * 절대 지키는 것:
 *   - os.tmpdir() 아래 새 폴더에서만 동작한다. 실제 사용자 폴더는 읽지도 쓰지도 않는다.
 *   - 확인하지 못한 항목은 통과로 적지 않는다. pytest 가 없으면 그 축은 "미검증"이다.
 *   - 하네스 혼자 확인할 수 없는 것(포털 판정 동일성, 보고서 이름 충돌, 재시작 지속성,
 *     체커 부재 시 설치 차단)은 "포털 측 테스트에서 검증: <스크립트>" 로만 적는다.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isDirectPackageInstall, languageFailureForPath, runtimeFailureForCommand } from "../lib/policy-engine.mjs";

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GG = join(HARNESS_ROOT, "bin", "gg.mjs");
const CLAUDE_HOOK = join(HARNESS_ROOT, "bin", "claude-pre-tool.mjs");

const SUPPORTED_TOOLS = Object.freeze(["codex", "claude-code", "claude-desktop", "chatgpt-codex-desktop", "lovable-github"]);
const ALLOWED_EXTENSIONS = Object.freeze([".py", ".js", ".jsx", ".ts", ".tsx"]);
const BLOCKED_EXTENSIONS = Object.freeze([".go", ".java", ".cs", ".rb", ".php", ".rs"]);

/**
 * 도구별 강제 지점. 표에 그대로 찍는다 — "모든 도구가 파일 생성 전에 막는다"고
 * 말하지 않기 위해서다. 모든 도구의 공통 최종 강제 지점은 Git/PR/CI 다.
 */
const ENFORCEMENT_POINTS = Object.freeze([
  { tool: "codex", point: "프로젝트 지침(AGENTS.md) + Git 훅 + gg verify", before_file_creation: "아니오" },
  { tool: "claude-code", point: "작업 전 훅(PreToolUse) — 파일 생성 전 차단", before_file_creation: "예" },
  { tool: "claude-desktop", point: "프로젝트 안내 + Git 훅/CI", before_file_creation: "아니오" },
  { tool: "chatgpt-codex-desktop", point: "프로젝트 안내 + Git 훅/CI", before_file_creation: "아니오" },
  { tool: "lovable-github", point: "VIBECODE-LOVABLE.md 안내 + GitHub PR/CI 워크플로(유일한 강제 지점)", before_file_creation: "아니오" }
]);

/** 하네스 혼자서는 확인할 수 없어 포털 저장소의 테스트에 맡기는 항목. */
const PORTAL_SIDE_ITEMS = Object.freeze([
  { item: "포털 판정과 로컬 판정의 동일성", script: "scripts/portal-scenario-test.mjs" },
  { item: "보고서 이름 충돌 방지", script: "scripts/report-naming-test.mjs" },
  { item: "재시작 후 상태 지속성", script: "scripts/portal-scenario-test.mjs" },
  { item: "체커 부재 시 패키지 설치 차단", script: "scripts/package-gate-smoke-test.mjs" }
]);

const STATUS = Object.freeze({ PASS: "통과", FAIL: "실패", UNVERIFIED: "미검증", PORTAL: "포털측", INFO: "정보" });

function runProcess(command, args, { cwd, env, input } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env: env ?? process.env, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolvePromise({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function parseJsonOutput(stdout) {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try { return JSON.parse(stdout.slice(start)); } catch { return null; }
}

/**
 * pytest 를 가진 인터프리터를 찾는다. 없으면 null — PyPI 축 항목은 미검증으로 남긴다.
 * (tests/standard-test-axes.test.mjs 와 같은 방식.)
 */
function interpreterWithPytest() {
  const probeCommand = process.platform === "win32" ? "where.exe" : "which";
  const listed = spawnSync(probeCommand, ["python"], { encoding: "utf8" });
  if (listed.status !== 0) return null;
  for (const candidate of listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["-m", "pytest", "--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/**
 * 하네스의 pythonCommand() 가 설치 디렉터리보다 PATH 를 먼저 보게 만든다.
 * 이 PC 의 어느 Python 에 pytest 가 있느냐로 결과가 갈리면 안 된다.
 */
function harnessEnvironment(sandbox, interpreter) {
  const empty = join(sandbox, "no-python-installs");
  const env = { ...process.env, LOCALAPPDATA: empty, ProgramFiles: empty, "ProgramFiles(x86)": empty };
  delete env.NODE_TEST_CONTEXT;
  if (interpreter) {
    const pathValue = `${dirname(interpreter)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || process.env.Path || ""}`;
    env.PATH = pathValue;
    env.Path = pathValue;
  }
  return { empty, env };
}

const NODE_TEST_SOURCE = (passes) => `import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

test("npm axis", () => {
  appendFileSync("runs-node.log", "run\\n");
  assert.equal(1 + 1, ${passes ? 2 : 3});
});
`;

const PYTEST_SOURCE = (passes) => `def test_pypi_axis():
    with open("runs-pypi.log", "a", encoding="utf-8") as handle:
        handle.write("run\\n")
    assert 1 + 1 == ${passes ? 2 : 3}
`;

async function runCount(project, name) {
  const path = join(project, name);
  if (!existsSync(path)) return 0;
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).length;
}

async function removeWithRetry(directory) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await rm(directory, { recursive: true, force: true }); return; }
    catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) || attempt === 5) return;
      await delay(100 * (attempt + 1));
    }
  }
}

class Report {
  constructor() { this.rows = []; }
  add(section, item, status, note = "") { this.rows.push({ section, item, status, note }); }
  pass(section, item, note) { this.add(section, item, STATUS.PASS, note); }
  fail(section, item, note) { this.add(section, item, STATUS.FAIL, note); }
  unverified(section, item, note) { this.add(section, item, STATUS.UNVERIFIED, note); }
  check(section, item, condition, note) { if (condition) this.pass(section, item, note); else this.fail(section, item, note); }
  count(status) { return this.rows.filter((row) => row.status === status).length; }
}

/** 표 한 줄. 한글 폭 계산은 하지 않는다 — 구분자만 맞추면 읽는 데 지장이 없다. */
function renderTable(rows, columns) {
  const lines = [`| ${columns.map((column) => column.label).join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`];
  for (const row of rows) lines.push(`| ${columns.map((column) => String(row[column.key] ?? "")).join(" | ")} |`);
  return lines.join("\n");
}

/**
 * 임시 프로젝트를 만든다. 모든 경로는 sandbox 아래여야 한다 — 아니면 즉시 던진다.
 * @param {{ node?: boolean, nodePasses?: boolean, python?: boolean, pythonPasses?: boolean, forbidden?: boolean }} shape
 */
async function createProject(sandbox, name, shape, env) {
  const project = join(sandbox, name);
  if (!resolve(project).startsWith(resolve(sandbox))) throw new Error(`샌드박스 밖 경로: ${project}`);
  await mkdir(project, { recursive: true });
  const init = await runProcess(process.execPath, [GG, "init", "--project", project, "--tools", "all", "--runtime", "gg_standard", "--level", "L1"], { env });
  if (init.code !== 0) throw new Error(`gg init 실패 (${name}): ${init.stderr || init.stdout}`);
  await mkdir(join(project, "tests"), { recursive: true });
  if (shape.node) {
    await writeFile(join(project, "package.json"), JSON.stringify({ name, private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
    await writeFile(join(project, "app.js"), "export const add = (a, b) => a + b;\n");
    await writeFile(join(project, "tests", "app.test.js"), NODE_TEST_SOURCE(shape.nodePasses !== false));
  }
  if (shape.python) {
    await writeFile(join(project, "app.py"), "def add(a, b):\n    return a + b\n");
    await writeFile(join(project, "pyproject.toml"), `[project]\nname = "${name}"\nversion = "0.0.0"\n`);
    await writeFile(join(project, "tests", "test_app.py"), PYTEST_SOURCE(shape.pythonPasses !== false));
  }
  if (shape.forbidden) {
    await writeFile(join(project, "app.py"), "def ok():\n    return True\n");
    await writeFile(join(project, "main.go"), "package main\n");
    await writeFile(join(project, "App.java"), "class App {}\n");
    await writeFile(join(project, "Program.cs"), "class Program {}\n");
    await writeFile(join(project, "app.rb"), "puts 1\n");
    await writeFile(join(project, "index.php"), "<?php echo 1;\n");
    await writeFile(join(project, "lib.rs"), "fn main() {}\n");
  }
  return project;
}

async function callClaudeHook(project, toolInput, env) {
  const payload = JSON.stringify({ tool_name: toolInput.command ? "Bash" : "Write", tool_input: toolInput, cwd: project });
  return runProcess(process.execPath, [CLAUDE_HOOK], { cwd: project, env, input: payload });
}

async function findFilesMatching(root, pattern) {
  const hits = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (pattern.test(entry.name)) hits.push(relative(root, path));
      if (entry.isDirectory() && entry.name !== "node_modules") await walk(path);
    }
  }
  await walk(root);
  return hits;
}

export async function main({ log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const report = new Report();
  const sandbox = await mkdtemp(join(tmpdir(), "vibecode-pilot-e2e-"));
  const interpreter = interpreterWithPytest();
  const { empty, env } = harnessEnvironment(sandbox, interpreter);
  await mkdir(empty, { recursive: true });
  const startedAt = new Date();

  try {
    // ------------------------------------------------------------------
    // 1. 언어 정책 — 정책 엔진 직접 호출
    // ------------------------------------------------------------------
    for (const extension of ALLOWED_EXTENSIONS) {
      const failure = languageFailureForPath("gg_standard", `src/app${extension}`);
      report.check("언어 정책(엔진)", `${extension} 허용`, failure === null, failure || "gg_standard 허용 확장자");
    }
    for (const extension of BLOCKED_EXTENSIONS) {
      const failure = languageFailureForPath("gg_standard", `src/app${extension}`);
      report.check("언어 정책(엔진)", `${extension} 차단`, typeof failure === "string" && failure.length > 0, failure || "차단 메시지가 없다");
    }

    // ------------------------------------------------------------------
    // 2. 임시 프로젝트 생성 (Python 전용 · Node 전용 · 혼합 · 금지 언어 포함)
    // ------------------------------------------------------------------
    const pythonOnly = await createProject(sandbox, "python-only", { python: true }, env);
    const nodeOnly = await createProject(sandbox, "node-only", { node: true }, env);
    const mixed = await createProject(sandbox, "mixed", { node: true, python: true }, env);
    const mixedFailing = await createProject(sandbox, "mixed-failing", { node: true, python: true, pythonPasses: false }, env);
    const forbidden = await createProject(sandbox, "forbidden-languages", { forbidden: true }, env);
    report.pass("프로젝트 생성", "임시 프로젝트 5개 gg init (gg_standard, --tools all)", sandbox);

    // ------------------------------------------------------------------
    // 3. 언어 정책 — 실제 CLI 판정 (gg build 는 policyCheck 를 그대로 쓴다)
    // ------------------------------------------------------------------
    const forbiddenBuild = await runProcess(process.execPath, [GG, "build", "--project", forbidden], { env });
    const forbiddenVerdict = parseJsonOutput(forbiddenBuild.stdout);
    const forbiddenFailures = (forbiddenVerdict?.failures || []).join("\n");
    report.check("언어 정책(CLI)", "금지 언어 파일이 있는 프로젝트는 gg build 가 차단(exit 10)", forbiddenBuild.code === 10, `exit=${forbiddenBuild.code}`);
    for (const file of ["main.go", "App.java", "Program.cs", "app.rb", "index.php", "lib.rs"]) {
      report.check("언어 정책(CLI)", `차단 사유에 ${file} 명시`, forbiddenFailures.includes(file), "");
    }
    const allowedBuild = await runProcess(process.execPath, [GG, "build", "--project", mixed], { env });
    report.check("언어 정책(CLI)", "허용 언어(.py + .js)만 있는 혼합 프로젝트는 gg build 통과", allowedBuild.code === 0, `exit=${allowedBuild.code} ${(parseJsonOutput(allowedBuild.stdout)?.failures || []).join("; ")}`);

    // ------------------------------------------------------------------
    // 4. Claude Code 작업 전 훅 — 파일 생성 전 차단 (exit 2 만 차단이다)
    // ------------------------------------------------------------------
    const hookGo = await callClaudeHook(mixed, { file_path: join(mixed, "service.go") }, env);
    report.check("Claude 훅", "service.go 쓰기 → exit 2 로 차단", hookGo.code === 2, hookGo.stderr.trim().split("\n")[0] || "");
    const hookTs = await callClaudeHook(mixed, { file_path: join(mixed, "service.ts") }, env);
    report.check("Claude 훅", "service.ts 쓰기 → 통과(exit 0)", hookTs.code === 0, hookTs.stderr.trim());
    const hookPy = await callClaudeHook(mixed, { file_path: join(mixed, "service.py") }, env);
    report.check("Claude 훅", "service.py 쓰기 → 통과(exit 0)", hookPy.code === 0, hookPy.stderr.trim());

    // ------------------------------------------------------------------
    // 5. 테스트 축 — gg_standard 는 npm 과 pytest 를 각각 정확히 한 번 돌린다
    // ------------------------------------------------------------------
    const pytestNote = interpreter ? `pytest 인터프리터: ${interpreter}` : "pytest 를 가진 Python 인터프리터를 찾지 못했다";
    async function verifyAxes(project) {
      const result = await runProcess(process.execPath, [GG, "verify", "--project", project, "--run-tests"], { env, cwd: project });
      const verdict = parseJsonOutput(result.stdout);
      const axis = (name) => (verdict?.test?.axes || []).find((item) => item.axis === name) || {};
      return { result, verdict, axis, node: await runCount(project, "runs-node.log"), pypi: await runCount(project, "runs-pypi.log") };
    }
    const runtimeBlocked = (verdict) => (verdict?.runtime_failures || []).some((item) => /Python/.test(item));

    // Node 전용: Python 인터프리터 자체가 없으면 gg_standard 의 runtimeCheck 가 막는다 — 그때는 미검증.
    const nodeRun = await verifyAxes(nodeOnly);
    if (runtimeBlocked(nodeRun.verdict)) {
      report.unverified("테스트 축", "Node 전용: npm 축 1회 실행·통과", "Python 런타임이 없어 gg_standard runtimeCheck 에서 멈춤");
    } else {
      report.check("테스트 축", "Node 전용: npm 축 1회 실행·통과", nodeRun.axis("npm").status === "passed" && nodeRun.node === 1, `npm=${nodeRun.axis("npm").status} 실행횟수=${nodeRun.node}`);
      report.check("테스트 축", "Node 전용: PyPI 축은 not_configured 로 기록", nodeRun.axis("pypi").status === "not_configured" && nodeRun.pypi === 0, `pypi=${nodeRun.axis("pypi").status}`);
    }

    if (!interpreter) {
      report.unverified("테스트 축", "Python 전용: PyPI 축 1회 실행·통과", pytestNote);
      report.unverified("테스트 축", "혼합: npm 1회 + pytest 1회, 전체 통과", pytestNote);
      report.unverified("테스트 축", "혼합: pytest 실패 시 전체 실패(exit 30)", pytestNote);
    } else {
      const pythonRun = await verifyAxes(pythonOnly);
      report.check("테스트 축", "Python 전용: PyPI 축 1회 실행·통과", pythonRun.axis("pypi").status === "passed" && pythonRun.pypi === 1, `pypi=${pythonRun.axis("pypi").status} 실행횟수=${pythonRun.pypi} · ${pytestNote}`);
      report.check("테스트 축", "Python 전용: npm 축은 not_configured 로 기록", pythonRun.axis("npm").status === "not_configured" && pythonRun.node === 0, `npm=${pythonRun.axis("npm").status}`);

      const mixedRun = await verifyAxes(mixed);
      report.check("테스트 축", "혼합: npm 1회 + pytest 1회, 전체 통과", mixedRun.verdict?.test?.status === "passed" && mixedRun.node === 1 && mixedRun.pypi === 1, `status=${mixedRun.verdict?.test?.status} npm실행=${mixedRun.node} pytest실행=${mixedRun.pypi}`);

      const failingRun = await verifyAxes(mixedFailing);
      report.check("테스트 축", "혼합: pytest 실패 시 전체 실패(exit 30)", failingRun.result.code === 30 && failingRun.axis("npm").status === "passed" && failingRun.axis("pypi").status === "failed" && failingRun.verdict?.status === "blocked", `exit=${failingRun.result.code} npm=${failingRun.axis("npm").status} pypi=${failingRun.axis("pypi").status}`);
      report.check("테스트 축", "혼합 실패에서도 두 축 모두 정확히 1회 실행", failingRun.node === 1 && failingRun.pypi === 1, `npm실행=${failingRun.node} pytest실행=${failingRun.pypi}`);
    }

    // ------------------------------------------------------------------
    // 6. 패키지 설치 정책 — 직접 설치는 막고 승인 래퍼는 통과
    // ------------------------------------------------------------------
    const directInstalls = ["pip install requests", "npm install left-pad", "python -m pip install requests", "bash -c \"pip install requests\""];
    for (const command of directInstalls) report.check("패키지 정책(엔진)", `직접 설치 차단: ${command}`, isDirectPackageInstall(command), "");
    const approvedWrappers = [
      "gg package check --ecosystem npm --name left-pad --version 1.3.0",
      "node .vibecode-harness/bin/gg.mjs package check --ecosystem pypi --name requests --version 2.32.0",
      "npm test",
      "python -m pytest -q"
    ];
    for (const command of approvedWrappers) {
      report.check("패키지 정책(엔진)", `승인 래퍼 통과: ${command}`, !isDirectPackageInstall(command) && runtimeFailureForCommand("gg_standard", command) === null, "");
    }
    const hookPip = await callClaudeHook(mixed, { command: "pip install requests" }, env);
    report.check("패키지 정책(훅)", "Bash 'pip install requests' → exit 2 로 차단", hookPip.code === 2, hookPip.stderr.trim().split("\n")[0] || "");
    const hookNpm = await callClaudeHook(mixed, { command: "npm install left-pad" }, env);
    report.check("패키지 정책(훅)", "Bash 'npm install left-pad' → exit 2 로 차단", hookNpm.code === 2, hookNpm.stderr.trim().split("\n")[0] || "");
    const hookWrapper = await callClaudeHook(mixed, { command: "gg package check --ecosystem npm --name left-pad --version 1.3.0" }, env);
    report.check("패키지 정책(훅)", "Bash 'gg package check …' → 통과(exit 0)", hookWrapper.code === 0, hookWrapper.stderr.trim());

    // ------------------------------------------------------------------
    // 7. 안티그래비티 부재 — gg init --tools all 이 만든 것 전부
    // ------------------------------------------------------------------
    const lockText = await readFile(join(mixed, ".vibecode-harness", "harness.lock.json"), "utf8");
    const lock = JSON.parse(lockText);
    report.check("지원 도구", "lock.tools 가 정확히 다섯 도구", JSON.stringify(lock.tools) === JSON.stringify(SUPPORTED_TOOLS), lock.tools.join(", "));
    report.check("지원 도구", "lock 에 antigravity 키 없음", !Object.hasOwn(lock, "antigravity_hook_sha256") && !Object.hasOwn(lock.managed_adapters || {}, "antigravity_plugin") && !/antigravity/i.test(lockText), "");
    const antigravityFiles = await findFilesMatching(mixed, /antigravity/i);
    report.check("지원 도구", "프로젝트에 antigravity 이름의 파일·폴더 없음", antigravityFiles.length === 0 && !existsSync(join(mixed, ".agents")), antigravityFiles.join(", "));

    // ------------------------------------------------------------------
    // 8. 도구별 강제 지점 (정보) · 9. 포털 측 검증 항목
    // ------------------------------------------------------------------
    for (const entry of ENFORCEMENT_POINTS) report.add("강제 지점", entry.tool, STATUS.INFO, `${entry.point} · 파일 생성 전 차단: ${entry.before_file_creation}`);
    for (const entry of PORTAL_SIDE_ITEMS) report.add("포털 측", entry.item, STATUS.PORTAL, `포털 측 테스트에서 검증: ${entry.script}`);
  } catch (error) {
    report.fail("실행", "스크립트 자체 오류", error instanceof Error ? error.message : String(error));
  } finally {
    await removeWithRetry(sandbox);
  }

  // ------------------------------------------------------------------
  // 출력
  // ------------------------------------------------------------------
  log("# 바이브코드 하네스 시험운영 E2E 결과");
  log("");
  log(`- 실행 시각: ${startedAt.toISOString()}`);
  log(`- 샌드박스: ${sandbox} (실행 후 삭제)`);
  log(`- Node: ${process.version} · pytest 인터프리터: ${interpreter || "없음(해당 축 미검증)"}`);
  log("");
  log(renderTable(report.rows, [
    { key: "section", label: "구분" }, { key: "item", label: "항목" }, { key: "status", label: "결과" }, { key: "note", label: "비고" }
  ]));
  log("");
  log("## 도구별 강제 지점");
  log("");
  log(renderTable(ENFORCEMENT_POINTS, [
    { key: "tool", label: "도구" }, { key: "point", label: "강제 지점" }, { key: "before_file_creation", label: "파일 생성 전 차단" }
  ]));
  log("");
  log("모든 도구의 공통 최종 강제 지점은 Git 훅 / PR / CI 다. 파일 생성 전에 막는 도구는 Claude Code 뿐이다.");
  log("");
  log("## 포털 측 테스트에서 검증하는 항목");
  log("");
  for (const entry of PORTAL_SIDE_ITEMS) log(`- ${entry.item}: 포털 측 테스트에서 검증: ${entry.script}`);
  log("");
  const summary = `통과: ${report.count(STATUS.PASS)} · 실패: ${report.count(STATUS.FAIL)} · 미검증: ${report.count(STATUS.UNVERIFIED)} · 포털측: ${report.count(STATUS.PORTAL)}`;
  log(`## 요약 — ${summary}`);
  const exitCode = report.count(STATUS.FAIL) > 0 ? 1 : 0;
  return { exitCode, rows: report.rows, summary };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { exitCode } = await main();
  process.exitCode = exitCode;
}
