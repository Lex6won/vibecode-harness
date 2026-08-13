#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installationState, verifyBundle } from "../lib/release-integrity.mjs";

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

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = join(HARNESS_ROOT, "shared", "harness-core.yaml");
const INSTITUTION_PROFILE_PATH = join(HARNESS_ROOT, "shared", "institution-profile.yaml");
const ROOT_PACKAGE_POLICY_PATH = join(HARNESS_ROOT, "shared", "references", "package-policy.json");
const CODEX_TEMPLATE_PATH = join(HARNESS_ROOT, "adapters", "codex", "AGENTS.template.md");
const CLAUDE_TEMPLATE_PATH = join(HARNESS_ROOT, "adapters", "claude-code", "CLAUDE.template.md");
const CI_TEMPLATE_PATH = join(HARNESS_ROOT, "templates", "vibecode-harness-ci.yml");
const TRUST_PATH = join(HARNESS_ROOT, "shared", "trust", "approved-signers.json");
const RELEASE_INTEGRITY_PATH = join(HARNESS_ROOT, "lib", "release-integrity.mjs");
const BUNDLED_CHECKER_PATH = join(HARNESS_ROOT, "checker", process.platform === "win32" ? "gvskb.exe" : "gvskb");
const BUNDLED_PYTHON_PATH = join(HARNESS_ROOT, "runtime", process.platform === "win32" ? "python.exe" : "python");
const BLOCKED_EXTENSIONS = new Map([
  [".java", "Java"], [".go", "Go"], [".php", "PHP"], [".rb", "Ruby"],
  [".cs", "C#"], [".rs", "Rust"]
]);
const IGNORED_DIRECTORIES = new Set([".git", ".githooks", ".vibecode-harness", "node_modules", ".venv", "venv", ".check-reports", "evidence", "dist", "build", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".py", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);

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
  node bin/gg.mjs init --project <폴더> [--tools codex|claude|both] [--runtime python_internal|node_web|typescript_web] [--level L1|L2|L3] [--ci]
  node bin/gg.mjs doctor [--project <폴더>]
  node bin/gg.mjs start --project <폴더> --brief <업무 설명>
  node bin/gg.mjs design --project <폴더> [--database yes|no] [--admin yes|no] [--external-api yes|no] [--confirm]
  node bin/gg.mjs package check --project <폴더> --ecosystem npm|pypi --name <패키지> --version <버전>
  node bin/gg.mjs bundle verify --bundle <승인 번들 폴더> [--trust <기관 공개키 목록>]
  node bin/gg.mjs bundle status --installed <설치 폴더> [--candidate <포털에서 받은 승인 번들 폴더>] [--trust <기관 공개키 목록>]
  node bin/gg.mjs build --project <폴더>
  node bin/gg.mjs verify --project <폴더> [--run-tests] [--hook] [--skip-checker] [--no-tests]
  node bin/gg.mjs release --project <폴더>

체커는 외부 엔진으로 호출만 합니다. 현재 CLI JSON에 공식 최종 판정 필드가 없으므로
verify는 검사 증적의 완전성을 확인하며, release는 사람 검토를 요구합니다.`);
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

function hasBlockedRuntime(command) {
  return /(^|[\s;&|])(?:go|java|php|ruby|dotnet|cargo)(?:[\s;&|]|$)/.test(cleanCommand(command));
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
  const packageSnapshot = join(project, ".vibecode-harness", "policy", "package-policy.json");
  for (const path of [policySnapshot, profileSnapshot, packageSnapshot]) {
    if (!(await pathExists(path))) failures.push(`필수 정책 사본이 없습니다: ${relative(project, path)}`);
  }
  if (failures.length) return failures;
  if ((await sha256(policySnapshot)) !== lock.policy_sha256) failures.push("하네스 정책 파일이 초기화 이후 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  if ((await sha256(profileSnapshot)) !== lock.institution_profile_sha256) failures.push("기관 프로파일이 초기화 이후 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  if (lock.package_policy_sha256 && (await sha256(packageSnapshot)) !== lock.package_policy_sha256) failures.push("패키지 정책이 초기화 이후 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  const localRunner = join(project, ".vibecode-harness", "bin", "gg.mjs");
  if (!(await pathExists(localRunner))) failures.push("프로젝트 실행기 사본이 없습니다. 승인된 하네스를 다시 적용하세요.");
  else if (lock.runner_sha256 && (await sha256(localRunner)) !== lock.runner_sha256) failures.push("프로젝트 실행기 사본이 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  const localIntegrity = join(project, ".vibecode-harness", "lib", "release-integrity.mjs");
  if (!(await pathExists(localIntegrity))) failures.push("프로젝트 번들 무결성 검증 모듈이 없습니다. 승인된 하네스를 다시 적용하세요.");
  else if (lock.release_integrity_sha256 && (await sha256(localIntegrity)) !== lock.release_integrity_sha256) failures.push("프로젝트 번들 무결성 검증 모듈이 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  const localHook = join(project, ".vibecode-harness", "bin", "claude-pre-tool.mjs");
  if (lock.tools?.includes("claude-code")) {
    if (!(await pathExists(localHook))) failures.push("Claude Code 훅 사본이 없습니다. 승인된 하네스를 다시 적용하세요.");
    else if (lock.claude_hook_sha256 && (await sha256(localHook)) !== lock.claude_hook_sha256) failures.push("Claude Code 훅 사본이 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  }
  const files = await listFiles(project);
  const implementationFiles = files.filter((file) => SOURCE_EXTENSIONS.has(extname(file).toLowerCase()));
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
        if (hasBlockedRuntime(command)) failures.push(`허용되지 않은 런타임을 호출하는 npm script '${name}'`);
      }
      if (lock.runtime_profile === "python_internal" && Object.keys(manifest.scripts || {}).length > 0) failures.push("Python 트랙에서 package.json 실행 스크립트를 발견했습니다. 트랙을 바꾸거나 예외 검토가 필요합니다.");
    } catch { failures.push("package.json 형식이 올바르지 않습니다."); }
  }
  const pythonIndicators = ["requirements.txt", "pyproject.toml", "Pipfile"];
  if (lock.runtime_profile === "node_web" || lock.runtime_profile === "typescript_web") {
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
  if (lock.runtime_profile === "node_web" || lock.runtime_profile === "typescript_web") {
    const result = await run(process.execPath, ["--version"]);
    const major = Number((result.stdout.match(/v(\d+)/) || [])[1]);
    if (!Number.isInteger(major) || major < 22) checks.push(`Node.js 22 이상이 필요합니다. 현재: ${result.stdout.trim() || "확인 불가"}`);
  }
  if (lock.runtime_profile === "python_internal" && !(await pythonCommand())) checks.push("Python 트랙에는 승인된 Python 런타임이 필요합니다.");
  return checks;
}

async function writeReceipt(project, name, payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(project, "evidence", `${stamp}-${name}.json`);
  await writeJson(path, { schema_version: 1, created_at: new Date().toISOString(), ...payload });
  return path;
}

async function runProjectTests(project, lock, options) {
  const noTests = Boolean(options["no-tests"]);
  if (noTests) {
    if (lock.level !== "L1") return { status: "blocked", reason: "L2 이상에서는 --no-tests를 사용할 수 없습니다." };
    return { status: "skipped", reason: "L1 안내 단계에서만 사용자 요청으로 테스트를 생략했습니다." };
  }
  if (options.hook) return { status: "deferred", reason: "Git 훅에서는 미검증 프로젝트의 테스트 명령을 실행하지 않습니다. CI 또는 사용자가 --run-tests로 명시 실행해야 합니다." };
  const packageJson = join(project, "package.json");
  if (await pathExists(packageJson)) {
    const manifest = await readJson(packageJson);
    if (manifest.scripts?.test) {
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
  }
  const testsPath = join(project, "tests");
  if (await pathExists(testsPath)) {
    if (lock.runtime_profile === "python_internal") {
      if (!options["run-tests"]) {
        return { status: "confirmation_required", command: "python -m pytest -q", reason: "테스트 실행은 프로젝트 코드를 실행합니다. 내용을 확인한 뒤 --run-tests로 명시 실행하세요." };
      }
      const python = await pythonCommand();
      if (!python) return { status: "blocked", reason: "Python 트랙에 필요한 Python 런타임을 찾을 수 없습니다." };
      const result = await run(python.command, ["-m", "pytest", "-q"], { cwd: project });
      return { status: result.code === 0 ? "passed" : "failed", command: "python -m pytest -q", code: result.code, stderr: result.stderr.slice(-2000) };
    }
  }
  return { status: "not_configured", reason: "실행할 테스트 명령이 없습니다. L2 이상에서는 테스트를 추가해야 합니다." };
}

async function runChecker(project, lock, env = process.env) {
  const bundle = await runningBundleStatus();
  if (!["developer_install", "verified"].includes(bundle.status)) return { status: "incomplete", reason: "설치된 승인 번들의 무결성을 확인할 수 없습니다. 공식 복구 설치 후 다시 시도하세요.", bundle };
  const checker = await checkerCommand(env);
  if (!checker) return { status: "incomplete", reason: "vibecode-checker(gvskb)를 찾을 수 없습니다." };
  const sourceFiles = (await listFiles(project)).filter((file) => SOURCE_EXTENSIONS.has(extname(file).toLowerCase()));
  if (sourceFiles.length === 0) return { status: "incomplete", reason: "지원되는 구현 소스 파일이 없습니다. 지침·문서 파일만으로는 점검을 통과할 수 없습니다." };
  const profileMap = {
    python_internal: "internal-db-query",
    node_web: "web-civil-service",
    typescript_web: "web-civil-service"
  };
  const profile = profileMap[lock.runtime_profile] || "public-default-strict";
  const args = ["scan", project, "--format", "json", "--stdout", "--profile", profile, "--check-deps", "--include-installed", "--env", lock.level === "L3" ? "E2" : "E1", "--fail-on", "block"];
  const result = await run(checker.command, args, { cwd: project, env });
  if (result.code === null) return { status: "incomplete", reason: "체커를 실행할 수 없습니다.", stderr: result.stderr.slice(-2000) };
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { return { status: "incomplete", reason: "체커 JSON 결과를 읽을 수 없습니다.", stderr: result.stderr.slice(-2000) }; }
  const scannedFiles = Array.isArray(report.scanned_files) ? report.scanned_files : [];
  if (scannedFiles.length === 0) return { status: "incomplete", reason: "체커가 검사한 파일이 없습니다. 대상 경로와 지원 언어를 확인하세요.", report };
  if (report.profile_fallback) return { status: "incomplete", reason: "체커 프로파일 fallback이 발생했습니다.", report };
  const skipped = Array.isArray(report.skipped_files) ? report.skipped_files : [];
  const truncated = skipped.some((item) => /max_files|최대 파일 수/i.test(String(item?.reason || "")));
  if (truncated) return { status: "incomplete", reason: "체커 파일 상한에 도달했습니다. 검사 범위를 나누거나 상한을 조정하세요.", report };
  const declaredDependencies = await declaredDependencyCount(project);
  const audits = Array.isArray(report.dependency_audit?.audits) ? report.dependency_audit.audits : [];
  const dependencyUnparsed = audits.some((audit) => audit?.verdict === "unparsed" || audit?.requires_review === true && Number(audit?.parsed_count || 0) === 0);
  if (declaredDependencies > 0 && dependencyUnparsed) {
    return { status: "incomplete", reason: "선언된 의존성이 있지만 체커 의존성 감사를 완료하지 못했습니다.", declaredDependencies, report };
  }
  if (result.code !== 0) return { status: "blocked", reason: "체커가 공식 차단 종료 코드를 반환했습니다.", exit_code: result.code, scannedFiles: scannedFiles.length, stderr: result.stderr.slice(-2000) };
  const reportPath = await writeReceipt(project, "checker-evidence", {
    kind: "checker_evidence",
    checker: checker.source === "bundled" ? "bundled_gvskb" : "system_gvskb",
    profile: report.profile,
    scanned_file_count: scannedFiles.length,
    finding_count: report.summary?.finding_count ?? null,
    declared_dependency_count: declaredDependencies,
    profile_fallback: Boolean(report.profile_fallback),
    report_sha256: createHash("sha256").update(result.stdout).digest("hex"),
    final_verdict: "review_required"
  });
  return { status: "review_required", reportPath, scannedFiles: scannedFiles.length, findings: report.summary?.finding_count ?? null };
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
  const checker = await checkerCommand();
  if (!checker) {
    const receipt = await writeReceipt(project, "package-check", { kind: "package_check", status: "incomplete", reason: "vibecode-checker를 찾을 수 없습니다.", name, version, ecosystem });
    print({ status: "incomplete", reason: "체커가 없어 패키지 설치를 승인할 수 없습니다.", receipt });
    process.exitCode = EXIT.CHECKER_INCOMPLETE;
    return;
  }
  const result = await run(checker.command, ["check-package", name, "--ecosystem", ecosystem, "--version", version, "--env", lock.level === "L3" ? "E2" : "E1"], { cwd: project });
  let decision;
  try { decision = JSON.parse(result.stdout); }
  catch {
    const receipt = await writeReceipt(project, "package-check", { kind: "package_check", status: "incomplete", reason: "체커 패키지 결과를 읽을 수 없습니다.", name, version, ecosystem, stderr: result.stderr.slice(-2000) });
    print({ status: "incomplete", reason: "체커 패키지 결과를 읽을 수 없습니다.", receipt });
    process.exitCode = EXIT.CHECKER_INCOMPLETE;
    return;
  }
  const blocked = result.code !== 0 || ["malicious", "registry_rejected", "not_found"].includes(decision.verdict) || Boolean(decision.in_kev);
  const status = blocked ? "blocked" : decision.requires_review ? "review_required" : "passed";
  const receipt = await writeReceipt(project, "package-check", {
    kind: "package_check", status, name, version, ecosystem, checker: checker.source === "bundled" ? "bundled_gvskb" : "system_gvskb", checker_exit_code: result.code,
    verdict: decision.verdict, severity: decision.verdict_severity, requires_review: Boolean(decision.requires_review), in_kev: Boolean(decision.in_kev), checked: Boolean(decision.checked)
  });
  print({ status, name, version, ecosystem, verdict: decision.verdict, requires_review: Boolean(decision.requires_review), receipt, next: blocked ? "대체 패키지 또는 승인된 예외 검토를 선택하세요." : "패키지 설치는 승인된 설치 절차에서 진행하세요." });
  if (blocked) process.exitCode = EXIT.PACKAGE;
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

async function initCommand(options) {
  const project = projectPath(options);
  const tools = options.tools || "both";
  const runtime = options.runtime || "typescript_web";
  const level = options.level || "L2";
  if (!['codex', 'claude', 'both'].includes(tools)) throw new Error("--tools는 codex, claude, both 중 하나여야 합니다.");
  if (!['python_internal', 'node_web', 'typescript_web'].includes(runtime)) throw new Error("허용되지 않은 --runtime 값입니다.");
  if (!['L1', 'L2', 'L3'].includes(level)) throw new Error("--level은 L1, L2, L3 중 하나여야 합니다.");
  await mkdir(project, { recursive: true });
  const harnessDir = join(project, ".vibecode-harness");
  const lockPath = join(harnessDir, "harness.lock.json");
  if (await pathExists(lockPath)) throw new Error("이미 초기화된 프로젝트입니다. 기존 lock을 덮어쓰지 않습니다.");
  await mkdir(join(harnessDir, "policy"), { recursive: true });
  await mkdir(join(harnessDir, "bin"), { recursive: true });
  await mkdir(join(harnessDir, "lib"), { recursive: true });
  await cp(POLICY_PATH, join(harnessDir, "policy", "harness-core.yaml"));
  await cp(INSTITUTION_PROFILE_PATH, join(harnessDir, "policy", "institution-profile.yaml"));
  await cp(ROOT_PACKAGE_POLICY_PATH, join(harnessDir, "policy", "package-policy.json"));
  await cp(join(HARNESS_ROOT, "bin", "gg.mjs"), join(harnessDir, "bin", "gg.mjs"));
  await cp(join(HARNESS_ROOT, "bin", "claude-pre-tool.mjs"), join(harnessDir, "bin", "claude-pre-tool.mjs"));
  await cp(RELEASE_INTEGRITY_PATH, join(harnessDir, "lib", "release-integrity.mjs"));
  const lock = {
    schema_version: 1,
    harness_version: "0.1.0",
    project_id: randomUUID(),
    created_at: new Date().toISOString(),
    level,
    runtime_profile: runtime,
    tools: tools === "both" ? ["codex", "claude-code"] : [tools === "claude" ? "claude-code" : "codex"],
    allowed_languages: ["python", "javascript", "typescript"],
    policy_sha256: await sha256(join(harnessDir, "policy", "harness-core.yaml")),
    institution_profile_sha256: await sha256(join(harnessDir, "policy", "institution-profile.yaml")),
    package_policy_sha256: await sha256(join(harnessDir, "policy", "package-policy.json")),
    runner_sha256: await sha256(join(harnessDir, "bin", "gg.mjs")),
    release_integrity_sha256: await sha256(join(harnessDir, "lib", "release-integrity.mjs")),
    claude_hook_sha256: await sha256(join(harnessDir, "bin", "claude-pre-tool.mjs")),
    checker_machine_verdict: "pending_upstream_machine_verdict"
  };
  await writeJson(lockPath, lock);
  if (tools === "codex" || tools === "both") {
    if (!(await pathExists(join(project, "AGENTS.md")))) await cp(CODEX_TEMPLATE_PATH, join(project, "AGENTS.md"));
    await mkdir(join(project, ".codex"), { recursive: true });
    await writeFile(join(project, ".codex", "vibecode-harness.md"), "Use AGENTS.md and run gg verify before completion.\n", "utf8");
  }
  let claudeSettingsStatus = "not_selected";
  if (tools === "claude" || tools === "both") {
    if (!(await pathExists(join(project, "CLAUDE.md")))) await cp(CLAUDE_TEMPLATE_PATH, join(project, "CLAUDE.md"));
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(join(project, ".claude", "vibecode-harness.md"), "Use CLAUDE.md and run gg verify before completion.\n", "utf8");
    const claudeSettingsPath = join(project, ".claude", "settings.json");
    const hookEntry = { type: "command", command: "node .vibecode-harness/bin/claude-pre-tool.mjs" };
    if (!(await pathExists(claudeSettingsPath))) {
      await writeJson(claudeSettingsPath, { hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit|Bash", hooks: [hookEntry] }] } });
      claudeSettingsStatus = "created";
    } else {
      try {
        const settings = await readJson(claudeSettingsPath);
        const backup = join(harnessDir, "backups", `claude-settings-${Date.now()}.json`);
        await cp(claudeSettingsPath, backup);
        settings.hooks = settings.hooks || {};
        settings.hooks.PreToolUse = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
        const exists = settings.hooks.PreToolUse.some((entry) => Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook.command === hookEntry.command));
        if (!exists) settings.hooks.PreToolUse.push({ matcher: "Write|Edit|MultiEdit|Bash", hooks: [hookEntry] });
        await writeJson(claudeSettingsPath, settings);
        claudeSettingsStatus = exists ? "already_configured" : "merged_with_backup";
      } catch {
        claudeSettingsStatus = "manual_required_invalid_settings";
      }
    }
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
  if (options.ci) {
    const workflowPath = join(project, ".github", "workflows", "vibecode-harness.yml");
    if (await pathExists(workflowPath)) ci = "existing_workflow_preserved";
    else {
      await mkdir(dirname(workflowPath), { recursive: true });
      await cp(CI_TEMPLATE_PATH, workflowPath);
      ci = "created_requires_approved_windows_runner";
    }
  }
  await writeReceipt(project, "init", { kind: "harness_init", runtime, tools: lock.tools, level, git_hook: hook, ci, claude_settings: claudeSettingsStatus });
  print({ status: "initialized", project, runtime, tools: lock.tools, level, git_hook: hook, ci, claude_settings: claudeSettingsStatus, next: "gg doctor --project <프로젝트 폴더>" });
}

async function doctorCommand(options) {
  const project = projectPath(options);
  let lock = null;
  let lockError = null;
  try { lock = await getLock(project); } catch (error) { lockError = error.message; }
  const [git, checker] = await Promise.all([commandAvailable("git"), checkerCommand()]);
  const bundle = await runningBundleStatus();
  const nodeVersion = process.version;
  const adapters = {};
  if (lock?.value.tools.includes("codex")) {
    const agents = join(project, "AGENTS.md");
    adapters.codex = (await pathExists(agents)) && /vibecode-harness/.test(await readFile(agents, "utf8")) ? "applied" : "repair_required";
  }
  if (lock?.value.tools.includes("claude-code")) {
    const claude = join(project, "CLAUDE.md");
    const settings = join(project, ".claude", "settings.json");
    let hookApplied = false;
    try {
      const parsed = await readJson(settings);
      hookApplied = JSON.stringify(parsed.hooks?.PreToolUse || []).includes(".vibecode-harness/bin/claude-pre-tool.mjs");
    } catch { /* reported below */ }
    adapters.claude_code = (await pathExists(claude)) && hookApplied ? "applied" : "repair_required";
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
    checker: checker ? { status: "available", source: checker.source } : { status: "not_installed" },
    bundle,
    adapters,
    harness: lock?.value ?? null,
    message: lockError || (checker ? "하네스와 체커 실행 경로를 확인했습니다." : "체커가 없어 표준 보안 점검은 실행할 수 없습니다.")
  };
  if (lock) result.policy_failures = await policyCheck(project, lock.value);
  print(result);
  if (!lock || !checker) process.exitCode = EXIT.CHECKER_INCOMPLETE;
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
  const test = await runProjectTests(project, lock, options);
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
    reason: "현재 체커 CLI JSON에 공식 최종 기계 판정 계약이 없어 자동 이관을 승인하지 않습니다.",
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
  if (!command || command === "help" || options.help) return usage();
  try {
    if (command === "init") await initCommand(options);
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
