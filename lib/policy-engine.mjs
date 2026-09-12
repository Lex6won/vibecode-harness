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

export function runtimeFailureForCommand(profileId, command) {
  const profile = getPolicyProfile(profileId) || POLICY_PROFILES.general;
  const normalized = String(command || "").replace(/\\/g, "/").toLowerCase();
  const runtimeMatch = /(^|[\s;&|])(?:go|java|php|ruby|dotnet|cargo|gcc|g\+\+|clang|swift|kotlinc|powershell|pwsh)(?:[\s;&|]|$)/.test(normalized);
  if (runtimeMatch) return "승인되지 않은 언어 또는 런타임 명령입니다.";
  if (!profile.allowed_runtime_families.includes("python") && /(^|[\s;&|])(?:python|python3|pip|pip3)(?:\.exe)?(?:[\s;&|]|$)/.test(normalized)) {
    return "이 프로젝트는 Python 런타임을 허용하지 않습니다.";
  }
  if (!profile.allowed_runtime_families.some((item) => item === "node" || item === "supabase-deno") && /(^|[\s;&|])(?:node|npm|pnpm|yarn|npx)(?:\.cmd|\.exe)?(?:[\s;&|]|$)/.test(normalized)) {
    return "이 프로젝트는 Node.js 런타임을 허용하지 않습니다.";
  }
  return null;
}

export function isDirectPackageInstall(command) {
  const normalized = String(command || "").replace(/\\/g, "/").toLowerCase();
  return /(^|[\s;&|])(?:npm|pnpm|yarn)(?:\.cmd|\.exe)?\s+(?:install|add)\b/.test(normalized)
    || /(^|[\s;&|])npx(?:\.cmd|\.exe)?\s+(?!--no-install\b)/.test(normalized)
    || /(?:^|[\s;&|])(?:pip|pip3)(?:\.exe)?\s+install\b|python(?:\.exe)?\s+-m\s+pip\s+install\b/.test(normalized);
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
