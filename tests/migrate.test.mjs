import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * 트랙 변경(`gg migrate`).
 *
 * 무엇이 없었나: `gg init` 은 기존 lock 을 거부하고 `gg configure` 는 도구만
 * 다뤘다. 그래서 **한 번 정한 runtime 을 바꿀 방법이 아예 없었다.**
 *
 * 이것이 실제로 문제가 된 방식은 이렇다. 기관이 표준 트랙(gg_standard)을 새로
 * 정했는데 기존 프로젝트는 옛 트랙에 묶여 있었고, 그 프로젝트에서 파이썬 파일을
 * 만들려 하면 훅이 막았다. 표준에 맞춰 일하려면 정책을 우회하는 수밖에 없었고,
 * 그러면 정책이 아니라 우회가 표준이 된다.
 *
 * 옮기는 것 자체보다 중요한 것은 **옮긴 기록이 남는가**와 **좁히는 방향에서
 * 조용히 위반 상태가 되지 않는가** 이다.
 */

const harnessRoot = resolve(import.meta.dirname, "..");
const gg = join(harnessRoot, "bin", "gg.mjs");

function runGg(project, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [gg, ...args, "--project", project], { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function verdict(stdout) {
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

async function makeProject(runtime, files = {}) {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-migrate-"));
  const init = await runGg(project, ["init", "--tools", "both", "--runtime", runtime, "--level", "L1"]);
  assert.equal(init.code, 0, init.stderr || init.stdout);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(project, name), content);
  }
  return project;
}

async function lockOf(project) {
  return JSON.parse(await readFile(join(project, ".vibecode-harness", "harness.lock.json"), "utf8"));
}

async function cleanup(project) {
  if (project) await rm(project, { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 넓히는 방향 — 기관 표준으로 옮긴다
// ---------------------------------------------------------------------------

test("좁은 트랙에서 기관 표준으로 옮기면 파이썬이 1급 언어가 된다", async () => {
  const project = await makeProject("typescript_postgres", { "app.ts": "export const a = 1;\n" });
  try {
    const before = await lockOf(project);
    assert.ok(!before.allowed_languages.includes("python"), "옮기기 전에는 파이썬이 없어야 한다");

    const result = await runGg(project, ["migrate", "--runtime", "gg_standard"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(verdict(result.stdout).status, "migrated");

    const after = await lockOf(project);
    assert.equal(after.runtime_profile, "gg_standard");
    assert.equal(after.policy_profile, "gg_standard");
    for (const language of ["python", "javascript", "typescript"]) {
      assert.ok(after.allowed_languages.includes(language), `${language} 가 허용돼야 한다`);
    }
  } finally {
    await cleanup(project);
  }
});

test("옮겨도 프로젝트의 신원과 도구 설정은 그대로다", async () => {
  const project = await makeProject("typescript_web", { "app.ts": "export const a = 1;\n" });
  try {
    const before = await lockOf(project);
    await runGg(project, ["migrate", "--runtime", "gg_standard"]);
    const after = await lockOf(project);
    // 트랙을 바꾼 것이지 다른 프로젝트가 된 것이 아니다.
    assert.equal(after.project_id, before.project_id);
    assert.equal(after.created_at, before.created_at);
    assert.deepEqual(after.tools, before.tools);
    assert.deepEqual(after.managed_adapters, before.managed_adapters);
    assert.equal(after.level, before.level, "--level 을 주지 않으면 단계는 그대로다");
  } finally {
    await cleanup(project);
  }
});

test("무엇에서 무엇으로 옮겼는지 lock 과 영수증에 남는다", async () => {
  const project = await makeProject("typescript_postgres", { "app.ts": "export const a = 1;\n" });
  try {
    const result = await runGg(project, ["migrate", "--runtime", "gg_standard"]);
    const after = await lockOf(project);
    assert.equal(after.migrated_from.runtime_profile, "typescript_postgres");
    assert.equal(after.migrated_from.policy_profile, "typescript_postgres");
    assert.ok(after.migrated_at, "옮긴 시각이 남아야 한다");

    // 옛 lock 이 보존돼야 되짚을 수 있다.
    const backups = await readdir(join(project, ".vibecode-harness", "backups"));
    assert.ok(backups.some((name) => name.endsWith("harness.lock.json")), "옛 lock 이 백업되지 않았습니다");

    const receipt = JSON.parse(await readFile(verdict(result.stdout).receipt, "utf8"));
    assert.equal(receipt.kind, "migrate");
    assert.equal(receipt.status, "migrated");
    assert.equal(receipt.from.runtime_profile, "typescript_postgres");
    assert.equal(receipt.to.runtime_profile, "gg_standard");
  } finally {
    await cleanup(project);
  }
});

test("옮기면 프로젝트의 하네스 사본이 새 번들로 갱신되고 지문이 맞는다", async () => {
  const project = await makeProject("typescript_web", { "app.ts": "export const a = 1;\n" });
  try {
    await runGg(project, ["migrate", "--runtime", "gg_standard"]);
    // verify 의 변조 탐지가 바로 걸리면 옮긴 프로젝트는 쓸 수 없다.
    const verify = await runGg(project, ["verify", "--no-tests", "--skip-checker"]);
    const printed = verdict(verify.stdout);
    const failures = JSON.stringify(printed.policy_failures || []);
    assert.doesNotMatch(failures, /변경되었습니다|changed after initialization/, `지문 불일치: ${failures}`);
  } finally {
    await cleanup(project);
  }
});

// ---------------------------------------------------------------------------
// 좁히는 방향 — 조용히 위반 상태로 만들지 않는다
// ---------------------------------------------------------------------------

test("새 트랙이 허용하지 않는 파일이 있으면 멈추고 무엇이 걸리는지 보여준다", async () => {
  const project = await makeProject("gg_standard", {
    "app.py": "def add(a, b):\n    return a + b\n",
    "app.ts": "export const a = 1;\n"
  });
  try {
    const result = await runGg(project, ["migrate", "--runtime", "typescript_web"]);
    assert.equal(result.code, 10, result.stdout);
    const printed = verdict(result.stdout);
    assert.equal(printed.status, "blocked");
    assert.ok(printed.violations.some((path) => path.endsWith("app.py")), `걸린 파일을 보여줘야 한다: ${JSON.stringify(printed.violations)}`);
    assert.ok(printed.dropped_extensions.includes(".py"));

    // 막혔으면 트랙은 그대로여야 한다 — 절반만 옮겨진 상태가 가장 나쁘다.
    assert.equal((await lockOf(project)).runtime_profile, "gg_standard");
  } finally {
    await cleanup(project);
  }
});

test("--force 로 넘길 수 있지만 몇 건을 넘겼는지 영수증에 남는다", async () => {
  const project = await makeProject("gg_standard", {
    "app.py": "def add(a, b):\n    return a + b\n",
    "app.ts": "export const a = 1;\n"
  });
  try {
    const result = await runGg(project, ["migrate", "--runtime", "typescript_web", "--force"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(await readFile(verdict(result.stdout).receipt, "utf8"));
    assert.ok(receipt.forced_over_violations > 0, "넘긴 건수가 남아야 한다");
  } finally {
    await cleanup(project);
  }
});

// ---------------------------------------------------------------------------
// 입력 검사
// ---------------------------------------------------------------------------

test("알 수 없는 트랙으로는 옮기지 않는다", async () => {
  const project = await makeProject("typescript_web", { "app.ts": "export const a = 1;\n" });
  try {
    const result = await runGg(project, ["migrate", "--runtime", "does_not_exist"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /허용되지 않은/);
    assert.equal((await lockOf(project)).runtime_profile, "typescript_web");
  } finally {
    await cleanup(project);
  }
});

test("같은 트랙으로 옮기라고 하면 아무것도 바꾸지 않는다", async () => {
  const project = await makeProject("gg_standard", { "app.py": "def a():\n    return 1\n" });
  try {
    const before = await lockOf(project);
    const result = await runGg(project, ["migrate", "--runtime", "gg_standard"]);
    assert.equal(result.code, 0);
    assert.equal(verdict(result.stdout).status, "unchanged");
    const after = await lockOf(project);
    assert.equal(after.updated_at, before.updated_at, "바꾼 것이 없으면 시각도 건드리지 않는다");
    assert.equal(after.migrated_at, undefined);
  } finally {
    await cleanup(project);
  }
});

test("초기화되지 않은 폴더에서는 옮길 것이 없다고 말한다", async () => {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-nolock-"));
  try {
    const result = await runGg(project, ["migrate", "--runtime", "gg_standard"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /초기화되지 않았습니다/);
  } finally {
    await cleanup(project);
  }
});
