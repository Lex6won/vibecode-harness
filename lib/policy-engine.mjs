import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

const LANGUAGE_BY_EXTENSION = Object.freeze({
  ".py": "Python",
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".jsx": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".java": "Java",
  ".go": "Go",
  ".php": "PHP",
  ".rb": "Ruby",
  ".cs": "C#",
  ".rs": "Rust",
  ".c": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".cxx": "C++",
  ".h": "C/C++",
  ".hpp": "C/C++",
  ".swift": "Swift",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".sh": "Shell",
  ".ps1": "PowerShell",
  ".fs": "F#",
  ".vb": "Visual Basic"
});

const JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx"]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx"]);
const PYTHON_EXTENSIONS = new Set([".py"]);
const CODE_EXTENSIONS = new Set(Object.keys(LANGUAGE_BY_EXTENSION));
const TYPESCRIPT_POSTGRES_PROFILE = Object.freeze({
  id: "typescript_postgres",
  display_name: "JavaScript · TypeScript · PostgreSQL 공통형",
  allowed_languages: ["javascript", "typescript"],
  allowed_implementation_extensions: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"],
  allowed_runtime_families: ["node", "supabase-deno"],
  package_manager: ["npm"],
  strict_typescript: false
});

// 기관 표준 혼합 트랙.
//
// 기관 프로파일이 선언하는 기능 언어는 python · javascript · typescript 셋이고
// (institution-profile.yaml: allowed_function_implementation_languages), 패키지
// 생태계는 PyPI 와 npm 이 **둘 다 1급**이다(package-policy.json 의 denied/
// restricted 가 양쪽 키를 갖고, `gg package check` 는 --ecosystem npm|pypi 를 받는다).
//
// 그런데 선택 가능한 runtime 은 전부 그보다 좁아, **선언된 표준을 표현할 수 있는
// 트랙이 없었다.** 세 언어를 모두 담는 프로파일은 `general` 뿐인데 그것은 runtime
// 미지정 시 떨어지는 fallback 이라, 기관 표준을 "정해지지 않은 상태"로 두는 셈이었다.
//
// gg_standard 는 그 공백을 메운다. Python 을 예외로 덧붙이는 것이 아니라 PyPI 축
// (Python)과 npm 축(JS/TS)을 **대칭으로** 인정하는 정식 트랙이다. 공공 바이브코딩
// 포털이 실제로 그런 구조다 — 서버는 Node, 패키지 게이트는 gvskb_gate.py(PyPI)와
// gvskb_gate.js(npm) 한 쌍, 배포용 골든 템플릿은 Python 프로젝트다.
const GG_STANDARD_PROFILE = Object.freeze({
  id: "gg_standard",
  display_name: "기관 표준 (Python · JavaScript · TypeScript · PyPI · npm)",
  allowed_languages: ["python", "javascript", "typescript"],
  allowed_implementation_extensions: [".py", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"],
  allowed_runtime_families: ["node", "python"],
  package_manager: ["npm", "pip"],
  strict_typescript: false
});

export const POLICY_PROFILES = Object.freeze({
  gg_standard: GG_STANDARD_PROFILE,
  general: Object.freeze({
    id: "general",
    display_name: "기본 호환형 (Python · JavaScript · TypeScript)",
    allowed_languages: ["python", "javascript", "typescript"],
    allowed_implementation_extensions: [".py", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"],
    allowed_runtime_families: ["node", "python"],
    package_manager: ["npm", "pip"],
    strict_typescript: false
  }),
  typescript_web: Object.freeze({
    id: "typescript_web",
    display_name: "TypeScript 웹",
    allowed_languages: ["javascript", "typescript"],
    allowed_implementation_extensions: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"],
    allowed_runtime_families: ["node"],
    package_manager: ["npm"],
    strict_typescript: false
  }),
  typescript_postgres: TYPESCRIPT_POSTGRES_PROFILE,
  // Legacy project locks remain valid; new projects use typescript_postgres.
  typescript_supabase: TYPESCRIPT_POSTGRES_PROFILE,
  python_internal: Object.freeze({
    id: "python_internal",
    display_name: "Python 업무자동화",
    allowed_languages: ["python"],
    allowed_implementation_extensions: [".py"],
    allowed_runtime_families: ["python"],
    package_manager: ["pip"],
    strict_typescript: false
  })
});

export const RUNTIME_PROFILE_TO_POLICY = Object.freeze({
  gg_standard: "gg_standard",
  node_web: "typescript_web",
  typescript_web: "typescript_web",
  typescript_postgres: "typescript_postgres",
  typescript_supabase: "typescript_postgres",
  python_internal: "python_internal"
});

export function policyProfileForRuntime(runtimeProfile) {
  return RUNTIME_PROFILE_TO_POLICY[runtimeProfile] || "general";
}

export function getPolicyProfile(profileId) {
  return POLICY_PROFILES[profileId] || null;
}

export function sourceExtensionsForProfile(profileId) {
  return new Set(getPolicyProfile(profileId)?.allowed_implementation_extensions || []);
}

function isAllowedJavaScriptSupportFile(filePath) {
  const name = basename(filePath).toLowerCase();
  return /(?:^|\.)(?:test|spec)\.[cm]?jsx?$/.test(name)
    || /^(?:vite|vitest|eslint|prettier|postcss|tailwind|playwright|jest)\.config\.[cm]?js$/.test(name);
}

export function languageFailureForPath(profileId, filePath) {
  const profile = getPolicyProfile(profileId) || POLICY_PROFILES.general;
  const extension = extname(filePath).toLowerCase();
  if (!CODE_EXTENSIONS.has(extension)) return null;
  if (profile.allowed_implementation_extensions.includes(extension)) return null;
  if (profile.strict_typescript && JAVASCRIPT_EXTENSIONS.has(extension) && isAllowedJavaScriptSupportFile(filePath)) return null;
  if (profile.id === "general") return `${LANGUAGE_BY_EXTENSION[extension] || extension} 파일은 기관 기본 언어 정책에서 허용하지 않습니다: ${filePath}`;
  return `${LANGUAGE_BY_EXTENSION[extension] || extension} 파일은 '${profile.display_name}' 정책에서 허용하지 않습니다: ${filePath}`;
}

export function hasImplementationSource(profileId, filePath) {
  const profile = getPolicyProfile(profileId) || POLICY_PROFILES.general;
  const extension = extname(filePath).toLowerCase();
  return profile.allowed_implementation_extensions.includes(extension)
    && !(profile.strict_typescript && JAVASCRIPT_EXTENSIONS.has(extension) && isAllowedJavaScriptSupportFile(filePath));
}

export function hasAllowedImplementationSource(profileId, files) {
  return files.some((file) => hasImplementationSource(profileId, file));
}

/** 다른 명령줄을 인자로 받아 실행하는 것들 — 그 인자도 명령으로 봐야 한다. */
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "env", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "xargs", "nohup", "time", "sudo", "doas"]);
const COMMAND_SEPARATORS = new Set([";", "&", "&&", "|", "||", "(", ")", "{", "}", "\n"]);

/**
 * 명령줄을 따옴표를 지키며 토큰으로 쪼개고, 각 토큰이 **명령 자리**인지 표시한다.
 *
 * 왜 필요한가: 예전에는 명령줄 **문자열 전체**에 정규식을 걸었다. 그래서 따옴표
 * 안의 평범한 글자도 명령으로 읽혔다. 실제로 커밋 메시지에 'Python' 이라는
 * 낱말이 들어갔다는 이유로 커밋이 차단됐다.
 *
 * 그 반대 방향도 문제다. 차단이 우연히 걸리는 것이면 통과도 우연이다 —
 * 정책이 무엇을 막고 무엇을 막지 않는지 아무도 말할 수 없게 된다.
 *
 * 명령 자리는 문장의 처음이거나 구분자(`;` `&&` `||` `|` …) 바로 뒤다.
 * 따옴표는 벗겨서 토큰 값으로 쓴다 — `"npm" install` 은 여전히 npm 실행이다.
 */
function commandPositionTokens(command) {
  const text = String(command || "");
  const tokens = [];
  let current = "";
  let quote = null;
  let hasContent = false;

  const flush = () => {
    if (hasContent) tokens.push(current);
    current = "";
    hasContent = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
      else { current += character; hasContent = true; }
      continue;
    }
    if (character === "'" || character === '"') { quote = character; hasContent = true; continue; }
    if (character === "\\" && isEscapeBackslash(text, index)) {
      // 이스케이프된 다음 글자는 구분자로 보지 않는다. (`C:\Python311\python.exe` 의 `\P` 는 경로 구분자다.)
      current += text[index + 1];
      hasContent = true;
      index += 1;
      continue;
    }
    if (/\s/.test(character)) { flush(); if (character === "\n") tokens.push("\n"); continue; }
    if (";&|()".includes(character)) {
      flush();
      const next = text[index + 1];
      if ((character === "&" || character === "|") && next === character) { tokens.push(character + next); index += 1; }
      else tokens.push(character);
      continue;
    }
    current += character;
    hasContent = true;
  }
  flush();

  const result = [];
  let atCommandPosition = true;
  for (const token of tokens) {
    if (COMMAND_SEPARATORS.has(token)) { atCommandPosition = true; continue; }
    result.push({ token, atCommandPosition, index: result.length });
    // `FOO=1 npm i x` · `env FOO=1 npm i x` · `corepack npm install x` · `sudo npm i x` — 할당과 접두 래퍼 다음도 명령 자리다.
    atCommandPosition = atCommandPosition && (ASSIGNMENT_TOKEN.test(token) || PREFIX_WRAPPERS.has(executableName(token)));
  }
  return result;
}

const ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIX_WRAPPERS = new Set(["env", "nohup", "sudo", "doas", "time", "corepack", "command", "exec", "builtin", "nice", "stdbuf"]);

/** 백슬래시가 이스케이프인가 — 다음 글자가 경로 글자(영숫자·`.`·`_`)면 Windows 구분자로 보고 그대로 둔다. */
function isEscapeBackslash(text, index) {
  const next = text[index + 1];
  return next !== undefined && !/[A-Za-z0-9_.]/.test(next);
}

/** 경로·확장자를 떼어낸 실행 파일 이름. `/usr/bin/python3.exe` → `python3` */
function executableName(token) {
  const base = String(token).replace(/\\/g, "/").toLowerCase().split("/").pop() || "";
  const name = base.replace(/\.(?:exe|cmd|bat|ps1)$/, "");
  // `python3.11`·`pip3.11` 같은 버전 접미는 같은 실행 파일이다.
  return name.replace(/^(python|pip)3\.\d+$/, "$13");
}

/**
 * 명령 자리에 있는 실행 파일 이름들. 셸 래퍼의 인자도 명령줄로 보고 파고든다 —
 * `bash -c "pip install x"` 을 놓치면 검사는 형식만 남는다.
 */
function invokedExecutables(command, depth = 0) {
  const names = [];
  const tokens = commandPositionTokens(command);
  for (const entry of tokens) {
    if (!entry.atCommandPosition) continue;
    const name = executableName(entry.token);
    if (!name) continue;
    names.push(name);
    if (depth < 3 && SHELL_WRAPPERS.has(name)) {
      // 래퍼 뒤에 오는 인자들을 각각 명령줄로 한 번 더 본다.
      for (const argument of tokens.slice(entry.index + 1)) {
        if (/\s/.test(argument.token)) names.push(...invokedExecutables(argument.token, depth + 1));
        else names.push(executableName(argument.token));
      }
    }
  }
  return names;
}

// 47차 — deno·bun(별도 JS 런타임)·perl·lua 추가. bun 의 설치 명령(`bun add`)은 아래
// isDirectPackageInstall 이 먼저 잡고, 그 밖의 bun 실행은 여기서 승인되지 않은 런타임으로 막힌다.
const UNAPPROVED_RUNTIMES = new Set(["go", "java", "php", "ruby", "dotnet", "cargo", "gcc", "g++", "clang", "swift", "kotlinc", "powershell", "pwsh", "deno", "bun", "bunx", "perl", "lua", "luajit"]);
const PYTHON_RUNTIMES = new Set(["python", "python3", "py", "pip", "pip3", "pipx", "uv", "poetry", "pipenv", "conda", "mamba", "micromamba"]);
const NODE_RUNTIMES = new Set(["node", "npm", "pnpm", "yarn", "npx"]);

export function runtimeFailureForCommand(profileId, command) {
  const profile = getPolicyProfile(profileId) || POLICY_PROFILES.general;
  const invoked = invokedExecutables(command);
  if (invoked.some((name) => UNAPPROVED_RUNTIMES.has(name))) return "승인되지 않은 언어 또는 런타임 명령입니다.";
  if (!profile.allowed_runtime_families.includes("python") && invoked.some((name) => PYTHON_RUNTIMES.has(name))) {
    return "이 프로젝트는 Python 런타임을 허용하지 않습니다.";
  }
  if (!profile.allowed_runtime_families.some((item) => item === "node" || item === "supabase-deno") && invoked.some((name) => NODE_RUNTIMES.has(name))) {
    return "이 프로젝트는 Node.js 런타임을 허용하지 않습니다.";
  }
  return null;
}

/** 값을 하나 더 먹는 전역 플래그 — `npm --prefix . install` 의 `.` 은 하위 명령이 아니다. */
const VALUE_FLAGS = new Set(["--prefix", "-c", "--workspace", "--registry", "--loglevel", "--userconfig", "--cache", "--cwd", "--dir", "--filter", "--python", "-p", "--index-url", "-i", "--project", "--directory"]);

/** 이 명령 뒤에 오는 **하위 명령**(첫 번째 플래그 아닌 토큰, 구분자 전까지). 없으면 undefined. */
function subcommandOf(rest) {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (COMMAND_SEPARATORS.has(token)) return undefined;
    if (token.startsWith("-")) {
      if (VALUE_FLAGS.has(token.toLowerCase()) && !token.includes("=")) index += 1;
      continue;
    }
    return token;
  }
  return undefined;
}

/** `[python, -m, pip, install]` 처럼 `-m pip install` 이 들어 있는가(순서 무관 플래그는 건너뛴다). */
function invokesPipModuleInstall(rest) {
  const moduleIndex = rest.indexOf("-m");
  if (moduleIndex === -1) return false;
  return rest[moduleIndex + 1] === "pip" && subcommandOf(rest.slice(moduleIndex + 2)) === "install";
}

const NPM_INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "ci", "install-ci-test", "cit", "install-test", "it", "isntall", "exec", "x", "link", "ln", "update", "up", "upgrade"]);
const PNPM_INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "dlx", "link", "ln", "update", "up", "upgrade"]);
const YARN_INSTALL_SUBCOMMANDS = new Set(["install", "add", "dlx", "link", "upgrade", "up", "upgrade-interactive"]);
const BUN_INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "x", "link", "update"]);
const UV_INSTALL_SUBCOMMANDS = new Set(["add", "sync", "tool"]);
const POETRY_INSTALL_SUBCOMMANDS = new Set(["add", "install", "sync"]);
const PIPENV_INSTALL_SUBCOMMANDS = new Set(["install", "sync", "update"]);
const CONDA_INSTALL_SUBCOMMANDS = new Set(["install", "create", "update"]);

/**
 * 패키지를 **직접 설치**하는 명령인가.
 *
 * 47차 — 예전에는 `npm install|add`·`pip install`·`python -m pip install` 네 가지만 봤다.
 * 그래서 `npm i`, `npm ci`, `npm -g install`(첫 인자가 플래그), 인자 없는 `yarn`, `py -m pip`,
 * `uv`, `poetry`, `pipx`, `bun` 이 전부 통과했다 — 막는 목록이 짧으면 우회 목록이 길어진다.
 * 하위 명령은 **플래그를 건너뛰고** 첫 토큰으로 정한다.
 */
export function isDirectPackageInstall(command, depth = 0) {
  const tokens = commandPositionTokens(command);
  for (const entry of tokens) {
    if (!entry.atCommandPosition) continue;
    const name = executableName(entry.token);
    const rest = tokens.slice(entry.index + 1).map((item) => item.token);
    const next = subcommandOf(rest);

    if (name === "npm" && NPM_INSTALL_SUBCOMMANDS.has(next)) return true;
    if (name === "pnpm" && PNPM_INSTALL_SUBCOMMANDS.has(next)) return true;
    // 인자 없는 `yarn` 은 `yarn install` 이다.
    if (name === "yarn" && (next === undefined || YARN_INSTALL_SUBCOMMANDS.has(next))) return true;
    if (name === "bun" && BUN_INSTALL_SUBCOMMANDS.has(next)) return true;
    if (name === "bunx") return true;
    // `npx --no-install x` 만 예외 — **첫 인자**로만 본다(`npx x; echo --no-install` 우회 차단).
    if (name === "npx" && rest[0] !== undefined && rest[0] !== "--no-install") return true;
    if (["pip", "pip3", "pipx"].includes(name) && next === "install") return true;
    if (name === "uv" && (UV_INSTALL_SUBCOMMANDS.has(next) || (next === "pip" && subcommandOf(rest.slice(rest.indexOf("pip") + 1)) === "install"))) return true;
    if (name === "poetry" && POETRY_INSTALL_SUBCOMMANDS.has(next)) return true;
    if (name === "pipenv" && PIPENV_INSTALL_SUBCOMMANDS.has(next)) return true;
    if (["conda", "mamba", "micromamba"].includes(name) && CONDA_INSTALL_SUBCOMMANDS.has(next)) return true;
    // python -m pip install · py -m pip install · python3 -m pip install
    if (["python", "python3", "py"].includes(name) && invokesPipModuleInstall(rest)) return true;

    if (depth < 3 && SHELL_WRAPPERS.has(name)) {
      for (const argument of rest) {
        if (/\s/.test(argument) && isDirectPackageInstall(argument, depth + 1)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 하네스 보호 파일 — AI 도구가 정책·훅·lock 을 고쳐 스스로를 풀어 주지 못하게 한다.
//
// 47차 — 훅은 `.json` 을 허용 확장자로 보았고, lock 의 해시는 lock 자신이 들고 있었다.
// 그래서 Claude 가 `.claude/settings.json` 에서 훅 항목을 지우거나 `harness.lock.json` 의
// `policy_profile` 을 `general` 로 바꾸면 그 뒤로는 아무것도 막히지 않았다. 정책을 집행하는
// 파일을 정책의 적용 대상이 고칠 수 있으면 집행이 아니라 권고다.
//
// 47차 적대적 리뷰 반영 — 첫 판은 문자열 포함 여부로 봤다. 그래서 (a) `sh -c "rm -rf .vibecode-harness"`
// 처럼 래퍼 안쪽은 못 보고, (b) `cd .claude && echo "{}" > settings.json`·`mv .claude .claude.bak` 은 지나가고,
// (c) `.vibecode\-harness`·`.vibecode-har""ness`·`.vibecode-h*` 는 빠져나가며, (d) 반대로 문서가 안내하는
// `node .vibecode-harness/bin/gg.mjs verify … 2>&1`·`ls .vibecode-harness > files.txt` 는 막혔다.
// 지금은 토큰 값(따옴표·이스케이프를 벗긴 것)으로 **쓰기 대상 인자**만 본다.
// ---------------------------------------------------------------------------

export const PROTECTED_PATH_MESSAGE = "하네스 보호 파일은 AI 도구가 수정하지 않습니다. gg update 를 쓰세요.";

/** 경로를 비교용으로 정규화한다 — 구분자 통일 · 소문자 · `.`/`..` 해소 · 앞의 `./` 제거. */
function normalizedSegments(filePath) {
  const raw = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  if (!raw) return [];
  const segments = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { segments.pop(); continue; }
    segments.push(part);
  }
  return segments;
}

/**
 * 세그먼트 열이 보호 대상인가.
 * `folderLevel` 이면 `.claude` 폴더 자체(이동·삭제·복사 대상)도 보호한다 — 파일 쓰기 판정에서는
 * `.claude/vibecode-harness.md` 같은 하네스 안내 파일을 막지 않기 위해 settings 두 파일만 본다.
 */
function segmentsProtected(segments, { folderLevel = false } = {}) {
  if (!segments.length) return false;
  const last = segments.at(-1);
  if (last === "harness.lock.json") return true;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = segments[index + 1];
    if (segment === ".vibecode-harness" || segment === ".githooks") return true;
    if (segment === ".git" && next === "hooks") return true;
    if (segment === ".github" && next === "workflows" && segments[index + 2] === "vibecode-harness.yml") return true;
    if (segment === ".claude") {
      if (next === "settings.json" || next === "settings.local.json") return true;
      if (folderLevel && next === undefined) return true;
    }
  }
  return false;
}

/** 이 경로가 하네스 보호 파일에 해당하는가(파일 쓰기 도구용). `~/.claude/settings.json` 도 보호한다 — 사용자 전역 훅도 같은 집행 지점이다. */
export function isProtectedPath(filePath) {
  return segmentsProtected(normalizedSegments(filePath));
}

/** 파일 쓰기(Write·Edit·NotebookEdit)가 보호 파일을 향하면 사유, 아니면 null. */
export function protectedPathFailure(filePath) {
  return isProtectedPath(filePath) ? `${PROTECTED_PATH_MESSAGE} (${filePath})` : null;
}

/**
 * 따옴표를 지키며 토큰으로 쪼개되 **구분자와 따옴표 여부를 남긴다**. `commandPositionTokens` 와 같은
 * 규칙이지만 보호 경로 판정은 "이 `>` 가 따옴표 밖이었나"를 알아야 해서 따로 둔다.
 * 반환: [{ value, quoted, sep }] — sep 토큰은 `;` `&&` `||` `|` `&` `(` `)` `\n`.
 */
function shellTokens(command) {
  const text = String(command || "");
  const tokens = [];
  let current = "";
  let quote = null;
  let quoted = false;
  let hasContent = false;
  const flush = () => {
    if (hasContent) tokens.push({ value: current, quoted, sep: false });
    current = "";
    quoted = false;
    hasContent = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
      else { current += character; hasContent = true; }
      continue;
    }
    if (character === "'" || character === '"') { quote = character; quoted = true; hasContent = true; continue; }
    if (character === "\\" && isEscapeBackslash(text, index)) { current += text[index + 1]; quoted = true; hasContent = true; index += 1; continue; }
    if (/\s/.test(character)) { flush(); if (character === "\n") tokens.push({ value: "\n", quoted: false, sep: true }); continue; }
    if (";&|()".includes(character)) {
      flush();
      const next = text[index + 1];
      if ((character === "&" || character === "|") && next === character) { tokens.push({ value: character + next, quoted: false, sep: true }); index += 1; }
      else tokens.push({ value: character, quoted: false, sep: true });
      continue;
    }
    current += character;
    hasContent = true;
  }
  flush();
  return tokens;
}

/** 구분자로 나눈 명령 조각들(각각 토큰 배열). */
function commandSegments(command) {
  const segments = [];
  let current = [];
  for (const token of shellTokens(command)) {
    if (token.sep) { if (current.length) segments.push(current); current = []; continue; }
    current.push(token);
  }
  if (current.length) segments.push(current);
  return segments;
}

const GLOB_META = /[*?[]/;
/** 글롭 토큰의 글자 그대로인 앞부분이 이 보호 이름들의 앞부분과 겹치면 보호 대상으로 본다. */
const PROTECTED_NAME_PREFIXES = Object.freeze([".vibecode-harness", ".claude", ".githooks", "harness.lock.json", "vibecode-harness.yml", "hooks"]);

function isAbsoluteLike(value) {
  return /^(?:[a-z]:)?[\\/]/i.test(value) || value.startsWith("~");
}

/** 조각 안의 `cd <경로>` 를 따라 상대 경로의 기준을 옮긴다 — `cd .claude && echo "{}" > settings.json`. */
function resolveAgainst(cwdPrefix, value) {
  if (!cwdPrefix || isAbsoluteLike(value)) return value;
  return `${cwdPrefix}/${value}`;
}

/**
 * 명령 인자 하나가 보호 대상을 가리키는가(폴더 단위 포함, 글롭 포함).
 * `rm -rf .vibecode-h*` 는 `.vibecode-h` 가 `.vibecode-harness` 의 앞부분이므로 보호다.
 * `rm -rf dist/*` 는 폴더 `dist` 가 보호가 아니고 마지막 조각이 비었으므로 통과다.
 */
function isProtectedTarget(value, cwdPrefix = "") {
  const resolved = resolveAgainst(cwdPrefix, String(value || ""));
  if (!resolved || resolved.startsWith("-")) return false;
  if (GLOB_META.test(resolved)) {
    const literal = resolved.slice(0, resolved.search(GLOB_META));
    const pieces = literal.replace(/\\/g, "/").split("/");
    const stem = pieces.pop().toLowerCase();           // 글자 그대로인 마지막 조각(`.vibecode-h`, `.`, ``)
    const directory = normalizedSegments(pieces.join("/"));
    if (segmentsProtected(directory, { folderLevel: true })) return true;
    if (!stem) return false;                             // `rm -rf dist/*` · `rm -rf *`
    if (stem === ".") return true;                       // `.*` — 숨김 항목 전부(.claude·.vibecode-harness 포함)
    return PROTECTED_NAME_PREFIXES.some((name) => name.startsWith(stem) && stem.length >= 2);
  }
  return segmentsProtected(normalizedSegments(resolved), { folderLevel: true });
}

// 명령줄에서 **쓰기**로 보는 동사. 읽기(cat · type · Get-Content · ls · git diff)는 여기 없다.
const DELETE_OR_TOUCH_VERBS = new Set(["rm", "del", "erase", "rmdir", "rd", "truncate", "touch", "chmod", "chown", "attrib", "icacls", "ln", "mklink", "unlink", "shred"]);
const MOVE_VERBS = new Set(["mv", "move", "ren", "rename"]);                 // 원본·대상 모두 대상이다(옮기면 원본이 사라진다)
const COPY_VERBS = new Set(["cp", "copy", "xcopy", "robocopy", "install"]);  // 마지막 인자(대상)만 — 보호 파일을 **읽어** 백업하는 것은 허용
const TEE_VERBS = new Set(["tee"]);
const PS_WRITE_CMDLETS = new Set(["set-content", "add-content", "out-file", "new-item", "clear-content", "remove-item", "ri", "set-itemproperty", "rename-item", "rni", "move-item", "mi", "mv", "move", "del", "erase", "rd", "rm", "rmdir", "ni", "sc", "ac"]);
const PS_COPY_CMDLETS = new Set(["copy-item", "cpi", "cp", "copy"]);
const SCRIPT_WRAPPERS = new Set(["sed", "perl", "python", "python3", "py", "node", "ruby"]);
const SCRIPT_WRITE_HINT = /writefile|write_text|open\([^)]*['"][wa]|set-content|out-file|remove-item|unlink|rmsync|rename|copyfile|\.write\(|truncate|rmdir/i;
const PS_PATH_FLAGS = new Set(["-path", "-literalpath", "-filepath", "-destination", "-newname", "-target"]);

function positionalArguments(tokens) {
  return tokens.filter((token) => !token.value.startsWith("-")).map((token) => token.value);
}

/** 조각 하나에서 쓰기 대상으로 쓰인 인자들. 래퍼면 안쪽 문자열을 재귀한다. */
function writeTargetsOfSegment(tokens, cwdPrefix, depth) {
  const targets = [];
  if (!tokens.length) return targets;
  // 리다이렉트 — 따옴표 밖의 `>` `>>` `N>` `&>` `>|` 와 그 **다음 토큰**(또는 붙은 꼬리)만 본다. `2>&1` 은 대상이 아니다.
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.quoted) continue;
    const match = token.value.match(/^(?:\d*>>?|&>>?|>\|)(.*)$/);
    if (!match) continue;
    const tail = match[1];
    const target = tail || tokens[index + 1]?.value;
    if (!target || target.startsWith("&")) continue;
    targets.push(target);
  }
  const argumentTokens = tokens.filter((token) => !(!token.quoted && /^(?:\d*>>?|&>>?|>\|)/.test(token.value)));
  const name = executableName(argumentTokens[0].value);
  const rest = argumentTokens.slice(1);
  const positional = positionalArguments(rest);
  const lower = (value) => String(value).toLowerCase();
  if (DELETE_OR_TOUCH_VERBS.has(name) || MOVE_VERBS.has(name) || TEE_VERBS.has(name)) targets.push(...positional);
  else if (COPY_VERBS.has(name)) { if (positional.length >= 2) targets.push(positional.at(-1)); }
  else if (PS_WRITE_CMDLETS.has(name)) {
    for (let index = 0; index < rest.length; index += 1) {
      if (PS_PATH_FLAGS.has(lower(rest[index].value)) && rest[index + 1]) targets.push(rest[index + 1].value);
    }
    targets.push(...positional);
  } else if (PS_COPY_CMDLETS.has(name)) {
    for (let index = 0; index < rest.length; index += 1) {
      if (lower(rest[index].value) === "-destination" && rest[index + 1]) targets.push(rest[index + 1].value);
    }
    if (positional.length >= 2) targets.push(positional.at(-1));
  } else if (name === "git") {
    // `git config core.hooksPath x` 는 훅 집행 지점을 바꾼다(L2).
    if (positional[0] === "config" && positional.some((value) => /^core\.hookspath$/i.test(value)) && positional.length >= 3) targets.push(".githooks");
  } else if (SCRIPT_WRAPPERS.has(name) || name.startsWith("python")) {
    const inline = rest.some((token) => token.value === "-i" || token.value.startsWith("-i.") || token.value === "--in-place");
    if (name === "sed" || name === "perl") {
      if (inline) targets.push(...positional.slice(1));
    } else {
      // `node -e "fs.writeFileSync('.vibecode-harness/…')"` 처럼 스크립트 본문에 보호 경로와 쓰기 호출이 함께 있으면 막는다.
      for (const token of rest) {
        if (!SCRIPT_WRITE_HINT.test(token.value)) continue;
        const mentioned = token.value.match(/['"`]([^'"`]+)['"`]/g) || [];
        targets.push(...mentioned.map((quoted) => quoted.slice(1, -1)));
      }
    }
  }
  // 셸 래퍼 — 안쪽 문자열을 명령줄로 다시 본다(H1).
  if (depth < 3 && SHELL_WRAPPERS.has(name)) {
    for (const token of rest) {
      if (/\s/.test(token.value)) targets.push(...collectWriteTargets(token.value, cwdPrefix, depth + 1));
    }
  }
  return targets.map((value) => resolveAgainst(cwdPrefix, value));
}

/** 명령줄 전체에서 보호 여부와 무관하게 "쓰기 대상"으로 쓰인 인자들을 모은다(`cd` 추적 포함). */
function collectWriteTargets(command, cwdPrefix = "", depth = 0) {
  const targets = [];
  let cwd = cwdPrefix;
  for (const segment of commandSegments(command)) {
    const name = executableName(segment[0].value);
    if (name === "cd" || name === "set-location" || name === "pushd" || name === "sl") {
      const directory = positionalArguments(segment.slice(1))[0];
      if (directory) cwd = isAbsoluteLike(directory) ? directory : (cwd ? `${cwd}/${directory}` : directory);
      continue;
    }
    targets.push(...writeTargetsOfSegment(segment, cwd, depth));
  }
  return targets;
}

/**
 * Bash·PowerShell 명령이 보호 파일에 **쓰려는** 것으로 보이면 사유, 아니면 null.
 *
 * 완전한 셸 파서가 아니다 — 변수로 경로를 조립하거나 스크립트 파일에 담아 실행하면 못 본다.
 * 남은 우회는 `gg verify` 의 lock 지문·훅 등록 검사와 CI 가 받는다. 이 훅의 역할은
 * "한 줄로 끝나는" 우회를 없애면서 문서가 안내하는 읽기·실행(`node .vibecode-harness/bin/gg.mjs verify … 2>&1`,
 * `ls .vibecode-harness > files.txt`, `cp .vibecode-harness/harness.lock.json /tmp/backup.json`)은 통과시키는 것이다.
 */
export function protectedPathCommandFailure(command) {
  const text = String(command || "");
  if (!text.trim()) return null;
  const hit = collectWriteTargets(text).find((target) => isProtectedTarget(target));
  if (hit === undefined) return null;
  return `${PROTECTED_PATH_MESSAGE} (명령이 ${hit} 에 쓰려고 합니다)`;
}

export function implementationLanguageNames(profileId) {
  const profile = getPolicyProfile(profileId) || POLICY_PROFILES.general;
  return profile.allowed_languages.map((language) => ({ python: "Python", javascript: "JavaScript", typescript: "TypeScript" }[language] || language));
}

/**
 * 이 디렉터리를 관장하는 프로파일. 없으면 null(어느 하네스 프로젝트에도 속하지 않음).
 */
export function policyProfileForDirectory(startDirectory) {
  let directory = resolve(startDirectory);
  while (true) {
    const lock = resolve(directory, ".vibecode-harness", "harness.lock.json");
    if (existsSync(lock)) {
      try { return JSON.parse(readFileSync(lock, "utf8")).policy_profile || "general"; } catch { return "general"; }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * 이 작업에 적용할 프로파일을 정한다.
 *
 * 예전에는 `process.cwd()` 하나만 봤다. 그래서 **같은 파일을 쓰는데 터미널이
 * 어디 있었느냐로 판정이 갈렸다** — 프로젝트 안에서 실행하면 막히고, 잠깐
 * 바깥으로 나갔다 실행하면 통과했다. 정책이 파일이 아니라 우연에 달려 있었던
 * 것이고, 그 상태에서는 막혔다는 사실도 통과했다는 사실도 근거가 되지 못한다.
 *
 * 그래서 **대상 파일이 속한 프로젝트**를 먼저 본다. 파일이 어느 하네스
 * 프로젝트에도 속하지 않으면(외부 경로) 세션이 열린 프로젝트의 정책을 적용한다 —
 * 바깥에 써 두고 나중에 들여오는 우회로를 열지 않기 위해서다.
 *
 * @param {{ filePath?: string, cwd?: string }} context
 */
export function resolvePolicyProfile({ filePath, cwd } = {}) {
  if (filePath) {
    const owning = policyProfileForDirectory(dirname(resolve(filePath)));
    if (owning) return owning;
  }
  return policyProfileForDirectory(resolve(cwd || process.cwd())) || "general";
}

export const ALL_CODE_EXTENSIONS = CODE_EXTENSIONS;
export const TYPESCRIPT_SOURCE_EXTENSIONS = TYPESCRIPT_EXTENSIONS;
export const PYTHON_SOURCE_EXTENSIONS = PYTHON_EXTENSIONS;
