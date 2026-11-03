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
    if (character === "\\" && index + 1 < text.length) {
      // 이스케이프된 다음 글자는 구분자로 보지 않는다.
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
    atCommandPosition = false;
  }
  return result;
}

/** 경로·확장자를 떼어낸 실행 파일 이름. `/usr/bin/python3.exe` → `python3` */
function executableName(token) {
  const base = String(token).replace(/\\/g, "/").toLowerCase().split("/").pop() || "";
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/, "");
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
const PYTHON_RUNTIMES = new Set(["python", "python3", "py", "pip", "pip3", "pipx", "uv", "poetry", "pipenv", "conda"]);
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
const VALUE_FLAGS = new Set(["--prefix", "-c", "--workspace", "-w", "--registry", "--loglevel", "--userconfig", "--cache", "--cwd", "--dir", "--filter", "--python", "-p", "--index-url", "-i", "--project", "--directory"]);

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

const NPM_INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "ci", "install-ci-test", "cit", "install-test", "it", "isntall", "exec", "x", "link", "ln"]);
const PNPM_INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "dlx", "link", "ln"]);
const YARN_INSTALL_SUBCOMMANDS = new Set(["install", "add", "dlx", "link"]);
const BUN_INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "x", "link"]);
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
    if (name === "npx" && next !== undefined && !rest.includes("--no-install")) return true;
    if (["pip", "pip3", "pipx"].includes(name) && next === "install") return true;
    if (name === "uv" && (UV_INSTALL_SUBCOMMANDS.has(next) || (next === "pip" && subcommandOf(rest.slice(rest.indexOf("pip") + 1)) === "install"))) return true;
    if (name === "poetry" && POETRY_INSTALL_SUBCOMMANDS.has(next)) return true;
    if (name === "pipenv" && PIPENV_INSTALL_SUBCOMMANDS.has(next)) return true;
    if (name === "conda" && CONDA_INSTALL_SUBCOMMANDS.has(next)) return true;
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
// ---------------------------------------------------------------------------

const PROTECTED_PATH_SEGMENTS = Object.freeze([
  ".vibecode-harness/",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".githooks/",
  ".github/workflows/vibecode-harness.yml",
  "harness.lock.json"
]);

export const PROTECTED_PATH_MESSAGE = "하네스 보호 파일은 AI 도구가 수정하지 않습니다. gg update 를 쓰세요.";

function normalizedPathForMatch(filePath) {
  return String(filePath || "").replace(/\\/g, "/").toLowerCase();
}

/** 이 경로가 하네스 보호 파일에 해당하는가. */
export function isProtectedPath(filePath) {
  const normalized = normalizedPathForMatch(filePath);
  if (!normalized) return false;
  return PROTECTED_PATH_SEGMENTS.some((segment) => {
    const needle = segment.toLowerCase();
    if (needle.endsWith("/")) return normalized.includes(`/${needle}`) || normalized.startsWith(needle);
    return normalized === needle || normalized.endsWith(`/${needle}`) || normalized.includes(`/${needle}`);
  });
}

/** 파일 쓰기(Write·Edit·NotebookEdit)가 보호 파일을 향하면 사유, 아니면 null. */
export function protectedPathFailure(filePath) {
  return isProtectedPath(filePath) ? `${PROTECTED_PATH_MESSAGE} (${filePath})` : null;
}

// 명령줄에서 **쓰기**로 보는 동사·연산자. 읽기(cat · type · Get-Content · ls)는 여기 없다.
const WRITE_VERBS = new Set([
  "rm", "del", "erase", "rmdir", "rd", "mv", "move", "ren", "rename", "cp", "copy", "xcopy", "robocopy",
  "tee", "truncate", "touch", "install", "ln", "mklink", "attrib", "icacls", "chmod", "chown",
  "set-content", "add-content", "out-file", "remove-item", "move-item", "copy-item", "rename-item",
  "new-item", "clear-content", "set-itemproperty", "ri", "mi", "cpi", "rni", "ni", "sc"
]);
const WRITE_WRAPPERS = new Set(["sed", "perl", "python", "python3", "py", "node", "powershell", "pwsh", "cmd", "cmd.exe", "powershell.exe", "pwsh.exe"]);

/**
 * Bash·PowerShell 명령이 보호 파일에 **쓰려는** 것으로 보이면 사유, 아니면 null.
 *
 * 완전한 셸 파서가 아니다 — 보호 경로 문자열이 등장하고(따옴표 안 포함) 같은 명령줄에
 * 리다이렉트(`>`·`>>`)나 쓰기 동사가 있으면 막는다. 읽기만 하는 명령은 통과시킨다.
 * 우회 여지는 남지만(변수로 경로를 조립하는 등), 남은 우회는 `gg verify` 의 lock 지문
 * 검사와 CI 가 받는다. 이 훅의 역할은 "한 줄로 끝나는" 우회를 없애는 것이다.
 */
export function protectedPathCommandFailure(command) {
  const text = String(command || "");
  if (!text.trim()) return null;
  const lowered = text.replace(/\\/g, "/").toLowerCase();
  // 폴더 항목은 끝 `/` 없이도 본다 — `rm -rf .vibecode-harness` 는 폴더째 지우는 명령이다.
  const mentioned = PROTECTED_PATH_SEGMENTS.filter((segment) => lowered.includes(segment.toLowerCase().replace(/\/$/, "")));
  if (!mentioned.length) return null;
  const tokens = commandPositionTokens(text);
  const rawTokens = tokens.map((entry) => entry.token);
  const hasRedirect = /(^|[^<>])>{1,2}(?!>)/.test(text.replace(/"[^"]*"|'[^']*'/g, (quoted) => " ".repeat(quoted.length)));
  const commandNames = tokens.filter((entry) => entry.atCommandPosition).map((entry) => executableName(entry.token));
  const hasWriteVerb = commandNames.some((name) => WRITE_VERBS.has(name));
  // `sed -i`, `python -c "open(..., 'w')"`, `node -e "fs.writeFileSync(...)"`, `powershell -Command Set-Content`
  const hasWriteWrapper = commandNames.some((name) => WRITE_WRAPPERS.has(name))
    && (rawTokens.includes("-i") || /writefile|write_text|open\([^)]*['"]w|set-content|out-file|remove-item|unlink|rmsync|rename|copyfile|\.write\(/i.test(text));
  if (!hasRedirect && !hasWriteVerb && !hasWriteWrapper) return null;
  return `${PROTECTED_PATH_MESSAGE} (명령이 ${mentioned[0]} 에 쓰려고 합니다)`;
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
