import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

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

async function makeProject({ runtime = "typescript_web", level = "L1", source = "export const add = (a, b) => a + b;\n", testSource = null } = {}) {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-test-"));
  const init = await runGg(project, ["init", "--tools", "both", "--runtime", runtime, "--level", level]);
  assert.equal(init.code, 0, init.stderr || init.stdout);
  if (runtime !== "python_internal") {
    await writeFile(join(project, "package.json"), JSON.stringify({
      name: "harness-test",
      private: true,
      type: "module",
      scripts: { test: "node --test" }
    }, null, 2));
    await writeFile(join(project, "app.js"), source);
    if (testSource) {
      await writeFile(join(project, "app.test.js"), testSource);
    } else {
      await writeFile(join(project, "app.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('works', () => assert.equal(1 + 1, 2));\n");
    }
  }
  return project;
}

async function withProject(factory, body) {
  const project = await factory();
  try { await body(project); } finally { await rm(project, { recursive: true, force: true }); }
}

test("init creates locked policy, adapters, and project evidence", async () => {
  await withProject(makeProject, async (project) => {
    const lock = JSON.parse(await readFile(join(project, ".vibecode-harness", "harness.lock.json"), "utf8"));
    assert.deepEqual(lock.allowed_languages, ["python", "javascript", "typescript"]);
    assert.match(await readFile(join(project, "AGENTS.md"), "utf8"), /vibecode-harness/);
    assert.match(await readFile(join(project, "CLAUDE.md"), "utf8"), /vibecode-harness/);
    assert.match(await readFile(join(project, ".claude", "settings.json"), "utf8"), /PreToolUse/);
    assert.match(await readFile(join(project, ".vibecode-harness", "bin", "gg.mjs"), "utf8"), /verifyCommand/);
  });
});

test("build blocks a denied runtime invoked from npm scripts", async () => {
  await withProject(makeProject, async (project) => {
    await writeFile(join(project, "package.json"), JSON.stringify({
      name: "runtime-violation",
      private: true,
      scripts: { test: "node --test", compile: "go test ./..." }
    }, null, 2));
    const result = await runGg(project, ["build"]);
    assert.equal(result.code, 10, result.stdout + result.stderr);
    assert.match(result.stdout, /허용되지 않은 런타임/);
  });
});

test("build blocks a denied language file", async () => {
  await withProject(makeProject, async (project) => {
    await writeFile(join(project, "unsafe.go"), "package main\n");
    const result = await runGg(project, ["build"]);
    assert.equal(result.code, 10, result.stdout + result.stderr);
    assert.match(result.stdout, /허용되지 않은 Go/);
  });
});

test("build blocks tampered policy snapshots", async () => {
  await withProject(makeProject, async (project) => {
    const policyPath = join(project, ".vibecode-harness", "policy", "harness-core.yaml");
    await writeFile(policyPath, `${await readFile(policyPath, "utf8")}\n# modified\n`);
    const result = await runGg(project, ["build"]);
    assert.equal(result.code, 10, result.stdout + result.stderr);
    assert.match(result.stdout, /정책 파일이 초기화 이후 변경/);
  });
});

test("verify blocks a failing user test", async () => {
  await withProject(
    () => makeProject({ testSource: "import test from 'node:test'; import assert from 'node:assert/strict'; test('fails', () => assert.equal(1, 2));\n" }),
    async (project) => {
      const result = await runGg(project, ["verify", "--skip-checker"]);
      assert.equal(result.code, 30, result.stdout + result.stderr);
    assert.match(result.stdout, /"status": "blocked"/);
    assert.match(result.stdout, /"status": "failed"/);
    }
  );
});

test("verify does not let a skipped checker pass", async () => {
  await withProject(makeProject, async (project) => {
    const result = await runGg(project, ["verify", "--skip-checker"]);
    assert.equal(result.code, 41, result.stdout + result.stderr);
    assert.match(result.stdout, /incomplete/);
    assert.match(result.stdout, /통과한 것으로 처리하지 않습니다/);
  });
});

test("verify blocks test skipping above L1", async () => {
  await withProject(() => makeProject({ level: "L2" }), async (project) => {
    const result = await runGg(project, ["verify", "--no-tests", "--skip-checker"]);
    assert.equal(result.code, 30, result.stdout + result.stderr);
    assert.match(result.stdout, /L2 이상에서는 --no-tests/);
  });
});

test("verify treats an empty source scan as incomplete", async () => {
  await withProject(
    async () => {
      const project = await mkdtemp(join(tmpdir(), "vibecode-harness-empty-"));
      const init = await runGg(project, ["init", "--tools", "codex", "--runtime", "typescript_web", "--level", "L1"]);
      assert.equal(init.code, 0, init.stderr || init.stdout);
      return project;
    },
    async (project) => {
      const result = await runGg(project, ["verify", "--no-tests"]);
      assert.equal(result.code, 41, result.stdout + result.stderr);
      assert.match(result.stdout, /incomplete/);
    }
  );
});

test("verify allows a complete clean scan to continue development but keeps release review required", async () => {
  await withProject(makeProject, async (project) => {
    const result = await runGg(project, ["verify"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /review_required/);
    assert.match(result.stdout, /커밋은 가능하지만/);
  });
});

test("start and design create user-facing planning artifacts without overwriting them", async () => {
  await withProject(makeProject, async (project) => {
    const start = await runGg(project, ["start", "--brief", "반복 업무 처리 현황을 확인하는 내부 도구"]);
    assert.equal(start.code, 0, start.stdout + start.stderr);
    const design = await runGg(project, ["design"]);
    assert.equal(design.code, 0, design.stdout + design.stderr);
    assert.match(await readFile(join(project, "evidence", "feature-brief.md"), "utf8"), /반복 업무/);
    assert.match(await readFile(join(project, "evidence", "design", "data-and-admin-decision.md"), "utf8"), /관리자/);
  });
});

test("release always requires human review", async () => {
  await withProject(makeProject, async (project) => {
    const result = await runGg(project, ["release"]);
    assert.equal(result.code, 42, result.stdout + result.stderr);
    assert.match(result.stdout, /review_required/);
    assert.match(await readFile(join(project, "evidence", "release-manifest.json"), "utf8"), /사람 검토/);
  });
});
