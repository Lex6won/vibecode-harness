import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { policyProfileForDirectory, resolvePolicyProfile } from "../lib/policy-engine.mjs";

/**
 * 어떤 정책으로 판정할 것인가.
 *
 * 무엇이 잘못돼 있었나: 훅이 `process.cwd()` 하나만 보고 프로파일을 정했다.
 * 그래서 **같은 파일을 쓰는데 터미널이 어디 있었느냐로 판정이 갈렸다** —
 * 프로젝트 안에서 실행하면 막히고, 잠깐 바깥에서 실행하면 통과했다.
 *
 * 실제로 이 저장소 작업 중에 그 일이 일어났다. 같은 종류의 파일을 같은 곳에
 * 쓰는데 한 번은 통과하고 한 번은 막혔다. 정책이 파일이 아니라 **우연**에
 * 달려 있으면, 막혔다는 사실도 통과했다는 사실도 근거가 되지 못한다.
 *
 * 그래서 대상 파일이 속한 프로젝트를 먼저 본다. 어느 하네스 프로젝트에도
 * 속하지 않는 파일은 세션이 열린 프로젝트의 정책을 따른다 — 바깥에 써 두고
 * 나중에 들여오는 우회로를 열지 않기 위해서다.
 */

const harnessRoot = resolve(import.meta.dirname, "..");
const hook = join(harnessRoot, "bin", "claude-pre-tool.mjs");

async function makeLockedProject(policyProfile) {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-policy-"));
  await mkdir(join(project, ".vibecode-harness"), { recursive: true });
  await writeFile(
    join(project, ".vibecode-harness", "harness.lock.json"),
    JSON.stringify({ policy_profile: policyProfile, runtime_profile: policyProfile, level: "L2" }, null, 2)
  );
  return project;
}

async function makePlainDirectory() {
  return mkdtemp(join(tmpdir(), "vibecode-harness-plain-"));
}

function runHook(payload, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [hook], { cwd, shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function cleanup(...directories) {
  for (const directory of directories) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 파일이 속한 프로젝트가 판정한다
// ---------------------------------------------------------------------------

test("파일이 속한 프로젝트의 정책으로 판정한다 — 터미널 위치가 아니라", async () => {
  const pythonProject = await makeLockedProject("python_internal");
  const typescriptProject = await makeLockedProject("typescript_postgres");
  try {
    const target = join(pythonProject, "app.py");
    // 터미널이 TypeScript 프로젝트 안에 있어도, 파이썬 프로젝트의 파일은
    // 파이썬 프로젝트의 정책으로 본다.
    assert.equal(resolvePolicyProfile({ filePath: target, cwd: typescriptProject }), "python_internal");
    assert.equal(resolvePolicyProfile({ filePath: target, cwd: pythonProject }), "python_internal");
  } finally {
    await cleanup(pythonProject, typescriptProject);
  }
});

test("같은 파일은 터미널이 어디에 있든 같은 판정을 받는다", async () => {
  const project = await makeLockedProject("python_internal");
  const elsewhere = await makePlainDirectory();
  try {
    const payload = { tool_input: { file_path: join(project, "app.py") } };
    const inside = await runHook(payload, project);
    const outside = await runHook(payload, elsewhere);
    // 이것이 이번 결함의 핵심이다. 예전에는 두 결과가 달랐다.
    assert.equal(inside.code, outside.code, `터미널 위치로 판정이 갈렸습니다: ${inside.code} ≠ ${outside.code}`);
    assert.equal(inside.code, 0, inside.stderr);
  } finally {
    await cleanup(project, elsewhere);
  }
});

test("허용하지 않는 언어는 그 프로젝트 안에서 여전히 막힌다", async () => {
  const project = await makeLockedProject("typescript_postgres");
  const elsewhere = await makePlainDirectory();
  try {
    const payload = { tool_input: { file_path: join(project, "app.py") } };
    for (const [label, cwd] of [["프로젝트 안", project], ["프로젝트 밖", elsewhere]]) {
      const result = await runHook(payload, cwd);
      assert.equal(result.code, 2, `${label}: 막혀야 합니다`);
      assert.match(result.stderr, /허용하지 않습니다/);
    }
  } finally {
    await cleanup(project, elsewhere);
  }
});

// ---------------------------------------------------------------------------
// 기관 표준에서 파이썬은 1급 언어다
// ---------------------------------------------------------------------------

test("gg_standard 프로젝트에서는 .py 도 .ts 도 막히지 않는다", async () => {
  // 기관 프로파일은 세 기능 언어(파이썬·JS·TS)를 선언한다. 표준 트랙에서
  // 파이썬을 막는 것은 예외 처리가 아니라 선언과 어긋나는 것이다.
  const project = await makeLockedProject("gg_standard");
  try {
    for (const name of ["app.py", "app.ts", "app.js", "app.tsx", "app.mjs"]) {
      const result = await runHook({ tool_input: { file_path: join(project, name) } }, project);
      assert.equal(result.code, 0, `${name} 이 막혔습니다: ${result.stderr}`);
    }
  } finally {
    await cleanup(project);
  }
});

test("gg_standard 는 두 생태계의 런타임 명령을 모두 허용한다", async () => {
  const project = await makeLockedProject("gg_standard");
  try {
    for (const command of ["python -m pytest -q", "pip --version", "npm test", "node --test"]) {
      const result = await runHook({ tool_input: { command } }, project);
      assert.equal(result.code, 0, `'${command}' 가 막혔습니다: ${result.stderr}`);
    }
  } finally {
    await cleanup(project);
  }
});

// ---------------------------------------------------------------------------
// 바깥 경로 — 우회로를 열지 않는다
// ---------------------------------------------------------------------------

test("어느 프로젝트에도 속하지 않는 파일은 세션 프로젝트의 정책을 따른다", async () => {
  // 바깥에 써 두고 나중에 들여오는 경로를 열면 정책은 있으나 마나다.
  const project = await makeLockedProject("typescript_postgres");
  const outside = await makePlainDirectory();
  try {
    const result = await runHook({ tool_input: { file_path: join(outside, "app.py") } }, project);
    assert.equal(result.code, 2, "세션 프로젝트의 정책이 적용돼야 합니다");
  } finally {
    await cleanup(project, outside);
  }
});

test("어느 프로젝트에도 속하지 않으면 null 을 돌려준다", async () => {
  const outside = await makePlainDirectory();
  try {
    assert.equal(policyProfileForDirectory(outside), null);
    // 그때의 기본값은 general — 기관 기본 언어 정책이다.
    assert.equal(resolvePolicyProfile({ filePath: join(outside, "a.py"), cwd: outside }), "general");
  } finally {
    await cleanup(outside);
  }
});

test("망가진 lock 은 통과가 아니라 기본 정책으로 떨어진다", async () => {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-broken-"));
  try {
    await mkdir(join(project, ".vibecode-harness"), { recursive: true });
    await writeFile(join(project, ".vibecode-harness", "harness.lock.json"), "{ 이건 JSON 이 아니다");
    assert.equal(policyProfileForDirectory(project), "general");
  } finally {
    await cleanup(project);
  }
});
