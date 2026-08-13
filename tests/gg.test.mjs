import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

const harnessRoot = resolve(import.meta.dirname, "..");
const gg = join(harnessRoot, "bin", "gg.mjs");

function runGg(project, args, env = process.env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [gg, ...args, "--project", project], { shell: false, windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function runCommand(command, args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function fakeCheckerEnvironment(report = { scanned_files: ["app.ts"], skipped_files: [], profile: "web-civil-service", summary: { finding_count: 0 } }) {
  const directory = await mkdtemp(join(tmpdir(), "vibecode-harness-fake-gvskb-"));
  await copyFile(process.execPath, join(directory, "gvskb.exe"));
  return {
    report,
    directory,
    env: { ...process.env, PATH: `${directory};${process.env.PATH}`, GG_TEST_CHECKER_REPORT: JSON.stringify(report) }
  };
}

async function writeFakeChecker(project) {
  await writeFile(join(project, "scan"), "process.stdout.write(process.env.GG_TEST_CHECKER_REPORT + '\\n');\n");
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
    await writeFile(join(project, runtime === "typescript_web" ? "app.ts" : "app.js"), source);
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
    const localRunner = await runCommand(process.execPath, [join(project, ".vibecode-harness", "bin", "gg.mjs"), "doctor", "--project", project], project);
    assert.notEqual(localRunner.code, 70, localRunner.stderr || localRunner.stdout);
    assert.doesNotMatch(localRunner.stderr, /ERR_MODULE_NOT_FOUND/);
  });
});

test("init creates an opt-in CI gate without overwriting project workflows", async () => {
  await withProject(
    async () => {
      const project = await mkdtemp(join(tmpdir(), "vibecode-harness-ci-"));
      const init = await runGg(project, ["init", "--tools", "codex", "--runtime", "typescript_web", "--level", "L1", "--ci"]);
      assert.equal(init.code, 0, init.stdout + init.stderr);
      return project;
    },
    async (project) => {
      const workflow = await readFile(join(project, ".github", "workflows", "vibecode-harness.yml"), "utf8");
      assert.match(workflow, /vibecode-approved/);
      assert.match(workflow, /gg\.mjs verify/);
    }
  );
});

test("init preserves an existing default Git pre-commit hook", async () => {
  await withProject(
    async () => {
      const project = await mkdtemp(join(tmpdir(), "vibecode-harness-git-hook-"));
      const git = await runCommand("git", ["init"], project);
      assert.equal(git.code, 0, git.stdout + git.stderr);
      await writeFile(join(project, ".git", "hooks", "pre-commit"), "#!/usr/bin/env sh\necho existing\n");
      const init = await runGg(project, ["init", "--tools", "codex", "--runtime", "typescript_web", "--level", "L1"]);
      assert.equal(init.code, 0, init.stdout + init.stderr);
      return project;
    },
    async (project) => {
      assert.equal(await readFile(join(project, ".git", "hooks", "pre-commit"), "utf8"), "#!/usr/bin/env sh\necho existing\n");
      const hookPath = await runCommand("git", ["config", "--get", "core.hooksPath"], project);
      assert.notEqual(hookPath.stdout.trim(), ".githooks");
    }
  );
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

test("build blocks a tampered local runner", async () => {
  await withProject(makeProject, async (project) => {
    const runner = join(project, ".vibecode-harness", "bin", "gg.mjs");
    await writeFile(runner, `${await readFile(runner, "utf8")}\n// changed\n`);
    const result = await runGg(project, ["build"]);
    assert.equal(result.code, 10, result.stdout + result.stderr);
    assert.match(result.stdout, /프로젝트 실행기 사본이 변경/);
  });
});

test("build blocks an unreadable package policy as an integrity failure", async () => {
  await withProject(makeProject, async (project) => {
    const policyPath = join(project, ".vibecode-harness", "policy", "package-policy.json");
    await writeFile(policyPath, "{ invalid json\n");
    const result = await runGg(project, ["build"]);
    assert.equal(result.code, 10, result.stdout + result.stderr);
    assert.match(result.stdout, /패키지 정책/);
  });
});

test("verify blocks a failing user test", async () => {
  await withProject(
    () => makeProject({ testSource: "import test from 'node:test'; import assert from 'node:assert/strict'; test('fails', () => assert.equal(1, 2));\n" }),
    async (project) => {
      const result = await runGg(project, ["verify", "--skip-checker", "--run-tests"]);
      assert.equal(result.code, 30, result.stdout + result.stderr);
    assert.match(result.stdout, /"status": "blocked"/);
    assert.match(result.stdout, /"status": "failed"/);
    }
  );
});

test("verify does not let a skipped checker pass", async () => {
  await withProject(makeProject, async (project) => {
    const result = await runGg(project, ["verify", "--skip-checker", "--run-tests"]);
    assert.equal(result.code, 41, result.stdout + result.stderr);
    assert.match(result.stdout, /incomplete/);
    assert.match(result.stdout, /통과한 것으로 처리하지 않습니다/);
  });
});

test("verify requires an explicit decision before it executes project tests", async () => {
  await withProject(makeProject, async (project) => {
    const result = await runGg(project, ["verify", "--skip-checker"]);
    assert.equal(result.code, 30, result.stdout + result.stderr);
    assert.match(result.stdout, /테스트 실행은 프로젝트 코드를 실행합니다/);
  });
});

test("verify blocks test skipping above L1", async () => {
  await withProject(() => makeProject({ level: "L2" }), async (project) => {
    const start = await runGg(project, ["start", "--brief", "민원 안내 화면을 만듭니다."]);
    assert.equal(start.code, 0, start.stdout + start.stderr);
    const design = await runGg(project, ["design", "--database", "no", "--admin", "no", "--external-api", "no", "--confirm"]);
    assert.equal(design.code, 0, design.stdout + design.stderr);
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
    const checker = await fakeCheckerEnvironment();
    try {
      await writeFakeChecker(project);
      const result = await runGg(project, ["verify", "--run-tests"], checker.env);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /review_required/);
      assert.match(result.stdout, /커밋은 가능하지만/);
    } finally {
      await rm(checker.directory, { recursive: true, force: true });
    }
  });
});

test("verify treats declared dependencies without a completed audit as incomplete", async () => {
  await withProject(makeProject, async (project) => {
    await writeFile(join(project, "package.json"), JSON.stringify({
      name: "dependency-audit-test", private: true, type: "module", scripts: { test: "node --test" }, dependencies: { zod: "3.24.0" }
    }));
    const checker = await fakeCheckerEnvironment({
      scanned_files: ["app.ts"], skipped_files: [], profile: "web-civil-service", summary: { finding_count: 0 },
      dependency_audit: { audits: [{ verdict: "unparsed", requires_review: true, parsed_count: 0 }] }
    });
    try {
      await writeFakeChecker(project);
      const result = await runGg(project, ["verify", "--run-tests"], checker.env);
      assert.equal(result.code, 41, result.stdout + result.stderr);
      assert.match(result.stdout, /의존성 감사를 완료하지 못했습니다/);
    } finally {
      await rm(checker.directory, { recursive: true, force: true });
    }
  });
});

test("start and design create user-facing planning artifacts without overwriting them", async () => {
  await withProject(makeProject, async (project) => {
    const start = await runGg(project, ["start", "--brief", "반복 업무 처리 현황을 확인하는 내부 도구"]);
    assert.equal(start.code, 0, start.stdout + start.stderr);
    const design = await runGg(project, ["design", "--database", "no", "--admin", "no", "--external-api", "no", "--confirm"]);
    assert.equal(design.code, 0, design.stdout + design.stderr);
    assert.match(await readFile(join(project, "evidence", "feature-brief.md"), "utf8"), /반복 업무/);
    assert.match(await readFile(join(project, "evidence", "design", "data-and-admin-decision.md"), "utf8"), /관리자/);
    assert.match(await readFile(join(project, "evidence", "design", "visual-review-receipt.json"), "utf8"), /html_prototype/);
  });
});

test("start does not save a brief that resembles personal or secret data", async () => {
  await withProject(makeProject, async (project) => {
    const result = await runGg(project, ["start", "--brief", "담당자 hong@example.go.kr의 token=not-a-real-token 값을 사용합니다."]);
    assert.equal(result.code, 70, result.stdout + result.stderr);
    assert.match(result.stderr, /개인정보 또는 비밀값/);
    await assert.rejects(readFile(join(project, "evidence", "feature-brief.md"), "utf8"));
  });
});

test("L2 build requires a confirmed visual design", async () => {
  await withProject(() => makeProject({ level: "L2" }), async (project) => {
    const before = await runGg(project, ["build"]);
    assert.equal(before.code, 10, before.stdout + before.stderr);
    assert.match(before.stdout, /HTML 화면 시안을 확인/);
    assert.equal((await runGg(project, ["start", "--brief", "개인정보 없이 상태를 확인하는 내부 도구"])).code, 0);
    assert.equal((await runGg(project, ["design", "--database", "no", "--admin", "no", "--external-api", "no", "--confirm"])).code, 0);
    const after = await runGg(project, ["build"]);
    assert.equal(after.code, 0, after.stdout + after.stderr);
  });
});

test("package check blocks a locally denied package before registry access", async () => {
  await withProject(makeProject, async (project) => {
    const result = await runGg(project, ["package", "check", "--ecosystem", "npm", "--name", "firebase", "--version", "10.0.0"]);
    assert.equal(result.code, 20, result.stdout + result.stderr);
    assert.match(result.stdout, /기관 기본 차단 패키지/);
  });
});

test("init merges a valid existing Claude settings file and preserves a backup", async () => {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-settings-"));
  try {
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(join(project, "CLAUDE.md"), "existing instructions\n");
    await writeFile(join(project, ".claude", "settings.json"), "{}\n");
    const init = await runGg(project, ["init", "--tools", "claude", "--runtime", "typescript_web", "--level", "L1"]);
    assert.equal(init.code, 0, init.stdout + init.stderr);
    assert.match(await readFile(join(project, ".claude", "settings.json"), "utf8"), /claude-pre-tool/);
    const backups = await readdir(join(project, ".vibecode-harness", "backups"));
    assert.equal(backups.length, 1);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("release always requires human review", async () => {
  await withProject(makeProject, async (project) => {
    const result = await runGg(project, ["release"]);
    assert.equal(result.code, 42, result.stdout + result.stderr);
    assert.match(result.stdout, /review_required/);
    assert.match(await readFile(join(project, "evidence", "release-manifest.json"), "utf8"), /사람 검토/);
  });
});
