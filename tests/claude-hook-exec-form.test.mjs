import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * Claude Code 훅 등록 형식.
 *
 * 무엇이 잘못돼 있었나: 훅이 `node .vibecode-harness/bin/claude-pre-tool.mjs`
 * 라는 **상대 경로**로 등록돼 있었다. Claude 가 프로젝트 루트 밖에서 도구를
 * 실행하면 그 파일을 찾지 못해 exit 1 로 끝나는데, Claude Code 는 exit 2 만
 * 차단으로 보므로 **정책 검사 없이 그대로 진행됐다.** 훅이 열리는 방향으로
 * 실패하고 있었고, 그 실패는 아무 데도 기록되지 않았다.
 *
 * 그래서 exec 형식(`args`)으로 바꾼다. Claude Code 가 `${CLAUDE_PROJECT_DIR}`
 * 를 직접 치환하므로 어느 셸인지와 무관하고, 인라인 부트스트랩이 훅 파일을
 * 불러오지 못하면 exit 2 로 끝낸다 — 정책을 확인하지 못한 것은 통과가 아니다.
 *
 * 여기서는 Claude Code 가 하는 일을 흉내낸다: settings.json 의 훅 항목을 읽고,
 * 플레이스홀더를 프로젝트 경로로 바꾼 뒤, 그 `command`/`args` 를 그대로 띄운다.
 */

const harnessRoot = resolve(import.meta.dirname, "..");
const gg = join(harnessRoot, "bin", "gg.mjs");
const MARKER = ".vibecode-harness/bin/claude-pre-tool.mjs";
const PLACEHOLDER = "${CLAUDE_PROJECT_DIR}";

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

async function makeProject(runtime = "gg_standard") {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-hook-"));
  const init = await runGg(project, ["init", "--tools", "both", "--runtime", runtime, "--level", "L1"]);
  assert.equal(init.code, 0, init.stderr || init.stdout);
  return project;
}

async function settingsOf(project) {
  return JSON.parse(await readFile(join(project, ".claude", "settings.json"), "utf8"));
}

function harnessHooks(settings) {
  return (settings.hooks?.PreToolUse || [])
    .flatMap((entry) => Array.isArray(entry.hooks) ? entry.hooks : [])
    .filter((hook) => hook.command?.includes?.(MARKER) || (hook.args || []).some((argument) => String(argument).includes(MARKER)));
}

/**
 * Claude Code 처럼 훅을 띄운다. `projectDir` 이 플레이스홀더에 들어갈 값이고,
 * `cwd` 는 Claude 가 도구를 실행하던 위치다 — 둘은 다를 수 있다.
 */
function invokeHook(hook, { projectDir, cwd, payload }) {
  const args = (hook.args || []).map((argument) => String(argument).split(PLACEHOLDER).join(projectDir));
  return new Promise((resolvePromise) => {
    const child = spawn(hook.command, args, { cwd, shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stderr }));
    child.stdin.end(JSON.stringify({ ...payload, cwd }));
  });
}

async function cleanup(...directories) {
  for (const directory of directories) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

const BLOCKED = { tool_input: { command: "go build ./..." } };
const ALLOWED = { tool_input: { command: "npm test" } };

// ---------------------------------------------------------------------------
// 등록 형식
// ---------------------------------------------------------------------------

test("init 은 exec 형식으로 등록하고 상대 경로는 남기지 않는다", async () => {
  const project = await makeProject();
  try {
    const hooks = harnessHooks(await settingsOf(project));
    assert.equal(hooks.length, 1);
    const [hook] = hooks;
    assert.equal(hook.command, "node", "셸을 거치지 않으려면 실행 파일 이름이어야 한다");
    assert.ok(Array.isArray(hook.args), "exec 형식은 args 배열이다");
    assert.equal(hook.args.at(-1), `${PLACEHOLDER}/${MARKER}`);
    assert.ok(hook.args.includes("-e"), "부트스트랩이 인라인으로 있어야 한다");
    assert.doesNotMatch(JSON.stringify(hook), /"node \.vibecode-harness/, "옛 상대 경로 형식이 남아 있다");
  } finally {
    await cleanup(project);
  }
});

// ---------------------------------------------------------------------------
// 프로젝트 안팎 어디서 실행돼도 같은 판정
// ---------------------------------------------------------------------------

test("프로젝트 루트에서: 허용은 0, 차단은 2", async () => {
  const project = await makeProject();
  try {
    const [hook] = harnessHooks(await settingsOf(project));
    const allow = await invokeHook(hook, { projectDir: project, cwd: project, payload: ALLOWED });
    assert.equal(allow.code, 0, allow.stderr);
    const block = await invokeHook(hook, { projectDir: project, cwd: project, payload: BLOCKED });
    assert.equal(block.code, 2);
    assert.match(block.stderr, /승인되지 않은 언어/);
  } finally {
    await cleanup(project);
  }
});

test("프로젝트 밖 CWD 에서: 허용은 0, 차단은 2 — 예전에는 여기서 검사가 사라졌다", async () => {
  const project = await makeProject();
  const elsewhere = await mkdtemp(join(tmpdir(), "vibecode-harness-elsewhere-"));
  try {
    const [hook] = harnessHooks(await settingsOf(project));
    const allow = await invokeHook(hook, { projectDir: project, cwd: elsewhere, payload: ALLOWED });
    assert.equal(allow.code, 0, allow.stderr);
    const block = await invokeHook(hook, { projectDir: project, cwd: elsewhere, payload: BLOCKED });
    assert.equal(block.code, 2, "프로젝트 밖에서도 차단은 차단이어야 한다");
    assert.match(block.stderr, /승인되지 않은 언어/);
    // 파일 정책도 프로젝트 기준으로 판정된다 — gg_standard 이므로 .py 는 허용.
    const python = await invokeHook(hook, { projectDir: project, cwd: elsewhere, payload: { tool_input: { file_path: join(project, "app.py") } } });
    assert.equal(python.code, 0, python.stderr);
  } finally {
    await cleanup(project, elsewhere);
  }
});

// ---------------------------------------------------------------------------
// 훅을 실행하지 못하면 통과가 아니라 차단
// ---------------------------------------------------------------------------

test("플레이스홀더가 치환되지 않으면 exit 2 로 차단한다", async () => {
  const project = await makeProject();
  try {
    const [hook] = harnessHooks(await settingsOf(project));
    // projectDir 을 플레이스홀더 그대로 두면 치환이 일어나지 않은 상황이 된다.
    const result = await invokeHook(hook, { projectDir: PLACEHOLDER, cwd: project, payload: ALLOWED });
    assert.equal(result.code, 2, "확인하지 못한 것은 통과가 아니다");
    assert.match(result.stderr, /정책 훅을 실행할 수 없습니다/);
  } finally {
    await cleanup(project);
  }
});

test("훅 파일이 없으면 exit 2 로 차단한다", async () => {
  const project = await makeProject();
  const empty = await mkdtemp(join(tmpdir(), "vibecode-harness-nohook-"));
  try {
    const [hook] = harnessHooks(await settingsOf(project));
    const result = await invokeHook(hook, { projectDir: empty, cwd: project, payload: ALLOWED });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /정책 훅을 실행할 수 없습니다/);
    assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
  } finally {
    await cleanup(project, empty);
  }
});

// ---------------------------------------------------------------------------
// 기존 프로젝트의 옛 등록을 gg update 가 바꾼다
// ---------------------------------------------------------------------------

async function installLegacySettings(project) {
  const settingsPath = join(project, ".claude", "settings.json");
  await mkdir(join(project, ".claude"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({
    permissions: { allow: ["Bash(ls)"] },
    hooks: {
      PreToolUse: [
        { matcher: "Write|Edit|MultiEdit|Bash", hooks: [{ type: "command", command: "node .vibecode-harness/bin/claude-pre-tool.mjs" }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "echo 다른-팀-훅" }] }
      ]
    }
  }, null, 2));
}

test("update 는 옛 상대 경로 훅을 exec 형식으로 바꾸고 다른 훅은 건드리지 않는다", async () => {
  const project = await makeProject();
  try {
    await installLegacySettings(project);
    const result = await runGg(project, ["update"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const printed = verdict(result.stdout);
    assert.equal(printed.claude_hook, "migrated");
    assert.equal(printed.status, "updated");

    const settings = await settingsOf(project);
    const text = JSON.stringify(settings);
    assert.doesNotMatch(text, /"node \.vibecode-harness\/bin\/claude-pre-tool\.mjs"/, "옛 형식이 남아 있다");
    const hooks = harnessHooks(settings);
    assert.equal(hooks.length, 1, "하나로 정리돼야 한다");
    assert.equal(hooks[0].command, "node");
    assert.equal(hooks[0].args.at(-1), `${PLACEHOLDER}/${MARKER}`);
    // 다른 팀의 훅과 권한 설정은 그대로다.
    assert.match(text, /다른-팀-훅/);
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });

    const backups = await readdir(join(project, ".vibecode-harness", "backups"));
    assert.ok(backups.some((name) => name.startsWith("claude-settings-before-update-")), "바꾸기 전 설정을 남겨야 한다");

    // 바뀐 등록이 실제로 동작한다.
    const block = await invokeHook(hooks[0], { projectDir: project, cwd: tmpdir(), payload: BLOCKED });
    assert.equal(block.code, 2);
  } finally {
    await cleanup(project);
  }
});

test("이미 현재 형식이면 update 는 설정을 다시 쓰지 않는다", async () => {
  const project = await makeProject();
  try {
    const before = await readFile(join(project, ".claude", "settings.json"), "utf8");
    const result = await runGg(project, ["update"]);
    const printed = verdict(result.stdout);
    assert.equal(printed.claude_hook, "already_configured");
    assert.equal(printed.status, "unchanged");
    assert.equal(await readFile(join(project, ".claude", "settings.json"), "utf8"), before);
  } finally {
    await cleanup(project);
  }
});

test("doctor 는 옛 형식을 '적용됨'이 아니라 update_required 로 보고한다", async () => {
  const project = await makeProject();
  try {
    await installLegacySettings(project);
    const legacy = verdict((await runGg(project, ["doctor"])).stdout);
    assert.equal(legacy.adapters.claude_code, "update_required");

    await runGg(project, ["update"]);
    const current = verdict((await runGg(project, ["doctor"])).stdout);
    assert.equal(current.adapters.claude_code, "applied");
  } finally {
    await cleanup(project);
  }
});

test("configure --remove claude 는 exec 형식 훅도 제거한다", async () => {
  const project = await makeProject();
  try {
    const result = await runGg(project, ["configure", "--remove", "claude"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(harnessHooks(await settingsOf(project)).length, 0);
  } finally {
    await cleanup(project);
  }
});
