#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, parse, resolve, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { CHECKER_STATUS_BY_VERDICT, MIN_CHECKER_VERSION, buildCheckerEvidence, checkerVersionSatisfies, parseCheckerVersion } from "../lib/checker-evidence.mjs";
import { cleanupSupersededBundleFiles, installationState, verifyBundle } from "../lib/release-integrity.mjs";
import {
  ALL_CODE_EXTENSIONS,
  getPolicyProfile,
  hasAllowedImplementationSource,
  languageFailureForPath,
  policyProfileForRuntime,
  runtimeFailureForCommand
} from "../lib/policy-engine.mjs";

const EXIT = Object.freeze({
  OK: 0,
  POLICY_OR_RUNTIME: 10,
  PACKAGE: 20,
  TEST: 30,
  CHECKER_BLOCK: 40,
  CHECKER_INCOMPLETE: 41,
  CHECKER_REVIEW: 42,
  USAGE: 64,
  SYSTEM: 70
});

/**
 * Claude Code 훅 등록 형식.
 *
 * 예전에는 `node .vibecode-harness/bin/claude-pre-tool.mjs` 라는 **상대 경로**를
 * 셸 형식으로 등록했다. Claude 가 프로젝트 루트 밖에서 도구를 실행하면 그 파일을
 * 찾지 못해 exit 1 로 끝나는데, Claude Code 는 exit 2 만 차단으로 보므로
 * **정책 검사 없이 그대로 진행됐다.** 훅이 열리는 방향으로 실패하고 있었다.
 *
 * 그래서 두 가지를 바꾼다.
 *
 * 1. exec 형식(`args` 배열). 셸을 거치지 않고 Claude Code 가 `${CLAUDE_PROJECT_DIR}`
 *    를 세션 시작 프로젝트 루트로 직접 치환한다. Windows 에서 Git Bash 인지
 *    PowerShell 인지에 따라 변수 확장이 갈리는 문제가 아예 없어진다. `node` 는
 *    어느 플랫폼에서나 실제 실행 파일이라 exec 형식으로 띄울 수 있다.
 * 2. 부트스트랩. 훅 파일을 `import()` 하고 **실패하면 exit 2** 로 끝낸다. 파일이
 *    없거나, 플레이스홀더가 치환되지 않았거나, 모듈이 깨졌으면 통과가 아니라
 *    차단이다 — 정책을 확인하지 못한 것은 정책을 통과한 것이 아니다.
 *
 * 부트스트랩은 settings.json 에 인라인으로 들어간다. 훅 파일이 없는 상황을 막는
 * 코드가 훅 파일 안에 있을 수는 없기 때문이다.
 */
const CLAUDE_HOOK_SCRIPT_PLACEHOLDER = "${CLAUDE_PROJECT_DIR}/.vibecode-harness/bin/claude-pre-tool.mjs";
const CLAUDE_HOOK_BOOTSTRAP = 'import("node:url").then((u) => import(u.pathToFileURL(process.argv[1]).href)).catch((e) => { process.stderr.write("바이브코드 하네스 차단: 정책 훅을 실행할 수 없습니다: " + process.argv[1] + " (" + ((e && e.code) || e) + ")\\n"); process.exit(2); });';
// 47차 — NotebookEdit(노트북 셀 쓰기)과 PowerShell(Windows Claude Code 의 셸 도구)을 추가했다.
// 예전 matcher 는 PowerShell 도구로 `npm install` 을 하거나 `.go` 파일을 쓰면 훅이 돌지 않았다.
const CLAUDE_HOOK_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell";

function claudeHookEntry() {
  return { type: "command", command: "node", args: ["-e", CLAUDE_HOOK_BOOTSTRAP, "--", CLAUDE_HOOK_SCRIPT_PLACEHOLDER] };
}

/** 이 하네스가 등록한 훅인가 — 옛 상대 경로 형식이든 현재 exec 형식이든. */
function isVibecodeClaudeHook(hook) {
  if (!hook || typeof hook !== "object") return false;
  const marker = ".vibecode-harness/bin/claude-pre-tool.mjs";
  if (typeof hook.command === "string" && hook.command.includes(marker)) return true;
  return Array.isArray(hook.args) && hook.args.some((argument) => String(argument).includes(marker));
}

function isCurrentClaudeHook(hook) {
  return JSON.stringify(hook) === JSON.stringify(claudeHookEntry());
}

/** 이 항목(matcher + hooks)이 현재 형식 그대로인가 — matcher 가 좁은 옛 등록은 '현재'가 아니다. */
function isCurrentClaudeHookEntry(entry) {
  return entry?.matcher === CLAUDE_HOOK_MATCHER && Array.isArray(entry.hooks) && entry.hooks.some(isCurrentClaudeHook);
}

/**
 * settings 안의 하네스 훅을 현재 형식으로 맞춘다. 다른 훅은 건드리지 않는다.
 * 반환 status: added | migrated | already_configured
 *
 * 47차 — matcher 도 비교한다. 훅 명령은 현재 형식인데 matcher 가 `Write|Edit|MultiEdit|Bash` 로
 * 남아 있으면 PowerShell·NotebookEdit 가 여전히 훅을 거치지 않으므로, 그것도 migrated 다.
 */
function ensureClaudeHook(settings) {
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  let found = 0;
  let replaced = 0;
  for (const entry of settings.hooks.PreToolUse) {
    if (!Array.isArray(entry.hooks)) continue;
    const hadOurs = entry.hooks.some(isVibecodeClaudeHook);
    entry.hooks = entry.hooks.map((hook) => {
      if (!isVibecodeClaudeHook(hook)) return hook;
      found += 1;
      if (isCurrentClaudeHook(hook)) return hook;
      replaced += 1;
      return claudeHookEntry();
    });
    // 우리 훅만 들어 있는 항목의 matcher 는 우리가 소유한다 — 넓힌다. 다른 훅과 섞인 항목은
    // 남의 matcher 를 바꾸지 않고, 우리 훅을 빼서 우리 항목으로 옮긴다.
    if (hadOurs && entry.matcher !== CLAUDE_HOOK_MATCHER) {
      if (entry.hooks.every(isVibecodeClaudeHook)) {
        entry.matcher = CLAUDE_HOOK_MATCHER;
      } else {
        entry.hooks = entry.hooks.filter((hook) => !isVibecodeClaudeHook(hook));
        settings.hooks.PreToolUse.push({ matcher: CLAUDE_HOOK_MATCHER, hooks: [claudeHookEntry()] });
      }
      replaced += 1;
    }
  }
  if (found === 0) {
    settings.hooks.PreToolUse.push({ matcher: CLAUDE_HOOK_MATCHER, hooks: [claudeHookEntry()] });
    return { status: "added", replaced: 0 };
  }
  // M10 — 우리 훅은 **한 항목에 한 번**만 남긴다. 옛 등록이 둘이었거나 혼합 항목에서 분리된 뒤 현행 항목이
  // 이미 있으면 두 번 실행된다. 첫 현행 항목을 남기고 나머지 항목에서는 우리 훅을 뺀다(빈 항목은 지운다).
  let kept = false;
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((entry) => {
    if (!Array.isArray(entry.hooks)) return true;
    const ours = entry.hooks.filter(isVibecodeClaudeHook);
    if (!ours.length) return true;
    if (!kept && isCurrentClaudeHookEntry(entry)) {
      if (ours.length > 1) { entry.hooks = [...entry.hooks.filter((hook) => !isVibecodeClaudeHook(hook)), ours[0]]; replaced += 1; }
      kept = true;
      return true;
    }
    entry.hooks = entry.hooks.filter((hook) => !isVibecodeClaudeHook(hook));
    replaced += 1;
    return entry.hooks.length > 0;
  });
  if (!kept) { settings.hooks.PreToolUse.push({ matcher: CLAUDE_HOOK_MATCHER, hooks: [claudeHookEntry()] }); replaced += 1; }
  return { status: replaced ? "migrated" : "already_configured", replaced };
}

/** init 과 migrate 가 받아들이는 트랙. 한 곳에서만 정한다 — 두 벌이 되면 갈라진다. */
const MIGRATABLE_RUNTIMES = Object.freeze(["gg_standard", "python_internal", "node_web", "typescript_web", "typescript_postgres"]);

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = join(HARNESS_ROOT, "shared", "harness-core.yaml");
const INSTITUTION_PROFILE_PATH = join(HARNESS_ROOT, "shared", "institution-profile.yaml");
const POLICY_PROFILES_PATH = join(HARNESS_ROOT, "shared", "policy-profiles.json");
const ROOT_PACKAGE_POLICY_PATH = join(HARNESS_ROOT, "shared", "references", "package-policy.json");
const CODEX_TEMPLATE_PATH = join(HARNESS_ROOT, "adapters", "codex", "AGENTS.template.md");
const CLAUDE_TEMPLATE_PATH = join(HARNESS_ROOT, "adapters", "claude-code", "CLAUDE.template.md");
const CI_TEMPLATE_PATH = join(HARNESS_ROOT, "templates", "vibecode-harness-ci.yml");
const TRUST_PATH = join(HARNESS_ROOT, "shared", "trust", "approved-signers.json");
const RELEASE_INTEGRITY_PATH = join(HARNESS_ROOT, "lib", "release-integrity.mjs");
const POLICY_ENGINE_PATH = join(HARNESS_ROOT, "lib", "policy-engine.mjs");
const CHECKER_EVIDENCE_PATH = join(HARNESS_ROOT, "lib", "checker-evidence.mjs");
const BUNDLED_CHECKER_PATH = join(HARNESS_ROOT, "checker", process.platform === "win32" ? "gvskb.exe" : "gvskb");
const BUNDLED_PYTHON_PATH = join(HARNESS_ROOT, "runtime", process.platform === "win32" ? "python.exe" : "python");
// Kept for legacy diagnostic wording; profile-aware validation below is authoritative.
const BLOCKED_EXTENSIONS = new Map([
  [".java", "Java"], [".go", "Go"], [".php", "PHP"], [".rb", "Ruby"],
  [".cs", "C#"], [".rs", "Rust"]
]);
const IGNORED_DIRECTORIES = new Set([".git", ".githooks", ".vibecode-harness", "node_modules", ".venv", "venv", ".check-reports", "evidence", "dist", "build", "coverage"]);
const TOOL_NAMES = Object.freeze({
  codex: "codex",
  claude: "claude-code",
  "claude-desktop": "claude-desktop",
  "chatgpt-desktop": "chatgpt-codex-desktop",
  "codex-desktop": "chatgpt-codex-desktop",
  "chatgpt-codex-desktop": "chatgpt-codex-desktop",
  lovable: "lovable-github",
  "lovable-github": "lovable-github"
});
const GUIDANCE_ADAPTERS = Object.freeze({
  "claude-desktop": Object.freeze({ source: join(HARNESS_ROOT, "adapters", "claude-desktop", "PROJECT-SUPPORT.md"), target: ".vibecode-harness/tool-guides/claude-desktop.md", status: "git_gate_required" }),
  "chatgpt-codex-desktop": Object.freeze({ source: join(HARNESS_ROOT, "adapters", "chatgpt-codex-desktop", "PROJECT-SUPPORT.md"), target: ".vibecode-harness/tool-guides/chatgpt-codex-desktop.md", status: "git_gate_required" }),
  "lovable-github": Object.freeze({ source: join(HARNESS_ROOT, "adapters", "lovable-github", "VIBECODE-LOVABLE.md"), target: "VIBECODE-LOVABLE.md", status: "github_pr_gate_required" })
});

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) { options._.push(token); continue; }
    const [name, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) { options[name] = inlineValue; continue; }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) { options[name] = next; index += 1; }
    else { options[name] = true; }
  }
  return { command, options };
}

function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function fail(message, code = EXIT.USAGE) {
  process.stderr.write(`gg: ${message}\n`);
  process.exitCode = code;
}

function usage() {
  print(`바이브코드 하네스 실행기

사용법:
  node bin/gg.mjs init --project <폴더> [--tools codex|claude|claude-desktop|chatgpt-desktop|lovable|both|all|codex,claude] [--runtime gg_standard|python_internal|node_web|typescript_web|typescript_postgres] [--level L1|L2|L3] [--ci] [--allow-broad-scope]
      드라이브 루트·홈 디렉터리·저장소 여러 개를 품은 폴더는 거부합니다. 의도한 것이면 --allow-broad-scope 로 승인하고, 그 사실은 lock 에 남습니다.
  node bin/gg.mjs init --interactive
  node bin/gg.mjs configure --project <folder> [--tools codex,claude,claude-desktop,chatgpt-desktop,lovable] [--remove codex,claude,claude-desktop,chatgpt-desktop,lovable]
  node bin/gg.mjs update --project <폴더>
  node bin/gg.mjs migrate --project <폴더> --runtime gg_standard|python_internal|node_web|typescript_web|typescript_postgres [--level L1|L2|L3] [--force]
  node bin/gg.mjs doctor [--project <폴더>]
  node bin/gg.mjs start --project <폴더> --brief <업무 설명>
  node bin/gg.mjs design --project <폴더> [--database yes|no] [--admin yes|no] [--external-api yes|no] [--confirm]
  node bin/gg.mjs package check --project <폴더> --ecosystem npm|pypi --name <패키지> --version <버전>
  node bin/gg.mjs bundle verify --bundle <승인 번들 폴더> [--trust <기관 공개키 목록>]
  node bin/gg.mjs bundle status --installed <설치 폴더> [--candidate <포털에서 받은 승인 번들 폴더>] [--trust <기관 공개키 목록>]
  node bin/gg.mjs bundle cleanup --bundle <설치 폴더> --previous-manifest <이전 승인 manifest> [--backup-dir <폴더>]
  node bin/gg.mjs build --project <폴더>
  node bin/gg.mjs verify --project <폴더> [--run-tests] [--hook] [--local-checker] [--skip-checker] [--no-tests]
      --local-checker 가 없으면 로컬 정책·테스트만 보고 최종 보안 점검은 포털에 맡깁니다(ready_for_portal_scan).
      --local-checker 는 이 PC 의 체커(${MIN_CHECKER_VERSION} 이상)로 표준 점검을 돌려 영수증을 남깁니다.
  node bin/gg.mjs release --project <폴더>

체커는 외부 엔진으로 호출만 합니다. 체커의 배포 판정(gate)은 영수증에 근거와 함께
보존하고 표(승인·조건부 → review_required, 차단 → blocked, 판정 불가 → undetermined)대로
옮겨 적지만, 이 하네스는 그것을 승인으로 바꾸지 않습니다 — verify는 검사 증적의
완전성을 확인하고, release는 사람 검토를 요구합니다.`);
}

function projectPath(options) {
  return resolve(options.project || process.cwd());
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function pathExists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false, windowsHide: true, env: options.env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolvePromise({ code: null, stdout, stderr, error }));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function commandAvailable(command, env = process.env) {
  if (existsSync(command)) return true;
  const probe = process.platform === "win32" ? ["where.exe", [command]] : ["which", [command]];
  const result = await run(probe[0], probe[1], { env });
  return result.code === 0;
}

async function approvedCommand({ bundledPath, fallback, env = process.env }) {
  if (await pathExists(join(HARNESS_ROOT, "bundle.manifest.json"))) {
    return (await pathExists(bundledPath)) ? { command: bundledPath, source: "bundled" } : null;
  }
  if (await pathExists(bundledPath)) return { command: bundledPath, source: "bundled" };
  if (await commandAvailable(fallback, env)) return { command: fallback, source: "system" };
  return null;
}

async function firstExisting(paths) {
  for (const candidate of paths.filter(Boolean)) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function pythonInstallationExecutable(filename, env = process.env) {
  if (process.platform !== "win32") return null;
  const roots = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Python"),
    env.ProgramFiles && join(env.ProgramFiles, "Python"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Python")
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^Python\d+(?:-\d+)?$/i.test(entry.name)) continue;
        candidates.push(filename === "python.exe"
          ? join(root, entry.name, filename)
          : join(root, entry.name, "Scripts", filename));
      }
    } catch { /* A Python installation directory is optional. */ }
  }
  return firstExisting(candidates);
}

async function perUserPythonScript(filename, env = process.env) {
  if (process.platform !== "win32" || !env.APPDATA) return null;
  const root = join(env.APPDATA, "Python");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && /^Python\d+(?:-\d+)?$/i.test(entry.name))
      .map((entry) => join(root, entry.name, "Scripts", filename));
    return firstExisting(candidates);
  } catch {
    return null;
  }
}

async function checkerCommand(env = process.env) {
  if (await pathExists(join(HARNESS_ROOT, "bundle.manifest.json"))) {
    return (await pathExists(BUNDLED_CHECKER_PATH)) ? { command: BUNDLED_CHECKER_PATH, source: "bundled" } : null;
  }
  if (await pathExists(BUNDLED_CHECKER_PATH)) return { command: BUNDLED_CHECKER_PATH, source: "bundled" };
  const userScript = await perUserPythonScript("gvskb.exe", env) || await pythonInstallationExecutable("gvskb.exe", env);
  if (userScript) return { command: userScript, source: "python_user_scripts" };
  return (await commandAvailable("gvskb", env)) ? { command: "gvskb", source: "system" } : null;
}

async function pythonCommand(env = process.env) {
  if (await pathExists(join(HARNESS_ROOT, "bundle.manifest.json"))) {
    return (await pathExists(BUNDLED_PYTHON_PATH)) ? { command: BUNDLED_PYTHON_PATH, source: "bundled" } : null;
  }
  if (await pathExists(BUNDLED_PYTHON_PATH)) return { command: BUNDLED_PYTHON_PATH, source: "bundled" };
  const installedPython = await pythonInstallationExecutable("python.exe", env);
  if (installedPython) return { command: installedPython, source: "python_installation" };
  return (await commandAvailable("python", env)) ? { command: "python", source: "system" } : null;
}

async function runningBundleStatus() {
  const manifest = join(HARNESS_ROOT, "bundle.manifest.json");
  if (!(await pathExists(manifest))) return { status: "developer_install" };
  return verifyBundle({ bundleDir: HARNESS_ROOT, trustPath: TRUST_PATH });
}

/**
 * 체커에 넘길 환경변수 — 기관 프로파일의 `checker_env:` 블록(47차).
 *
 * 폐쇄망 기관은 `GVSKB_MODE: offline`, `GVSKB_INTEL_REQUIRE_SIGNATURE: "1"`, `GVSKB_INTEL_DIR` 같은
 * 값을 모든 개발 PC 에 같은 방식으로 강제해야 한다. 사용자 환경변수에 맡기면 PC 마다 다르고,
 * 빠진 PC 에서는 서명 없는 번들을 받아들인다. 프로파일 사본은 lock 지문으로 보호되므로 여기
 * 적힌 값은 프로젝트 안에서 바뀌지 않는다. 블록이 없으면 빈 객체 — 동작 변화 없음.
 *
 * YAML 전체를 해석하지 않는다(의존성 0 원칙). `checker_env:` 아래 들여쓴 `KEY: value` 줄만 읽고,
 * 키는 `GVSKB_` 또는 `PYTHON` 으로 시작하는 것만 받는다 — 프로파일 파일로 PATH 를 바꾸는 길은 열지 않는다.
 */
// 허용 키 — `GVSKB_*` 와 인코딩 둘뿐이다. 리뷰 지적(H4): `PYTHON*` 전체를 허용하면 공유받은 저장소의
// 프로파일 사본이 PYTHONPATH·PYTHONSTARTUP 으로 체커 프로세스에 임의 코드를 넣을 수 있다.
const CHECKER_ENV_ALLOWED_EXACT = new Set(["PYTHONUTF8", "PYTHONIOENCODING"]);
function checkerEnvKeyAllowed(key) {
  return /^GVSKB_[A-Z0-9_]+$/.test(key) || CHECKER_ENV_ALLOWED_EXACT.has(key);
}

/** 반환 `{ env, error }` — 인라인 맵(`checker_env: { … }`)처럼 못 읽는 형식은 조용히 비우지 않고 error 로 알린다(M6). */
function parseCheckerEnvBlock(text) {
  const env = {};
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*checker_env\s*:/.test(line));
  if (start === -1) return { env, error: null };
  const inline = lines[start].replace(/^\s*checker_env\s*:/, "").replace(/#.*$/, "").trim();
  if (inline && inline !== "{}") {
    return { env, error: "institution-profile.yaml 의 checker_env 는 들여쓴 블록 형식(KEY: value 줄)만 지원합니다 — 인라인 맵 `{ … }` 은 읽지 않습니다." };
  }
  const baseIndent = (lines[start].match(/^\s*/) || [""])[0].length;
  const rejected = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = (line.match(/^\s*/) || [""])[0].length;
    if (indent <= baseIndent) break;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/);
    if (!match) return { env, error: `checker_env 줄을 읽을 수 없습니다: ${line.trim()}` };
    const [, key, rawValue] = match;
    if (!checkerEnvKeyAllowed(key)) { rejected.push(key); continue; }
    let value;
    try {
      if (/^".*"$/.test(rawValue)) value = JSON.parse(rawValue);                 // 큰따옴표 — JSON 규칙으로 이스케이프 해제
      else if (/^'.*'$/.test(rawValue)) value = rawValue.slice(1, -1);          // 작은따옴표 — 글자 그대로
      else value = rawValue.replace(/\s+#.*$/, "");                             // 맨 값 — 뒤의 주석만 떼어낸다
    } catch {
      return { env, error: `checker_env 값을 읽을 수 없습니다: ${key}` };
    }
    if (value) env[key] = String(value);
  }
  if (rejected.length) return { env, error: `checker_env 에 허용되지 않은 키가 있습니다(GVSKB_* · PYTHONUTF8 · PYTHONIOENCODING 만 가능): ${rejected.join(", ")}` };
  return { env, error: null };
}

/**
 * 체커에 넘길 env. `trusted` 가 false 면 프로젝트 사본을 **읽지 않는다** — 사본은 lock 지문이 맞을 때만
 * 믿을 수 있고(H4), 그 전에는 하네스가 배포한 원본 프로파일만 쓴다.
 */
async function checkerEnvForProject(project, base = process.env, { trusted = true } = {}) {
  const snapshot = join(project, ".vibecode-harness", "policy", "institution-profile.yaml");
  const source = trusted && (await pathExists(snapshot)) ? snapshot : INSTITUTION_PROFILE_PATH;
  let parsed = { env: {}, error: null };
  try { parsed = parseCheckerEnvBlock(await readFile(source, "utf8")); } catch (error) { parsed = { env: {}, error: `기관 프로파일을 읽지 못했습니다: ${error.message}` }; }
  return { env: { ...base, ...parsed.env }, overrides: parsed.env, error: parsed.error, source: source === snapshot ? "project_snapshot" : "harness_default" };
}

/**
 * 체커 신원·위협정보 상태 — `gvskb status --json`(0.6.1 부터 `intel`·`gate_contract` 포함).
 *
 * 왜 먼저 묻나(47차): 0.6.0 아래 체커는 패키지 검사를 `--check-deps` 옵션일 때만 한다. 그 체커에
 * 옵션 없는 기본 호출을 하면 패키지를 전혀 보지 않고도 '깨끗함'이 나온다 — 조용한 초록불.
 * 그래서 버전을 확인하지 못하면 검사를 시작하지 않는다. `status` 가 없는 아주 옛 체커는
 * `version` 출력으로 폴백하고, 둘 다 안 되면 '모름'이다(모름은 통과가 아니다).
 */
async function checkerStatusInfo(checker, env = process.env, cwd = undefined) {
  const status = await run(checker.command, ["status", "--json"], { env, cwd });
  if (status.code === 0) {
    try {
      const payload = JSON.parse(status.stdout);
      return {
        version: typeof payload.version === "string" ? payload.version : null,
        intel: payload.intel && typeof payload.intel === "object" ? payload.intel : null,
        gate_contract: payload.gate_contract && typeof payload.gate_contract === "object" ? payload.gate_contract : null,
        commit: payload.install_identity?.commit_id || null,
        source: "status"
      };
    } catch { /* 아래 폴백 */ }
  }
  const version = await run(checker.command, ["version"], { env, cwd });
  const parsed = version.code === 0 ? parseCheckerVersion(version.stdout) : null;
  return { version: parsed ? parsed.join(".") : null, intel: null, gate_contract: null, commit: null, source: parsed ? "version" : "unknown" };
}

/** 버전 하한 미달이면 incomplete 사유, 아니면 null. */
function checkerVersionFailure(info) {
  if (checkerVersionSatisfies(info?.version)) return null;
  return `체커 ${MIN_CHECKER_VERSION} 이상이 필요합니다(현재 ${info?.version || "확인 불가"}). 패키지 검사가 기본 수행되지 않는 버전입니다.`;
}

/** 판정 불가의 사람이 읽는 사유 — 위협정보 공백이면 다음 행동까지 적는다. */
function undeterminedReason(report) {
  const gap = report?.gate?.intel_gap;
  if (gap === "missing") return "위협정보 캐시 없음 — gvskb update-intel 또는 GVSKB_INTEL_DIR 반입 후 재시도";
  return String(report?.gate?.reason || "체커가 검사 범위를 판정하지 못했습니다.");
}

async function getLock(project) {
  const lockPath = join(project, ".vibecode-harness", "harness.lock.json");
  if (!(await pathExists(lockPath))) throw new Error("하네스가 초기화되지 않았습니다. 먼저 gg init을 실행하세요.");
  return { path: lockPath, value: await readJson(lockPath) };
}

async function listFiles(root, current = root, files = []) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await listFiles(root, fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function cleanCommand(command) {
  return String(command || "").replace(/\\/g, "/").toLowerCase();
}

function hasBlockedRuntime(command, policyProfile = "general") {
  return Boolean(runtimeFailureForCommand(policyProfile, cleanCommand(command)));
}

async function packagePolicy(project) {
  const snapshot = join(project, ".vibecode-harness", "policy", "package-policy.json");
  return readJson((await pathExists(snapshot)) ? snapshot : ROOT_PACKAGE_POLICY_PATH);
}

function packageNameFromRequirement(line) {
  const match = String(line).trim().match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(?:===|==|>=|<=|~=|>|<)?/);
  return match?.[1]?.toLowerCase() || null;
}

function packageNamesFromManifest(manifest) {
  const groups = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  return groups.flatMap((group) => Object.keys(manifest[group] || {})).map((name) => name.toLowerCase());
}

async function declaredDependencyCount(project) {
  let count = 0;
  const packageJson = join(project, "package.json");
  if (await pathExists(packageJson)) {
    try { count += packageNamesFromManifest(await readJson(packageJson)).length; } catch { /* policyCheck reports malformed JSON */ }
  }
  for (const filename of ["requirements.txt", "requirements-dev.txt"]) {
    const path = join(project, filename);
    if (!(await pathExists(path))) continue;
    for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
      if (line.trim() && !line.trim().startsWith("#") && packageNameFromRequirement(line)) count += 1;
    }
  }
  return count;
}

function sensitiveTextFindings(value) {
  const text = String(value || "");
  const patterns = [
    ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ["phone", /(?:01[0-9]|0[2-6][0-9])-?\d{3,4}-?\d{4}/],
    ["resident_number", /\b\d{6}-?[1-4]\d{6}\b/],
    ["secret", /(?:api[_-]?key|secret|password|token)\s*[:=]\s*[^\s]+/i]
  ];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function yesNoOption(options, name) {
  if (options[name] === undefined) return "undecided";
  const value = String(options[name]).toLowerCase();
  if (!["yes", "no"].includes(value)) throw new Error(`--${name}은 yes 또는 no여야 합니다.`);
  return value;
}

async function localPackageFailure(project) {
  const policy = await packagePolicy(project);
  const failures = [];
  const packageJson = join(project, "package.json");
  if (await pathExists(packageJson)) {
    try {
      const manifest = await readJson(packageJson);
      const denied = new Set(policy.denied.npm.map((name) => name.toLowerCase()));
      for (const name of packageNamesFromManifest(manifest)) if (denied.has(name)) failures.push(`기관 기본 차단 npm 패키지: ${name}`);
    } catch { /* package.json format failure is handled by policyCheck */ }
  }
  for (const filename of ["requirements.txt", "requirements-dev.txt"]) {
    const path = join(project, filename);
    if (!(await pathExists(path))) continue;
    const denied = new Set(policy.denied.pypi.map((name) => name.toLowerCase()));
    for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const name = packageNameFromRequirement(line);
      if (name && denied.has(name)) failures.push(`기관 기본 차단 PyPI 패키지: ${name}`);
    }
  }
  return failures;
}

async function policyCheck(project, lock) {
  const failures = [];
  const policySnapshot = join(project, ".vibecode-harness", "policy", "harness-core.yaml");
  const profileSnapshot = join(project, ".vibecode-harness", "policy", "institution-profile.yaml");
  const policyProfilesSnapshot = join(project, ".vibecode-harness", "policy", "policy-profiles.json");
  const packageSnapshot = join(project, ".vibecode-harness", "policy", "package-policy.json");
  for (const path of [policySnapshot, profileSnapshot, policyProfilesSnapshot, packageSnapshot]) {
    if (!(await pathExists(path))) failures.push(`필수 정책 사본이 없습니다: ${relative(project, path)}`);
  }
  if (failures.length) return failures;
  // 47차 — 지문은 **전부 있어야** 한다. 예전에는 "구버전 lock 에는 없으니 있을 때만" 검사했는데,
  // 그러면 lock 에서 필드 하나를 지우는 것으로 그 파일의 변조 검사가 꺼졌다. lock 이 구버전이면
  // 통과가 아니라 `gg update` 요구다 — update 가 모든 지문을 다시 쓴다.
  const LOCK_OUTDATED = "lock 이 구버전입니다(지문 누락) — `gg update` 로 올리세요.";
  const digestCheck = async (field, path, missingMessage, changedMessage) => {
    if (!(await pathExists(path))) { failures.push(missingMessage); return; }
    if (typeof lock[field] !== "string" || !lock[field]) { failures.push(`${LOCK_OUTDATED} (${field})`); return; }
    if ((await sha256(path)) !== lock[field]) failures.push(changedMessage);
  };
  await digestCheck("policy_sha256", policySnapshot, "필수 정책 사본이 없습니다: harness-core.yaml", "하네스 정책 파일이 초기화 이후 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  await digestCheck("institution_profile_sha256", profileSnapshot, "필수 정책 사본이 없습니다: institution-profile.yaml", "기관 프로파일이 초기화 이후 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  await digestCheck("package_policy_sha256", packageSnapshot, "필수 정책 사본이 없습니다: package-policy.json", "패키지 정책이 초기화 이후 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  await digestCheck("policy_profiles_sha256", policyProfilesSnapshot, "필수 정책 사본이 없습니다: policy-profiles.json", "Language policy profile snapshot changed after initialization. Reapply the approved harness.");
  await digestCheck("runner_sha256", join(project, ".vibecode-harness", "bin", "gg.mjs"), "프로젝트 실행기 사본이 없습니다. 승인된 하네스를 다시 적용하세요.", "프로젝트 실행기 사본이 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  await digestCheck("release_integrity_sha256", join(project, ".vibecode-harness", "lib", "release-integrity.mjs"), "프로젝트 번들 무결성 검증 모듈이 없습니다. 승인된 하네스를 다시 적용하세요.", "프로젝트 번들 무결성 검증 모듈이 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  await digestCheck("policy_engine_sha256", join(project, ".vibecode-harness", "lib", "policy-engine.mjs"), "Project language policy engine copy is missing. Reapply the approved harness.", "Project language policy engine changed after initialization. Reapply the approved harness.");
  // lock.checker_evidence_sha256 · lock.claude_hook_sha256 — 모든 지문이 같은 규칙(없으면 실패)을 따른다.
  await digestCheck("checker_evidence_sha256", join(project, ".vibecode-harness", "lib", "checker-evidence.mjs"), "프로젝트의 체커 증적 구성 모듈 사본이 없습니다. 승인된 하네스를 다시 적용하세요.", "체커 증적 구성 모듈이 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  if (lock.tools?.includes("claude-code")) {
    await digestCheck("claude_hook_sha256", join(project, ".vibecode-harness", "bin", "claude-pre-tool.mjs"), "Claude Code 훅 사본이 없습니다. 승인된 하네스를 다시 적용하세요.", "Claude Code 훅 사본이 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
    // M1 — settings.json 은 지문 대상이 아니라서 훅 등록을 지워도 아무도 몰랐다. 현행 형식 항목(matcher 포함)이 있어야 한다.
    const settingsPath = join(project, ".claude", "settings.json");
    try {
      const settings = await readJson(settingsPath);
      if (!(settings.hooks?.PreToolUse || []).some(isCurrentClaudeHookEntry)) failures.push("Claude Code 훅 등록(.claude/settings.json)이 없거나 구형입니다 — gg update 로 다시 등록하세요.");
    } catch {
      failures.push("Claude Code 훅 등록 파일(.claude/settings.json)을 읽을 수 없습니다 — gg update 로 다시 등록하세요.");
    }
  }
  // policy_profile 은 지문 대상 파일이 아니라 lock 의 값이다 — runtime 과 어긋나면 손으로 고친 것이다.
  if (lock.policy_profile && lock.runtime_profile && lock.policy_profile !== policyProfileForRuntime(lock.runtime_profile)) {
    failures.push(`lock 의 policy_profile(${lock.policy_profile})이 runtime_profile(${lock.runtime_profile})과 맞지 않습니다. 트랙 변경은 gg migrate 로만 합니다.`);
  }
  // 2차 리뷰 M4 — 하네스가 설치한 Git 훅(.githooks/pre-commit)이 있는데 core.hooksPath 가 풀렸으면 커밋 게이트가 꺼진 것이다.
  if (await pathExists(join(project, ".git")) && await pathExists(join(project, ".githooks", "pre-commit"))) {
    const hooksPath = await run("git", ["config", "--get", "core.hooksPath"], { cwd: project });
    if (hooksPath.code !== null && hooksPath.stdout.trim() !== ".githooks") {
      failures.push(`Git 훅 경로(core.hooksPath)가 .githooks 가 아닙니다(현재: ${hooksPath.stdout.trim() || "미설정"}). 하네스 pre-commit 이 실행되지 않습니다 — git config core.hooksPath .githooks 로 되돌리세요.`);
    }
  }
  const legacyPlugin = join(project, ".agents", "plugins", "vibecode-harness");
  if ((lock.retired_adapters_pending_cleanup || []).includes("google-antigravity") && await pathExists(legacyPlugin)) {
    failures.push("Retired Google Antigravity plugin remains in this project. Remove or independently review it before verification can continue.");
  }
  for (const tool of Object.keys(GUIDANCE_ADAPTERS)) {
    if (!lock.tools?.includes(tool)) continue;
    const adapter = GUIDANCE_ADAPTERS[tool];
    if (!(await pathExists(join(project, adapter.target)))) failures.push(`Required ${tool} support guidance is missing. Reapply the approved harness.`);
  }
  const needsPullRequestGate = (lock.tools || []).some((tool) => Object.hasOwn(GUIDANCE_ADAPTERS, tool));
  if (needsPullRequestGate && !(await pathExists(join(project, ".github", "workflows", "vibecode-harness.yml")))) {
    failures.push("Desktop and GitHub integrations require the VibeCode pull-request policy workflow.");
  }
  const policyProfile = lock.policy_profile || policyProfileForRuntime(lock.runtime_profile);
  if (!getPolicyProfile(policyProfile)) failures.push(`Unknown language policy profile: ${policyProfile}`);
  const files = await listFiles(project);
  const implementationFiles = files.filter((file) => hasAllowedImplementationSource(policyProfile, [file]));
  for (const file of files) {
    const languageFailure = languageFailureForPath(policyProfile, relative(project, file));
    if (languageFailure) failures.push(languageFailure);
  }
  for (const file of files) {
    const extension = extname(file).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(extension)) failures.push(`허용되지 않은 ${BLOCKED_EXTENSIONS.get(extension)} 소스 파일: ${relative(project, file)}`);
  }
  if (lock.runtime_profile === "python_internal") {
    for (const file of implementationFiles) if (extname(file).toLowerCase() !== ".py") failures.push(`Python 트랙에서 허용되지 않은 구현 파일: ${relative(project, file)}`);
  }
  if (lock.runtime_profile === "node_web") {
    for (const file of implementationFiles) if ([".ts", ".tsx"].includes(extname(file).toLowerCase())) failures.push(`Node.js 트랙에서 TypeScript 구현 파일을 발견했습니다: ${relative(project, file)}`);
  }
  if (lock.runtime_profile === "typescript_web" && implementationFiles.length && !implementationFiles.some((file) => [".ts", ".tsx"].includes(extname(file).toLowerCase()))) {
    failures.push("TypeScript 트랙에는 .ts 또는 .tsx 구현 파일이 하나 이상 필요합니다.");
  }
  const packageJson = join(project, "package.json");
  if (await pathExists(packageJson)) {
    try {
      const manifest = await readJson(packageJson);
      for (const [name, command] of Object.entries(manifest.scripts || {})) {
        if (runtimeFailureForCommand(policyProfile, command)) failures.push(`Unsupported runtime invoked by npm script '${name}'`);
        if (hasBlockedRuntime(command)) failures.push(`허용되지 않은 런타임을 호출하는 npm script '${name}'`);
      }
      if (lock.runtime_profile === "python_internal" && Object.keys(manifest.scripts || {}).length > 0) failures.push("Python 트랙에서 package.json 실행 스크립트를 발견했습니다. 트랙을 바꾸거나 예외 검토가 필요합니다.");
    } catch { failures.push("package.json 형식이 올바르지 않습니다."); }
  }
  const pythonIndicators = ["requirements.txt", "pyproject.toml", "Pipfile"];
  if (["node_web", "typescript_web", "typescript_postgres", "typescript_supabase"].includes(lock.runtime_profile)) {
    for (const item of pythonIndicators) if (await pathExists(join(project, item))) failures.push(`${lock.runtime_profile} 트랙에서 Python 의존성 선언을 발견했습니다: ${item}`);
  }
  if (lock.runtime_profile === "python_internal") {
    const nodeEntry = join(project, "package.json");
    if (await pathExists(nodeEntry)) failures.push("Python 트랙에서 package.json을 발견했습니다. 트랙을 바꾸거나 예외 검토가 필요합니다.");
  }
  try {
    const policy = await packagePolicy(project);
    for (const ecosystem of ["npm", "pypi"]) {
      if (!Array.isArray(policy.denied?.[ecosystem]) || !Array.isArray(policy.restricted?.[ecosystem])) {
        failures.push(`패키지 정책 형식이 올바르지 않습니다: ${ecosystem} 목록을 확인하세요.`);
      }
    }
    if (!failures.some((failure) => failure.startsWith("패키지 정책 형식"))) {
      failures.push(...await localPackageFailure(project));
    }
  } catch {
    failures.push("패키지 정책을 읽을 수 없습니다. 승인된 하네스를 다시 적용하세요.");
  }
  return failures;
}

async function runtimeCheck(lock) {
  const checks = [];
  // gg_standard 는 두 축을 모두 쓰므로 **양쪽 런타임이 다 있어야 한다.**
  // 한쪽만 있는 환경에서 통과시키면, 못 돌린 축을 '문제 없음'으로 읽게 된다.
  if (["gg_standard", "node_web", "typescript_web", "typescript_postgres", "typescript_supabase"].includes(lock.runtime_profile)) {
    const result = await run(process.execPath, ["--version"]);
    const major = Number((result.stdout.match(/v(\d+)/) || [])[1]);
    if (!Number.isInteger(major) || major < 22) checks.push(`Node.js 22 이상이 필요합니다. 현재: ${result.stdout.trim() || "확인 불가"}`);
  }
  if (["gg_standard", "python_internal"].includes(lock.runtime_profile) && !(await pythonCommand())) {
    checks.push(lock.runtime_profile === "gg_standard"
      ? "기관 표준 트랙은 PyPI 축을 포함하므로 승인된 Python 런타임이 필요합니다."
      : "Python 트랙에는 승인된 Python 런타임이 필요합니다.");
  }
  return checks;
}

async function writeReceipt(project, name, payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(project, "evidence", `${stamp}-${name}.json`);
  await writeJson(path, { schema_version: 1, created_at: new Date().toISOString(), ...payload });
  return path;
}

const TEST_NOT_CONFIGURED = Object.freeze({ status: "not_configured", reason: "실행할 테스트 명령이 없습니다. L2 이상에서는 테스트를 추가해야 합니다." });

/**
 * 테스트를 아예 실행하지 않기로 하는 사전 판단 — 축과 무관하다.
 * 해당하면 그 결과를, 아니면 null 을 돌려준다.
 */
function testExecutionGate(lock, options) {
  if (options["no-tests"]) {
    if (lock.level !== "L1") return { status: "blocked", reason: "L2 이상에서는 --no-tests를 사용할 수 없습니다." };
    return { status: "skipped", reason: "L1 안내 단계에서만 사용자 요청으로 테스트를 생략했습니다." };
  }
  if (options.hook) return { status: "deferred", reason: "Git 훅에서는 미검증 프로젝트의 테스트 명령을 실행하지 않습니다. CI 또는 사용자가 --run-tests로 명시 실행해야 합니다." };
  return null;
}

/**
 * npm 축 — package.json 의 승인된 test script 만 근거로 삼는다.
 *
 * `tests/` 폴더나 `.py` 파일은 보지 않는다. 혼합 프로젝트에서 축이 서로의
 * 판단 근거를 넘겨다보면 한 축이 다른 축의 명령을 대신 실행하게 된다.
 */
async function runNodeTests(project, options) {
  const packageJson = join(project, "package.json");
  if (!(await pathExists(packageJson))) return TEST_NOT_CONFIGURED;
  const manifest = await readJson(packageJson);
  if (!manifest.scripts?.test) return TEST_NOT_CONFIGURED;
  const declared = String(manifest.scripts.test).trim();
  if (declared !== "node --test") {
    return { status: "blocked", command: declared, reason: "승인된 기본 테스트 명령은 'node --test'뿐입니다. 사용자 확인과 격리 실행 정책을 적용하기 전에는 임의 npm script를 실행하지 않습니다." };
  }
  if (!options["run-tests"]) {
    return { status: "confirmation_required", command: declared, reason: "테스트 실행은 프로젝트 코드를 실행합니다. 내용을 확인한 뒤 --run-tests로 명시 실행하세요." };
  }
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!(await pathExists(npmCli))) {
    return { status: "failed", command: "npm test", reason: "Node.js에 포함된 npm 실행기를 찾을 수 없습니다." };
  }
  const testEnvironment = { ...process.env };
  delete testEnvironment.NODE_TEST_CONTEXT;
  const result = await run(process.execPath, [npmCli, "test"], { cwd: project, env: testEnvironment });
  return { status: result.code === 0 ? "passed" : "failed", command: "npm test", code: result.code, stderr: result.stderr.slice(-2000) };
}

/**
 * PyPI 축이 실행될 프로젝트인지 판단한다.
 *
 * `tests/` 폴더만으로는 판단하지 않는다 — 승인된 npm 명령이 `node --test` 이고
 * 그 기본 탐색 경로도 `tests/` 라서, 혼합 트랙에서 그 폴더는 어느 축의 것인지
 * 말해주지 않는다. 선언 파일이 있어야 Python 프로젝트다.
 *
 * 단일 언어 트랙(python_internal)에서는 그 모호함이 없으므로 종전대로
 * `tests/` 폴더도 근거로 인정한다 — 기존 프로젝트의 동작을 바꾸지 않는다.
 */
async function pythonTestsConfigured(project, { allowTestsDir }) {
  for (const marker of ["pyproject.toml", "pytest.ini", "tox.ini"]) {
    if (await pathExists(join(project, marker))) return true;
  }
  const setupCfg = join(project, "setup.cfg");
  if (await pathExists(setupCfg)) {
    const contents = await readFile(setupCfg, "utf8").catch(() => "");
    if (/^\s*\[tool:pytest\]/m.test(contents)) return true;
  }
  return allowTestsDir ? pathExists(join(project, "tests")) : false;
}

/** PyPI 축 — package.json 존재 여부와 무관하게 동작한다. */
async function runPythonTests(project, options, { allowTestsDir = false } = {}) {
  if (!(await pythonTestsConfigured(project, { allowTestsDir }))) return TEST_NOT_CONFIGURED;
  if (!options["run-tests"]) {
    return { status: "confirmation_required", command: "python -m pytest -q", reason: "테스트 실행은 프로젝트 코드를 실행합니다. 내용을 확인한 뒤 --run-tests로 명시 실행하세요." };
  }
  const python = await pythonCommand();
  if (!python) return { status: "blocked", reason: "Python 런타임을 찾을 수 없습니다. PyPI 축 테스트를 실행할 수 없습니다." };
  const result = await run(python.command, ["-m", "pytest", "-q"], { cwd: project });
  return { status: result.code === 0 ? "passed" : "failed", command: "python -m pytest -q", code: result.code, stderr: result.stderr.slice(-2000) };
}

/** 단일 언어 트랙 — 축이 하나뿐이므로 먼저 설정된 쪽을 쓴다. */
async function runProjectTests(project, lock, options) {
  const gate = testExecutionGate(lock, options);
  if (gate) return gate;
  const node = await runNodeTests(project, options);
  if (node.status !== "not_configured") return node;
  if (["python_internal", "gg_standard"].includes(lock.runtime_profile)) {
    const python = await runPythonTests(project, options, { allowTestsDir: true });
    if (python.status !== "not_configured") return python;
  }
  return TEST_NOT_CONFIGURED;
}

/**
 * gg_standard 는 두 축을 각각 정확히 한 번 돌린다.
 *
 * 한쪽만 통과한 것을 통과로 부르지 않고, 돌지 않은 축도 결과에 남긴다 —
 * 무엇이 실행되지 않았는지가 영수증에서 보여야 한다.
 */
async function runStandardTests(project, lock, options) {
  const gate = testExecutionGate(lock, options);
  if (gate) return gate;
  const axes = [
    { axis: "npm", ...(await runNodeTests(project, options)) },
    { axis: "pypi", ...(await runPythonTests(project, options, { allowTestsDir: false })) }
  ];
  const recorded = axes.map(({ axis, status, command, code, reason }) => ({ axis, status, command: command || null, code: code ?? null, reason: reason ?? null }));
  const ran = axes.filter((item) => item.status !== "not_configured");
  if (ran.length === 0) return { ...TEST_NOT_CONFIGURED, axes: recorded };
  // 가장 나쁜 상태가 전체 상태다 — 한 축이 막히거나 실패하면 통과가 아니다.
  const order = ["blocked", "failed", "confirmation_required", "deferred", "skipped", "not_configured", "passed"];
  const worst = ran.slice().sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0];
  return {
    status: worst.status,
    reason: worst.reason,
    command: recorded.map((item) => `${item.axis}: ${item.command || item.status}`).join(" · "),
    axes: recorded,
    stderr: worst.stderr
  };
}

async function runChecker(project, lock, baseEnv = process.env) {
  const bundle = await runningBundleStatus();
  if (!["developer_install", "verified"].includes(bundle.status)) return { status: "incomplete", reason: "설치된 승인 번들의 무결성을 확인할 수 없습니다. 공식 복구 설치 후 다시 시도하세요.", bundle };
  const { env, overrides: checkerEnv, error: checkerEnvError } = await checkerEnvForProject(project, baseEnv);
  if (checkerEnvError) return { status: "incomplete", reason: `기관 프로파일의 checker_env 를 적용할 수 없습니다 — ${checkerEnvError}` };
  const checker = await checkerCommand(env);
  if (!checker) return { status: "incomplete", reason: "vibecode-checker(gvskb)를 찾을 수 없습니다." };
  // 47차 — 버전 하한. 0.6 아래 체커는 옵션 없이는 패키지를 보지 않는다(조용한 초록불).
  const info = await checkerStatusInfo(checker, env, project);
  const versionFailure = checkerVersionFailure(info);
  if (versionFailure) return { status: "incomplete", reason: versionFailure, checker_version: info.version };
  const sourceFiles = (await listFiles(project)).filter((file) => ALL_CODE_EXTENSIONS.has(extname(file).toLowerCase()));
  if (sourceFiles.length === 0) return { status: "incomplete", reason: "지원되는 구현 소스 파일이 없습니다. 지침·문서 파일만으로는 점검을 통과할 수 없습니다." };
  const profileMap = {
    python_internal: "internal-db-query",
    node_web: "web-civil-service",
    typescript_web: "web-civil-service"
  };
  const profile = profileMap[lock.runtime_profile] || "public-default-strict";
  // 47차 — `--check-deps` 를 뺐다. 0.6 에서 그 옵션은 `--deps online`(외부 조회) 별칭이라, 붙이면
  // 폐쇄망 PC 에서도 외부 조회를 시도하고 로컬 기본값·위협정보 신선도 게이트를 우회한다.
  // `--deps` 는 넘기지 않는다 — 체커 기본 local, 기관은 GVSKB_DEPS_MODE(checker_env)로 바꾼다.
  const args = ["scan", project, "--format", "json", "--stdout", "--profile", profile, "--include-installed", "--env", lock.level === "L3" ? "E2" : "E1", "--fail-on", "block"];
  const result = await run(checker.command, args, { cwd: project, env });
  if (result.code === null) return { status: "incomplete", reason: "체커를 실행할 수 없습니다.", stderr: result.stderr.slice(-2000) };
  // 비판정 종료코드(64 사용법 오류·66 경로 없음)는 verdict 와 무관하게 검사가 아니다(L5).
  if ([64, 66].includes(result.code)) return { status: "incomplete", reason: `체커가 검사를 시작하지 못했습니다(종료코드 ${result.code}).`, exit_code: result.code, stderr: result.stderr.slice(-2000) };
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { return { status: "incomplete", reason: "체커 JSON 결과를 읽을 수 없습니다.", stderr: result.stderr.slice(-2000) }; }
  const scannedFiles = Array.isArray(report.scanned_files) ? report.scanned_files : [];
  const declaredDependencies = await declaredDependencyCount(project);
  const evidence = buildCheckerEvidence({
    checker: checker.source === "bundled" ? "bundled_gvskb" : "system_gvskb",
    report,
    scannedFileCount: scannedFiles.length,
    declaredDependencyCount: declaredDependencies,
    reportSha256: createHash("sha256").update(result.stdout).digest("hex"),
    exitCode: result.code
  });
  const receipt = () => writeReceipt(project, "checker-evidence", { ...evidence, checker_env: checkerEnv, checker_status_source: info.source });
  const common = { scannedFiles: scannedFiles.length, findings: report.summary?.finding_count ?? null, gate_verdict: evidence.checker_gate_verdict, checker_status: evidence.checker_status, dependency_check: evidence.checker_dependency_check };
  // 계약 규칙 ① — **차단은 어떤 미완 사유보다 먼저다**(M2). 범위 결손·프로파일 fallback 이 있어도 차단을
  // '불완전'으로 낮추지 않는다. 근거는 먼저 남긴다 — 차단된 경우가 근거가 가장 필요한 경우다.
  if (evidence.checker_status === "blocked") {
    // 2차 리뷰 L2 — 차단을 먼저 내되, 그 결과가 온전한 검사였는지도 영수증에 남긴다(검토자가 범위 결손을 봐야 한다).
    const coverageReasons = [];
    if (scannedFiles.length === 0) coverageReasons.push("scanned_files_empty");
    if (report.profile_fallback) coverageReasons.push("profile_fallback");
    if ((Array.isArray(report.skipped_files) ? report.skipped_files : []).some((item) => /max_files|최대 파일 수/i.test(String(item?.reason || "")))) coverageReasons.push("file_limit_truncated");
    const blockedAudits = Array.isArray(report.dependency_audit?.audits) ? report.dependency_audit.audits : [];
    if (declaredDependencies > 0 && blockedAudits.some((audit) => audit?.verdict === "unparsed" || audit?.requires_review === true && Number(audit?.parsed_count || 0) === 0)) coverageReasons.push("dependency_audit_unparsed");
    if (evidence.checker_dependency_check?.mode === "off") coverageReasons.push("dependency_check_off");
    const reportPath = await writeReceipt(project, "checker-evidence", { ...evidence, checker_env: checkerEnv, checker_status_source: info.source, coverage_incomplete_reasons: coverageReasons });
    return { status: "blocked", reason: evidence.checker_gate_verdict === "blocked" ? `체커 판정 차단 — ${evidence.checker_gate_reason || "차단 근거는 영수증 참조"}` : "체커가 공식 차단 종료 코드를 반환했습니다.", exit_code: result.code, reportPath, ...common, stderr: result.stderr.slice(-2000) };
  }
  // 차단이 아니면 검사가 온전했는지 본다 — 온전하지 않은 결과는 근거가 되지 못하므로 영수증을 남기지 않는다.
  if (scannedFiles.length === 0) return { status: "incomplete", reason: "체커가 검사한 파일이 없습니다. 대상 경로와 지원 언어를 확인하세요.", report };
  if (report.profile_fallback) return { status: "incomplete", reason: "체커 프로파일 fallback이 발생했습니다.", report };
  const skipped = Array.isArray(report.skipped_files) ? report.skipped_files : [];
  const truncated = skipped.some((item) => /max_files|최대 파일 수/i.test(String(item?.reason || "")));
  if (truncated) return { status: "incomplete", reason: "체커 파일 상한에 도달했습니다. 검사 범위를 나누거나 상한을 조정하세요.", report };
  const audits = Array.isArray(report.dependency_audit?.audits) ? report.dependency_audit.audits : [];
  const dependencyUnparsed = audits.some((audit) => audit?.verdict === "unparsed" || audit?.requires_review === true && Number(audit?.parsed_count || 0) === 0);
  if (declaredDependencies > 0 && dependencyUnparsed) {
    return { status: "incomplete", reason: "선언된 의존성이 있지만 체커 의존성 감사를 완료하지 못했습니다.", declaredDependencies, report };
  }
  // 패키지 검사를 생략한 결과(`--deps off`·GVSKB_DEPS_MODE=off)는 패키지 취약점이 빠진 결과다(L3).
  if (evidence.checker_dependency_check?.mode === "off") {
    return { status: "incomplete", reason: "체커가 패키지 검사를 생략했습니다(dependency_check.mode=off). 기관 설정 GVSKB_DEPS_MODE 를 확인하세요.", report };
  }
  // 0.6 이상인데 gate 가 없으면 계약 밖의 결과다 — 통과가 아니다(M3). 무엇을 돌려줬는지는 영수증으로 남긴다.
  if (!evidence.checker_gate_verdict) {
    const reportPath = await receipt();
    return { status: "incomplete", reason: "체커 결과에 배포 판정(gate.verdict)이 없습니다 — 체커 설치 상태를 확인하세요.", exit_code: result.code, reportPath, ...common };
  }
  const reportPath = await receipt();
  // 판정 불가는 차단이 아니라 '검사하지 못함'이다 — 막힌 곳이 아니라 빠진 것을 고쳐야 한다.
  if (evidence.checker_status === "undetermined") {
    return { status: "incomplete", reason: `체커가 판정하지 못했습니다: ${undeterminedReason(report)}`, exit_code: result.code, intel_gap: evidence.checker_intel_gap, reportPath, ...common, stderr: result.stderr.slice(-2000) };
  }
  if (evidence.checker_status !== "review_required") {
    return { status: "incomplete", reason: "체커 판정을 읽지 못했습니다(gate.verdict 와 종료코드 모두 해석 불가).", exit_code: result.code, reportPath, ...common, stderr: result.stderr.slice(-2000) };
  }
  return { status: "review_required", reportPath, ...common, conditional_criteria: evidence.checker_conditional_criteria };
}

async function packageCommand(options) {
  const project = projectPath(options);
  const action = options._[0];
  const ecosystem = String(options.ecosystem || "").toLowerCase();
  const name = String(options.name || "").trim();
  const version = String(options.version || "").trim();
  if (action !== "check") throw new Error("현재 지원하는 패키지 명령은 'gg package check'뿐입니다. 설치는 승인된 설치기 또는 별도 패키지 작업에서 처리합니다.");
  if (!["npm", "pypi"].includes(ecosystem)) throw new Error("--ecosystem은 npm 또는 pypi여야 합니다.");
  if (!name || !version) throw new Error("--name과 정확한 --version을 입력하세요. 최신 태그나 버전 생략은 허용하지 않습니다.");
  const lock = (await getLock(project)).value;
  const policyFailures = await policyCheck(project, lock);
  if (policyFailures.length) {
    const receipt = await writeReceipt(project, "package-check", { kind: "package_check", status: "blocked", policy_failures: policyFailures, name, version, ecosystem });
    print({ status: "blocked", policy_failures: policyFailures, receipt });
    process.exitCode = EXIT.POLICY_OR_RUNTIME;
    return;
  }
  const policy = await packagePolicy(project);
  if (new Set(policy.denied[ecosystem].map((item) => item.toLowerCase())).has(name.toLowerCase())) {
    const receipt = await writeReceipt(project, "package-check", { kind: "package_check", status: "blocked", reason: "기관 기본 차단 패키지", name, version, ecosystem });
    print({ status: "blocked", reason: "기관 기본 차단 패키지입니다. 대체안 또는 예외 검토를 사용하세요.", name, version, ecosystem, receipt });
    process.exitCode = EXIT.PACKAGE;
    return;
  }
  const bundle = await runningBundleStatus();
  if (!["developer_install", "verified"].includes(bundle.status)) {
    const receipt = await writeReceipt(project, "package-check", { kind: "package_check", status: "incomplete", reason: "설치된 승인 번들의 무결성을 확인할 수 없습니다.", bundle });
    print({ status: "incomplete", reason: "설치된 승인 번들의 무결성을 확인할 수 없습니다. 공식 복구 설치 후 다시 시도하세요.", receipt });
    process.exitCode = EXIT.CHECKER_INCOMPLETE;
    return;
  }
  const { env, overrides: checkerEnv, error: checkerEnvError } = await checkerEnvForProject(project);
  if (checkerEnvError) {
    const receipt = await writeReceipt(project, "package-check", { kind: "package_check", status: "incomplete", reason: checkerEnvError, name, version, ecosystem });
    print({ status: "incomplete", reason: `기관 프로파일의 checker_env 를 적용할 수 없습니다 — ${checkerEnvError}`, receipt });
    process.exitCode = EXIT.CHECKER_INCOMPLETE;
    return;
  }
  const checker = await checkerCommand(env);
  if (!checker) {
    const receipt = await writeReceipt(project, "package-check", { kind: "package_check", status: "incomplete", reason: "vibecode-checker를 찾을 수 없습니다.", name, version, ecosystem });
    print({ status: "incomplete", reason: "체커가 없어 패키지 설치를 승인할 수 없습니다.", receipt });
    process.exitCode = EXIT.CHECKER_INCOMPLETE;
    return;
  }
  const info = await checkerStatusInfo(checker, env, project);
  const versionFailure = checkerVersionFailure(info);
  if (versionFailure) {
    const receipt = await writeReceipt(project, "package-check", { kind: "package_check", status: "incomplete", reason: versionFailure, name, version, ecosystem, checker_version: info.version });
    print({ status: "incomplete", reason: versionFailure, receipt });
    process.exitCode = EXIT.CHECKER_INCOMPLETE;
    return;
  }
  const result = await run(checker.command, ["check-package", name, "--ecosystem", ecosystem, "--version", version, "--env", lock.level === "L3" ? "E2" : "E1"], { cwd: project, env });
  let decision;
  try { decision = JSON.parse(result.stdout); }
  catch {
    const receipt = await writeReceipt(project, "package-check", { kind: "package_check", status: "incomplete", reason: "체커 패키지 결과를 읽을 수 없습니다.", name, version, ecosystem, stderr: result.stderr.slice(-2000) });
    print({ status: "incomplete", reason: "체커 패키지 결과를 읽을 수 없습니다.", receipt });
    process.exitCode = EXIT.CHECKER_INCOMPLETE;
    return;
  }
  // 47차 — 체커 `check-package` 는 '취약'과 '판정 불가'를 둘 다 종료코드 1 로 낸다. 종료코드로 나누면
  // 위협정보가 없는 PC 에서 모든 패키지가 '차단'으로 보인다(실측). JSON 으로 나눈다:
  //   checked=false → 판정 불가(incomplete) · 악성·거부·미존재·KEV → 차단 · 취약 → 차단 · 검토 필요 → review_required
  const hardBlock = ["malicious", "registry_rejected", "not_found"].includes(decision.verdict) || Boolean(decision.in_kev) || Boolean(decision.is_malicious_package);
  const vulnerable = Number(decision.vulnerability_count || 0) > 0 || decision.verdict === "vulnerable";
  const unchecked = decision.checked === false && !hardBlock;
  const checkMode = typeof decision.check_mode === "string" ? decision.check_mode : null;
  // 특정 버전을 지목한 악성 권고가 있는데 이 버전의 해당 여부를 판정하지 못했다 — 통과로 읽히면 안 된다.
  const maliciousPossible = Array.isArray(decision.malicious_possible) ? decision.malicious_possible.map((row) => String(row?.id ?? "")).filter(Boolean) : [];
  let status;
  let reason = null;
  if (hardBlock || vulnerable) status = "blocked";
  else if (unchecked) {
    status = "incomplete";
    reason = `체커가 이 패키지를 판정하지 못했습니다(위협정보 없음 또는 조회 실패, check_mode=${checkMode || "미상"}). '안전'이 아닙니다 — gvskb update-intel 또는 GVSKB_INTEL_DIR 반입 후 다시 확인하세요.`;
  } else if (decision.requires_review) status = "review_required";
  else status = "passed";
  // 종료코드 교차 확인(M5) — scan 과 같은 규칙. 체커 check-package: 0 통과 · 1 취약/판정 불가/검토 · 2 차단.
  // JSON 이 '통과'인데 종료코드가 2 면 차단으로 올리고 충돌을 남긴다. 반대 방향(JSON 차단·종료 0)도 차단이다.
  let exitConflict = null;
  if (Number.isInteger(result.code)) {
    const exitStatus = result.code === 2 ? "blocked" : result.code === 1 ? "review_required" : result.code === 0 ? "passed" : null;
    const rank = { blocked: 3, incomplete: 2, review_required: 1, passed: 0 };
    if (exitStatus && exitStatus !== status && !(status === "incomplete" && exitStatus === "review_required") && !(status === "blocked" && exitStatus === "review_required" && vulnerable)) {
      exitConflict = { exit_code: result.code, json_status: status };
      if (rank[exitStatus] > rank[status]) status = exitStatus;
    }
  }
  const receipt = await writeReceipt(project, "package-check", {
    kind: "package_check", status, reason, name, version, ecosystem, checker: checker.source === "bundled" ? "bundled_gvskb" : "system_gvskb", checker_exit_code: result.code,
    checker_exit_conflict: exitConflict,
    checker_version: info.version, check_mode: checkMode, checker_env: checkerEnv,
    verdict: decision.verdict, severity: decision.verdict_severity ?? null, requires_review: Boolean(decision.requires_review), in_kev: Boolean(decision.in_kev), checked: Boolean(decision.checked),
    vulnerability_count: Number(decision.vulnerability_count || 0), malicious_possible: maliciousPossible
  });
  // 악성 차단은 체커가 종류별로 할 일을 적어 준다(확정 / 버전 미확인 / 구형식 위협정보).
  const next = status === "blocked" && decision.is_malicious_package && decision.note ? String(decision.note)
    : status === "blocked" ? "대체 패키지 또는 승인된 예외 검토를 선택하세요."
    : status === "incomplete" ? "위협정보를 갱신·반입한 뒤 다시 gg package check 를 실행하세요."
      : maliciousPossible.length ? `악성 권고(${maliciousPossible.slice(0, 3).join(", ")})가 있습니다. 공식 저장소에서 의도한 정상 패키지인지 확인한 뒤 승인된 설치 절차에서 진행하세요.`
        : "패키지 설치는 승인된 설치 절차에서 진행하세요.";
  print({ status, reason, name, version, ecosystem, verdict: decision.verdict, checked: Boolean(decision.checked), check_mode: checkMode, requires_review: Boolean(decision.requires_review), malicious_possible: maliciousPossible, receipt, next });
  if (status === "blocked") process.exitCode = EXIT.PACKAGE;
  if (status === "incomplete") process.exitCode = EXIT.CHECKER_INCOMPLETE;
}

async function bundleCommand(options) {
  const action = options._[0];
  const trustPath = resolve(options.trust || TRUST_PATH);
  if (action === "verify") {
    if (!options.bundle || options.bundle === true) throw new Error("bundle verify에는 --bundle <승인 번들 폴더>가 필요합니다.");
    const result = await verifyBundle({ bundleDir: resolve(options.bundle), trustPath });
    print(result);
    if (result.status !== "verified") process.exitCode = EXIT.CHECKER_INCOMPLETE;
    return;
  }
  if (action === "cleanup") {
    if (!options.bundle || options.bundle === true) throw new Error("bundle cleanup requires --bundle <installed bundle folder>.");
    if (!options["previous-manifest"] || options["previous-manifest"] === true) throw new Error("bundle cleanup requires --previous-manifest <previous approved manifest>.");
    const result = await cleanupSupersededBundleFiles({
      bundleDir: resolve(options.bundle),
      previousManifestPath: resolve(options["previous-manifest"]),
      trustPath,
      backupDir: options["backup-dir"] && options["backup-dir"] !== true ? resolve(options["backup-dir"]) : undefined
    });
    print(result);
    return;
  }
  if (action === "status") {
    if (!options.installed || options.installed === true) throw new Error("bundle status에는 --installed <설치 폴더>가 필요합니다.");
    const result = await installationState({
      installedDir: resolve(options.installed),
      candidateDir: options.candidate && options.candidate !== true ? resolve(options.candidate) : null,
      trustPath
    });
    print(result);
    if (!["current", "current_unknown"].includes(result.state)) process.exitCode = EXIT.CHECKER_INCOMPLETE;
    return;
  }
  throw new Error("지원하는 bundle 명령은 verify 또는 status입니다.");
}

function selectedTools(value) {
  const input = String(value || "both").trim().toLowerCase();
  if (input === "both") return [TOOL_NAMES.codex, TOOL_NAMES.claude];
  if (input === "all") return [...new Set(Object.values(TOOL_NAMES))];
  const tokens = input.split(",").map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) throw new Error("--tools에 하나 이상의 AI 도구를 지정하세요.");
  const tools = tokens.map((token) => TOOL_NAMES[token]);
  if (tools.some((tool) => !tool)) {
    throw new Error("--tools는 codex, claude, claude-desktop, chatgpt-desktop, lovable, both, all 또는 쉼표로 구분한 조합이어야 합니다.");
  }
  return [...new Set(tools)];
}

function includesTool(tools, name) {
  return tools.includes(name);
}

async function applyGuidanceAdapter(project, tool) {
  const adapter = GUIDANCE_ADAPTERS[tool];
  if (!adapter) return "not_applicable";
  const destination = join(project, adapter.target);
  if (await pathExists(destination)) return "existing_guidance_preserved";
  await mkdir(dirname(destination), { recursive: true });
  await cp(adapter.source, destination);
  return adapter.status;
}

async function removeGuidanceAdapter(project, tool, managedAdapters) {
  const adapter = GUIDANCE_ADAPTERS[tool];
  if (!adapter) return "not_applicable";
  const ownershipKey = `guidance:${tool}`;
  const destination = join(project, adapter.target);
  const expectedHash = managedAdapters?.[ownershipKey];
  if (typeof expectedHash !== "string" || !await pathExists(destination)) return "existing_guidance_preserved";
  if ((await sha256(destination)) !== expectedHash) return "modified_guidance_preserved";
  if (await pathExists(destination)) await rm(destination, { force: true });
  return "removed";
}

async function interactiveInitCommand(options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("--interactive는 사용자가 응답할 수 있는 터미널에서 실행해야 합니다.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const project = options.project && options.project !== true
      ? options.project
      : await prompt.question(`프로젝트 폴더 [${process.cwd()}]: `);
    const tools = options.tools && options.tools !== true
      ? options.tools
      : await prompt.question("AI 도구 (codex, claude, claude-desktop, chatgpt-desktop, lovable, all) [all]: ");
    const selectedInput = String(tools || "all").trim().toLowerCase();
    const defaultRuntime = "gg_standard";
    const runtime = options.runtime && options.runtime !== true
      ? options.runtime
      : await prompt.question(`프로젝트 유형 (gg_standard, typescript_postgres, typescript_web, node_web, python_internal) [${defaultRuntime}]: `);
    const level = options.level && options.level !== true
      ? options.level
      : await prompt.question("점검 수준 (L1, L2, L3) [L2]: ");
    return initCommand({
      ...options,
      project: project || process.cwd(),
      tools: tools || "all",
      runtime: runtime || defaultRuntime,
      level: level || "L2"
    });
  } finally {
    prompt.close();
  }
}

/**
 * 초기화 범위가 "프로젝트 하나"를 넘는지 본다.
 *
 * 왜 필요한가: 사용자가 작업 폴더 전체(예: `C:\coding`)나 홈 디렉터리에서
 * `gg init` 을 실행한 일이 있었다. 그러면 그 아래의 **서로 무관한 저장소 수십 개**가
 * 한 lock 에 묶이고, `gg verify` 는 옆 프로젝트의 Go 파일 때문에 막히며, Claude
 * 훅은 다른 팀 저장소의 파일 쓰기까지 이 프로젝트의 정책으로 판정한다. 정책이
 * 틀린 것이 아니라 **적용 단위가 틀린 것**인데, 그 상태에서는 어느 차단도 어느
 * 통과도 근거가 되지 못한다.
 *
 * 그래서 다음을 "범위 과다"로 본다.
 *   - 드라이브 루트(`C:\`, `/`)와 사용자 홈 디렉터리
 *   - 깊이 2 안에 자기 `.git` 을 제외한 `.git` 이 2개 이상 (중첩 저장소)
 *   - 서로 다른 바로 아래 하위 폴더에 프로젝트 선언(package.json ·
 *     pyproject.toml · requirements.txt)이 2개 이상 (독립 프로젝트 여럿)
 *
 * 판정만 하고 결정은 호출자가 한다 — init 은 거부하고, doctor 는 경고한다.
 * 이미 초기화된 프로젝트를 이 기준으로 깨뜨리지 않기 위해서다.
 */
const BROAD_SCOPE_SKIP_DIRECTORIES = new Set([...IGNORED_DIRECTORIES, ".claude", ".codex", ".github", ".agents", "__pycache__", ".idea", ".vscode"]);
const PROJECT_MANIFESTS = Object.freeze(["package.json", "pyproject.toml", "requirements.txt"]);

async function safeReaddir(directory) {
  try { return await readdir(directory, { withFileTypes: true }); } catch { return []; }
}

async function broadScopeFindings(project) {
  const root = resolve(project);
  const reasons = [];
  const nestedRepositories = [];
  const manifestProjects = [];
  const sameDirectory = (left, right) => (process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right);

  if (sameDirectory(root, parse(root).root)) reasons.push(`드라이브 루트(${root})는 프로젝트 폴더가 아닙니다.`);
  if (sameDirectory(root, resolve(homedir()))) reasons.push(`사용자 홈 디렉터리(${root})는 프로젝트 폴더가 아닙니다.`);
  if (!(await pathExists(root))) return { broad: reasons.length > 0, reasons, nested_repositories: [], manifest_projects: [] };

  for (const child of await safeReaddir(root)) {
    if (!child.isDirectory() || BROAD_SCOPE_SKIP_DIRECTORIES.has(child.name)) continue;
    const childPath = join(root, child.name);
    const grandchildren = await safeReaddir(childPath);
    if (grandchildren.some((entry) => entry.name === ".git")) nestedRepositories.push(child.name);
    if (grandchildren.some((entry) => entry.isFile() && PROJECT_MANIFESTS.includes(entry.name))) manifestProjects.push(child.name);
    for (const grandchild of grandchildren) {
      if (!grandchild.isDirectory() || BROAD_SCOPE_SKIP_DIRECTORIES.has(grandchild.name)) continue;
      const entries = await safeReaddir(join(childPath, grandchild.name));
      if (entries.some((entry) => entry.name === ".git")) nestedRepositories.push(`${child.name}/${grandchild.name}`);
    }
  }
  if (nestedRepositories.length >= 2) reasons.push(`범위 과다: 하위 저장소 ${nestedRepositories.length}개 포함 (${nestedRepositories.join(", ")})`);
  if (manifestProjects.length >= 2) reasons.push(`범위 과다: 독립 프로젝트 선언 ${manifestProjects.length}개 포함 (${manifestProjects.join(", ")})`);
  return { broad: reasons.length > 0, reasons, nested_repositories: nestedRepositories, manifest_projects: manifestProjects };
}

/**
 * 승인 번들의 파일을 프로젝트로 복사한다. init 과 migrate 가 같은 것을 깐다 —
 * 둘이 갈라지면 마이그레이션한 프로젝트만 옛 파일을 갖게 된다.
 */
async function installHarnessFiles(project) {
  const harnessDir = join(project, ".vibecode-harness");
  await mkdir(join(harnessDir, "policy"), { recursive: true });
  await mkdir(join(harnessDir, "bin"), { recursive: true });
  await mkdir(join(harnessDir, "lib"), { recursive: true });
  await cp(POLICY_PATH, join(harnessDir, "policy", "harness-core.yaml"));
  await cp(INSTITUTION_PROFILE_PATH, join(harnessDir, "policy", "institution-profile.yaml"));
  await cp(POLICY_PROFILES_PATH, join(harnessDir, "policy", "policy-profiles.json"));
  await cp(ROOT_PACKAGE_POLICY_PATH, join(harnessDir, "policy", "package-policy.json"));
  await cp(join(HARNESS_ROOT, "adapters"), join(harnessDir, "adapters"), { recursive: true });
  // The source tree may retain an empty directory after a retired adapter is
  // removed on Windows. Never ship or recreate that adapter in a project.
  await rm(join(harnessDir, "adapters", "antigravity"), { recursive: true, force: true });
  await cp(join(HARNESS_ROOT, "bin", "gg.mjs"), join(harnessDir, "bin", "gg.mjs"));
  await cp(join(HARNESS_ROOT, "bin", "claude-pre-tool.mjs"), join(harnessDir, "bin", "claude-pre-tool.mjs"));
  await cp(RELEASE_INTEGRITY_PATH, join(harnessDir, "lib", "release-integrity.mjs"));
  await cp(POLICY_ENGINE_PATH, join(harnessDir, "lib", "policy-engine.mjs"));
  await cp(CHECKER_EVIDENCE_PATH, join(harnessDir, "lib", "checker-evidence.mjs"));
  return harnessDir;
}

/** lock 에 새길 지문. verify 가 이 값으로 변조를 잡는다. */
async function harnessFileDigests(harnessDir) {
  return {
    policy_sha256: await sha256(join(harnessDir, "policy", "harness-core.yaml")),
    institution_profile_sha256: await sha256(join(harnessDir, "policy", "institution-profile.yaml")),
    policy_profiles_sha256: await sha256(join(harnessDir, "policy", "policy-profiles.json")),
    package_policy_sha256: await sha256(join(harnessDir, "policy", "package-policy.json")),
    runner_sha256: await sha256(join(harnessDir, "bin", "gg.mjs")),
    release_integrity_sha256: await sha256(join(harnessDir, "lib", "release-integrity.mjs")),
    policy_engine_sha256: await sha256(join(harnessDir, "lib", "policy-engine.mjs")),
    checker_evidence_sha256: await sha256(join(harnessDir, "lib", "checker-evidence.mjs")),
    claude_hook_sha256: await sha256(join(harnessDir, "bin", "claude-pre-tool.mjs"))
  };
}

async function initCommand(options) {
  const project = projectPath(options);
  const tools = selectedTools(options.tools || "both");
  const requestedRuntime = options.runtime || "gg_standard";
  const runtime = requestedRuntime === "typescript_supabase" ? "typescript_postgres" : requestedRuntime;
  const level = options.level || "L2";
  if (!MIGRATABLE_RUNTIMES.includes(runtime)) throw new Error("허용되지 않은 --runtime 값입니다.");
  if (includesTool(tools, TOOL_NAMES.lovable) && !["gg_standard", "typescript_postgres"].includes(runtime)) throw new Error("Lovable GitHub projects require the gg_standard or typescript_postgres runtime profile.");
  if (!['L1', 'L2', 'L3'].includes(level)) throw new Error("--level은 L1, L2, L3 중 하나여야 합니다.");
  const harnessDir = join(project, ".vibecode-harness");
  const lockPath = join(harnessDir, "harness.lock.json");
  if (await pathExists(lockPath)) throw new Error("이미 초기화된 프로젝트입니다. 기존 lock을 덮어쓰지 않습니다. 트랙을 바꾸려면 gg migrate를 쓰세요.");
  // 파일을 하나라도 쓰기 전에 범위를 본다. 거부할 때는 폴더도 만들지 않는다.
  const scope = await broadScopeFindings(project);
  const allowBroadScope = Boolean(options["allow-broad-scope"]);
  if (scope.broad && !allowBroadScope) {
    const detected = [...scope.nested_repositories, ...scope.manifest_projects];
    throw new Error([
      "범위 과다: 이 폴더는 하네스 프로젝트 하나로 초기화하기에 너무 넓습니다.",
      ...scope.reasons.map((reason) => `  - ${reason}`),
      detected.length ? `감지된 하위 프로젝트: ${[...new Set(detected)].join(", ")}` : null,
      "특정 하위 프로젝트 폴더 하나를 골라 그 폴더를 --project 로 지정해 다시 실행하세요.",
      "이 폴더 전체를 한 프로젝트로 다루는 것이 의도라면 --allow-broad-scope 를 붙여 명시적으로 승인할 수 있습니다. 그 승인은 lock 과 영수증에 남습니다."
    ].filter(Boolean).join("\n"));
  }
  await mkdir(project, { recursive: true });
  await installHarnessFiles(project);
  const lock = {
    schema_version: 3,
    harness_version: "0.3.0",
    project_id: randomUUID(),
    created_at: new Date().toISOString(),
    level,
    runtime_profile: runtime,
    policy_profile: policyProfileForRuntime(runtime),
    tools,
    allowed_languages: getPolicyProfile(policyProfileForRuntime(runtime)).allowed_languages,
    ...(await harnessFileDigests(harnessDir)),
    managed_adapters: {},
    // 47차 — 체커 0.6 의 gate.verdict 계약을 소비한다(표: lib/checker-evidence.mjs CHECKER_STATUS_BY_VERDICT).
    checker_machine_verdict: "gate_v1",
    checker_status_by_verdict: { ...CHECKER_STATUS_BY_VERDICT },
    min_checker_version: MIN_CHECKER_VERSION
  };
  // 넓은 범위를 사용자가 명시적으로 승인한 사실은 lock 에 남긴다 — 나중에 doctor 가
  // 같은 경고를 낼 때 "그때 알고 승인한 것"과 "모르고 넘어간 것"을 구분할 수 있어야 한다.
  const broadScopeOverride = scope.broad && allowBroadScope
    ? { allowed_at: new Date().toISOString(), reasons: scope.reasons, nested_repositories: scope.nested_repositories, manifest_projects: scope.manifest_projects }
    : null;
  if (broadScopeOverride) lock.broad_scope_override = broadScopeOverride;
  await writeJson(lockPath, lock);
  if (includesTool(tools, TOOL_NAMES.codex)) {
    if (!(await pathExists(join(project, "AGENTS.md")))) await cp(CODEX_TEMPLATE_PATH, join(project, "AGENTS.md"));
    await mkdir(join(project, ".codex"), { recursive: true });
    await writeFile(join(project, ".codex", "vibecode-harness.md"), "Use AGENTS.md and run gg verify before completion.\n", "utf8");
    lock.managed_adapters.codex_companion = true;
  }
  let claudeSettingsStatus = "not_selected";
  if (includesTool(tools, TOOL_NAMES.claude)) {
    if (!(await pathExists(join(project, "CLAUDE.md")))) await cp(CLAUDE_TEMPLATE_PATH, join(project, "CLAUDE.md"));
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(join(project, ".claude", "vibecode-harness.md"), "Use CLAUDE.md and run gg verify before completion.\n", "utf8");
    const claudeSettingsPath = join(project, ".claude", "settings.json");
    lock.managed_adapters.claude_companion = true;
    if (!(await pathExists(claudeSettingsPath))) {
      await writeJson(claudeSettingsPath, { hooks: { PreToolUse: [{ matcher: CLAUDE_HOOK_MATCHER, hooks: [claudeHookEntry()] }] } });
      claudeSettingsStatus = "created";
    } else {
      try {
        const settings = await readJson(claudeSettingsPath);
        const backup = join(harnessDir, "backups", `claude-settings-${Date.now()}.json`);
        await cp(claudeSettingsPath, backup);
        const result = ensureClaudeHook(settings);
        await writeJson(claudeSettingsPath, settings);
        claudeSettingsStatus = result.status === "already_configured" ? "already_configured" : "merged_with_backup";
      } catch {
        claudeSettingsStatus = "manual_required_invalid_settings";
      }
    }
  }
  const guidanceAdapters = {};
  for (const tool of tools.filter((item) => GUIDANCE_ADAPTERS[item])) {
    const status = await applyGuidanceAdapter(project, tool);
    guidanceAdapters[tool] = status;
    lock.managed_adapters[`guidance:${tool}`] = status !== "existing_guidance_preserved" ? await sha256(join(project, GUIDANCE_ADAPTERS[tool].target)) : null;
  }
  await mkdir(join(project, "evidence"), { recursive: true });
  const gitignorePath = join(project, ".gitignore");
  const existingGitignore = (await pathExists(gitignorePath)) ? await readFile(gitignorePath, "utf8") : "";
  await writeFile(gitignorePath, `${existingGitignore}\n.vibecode-harness/local/\nevidence/*.log\n`, "utf8");
  const gitAvailable = await commandAvailable("git");
  let hook = "Git을 찾지 못해 훅을 설치하지 않았습니다.";
  if (gitAvailable && await pathExists(join(project, ".git"))) {
    const existing = await run("git", ["config", "--get", "core.hooksPath"], { cwd: project });
    if (existing.code === 0 && existing.stdout.trim() && existing.stdout.trim() !== ".githooks") {
      hook = `기존 Git hooksPath(${existing.stdout.trim()})를 보존했습니다. 훅은 자동 설치하지 않았습니다.`;
    } else {
      const command = "node .vibecode-harness/bin/gg.mjs verify --project . --hook";
      const configuredHook = join(project, ".githooks", "pre-commit");
      const defaultHook = join(project, ".git", "hooks", "pre-commit");
      const activeHook = existing.code === 0 && existing.stdout.trim() === ".githooks" ? configuredHook : defaultHook;
      if (await pathExists(activeHook)) {
        const existingHook = await readFile(activeHook, "utf8");
        hook = existingHook.includes(command)
          ? "Git pre-commit 훅이 이미 적용되어 있습니다."
          : `기존 pre-commit 훅(${relative(project, activeHook)})을 보존했습니다. 수동 병합이 필요합니다.`;
      } else {
        await mkdir(dirname(configuredHook), { recursive: true });
        await writeFile(configuredHook, `#!/usr/bin/env sh\n${command}\n`, "utf8");
        const configured = await run("git", ["config", "core.hooksPath", ".githooks"], { cwd: project });
        hook = configured.code === 0 ? "Git pre-commit 훅을 설치했습니다." : "Git 훅 파일은 만들었지만 hooksPath 설정에 실패했습니다.";
      }
    }
  }
  let ci = "not_requested";
  if (options.ci || tools.some((tool) => Object.hasOwn(GUIDANCE_ADAPTERS, tool))) {
    const workflowPath = join(project, ".github", "workflows", "vibecode-harness.yml");
    if (await pathExists(workflowPath)) ci = "existing_workflow_preserved";
    else {
      await mkdir(dirname(workflowPath), { recursive: true });
      await cp(CI_TEMPLATE_PATH, workflowPath);
      ci = "created_requires_approved_windows_runner";
    }
  }
  await writeJson(lockPath, lock);
  await writeReceipt(project, "init", { kind: "harness_init", runtime, tools: lock.tools, level, git_hook: hook, ci, claude_settings: claudeSettingsStatus, guidance_adapters: guidanceAdapters, broad_scope_override: broadScopeOverride });
  print({ status: "initialized", project, runtime, tools: lock.tools, level, git_hook: hook, ci, claude_settings: claudeSettingsStatus, guidance_adapters: guidanceAdapters, broad_scope_override: broadScopeOverride, next: "gg doctor --project <프로젝트 폴더>" });
}

/**
 * 이미 초기화된 프로젝트의 트랙을 바꾼다.
 *
 * 왜 필요한가: `gg init` 은 기존 lock 을 거부하고 `gg configure` 는 도구만
 * 다룬다. 그래서 **한 번 정한 runtime 을 바꿀 방법이 없었다.** 기관이 표준
 * 트랙(gg_standard)을 새로 정해도 기존 프로젝트는 옛 트랙에 묶인 채였고,
 * 표준에 맞춰 일하려면 정책을 우회하는 수밖에 없었다 — 그러면 정책이 아니라
 * 우회가 표준이 된다.
 *
 * 좁히는 방향에서는 지금 있는 파일이 새 정책을 위반할 수 있다. 그 경우
 * 조용히 위반 상태로 만들지 않고 **무엇이 걸리는지 보여 주고 멈춘다.**
 */
async function migrateCommand(options) {
  const project = projectPath(options);
  const lockRecord = await getLock(project);
  const lock = lockRecord.value;
  const runtime = options.runtime;
  if (!runtime) throw new Error("gg migrate에는 --runtime이 필요합니다. 예: gg migrate --runtime gg_standard");
  if (!MIGRATABLE_RUNTIMES.includes(runtime)) throw new Error(`허용되지 않은 --runtime 값입니다. 가능한 값: ${MIGRATABLE_RUNTIMES.join(", ")}`);
  const level = options.level || lock.level;
  if (!["L1", "L2", "L3"].includes(level)) throw new Error("--level은 L1, L2, L3 중 하나여야 합니다.");

  const fromProfile = lock.policy_profile;
  const toProfile = policyProfileForRuntime(runtime);
  if (lock.runtime_profile === runtime && level === lock.level) {
    print({ status: "unchanged", runtime_profile: runtime, policy_profile: toProfile, reason: "이미 그 트랙입니다." });
    return;
  }

  // 좁아지는 경우에만 기존 파일을 확인한다. 넓어지는 쪽은 걸릴 것이 없고,
  // 큰 프로젝트 전체를 훑는 비용만 든다.
  const before = new Set(getPolicyProfile(fromProfile)?.allowed_implementation_extensions || []);
  const after = new Set(getPolicyProfile(toProfile)?.allowed_implementation_extensions || []);
  const dropped = [...before].filter((extension) => !after.has(extension));
  let violations = [];
  if (dropped.length > 0) {
    const files = await listFiles(project);
    violations = files.filter((file) => languageFailureForPath(toProfile, file)).map((file) => relative(project, file));
  }
  if (violations.length > 0 && !options.force) {
    const receipt = await writeReceipt(project, "migrate", {
      kind: "migrate", status: "blocked", from: fromProfile, to: toProfile,
      dropped_extensions: dropped, violation_count: violations.length, violations: violations.slice(0, 50)
    });
    print({
      status: "blocked",
      reason: `새 트랙이 허용하지 않는 파일이 ${violations.length}개 있습니다. 옮기거나 지운 뒤 다시 실행하세요.`,
      dropped_extensions: dropped,
      violations: violations.slice(0, 20),
      receipt
    });
    process.exitCode = EXIT.POLICY_OR_RUNTIME;
    return;
  }

  // 옛 lock 을 남긴다 — 무엇에서 무엇으로 옮겼는지 되짚을 수 있어야 한다.
  const harnessDir = join(project, ".vibecode-harness");
  await mkdir(join(harnessDir, "backups"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeJson(join(harnessDir, "backups", `${stamp}-harness.lock.json`), lock);

  await installHarnessFiles(project);
  const migrated = {
    ...lock,
    level,
    runtime_profile: runtime,
    policy_profile: toProfile,
    allowed_languages: getPolicyProfile(toProfile).allowed_languages,
    ...(await harnessFileDigests(harnessDir)),
    migrated_from: { runtime_profile: lock.runtime_profile, policy_profile: fromProfile, level: lock.level },
    migrated_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await writeJson(lockRecord.path, migrated);
  const receipt = await writeReceipt(project, "migrate", {
    kind: "migrate", status: "migrated",
    from: { runtime_profile: lock.runtime_profile, policy_profile: fromProfile, level: lock.level },
    to: { runtime_profile: runtime, policy_profile: toProfile, level },
    allowed_languages: migrated.allowed_languages,
    forced_over_violations: violations.length > 0 ? violations.length : 0
  });
  print({
    status: "migrated",
    from: { runtime_profile: lock.runtime_profile, policy_profile: fromProfile },
    to: { runtime_profile: runtime, policy_profile: toProfile },
    allowed_languages: migrated.allowed_languages,
    receipt,
    next: "gg verify를 실행해 새 트랙에서 검증하세요."
  });
}

/**
 * 프로젝트의 하네스 사본을 현재 승인 번들로 다시 깐다. 트랙은 건드리지 않는다.
 *
 * 왜 필요한가: 하네스를 고쳐도 **이미 초기화된 프로젝트에는 닿을 방법이 없었다.**
 * init 은 기존 lock 을 거부하고, configure 는 도구만 다루고, migrate 는 트랙이
 * 같으면 아무것도 하지 않는다. 그래서 훅의 결함을 고쳐도 그 훅을 실제로 쓰는
 * 프로젝트는 옛 파일을 계속 쓰게 된다 — 고친 것이 도달하지 않는 수정이다.
 */
async function updateCommand(options) {
  const project = projectPath(options);
  const lockRecord = await getLock(project);
  const lock = lockRecord.value;
  const harnessDir = join(project, ".vibecode-harness");

  // Google Antigravity is no longer a supported adapter.  Older projects may
  // still carry its copied plugin and lock metadata; retire only the plugin we
  // created, and leave a user-owned plugin in place for explicit review.
  const retiredAdapters = [];
  const removedLegacyFiles = [];
  const manualReviewRequired = [];
  const legacyAntigravity = "google-antigravity";
  const legacyPlugin = join(project, ".agents", "plugins", "vibecode-harness");
  const previousPendingRetirements = lock.retired_adapters_pending_cleanup || [];
  const pendingRetirements = new Set(previousPendingRetirements);
  if ((lock.tools || []).includes(legacyAntigravity) || pendingRetirements.has(legacyAntigravity)) {
    const plugin = legacyPlugin;
    if (lock.managed_adapters?.antigravity_plugin && await pathExists(plugin)) {
      await rm(plugin, { recursive: true, force: false });
      removedLegacyFiles.push(relative(project, plugin));
      retiredAdapters.push(legacyAntigravity);
      pendingRetirements.delete(legacyAntigravity);
    } else if (await pathExists(plugin)) {
      // 소유가 불분명한 플러그인은 지우지 않는다 — 사용자가 직접 만든 것일 수 있다.
      // 대신 lock 에 남겨 verify 가 계속 막게 한다.
      pendingRetirements.add(legacyAntigravity);
      manualReviewRequired.push(relative(project, plugin));
      retiredAdapters.push(`${legacyAntigravity}:manual_plugin_review_required`);
    } else {
      pendingRetirements.delete(legacyAntigravity);
    }
    lock.tools = lock.tools.filter((tool) => tool !== legacyAntigravity);
    delete lock.antigravity_hook_sha256;
    if (lock.managed_adapters) delete lock.managed_adapters.antigravity_plugin;
  }
  for (const legacyPath of [
    join(harnessDir, "bin", "antigravity-pre-tool.mjs"),
    join(harnessDir, "adapters", "antigravity")
  ]) {
    if (await pathExists(legacyPath)) {
      await rm(legacyPath, { recursive: true, force: true });
      removedLegacyFiles.push(relative(project, legacyPath));
      if (!retiredAdapters.includes(legacyAntigravity)) retiredAdapters.push(legacyAntigravity);
    }
  }
  // 무엇을 지웠고 무엇을 남겼는지는 update 영수증 한 줄로는 부족하다 — 지운 파일이
  // 하네스 소유였다는 근거와 남긴 파일이 왜 남았는지가 따로 남아야 한다.
  let legacyRemovalReceipt = null;
  if (removedLegacyFiles.length || manualReviewRequired.length) {
    legacyRemovalReceipt = await writeReceipt(project, "legacy-adapter-removed", {
      kind: "legacy_adapter_removed",
      adapter: legacyAntigravity,
      removed_files: removedLegacyFiles,
      manual_review_required: manualReviewRequired,
      reason: "Google Antigravity 는 2026-09-13 지원 대상에서 폐기됐다. 하네스가 생성한 파일만 제거하고 소유가 불분명한 경로는 남긴다."
    });
  }

  const before = await harnessFileDigests(harnessDir).catch(() => ({}));
  await mkdir(join(harnessDir, "backups"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeJson(join(harnessDir, "backups", `${stamp}-harness.lock.json`), lock);

  await installHarnessFiles(project);
  const after = await harnessFileDigests(harnessDir);
  const changed = Object.keys(after).filter((key) => before[key] !== after[key]);

  // 사본만 새로 깔고 등록 형식을 그대로 두면, 옛 상대 경로 훅은 여전히 프로젝트
  // 밖에서 정책 검사 없이 통과한다. 파일을 고친 것이 등록에 닿아야 한다.
  let claudeHook = "not_selected";
  if ((lock.tools || []).includes(TOOL_NAMES.claude)) {
    const settingsPath = join(project, ".claude", "settings.json");
    if (!(await pathExists(settingsPath))) {
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeJson(settingsPath, { hooks: { PreToolUse: [{ matcher: CLAUDE_HOOK_MATCHER, hooks: [claudeHookEntry()] }] } });
      claudeHook = "added";
    } else {
      try {
        const settings = await readJson(settingsPath);
        const result = ensureClaudeHook(settings);
        if (result.status !== "already_configured") {
          await cp(settingsPath, join(harnessDir, "backups", `claude-settings-before-update-${stamp}.json`));
          await writeJson(settingsPath, settings);
        }
        claudeHook = result.status;
      } catch {
        claudeHook = "manual_required_invalid_settings";
      }
    }
  }

  const pendingCleanupChanged = JSON.stringify([...pendingRetirements]) !== JSON.stringify(previousPendingRetirements);
  const somethingChanged = changed.length > 0 || retiredAdapters.length > 0 || pendingCleanupChanged || ["added", "migrated"].includes(claudeHook) || lock.checker_machine_verdict !== "gate_v1";
  if (pendingRetirements.size) lock.retired_adapters_pending_cleanup = [...pendingRetirements];
  else delete lock.retired_adapters_pending_cleanup;
  // 47차 — 계약 표식도 함께 올린다(구 lock 의 pending_upstream_machine_verdict → gate_v1).
  const updated = {
    ...lock, ...after,
    // L8 — runtime 과 어긋난 policy_profile 은 update 가 복구한다(migrate 는 같은 트랙이면 unchanged 로 끝난다).
    policy_profile: policyProfileForRuntime(lock.runtime_profile),
    allowed_languages: getPolicyProfile(policyProfileForRuntime(lock.runtime_profile))?.allowed_languages || lock.allowed_languages,
    checker_machine_verdict: "gate_v1",
    checker_status_by_verdict: { ...CHECKER_STATUS_BY_VERDICT },
    min_checker_version: MIN_CHECKER_VERSION,
    updated_at: new Date().toISOString()
  };
  await writeJson(lockRecord.path, updated);
  const receipt = await writeReceipt(project, "update", {
    kind: "update", status: somethingChanged ? "updated" : "unchanged",
    runtime_profile: lock.runtime_profile, policy_profile: lock.policy_profile,
    changed_files: changed, claude_hook: claudeHook, retired_adapters: retiredAdapters,
    removed_legacy_files: removedLegacyFiles, manual_review_required: manualReviewRequired, legacy_removal_receipt: legacyRemovalReceipt
  });
  print({
    status: somethingChanged ? "updated" : "unchanged",
    runtime_profile: lock.runtime_profile,
    policy_profile: lock.policy_profile,
    changed_files: changed,
    claude_hook: claudeHook,
    retired_adapters: retiredAdapters,
    removed_legacy_files: removedLegacyFiles,
    manual_review_required: manualReviewRequired,
    receipt,
    next: somethingChanged ? "gg verify로 새 사본에서 검증하세요." : "이미 현재 번들과 같습니다."
  });
}

async function configureCommand(options) {
  const project = projectPath(options);
  const lockRecord = await getLock(project);
  const lock = lockRecord.value;
  if (!options.tools && !options.remove) throw new Error("configure requires --tools or --remove.");

  const current = new Set(lock.tools || []);
  const desired = options.tools ? new Set(selectedTools(options.tools)) : new Set(current);
  if (options.remove) for (const tool of selectedTools(options.remove)) desired.delete(tool);
  if (!desired.size) throw new Error("At least one AI tool must remain selected for a managed project.");
  if (desired.has(TOOL_NAMES.lovable) && !["gg_standard", "typescript_postgres", "typescript_supabase"].includes(lock.runtime_profile)) throw new Error("Lovable GitHub support requires an existing gg_standard or typescript_postgres project. Create or migrate the project with one of those policy profiles first.");

  const harnessDir = join(project, ".vibecode-harness");
  const changes = { added: [], removed: [], preserved: [] };
  lock.managed_adapters = lock.managed_adapters || {};

  if (desired.has(TOOL_NAMES.codex) && !current.has(TOOL_NAMES.codex)) {
    const agents = join(project, "AGENTS.md");
    if (!(await pathExists(agents))) await cp(CODEX_TEMPLATE_PATH, agents);
    await mkdir(join(project, ".codex"), { recursive: true });
    await writeFile(join(project, ".codex", "vibecode-harness.md"), "Use AGENTS.md and run gg verify before completion.\n", "utf8");
    lock.managed_adapters.codex_companion = true;
    changes.added.push("codex");
  }

  if (desired.has(TOOL_NAMES.claude) && !current.has(TOOL_NAMES.claude)) {
    const claude = join(project, "CLAUDE.md");
    if (!(await pathExists(claude))) await cp(CLAUDE_TEMPLATE_PATH, claude);
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(join(project, ".claude", "vibecode-harness.md"), "Use CLAUDE.md and run gg verify before completion.\n", "utf8");
    const settingsPath = join(project, ".claude", "settings.json");
    let settings = { hooks: { PreToolUse: [] } };
    if (await pathExists(settingsPath)) {
      try {
        await mkdir(join(harnessDir, "backups"), { recursive: true });
        await cp(settingsPath, join(harnessDir, "backups", `claude-settings-before-configure-${Date.now()}.json`));
        settings = await readJson(settingsPath);
      } catch { throw new Error("Existing Claude Code settings.json is invalid. Fix it before configuring the harness."); }
    }
    ensureClaudeHook(settings);
    await writeJson(settingsPath, settings);
    lock.managed_adapters.claude_companion = true;
    changes.added.push("claude-code");
  }

  for (const tool of Object.keys(GUIDANCE_ADAPTERS)) {
    if (!desired.has(tool) || current.has(tool)) continue;
    const status = await applyGuidanceAdapter(project, tool);
    lock.managed_adapters[`guidance:${tool}`] = status !== "existing_guidance_preserved" ? await sha256(join(project, GUIDANCE_ADAPTERS[tool].target)) : null;
    changes.added.push(tool);
    if (status === "existing_guidance_preserved") changes.preserved.push(`${tool}-guidance`);
  }
  if (desired.size && [...desired].some((tool) => Object.hasOwn(GUIDANCE_ADAPTERS, tool))) {
    const workflowPath = join(project, ".github", "workflows", "vibecode-harness.yml");
    if (!(await pathExists(workflowPath))) {
      await mkdir(dirname(workflowPath), { recursive: true });
      await cp(CI_TEMPLATE_PATH, workflowPath);
    } else {
      changes.preserved.push("existing-pr-gate-workflow");
    }
  }

  if (!desired.has(TOOL_NAMES.codex) && current.has(TOOL_NAMES.codex)) {
    const companion = join(project, ".codex", "vibecode-harness.md");
    if (lock.managed_adapters.codex_companion && await pathExists(companion)) await rm(companion, { force: true });
    else changes.preserved.push("codex-companion");
    changes.preserved.push("AGENTS.md");
    delete lock.managed_adapters.codex_companion;
    changes.removed.push("codex");
  }

  if (!desired.has(TOOL_NAMES.claude) && current.has(TOOL_NAMES.claude)) {
    const settingsPath = join(project, ".claude", "settings.json");
    if (await pathExists(settingsPath)) {
      try {
        const settings = await readJson(settingsPath);
        await mkdir(join(harnessDir, "backups"), { recursive: true });
        await cp(settingsPath, join(harnessDir, "backups", `claude-settings-before-remove-${Date.now()}.json`));
        const entries = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
        settings.hooks = settings.hooks || {};
        settings.hooks.PreToolUse = entries.map((entry) => ({ ...entry, hooks: Array.isArray(entry.hooks) ? entry.hooks.filter((hook) => !isVibecodeClaudeHook(hook)) : [] })).filter((entry) => entry.hooks.length);
        await writeJson(settingsPath, settings);
      } catch { changes.preserved.push("claude-settings-invalid"); }
    }
    const companion = join(project, ".claude", "vibecode-harness.md");
    if (lock.managed_adapters.claude_companion && await pathExists(companion)) await rm(companion, { force: true });
    else changes.preserved.push("claude-companion");
    changes.preserved.push("CLAUDE.md");
    delete lock.managed_adapters.claude_companion;
    changes.removed.push("claude-code");
  }

  for (const tool of Object.keys(GUIDANCE_ADAPTERS)) {
    if (desired.has(tool) || !current.has(tool)) continue;
    const status = await removeGuidanceAdapter(project, tool, lock.managed_adapters);
    if (status !== "removed") changes.preserved.push(`${tool}-guidance`);
    delete lock.managed_adapters[`guidance:${tool}`];
    changes.removed.push(tool);
  }

  lock.tools = [...desired];
  lock.updated_at = new Date().toISOString();
  await writeJson(lockRecord.path, lock);
  const receipt = await writeReceipt(project, "configure", { kind: "harness_configure", tools: lock.tools, changes });
  print({ status: "configured", project, tools: lock.tools, changes, receipt, next: "gg doctor --project <project-folder>" });
}

async function doctorCommand(options) {
  const project = projectPath(options);
  let lock = null;
  let lockError = null;
  try { lock = await getLock(project); } catch (error) { lockError = error.message; }
  // H4 — 프로젝트 사본의 checker_env 는 lock 지문이 맞을 때만 쓴다. 지문 검사 전에 사본 env 로 체커를 띄우면
  // 공유받은 저장소의 프로파일이 doctor 한 번으로 임의 환경을 넣는다. 실패하면 하네스 원본 프로파일만 쓰고 경고한다.
  const policyFailures = lock ? await policyCheck(project, lock.value) : null;
  const envTrusted = Boolean(lock) && policyFailures.length === 0;
  const { env: checkerEnvironment, overrides: checkerEnv, error: checkerEnvError, source: checkerEnvSource } = await checkerEnvForProject(project, process.env, { trusted: envTrusted });
  const [git, checker] = await Promise.all([commandAvailable("git"), checkerCommand(checkerEnvironment)]);
  const bundle = await runningBundleStatus();
  const nodeVersion = process.version;
  // 47차 — 체커가 "있다"로 끝내지 않는다. 버전 하한과 위협정보 상태까지 묻는다. 버전 미달이면
  // 패키지 검사가 기본 수행되지 않는 체커이므로 doctor 도 실패(41)다.
  let checkerReport = { status: "not_installed" };
  const checkerWarnings = [];
  if (checker) {
    const info = await checkerStatusInfo(checker, checkerEnvironment, (await pathExists(project)) ? project : undefined);
    const versionFailure = checkerVersionFailure(info);
    const intel = info.intel || null;
    checkerReport = {
      status: versionFailure ? "version_too_old" : "available",
      source: checker.source,
      version: info.version,
      min_version: MIN_CHECKER_VERSION,
      commit: info.commit,
      intel: intel ? { state: intel.state ?? null, as_of: intel.as_of ?? null, age_days: intel.age_days ?? null, max_age_days: intel.max_age_days ?? null, missing: intel.missing ?? [], stale: intel.stale ?? [], signature: intel.signature ?? null, offline_mode: intel.offline_mode ?? null } : null,
      checker_env: checkerEnv,
      checker_env_source: checkerEnvSource,
      status_source: info.source
    };
    if (versionFailure) checkerWarnings.push(`ERROR ${versionFailure}`);
    if (lock && !envTrusted) checkerWarnings.push("WARN 정책 지문 검사에 실패해 프로젝트 사본의 checker_env 를 적용하지 않았습니다(하네스 원본 프로파일 사용). gg update 로 사본을 복구하세요.");
    if (checkerEnvError) checkerWarnings.push(`WARN ${checkerEnvError}`);
    if (intel?.state === "missing") checkerWarnings.push("WARN 위협정보 캐시가 없습니다 — 패키지 검사가 전부 판정 불가가 됩니다. (인터넷망) gvskb update-intel · (폐쇄망) GVSKB_INTEL_DIR 반입");
    else if (intel?.state === "stale") checkerWarnings.push(`WARN 위협정보가 ${intel.age_days ?? "?"}일 전 것입니다(기준 ${intel.max_age_days ?? "?"}일) — 패키지 판정이 조건부로 내려갑니다.`);
    else if (!intel && info.source !== "status") checkerWarnings.push("WARN 체커가 status --json 을 지원하지 않아 위협정보 상태를 확인하지 못했습니다.");
    if (intel?.signature && intel.signature.required === false) checkerWarnings.push("WARN 위협정보 번들 서명이 '필수'가 아닙니다 — 폐쇄망 자동 반입을 켠 기관은 GVSKB_INTEL_REQUIRE_SIGNATURE=1 을 checker_env 에 두세요.");
  }
  const adapters = {};
  if (lock?.value.tools.includes("codex")) {
    const agents = join(project, "AGENTS.md");
    adapters.codex = (await pathExists(agents)) && /vibecode-harness/.test(await readFile(agents, "utf8")) ? "applied" : "repair_required";
  }
  if (lock?.value.tools.includes("claude-code")) {
    const claude = join(project, "CLAUDE.md");
    const settings = join(project, ".claude", "settings.json");
    // 옛 상대 경로 형식은 '적용됨'이 아니다 — 프로젝트 밖에서는 정책 검사 없이
    // 통과하는 형식이므로, gg update 로 바꿔야 한다는 것을 따로 말해 준다.
    let hookState = "missing";
    try {
      const parsed = await readJson(settings);
      const entries = parsed.hooks?.PreToolUse || [];
      const hooks = entries.flatMap((entry) => Array.isArray(entry?.hooks) ? entry.hooks : []);
      // matcher 까지 현행이어야 '적용됨'이다(M1) — 훅 명령만 현행이고 matcher 가 좁으면 PowerShell 도구는 여전히 빠져나간다.
      if (entries.some(isCurrentClaudeHookEntry)) hookState = "current";
      else if (hooks.some(isVibecodeClaudeHook)) hookState = "legacy";
    } catch { /* reported below */ }
    if (!(await pathExists(claude)) || hookState === "missing") adapters.claude_code = "repair_required";
    else adapters.claude_code = hookState === "legacy" ? "update_required" : "applied";
  }
  for (const tool of Object.keys(GUIDANCE_ADAPTERS)) {
    if (!lock?.value.tools.includes(tool)) continue;
    const adapter = GUIDANCE_ADAPTERS[tool];
    adapters[tool] = await pathExists(join(project, adapter.target)) ? adapter.status : "repair_required";
  }
  let gitHook = "not_applicable";
  if (git && await pathExists(join(project, ".git"))) {
    const config = await run("git", ["config", "--get", "core.hooksPath"], { cwd: project });
    gitHook = config.code === 0 && config.stdout.trim() === ".githooks" && await pathExists(join(project, ".githooks", "pre-commit")) ? "applied" : "not_applied";
  }
  const result = {
    status: lock ? "ready_for_verify" : "not_initialized",
    project,
    node: nodeVersion,
    git,
    git_hook: gitHook,
    checker: checkerReport,
    bundle,
    adapters,
    harness: lock?.value ?? null,
    message: lockError || (checker
      ? (checkerReport.status === "version_too_old" ? `체커가 너무 오래됐습니다(${checkerReport.version} < ${MIN_CHECKER_VERSION}). 체커를 올린 뒤 다시 실행하세요.` : "하네스와 체커 실행 경로를 확인했습니다.")
      : "체커가 없어 표준 보안 점검은 실행할 수 없습니다.")
  };
  if (lock) result.policy_failures = policyFailures;
  // 범위 과다는 경고다, 실패가 아니다. 이미 그렇게 초기화돼 굴러가는 프로젝트를
  // 여기서 막으면 사용자는 doctor 를 안 돌리게 될 뿐이다 — 대신 눈에 띄게 남긴다.
  const scope = await broadScopeFindings(project);
  result.warnings = [...checkerWarnings, ...(scope.broad ? scope.reasons.map((reason) => `WARN ${reason}`) : [])];
  if (scope.broad && lock?.value.broad_scope_override) result.warnings.push(`WARN 이 범위는 init 시점(${lock.value.broad_scope_override.allowed_at})에 --allow-broad-scope 로 명시 승인됐습니다.`);
  if (checkerReport.status === "version_too_old") result.status = "checker_update_required";
  print(result);
  if (!lock || checkerReport.status === "version_too_old") process.exitCode = EXIT.CHECKER_INCOMPLETE;
}

async function startCommand(options) {
  const project = projectPath(options);
  await getLock(project);
  if (!options.brief || options.brief === true) throw new Error("--brief에 업무 설명을 입력하세요.");
  const sensitive = sensitiveTextFindings(options.brief);
  if (sensitive.length) throw new Error(`업무 설명에 개인정보 또는 비밀값으로 보이는 내용이 있습니다: ${sensitive.join(", ")}. 실제 값 대신 범주형 설명을 입력하세요.`);
  const path = join(project, "evidence", "feature-brief.md");
  if (await pathExists(path)) throw new Error("이미 feature-brief.md가 있습니다. 기존 요구사항을 덮어쓰지 않습니다.");
  await writeFile(path, `# 업무 기능 요약\n\n${options.brief}\n\n## 확인할 질문\n\n- 누가 사용하나요? 실제 이름·부서명은 기록하지 않습니다.\n- 입력·확인·저장해야 할 정보의 범주는 무엇인가요?\n- 종료 뒤에도 결과를 다시 찾아야 하나요?\n- 다른 사람의 현황·오류·이력을 관리해야 하나요?\n- 개인정보·인증정보·외부 API·파일 업로드가 필요한가요?\n`, "utf8");
  print({ status: "created", artifact: path, next: "gg design --project <프로젝트 폴더>" });
}

async function designCommand(options) {
  const project = projectPath(options);
  const lock = (await getLock(project)).value;
  const brief = join(project, "evidence", "feature-brief.md");
  if (!(await pathExists(brief))) throw new Error("먼저 gg start로 업무 설명과 질문을 기록하세요.");
  const designDir = join(project, "evidence", "design");
  await mkdir(designDir, { recursive: true });
  const artifacts = {
    screen_map: join(designDir, "screen-map.md"),
    function_spec: join(designDir, "screen-function-spec.md"),
    data_admin_decision: join(designDir, "data-and-admin-decision.md"),
    prototype: join(designDir, "screen-prototype.html"),
    decision: join(designDir, "design-decision.json"),
    visual_review: join(designDir, "visual-review-receipt.json")
  };
  const contents = {
    screen_map: "# 화면 목록\n\n- 시작 화면\n- 핵심 업무 화면\n- 결과 또는 저장 화면\n- 관리자 화면: 필요할 때만 추가\n",
    function_spec: "# 화면 기능 명세\n\n각 화면에서 사용자가 입력하는 것, 클릭하는 것, 확인하는 결과를 적습니다.\n",
    data_admin_decision: "# 데이터·관리자 판단\n\n- 브라우저를 닫은 뒤에도 결과를 다시 찾아야 하나요?\n- 여러 사람이 같은 자료를 확인·수정하나요?\n- 한 사람이 처리 현황과 오류를 확인해야 하나요?\n\n답변에 따라 DB와 관리자 화면 필요 여부를 결정합니다.\n"
  };
  for (const [name, path] of Object.entries(artifacts)) {
    if (contents[name] && !(await pathExists(path))) await writeFile(path, contents[name], "utf8");
  }
  if (!(await pathExists(artifacts.prototype))) {
    await writeFile(artifacts.prototype, `<!doctype html><html lang="ko"><meta charset="utf-8"><title>업무 화면 시안</title><style>body{font-family:system-ui,sans-serif;margin:48px;line-height:1.6;color:#10213d}main{max-width:900px}section{border:1px solid #cbd7ed;border-radius:8px;padding:24px;margin-top:20px}button{background:#476dc0;color:#fff;border:0;border-radius:6px;padding:12px 18px;font-weight:700}</style><main><h1>업무 도구 화면 시안</h1><p>사용자가 먼저 확인할 핵심 업무와 결과를 이 화면에서 정리합니다.</p><section><h2>시작</h2><p>사용자가 필요한 업무를 선택하고 필요한 정보를 입력합니다.</p><button type="button">업무 시작</button></section><section><h2>결과 확인</h2><p>처리 결과와 다음 행동을 한눈에 확인합니다.</p></section></main></html>`, "utf8");
  }
  const decision = {
    schema_version: 1,
    project_id: lock.project_id,
    created_at: new Date().toISOString(),
    database: yesNoOption(options, "database"),
    admin: yesNoOption(options, "admin"),
    external_api: yesNoOption(options, "external-api"),
    visual_interface: "html_prototype"
  };
  await writeJson(artifacts.decision, decision);
  if (options.confirm) {
    await writeJson(artifacts.visual_review, { schema_version: 1, review_kind: "html_prototype", reviewed_at: new Date().toISOString(), project_id: lock.project_id, prototype: relative(project, artifacts.prototype), decision });
  }
  print({ status: options.confirm ? "design_confirmed" : "design_artifacts_ready", artifacts, next: options.confirm ? "gg build --project <프로젝트 폴더>" : "screen-prototype.html을 확인한 뒤 gg design --confirm을 실행하세요." });
}

async function designFailures(project, lock) {
  if (lock.level === "L1") return [];
  const designDir = join(project, "evidence", "design");
  const failures = [];
  if (!(await pathExists(join(project, "evidence", "feature-brief.md")))) failures.push("L2 이상에서는 gg start로 업무 요약을 먼저 기록해야 합니다.");
  if (!(await pathExists(join(designDir, "design-decision.json")))) failures.push("L2 이상에서는 DB·관리자·외부 연계 판단을 기록해야 합니다.");
  if (!(await pathExists(join(designDir, "visual-review-receipt.json")))) failures.push("L2 이상에서는 HTML 화면 시안을 확인한 뒤 gg design --confirm을 실행해야 합니다.");
  return failures;
}

async function buildCommand(options) {
  const project = projectPath(options);
  const lock = (await getLock(project)).value;
  const failures = [...await policyCheck(project, lock), ...await runtimeCheck(lock), ...await designFailures(project, lock)];
  const receipt = await writeReceipt(project, "build-check", { kind: "build_check", status: failures.length ? "failed" : "passed", failures });
  print({ status: failures.length ? "blocked" : "ready", failures, receipt });
  if (failures.length) process.exitCode = EXIT.POLICY_OR_RUNTIME;
}

async function verifyCommand(options) {
  const project = projectPath(options);
  const lock = (await getLock(project)).value;
  const policyFailures = await policyCheck(project, lock);
  const runtimeFailures = await runtimeCheck(lock);
  const design = await designFailures(project, lock);
  if (policyFailures.length || runtimeFailures.length || design.length) {
    const receipt = await writeReceipt(project, "verify", { kind: "verify", status: "blocked", policy_failures: policyFailures, runtime_failures: runtimeFailures, design_failures: design });
    print({ status: "blocked", policy_failures: policyFailures, runtime_failures: runtimeFailures, design_failures: design, receipt });
    process.exitCode = EXIT.POLICY_OR_RUNTIME;
    return;
  }
  const test = lock.runtime_profile === "gg_standard"
    ? await runStandardTests(project, lock, options)
    : await runProjectTests(project, lock, options);
  if (test.status === "failed" || test.status === "blocked" || test.status === "confirmation_required") {
    const receipt = await writeReceipt(project, "verify", { kind: "verify", status: "test_failed", test });
    print({ status: "blocked", test, receipt });
    process.exitCode = EXIT.TEST;
    return;
  }
  if (lock.level !== "L1" && test.status === "not_configured") {
    const receipt = await writeReceipt(project, "verify", { kind: "verify", status: "test_not_configured", test });
    print({ status: "blocked", test, receipt });
    process.exitCode = EXIT.TEST;
    return;
  }
  if (!options["local-checker"]) {
    const checker = {
      status: "server_scan_required",
      reason: "Local language and project-policy checks passed. Request the final security scan from the portal after development is complete."
    };
    const receipt = await writeReceipt(project, "verify", {
      kind: "verify",
      status: "ready_for_portal_scan",
      test,
      checker,
      final_release_decision: "portal_scan_required"
    });
    print({ status: "ready_for_portal_scan", test, checker, receipt, next: "Complete the final server-side security scan in the portal before release." });
    return;
  }
  const checker = options["skip-checker"] ? { status: "incomplete", reason: "체커를 생략했습니다. 보안 검증을 통과한 것으로 처리하지 않습니다." } : await runChecker(project, lock);
  const status = checker.status === "blocked" ? "blocked" : checker.status === "incomplete" ? "incomplete" : "review_required";
  const receipt = await writeReceipt(project, "verify", { kind: "verify", status, test, checker, final_release_decision: checker.status === "review_required" ? "checker_review_required" : "not_eligible" });
  print({ status, test, checker, receipt, next: status === "review_required" ? "커밋은 가능하지만, 배포·이관은 사람 검토와 gg release 확인이 필요합니다." : "오류를 해결한 뒤 다시 gg verify를 실행하세요." });
  if (checker.status === "blocked") process.exitCode = EXIT.CHECKER_BLOCK;
  if (checker.status === "incomplete") process.exitCode = EXIT.CHECKER_INCOMPLETE;
}

async function releaseCommand(options) {
  const project = projectPath(options);
  const lock = (await getLock(project)).value;
  const manifest = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    project_id: lock.project_id,
    status: "checker_review_required",
    reason: "체커의 기계 판정(gate.verdict)은 영수증에 보존되지만, 이 하네스는 배포·이관을 자동 승인하지 않습니다. 승인은 포털의 사람 검토에서만 이뤄집니다.",
    human_review_required: true,
    user_message: "사람 검토 필요: 배포·이관 전에는 최신 체커 보고서와 미해결 항목을 검토하고 승인 기록을 남겨야 합니다.",
    required_human_actions: ["최신 체커 HTML·JSON 보고서 확인", "미해결 항목 확인", "승인 기록"]
  };
  const path = join(project, "evidence", "release-manifest.json");
  await writeJson(path, manifest);
  print({ status: "review_required", manifest: path, message: manifest.reason });
  process.exitCode = EXIT.CHECKER_REVIEW;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || options.help) return usage();
  try {
    if (command === "init" && options.interactive) await interactiveInitCommand(options);
    else if (command === "init") await initCommand(options);
    else if (command === "configure") await configureCommand(options);
    else if (command === "migrate") await migrateCommand(options);
    else if (command === "update") await updateCommand(options);
    else if (command === "doctor") await doctorCommand(options);
    else if (command === "start") await startCommand(options);
    else if (command === "design") await designCommand(options);
    else if (command === "package") await packageCommand(options);
    else if (command === "bundle") await bundleCommand(options);
    else if (command === "build") await buildCommand(options);
    else if (command === "verify") await verifyCommand(options);
    else if (command === "release") await releaseCommand(options);
    else fail(`알 수 없는 명령입니다: ${command}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), EXIT.SYSTEM);
  }
}

await main();
