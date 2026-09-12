import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

/**
 * gg_standard 의 두 테스트 축.
 *
 * 무엇이 잘못돼 있었나: 두 축이 같은 `runProjectTests()` 를 불렀고, 그 함수는
 * `package.json` 을 먼저 본 뒤 거기서 돌아갔다. 그래서 포털처럼 두 생태계가
 * 함께 있는 프로젝트에서 **PyPI 축이 npm test 를 한 번 더 실행하고 pytest 는
 * 아예 실행되지 않았다.** 두 축의 결과가 같아지므로 "가장 나쁜 상태" 계산도
 * npm 결과 둘을 비교했고, 결국 **돌지도 않은 축이 통과한 것처럼 보였다.**
 *
 * 그래서 여기서 확인하는 것은 "테스트가 통과하는가"가 아니라
 * **어느 축이 무슨 명령을 골랐고 각각 몇 번 실행됐는가** 이다.
 */

const harnessRoot = resolve(import.meta.dirname, "..");
const gg = join(harnessRoot, "bin", "gg.mjs");

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
 * pytest 를 가진 인터프리터를 찾는다.
 *
 * 못 찾으면 null — 그때는 실제 실행 테스트를 건너뛰되, 아래의 **명령 선택**
 * 테스트는 인터프리터 없이도 그대로 돌아간다.
 */
function interpreterWithPytest() {
  if (process.platform !== "win32") return null;
  const listed = spawnSync("where.exe", ["python"], { encoding: "utf8" });
  if (listed.status !== 0) return null;
  for (const candidate of listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["-m", "pytest", "--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const interpreter = interpreterWithPytest();

/**
 * 하네스가 **우리가 고른** 인터프리터를 쓰게 만든다.
 *
 * `pythonCommand()` 는 설치 디렉터리(LOCALAPPDATA·ProgramFiles)를 PATH 보다
 * 먼저 본다. 그 디렉터리들을 빈 곳으로 돌려 PATH 분기로 내려보낸다 —
 * 이 PC 에 설치된 인터프리터에 pytest 가 있는지 없는지에 결과가 좌우되면
 * 테스트가 아니라 그 PC 의 상태를 재는 것이 된다.
 */
async function pythonEnvironment() {
  const empty = await mkdtemp(join(tmpdir(), "vibecode-harness-no-python-"));
  return {
    empty,
    env: {
      ...process.env,
      LOCALAPPDATA: empty,
      ProgramFiles: empty,
      "ProgramFiles(x86)": empty,
      PATH: `${dirname(interpreter)};${process.env.PATH}`,
      Path: `${dirname(interpreter)};${process.env.PATH}`
    }
  };
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

/**
 * @param {object} shape
 * @param {boolean} shape.node        package.json + 승인된 test script
 * @param {boolean} shape.pythonMarker  Python 프로젝트 선언 파일
 * @param {boolean} shape.testsDir    tests/ 폴더 (어느 축의 것인지 말해주지 않는다)
 */
async function makeProject(shape, env) {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-axes-"));
  const init = await runGg(project, ["init", "--tools", "both", "--runtime", "gg_standard", "--level", "L1"], env);
  assert.equal(init.code, 0, init.stderr || init.stdout);
  await mkdir(join(project, "tests"), { recursive: true });
  if (shape.node) {
    await writeFile(join(project, "package.json"), JSON.stringify({
      name: "axes-test", private: true, type: "module", scripts: { test: "node --test" }
    }, null, 2));
    await writeFile(join(project, "app.js"), "export const add = (a, b) => a + b;\n");
    if (shape.testsDir !== false) await writeFile(join(project, "tests", "app.test.js"), NODE_TEST_SOURCE(shape.nodePasses !== false));
  }
  if (shape.python) {
    await writeFile(join(project, "app.py"), "def add(a, b):\n    return a + b\n");
    if (shape.pythonMarker) await writeFile(join(project, "pyproject.toml"), "[project]\nname = \"axes-test\"\nversion = \"0.0.0\"\n");
    if (shape.testsDir !== false) await writeFile(join(project, "tests", "test_app.py"), PYTEST_SOURCE(shape.pythonPasses !== false));
  }
  return project;
}

async function cleanup(...directories) {
  for (const directory of directories) {
    if (!directory) continue;
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** 축이 실제로 몇 번 실행됐는지 — 각 테스트가 실행될 때마다 한 줄을 남긴다. */
async function runCount(project, name) {
  const path = join(project, name);
  if (!existsSync(path)) return 0;
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).length;
}

function verdict(stdout) {
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

function axis(result, name) {
  const found = (result.test.axes || []).find((item) => item.axis === name);
  assert.ok(found, `${name} 축 결과가 기록돼야 한다 — 돌지 않은 축도 남는다`);
  return found;
}

const needsInterpreter = { skip: interpreter ? false : "pytest 를 가진 인터프리터를 찾지 못했습니다." };

// ---------------------------------------------------------------------------
// 어느 축이 무슨 명령을 고르는가 — 실제 실행 없이도 결정적으로 확인된다
// ---------------------------------------------------------------------------

test("A. Node 전용: tests/ 폴더가 있어도 PyPI 축은 pytest 를 고르지 않는다", needsInterpreter, async () => {
  const python = await pythonEnvironment();
  const project = await makeProject({ node: true, python: false }, python.env);
  try {
    const result = verdict((await runGg(project, ["verify", "--run-tests"], python.env)).stdout);
    assert.equal(axis(result, "npm").command, "npm test");
    // 핵심: tests/ 폴더가 있다는 이유만으로 PyPI 축을 실행하지 않는다.
    assert.equal(axis(result, "pypi").status, "not_configured");
    assert.equal(axis(result, "pypi").command, null);
    assert.equal(await runCount(project, "runs-pypi.log"), 0, "pytest 가 실행되면 안 된다");
    assert.equal(await runCount(project, "runs-node.log"), 1);
  } finally {
    await cleanup(project, python.empty);
  }
});

test("B. Python 전용: package.json 이 없어도 PyPI 축이 실행된다", needsInterpreter, async () => {
  const python = await pythonEnvironment();
  const project = await makeProject({ node: false, python: true, pythonMarker: true }, python.env);
  try {
    const result = verdict((await runGg(project, ["verify", "--run-tests"], python.env)).stdout);
    assert.equal(axis(result, "npm").status, "not_configured");
    assert.equal(axis(result, "pypi").command, "python -m pytest -q");
    assert.equal(axis(result, "pypi").status, "passed");
    assert.equal(await runCount(project, "runs-pypi.log"), 1);
    assert.equal(result.test.status, "passed");
  } finally {
    await cleanup(project, python.empty);
  }
});

test("C. 혼합: npm test 와 pytest 가 각각 정확히 한 번 실행된다", needsInterpreter, async () => {
  const python = await pythonEnvironment();
  const project = await makeProject({ node: true, python: true, pythonMarker: true }, python.env);
  try {
    const result = verdict((await runGg(project, ["verify", "--run-tests"], python.env)).stdout);
    assert.equal(axis(result, "npm").command, "npm test");
    assert.equal(axis(result, "pypi").command, "python -m pytest -q");
    // 예전에는 여기서 npm 이 2, pypi 가 0 이었다.
    assert.equal(await runCount(project, "runs-node.log"), 1, "npm test 는 한 번만 실행돼야 한다");
    assert.equal(await runCount(project, "runs-pypi.log"), 1, "pytest 는 한 번은 실행돼야 한다");
    assert.equal(result.test.status, "passed");
  } finally {
    await cleanup(project, python.empty);
  }
});

// ---------------------------------------------------------------------------
// 한 축만 통과한 것을 전체 통과로 부르지 않는다
// ---------------------------------------------------------------------------

test("D. 혼합: npm 성공 · pytest 실패면 전체 실패", needsInterpreter, async () => {
  const python = await pythonEnvironment();
  const project = await makeProject({ node: true, python: true, pythonMarker: true, pythonPasses: false }, python.env);
  try {
    const run = await runGg(project, ["verify", "--run-tests"], python.env);
    const result = verdict(run.stdout);
    assert.equal(axis(result, "npm").status, "passed");
    assert.equal(axis(result, "pypi").status, "failed");
    assert.equal(result.test.status, "failed");
    assert.equal(result.status, "blocked");
    assert.equal(run.code, 30);
  } finally {
    await cleanup(project, python.empty);
  }
});

test("E. 혼합: npm 실패 · pytest 성공이면 전체 실패", needsInterpreter, async () => {
  const python = await pythonEnvironment();
  const project = await makeProject({ node: true, python: true, pythonMarker: true, nodePasses: false }, python.env);
  try {
    const run = await runGg(project, ["verify", "--run-tests"], python.env);
    const result = verdict(run.stdout);
    assert.equal(axis(result, "npm").status, "failed");
    assert.equal(axis(result, "pypi").status, "passed");
    assert.equal(result.test.status, "failed");
    assert.equal(result.status, "blocked");
    assert.equal(run.code, 30);
  } finally {
    await cleanup(project, python.empty);
  }
});

// ---------------------------------------------------------------------------
// F′. 포털과 같은 구조 — .py 파일은 있지만 Python 프로젝트 선언은 없다
//
// 원안(F)은 "이 구조에서 pytest 가 실제 실행됨"을 요구했지만, 그것은 같은
// 지시의 "tests/ 폴더가 있다는 이유만으로 실행하지 않는다"와 충돌한다.
// 포털 실물에는 최상위 tests/ 도, test script 도, Python 선언 파일도 없고,
// .py 파일은 스캔용 취약 픽스처와 **다른 프로젝트로 배포되는 템플릿**에만 있다.
// 거기서 pytest 를 돌리면 포털이 아니라 템플릿의 스모크 테스트를 채점한다.
// 그래서 올바른 기대값은 "실행"이 아니라 **명시적 미설정 기록**이다.
// ---------------------------------------------------------------------------

test("F′. 포털 구조: npm 축만 돌고 PyPI 축은 미설정으로 남되 조용히 사라지지 않는다", needsInterpreter, async () => {
  const python = await pythonEnvironment();
  const project = await makeProject({ node: true, python: true, pythonMarker: false }, python.env);
  try {
    const result = verdict((await runGg(project, ["verify", "--run-tests"], python.env)).stdout);
    assert.equal(axis(result, "npm").status, "passed");
    assert.equal(axis(result, "pypi").status, "not_configured");
    assert.equal(await runCount(project, "runs-pypi.log"), 0, "선언 없는 프로젝트에서 pytest 를 추정 실행하지 않는다");
    // 미설정이 결과에서 사라지면 "돌지 않았다"는 사실을 영수증에서 읽을 수 없다.
    assert.match(result.test.command, /pypi: not_configured/);
    assert.equal(result.test.status, "passed");
  } finally {
    await cleanup(project, python.empty);
  }
});

// ---------------------------------------------------------------------------
// 좁은 트랙 회귀 — 이 변경이 단일 언어 트랙의 동작을 바꾸지 않는다
// ---------------------------------------------------------------------------

test("python_internal 은 종전대로 tests/ 폴더만으로도 PyPI 축을 실행한다", needsInterpreter, async () => {
  // 단일 언어 트랙에는 tests/ 가 어느 축의 것인지에 대한 모호함이 없다.
  // 여기까지 엄격하게 바꾸면 기존 프로젝트가 갑자기 '테스트 없음'이 된다.
  const python = await pythonEnvironment();
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-axes-narrow-"));
  try {
    const init = await runGg(project, ["init", "--tools", "both", "--runtime", "python_internal", "--level", "L1"], python.env);
    assert.equal(init.code, 0, init.stderr || init.stdout);
    await mkdir(join(project, "tests"), { recursive: true });
    await writeFile(join(project, "app.py"), "def add(a, b):\n    return a + b\n");
    await writeFile(join(project, "tests", "test_app.py"), PYTEST_SOURCE(true));
    const result = verdict((await runGg(project, ["verify", "--run-tests"], python.env)).stdout);
    assert.equal(result.test.command, "python -m pytest -q");
    assert.equal(result.test.status, "passed");
    assert.equal(await runCount(project, "runs-pypi.log"), 1);
  } finally {
    await cleanup(project, python.empty);
  }
});
