#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const CODEX_TEMPLATE_PATH = join(HARNESS_ROOT, "adapters", "codex", "AGENTS.template.md");
const CLAUDE_TEMPLATE_PATH = join(HARNESS_ROOT, "adapters", "claude-code", "CLAUDE.template.md");
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
  node bin/gg.mjs init --project <폴더> [--tools codex|claude|both] [--runtime python_internal|node_web|typescript_web] [--level L1|L2|L3]
  node bin/gg.mjs doctor [--project <폴더>]
  node bin/gg.mjs start --project <폴더> --brief <업무 설명>
  node bin/gg.mjs design --project <폴더>
  node bin/gg.mjs build --project <폴더>
  node bin/gg.mjs verify --project <폴더> [--skip-checker] [--no-tests]
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

async function commandAvailable(command) {
  const probe = process.platform === "win32" ? ["where.exe", [command]] : ["which", [command]];
  const result = await run(probe[0], probe[1]);
  return result.code === 0;
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

async function policyCheck(project, lock) {
  const failures = [];
  const policySnapshot = join(project, ".vibecode-harness", "policy", "harness-core.yaml");
  const profileSnapshot = join(project, ".vibecode-harness", "policy", "institution-profile.yaml");
  for (const path of [policySnapshot, profileSnapshot]) {
    if (!(await pathExists(path))) failures.push(`필수 정책 사본이 없습니다: ${relative(project, path)}`);
  }
  if (failures.length) return failures;
  if ((await sha256(policySnapshot)) !== lock.policy_sha256) failures.push("하네스 정책 파일이 초기화 이후 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  if ((await sha256(profileSnapshot)) !== lock.institution_profile_sha256) failures.push("기관 프로파일이 초기화 이후 변경되었습니다. 승인된 하네스를 다시 적용하세요.");
  const files = await listFiles(project);
  for (const file of files) {
    const extension = extname(file).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(extension)) failures.push(`허용되지 않은 ${BLOCKED_EXTENSIONS.get(extension)} 소스 파일: ${relative(project, file)}`);
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
  return failures;
}

async function runtimeCheck(lock) {
  const checks = [];
  if (lock.runtime_profile === "node_web" || lock.runtime_profile === "typescript_web") {
    const result = await run(process.execPath, ["--version"]);
    const major = Number((result.stdout.match(/v(\d+)/) || [])[1]);
    if (!Number.isInteger(major) || major < 22) checks.push(`Node.js 22 이상이 필요합니다. 현재: ${result.stdout.trim() || "확인 불가"}`);
  }
  if (lock.runtime_profile === "python_internal" && !(await commandAvailable("python"))) checks.push("Python 트랙에는 승인된 Python 런타임이 필요합니다.");
  return checks;
}

async function writeReceipt(project, name, payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(project, "evidence", `${stamp}-${name}.json`);
  await writeJson(path, { schema_version: 1, created_at: new Date().toISOString(), ...payload });
  return path;
}

async function runProjectTests(project, lock, noTests) {
  if (noTests) {
    if (lock.level !== "L1") return { status: "blocked", reason: "L2 이상에서는 --no-tests를 사용할 수 없습니다." };
    return { status: "skipped", reason: "L1 안내 단계에서만 사용자 요청으로 테스트를 생략했습니다." };
  }
  const packageJson = join(project, "package.json");
  if (await pathExists(packageJson)) {
    const manifest = await readJson(packageJson);
    if (manifest.scripts?.test) {
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
      const result = await run("python", ["-m", "pytest", "-q"], { cwd: project });
      return { status: result.code === 0 ? "passed" : "failed", command: "python -m pytest -q", code: result.code, stderr: result.stderr.slice(-2000) };
    }
  }
  return { status: "not_configured", reason: "실행할 테스트 명령이 없습니다. L2 이상에서는 테스트를 추가해야 합니다." };
}

async function runChecker(project, lock) {
  if (!(await commandAvailable("gvskb"))) return { status: "incomplete", reason: "vibecode-checker(gvskb)를 찾을 수 없습니다." };
  const sourceFiles = (await listFiles(project)).filter((file) => SOURCE_EXTENSIONS.has(extname(file).toLowerCase()));
  if (sourceFiles.length === 0) return { status: "incomplete", reason: "지원되는 구현 소스 파일이 없습니다. 지침·문서 파일만으로는 점검을 통과할 수 없습니다." };
  const profileMap = {
    python_internal: "internal-db-query",
    node_web: "web-civil-service",
    typescript_web: "web-civil-service"
  };
  const profile = profileMap[lock.runtime_profile] || "public-default-strict";
  const args = ["scan", project, "--format", "json", "--stdout", "--profile", profile, "--check-deps", "--include-installed", "--env", lock.level === "L3" ? "E2" : "E1", "--fail-on", "block"];
  const result = await run("gvskb", args, { cwd: project });
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
  if (result.code !== 0) return { status: "blocked", reason: "체커가 공식 차단 종료 코드를 반환했습니다.", exit_code: result.code, scannedFiles: scannedFiles.length, stderr: result.stderr.slice(-2000) };
  const reportPath = await writeReceipt(project, "checker-evidence", {
    kind: "checker_evidence",
    checker: "gvskb",
    profile: report.profile,
    scanned_file_count: scannedFiles.length,
    finding_count: report.summary?.finding_count ?? null,
    profile_fallback: Boolean(report.profile_fallback),
    report_sha256: createHash("sha256").update(result.stdout).digest("hex"),
    final_verdict: "review_required"
  });
  return { status: "review_required", reportPath, scannedFiles: scannedFiles.length, findings: report.summary?.finding_count ?? null };
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
  await cp(POLICY_PATH, join(harnessDir, "policy", "harness-core.yaml"));
  await cp(INSTITUTION_PROFILE_PATH, join(harnessDir, "policy", "institution-profile.yaml"));
  await cp(join(HARNESS_ROOT, "bin", "gg.mjs"), join(harnessDir, "bin", "gg.mjs"));
  await cp(join(HARNESS_ROOT, "bin", "claude-pre-tool.mjs"), join(harnessDir, "bin", "claude-pre-tool.mjs"));
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
    checker_machine_verdict: "pending_upstream_machine_verdict"
  };
  await writeJson(lockPath, lock);
  if (tools === "codex" || tools === "both") {
    if (!(await pathExists(join(project, "AGENTS.md")))) await cp(CODEX_TEMPLATE_PATH, join(project, "AGENTS.md"));
    await mkdir(join(project, ".codex"), { recursive: true });
    await writeFile(join(project, ".codex", "vibecode-harness.md"), "Use AGENTS.md and run gg verify before completion.\n", "utf8");
  }
  if (tools === "claude" || tools === "both") {
    if (!(await pathExists(join(project, "CLAUDE.md")))) await cp(CLAUDE_TEMPLATE_PATH, join(project, "CLAUDE.md"));
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(join(project, ".claude", "vibecode-harness.md"), "Use CLAUDE.md and run gg verify before completion.\n", "utf8");
    const claudeSettingsPath = join(project, ".claude", "settings.json");
    if (!(await pathExists(claudeSettingsPath))) {
      await writeJson(claudeSettingsPath, {
        hooks: {
          PreToolUse: [{
            matcher: "Write|Edit|MultiEdit|Bash",
            hooks: [{ type: "command", command: "node .vibecode-harness/bin/claude-pre-tool.mjs" }]
          }]
        }
      });
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
      await mkdir(join(project, ".githooks"), { recursive: true });
      const command = "node .vibecode-harness/bin/gg.mjs verify --project .";
      await writeFile(join(project, ".githooks", "pre-commit"), `#!/usr/bin/env sh\n${command}\n`, "utf8");
      const configured = await run("git", ["config", "core.hooksPath", ".githooks"], { cwd: project });
      hook = configured.code === 0 ? "Git pre-commit 훅을 설치했습니다." : "Git 훅 파일은 만들었지만 hooksPath 설정에 실패했습니다.";
    }
  }
  await writeReceipt(project, "init", { kind: "harness_init", runtime, tools: lock.tools, level, git_hook: hook });
  print({ status: "initialized", project, runtime, tools: lock.tools, level, git_hook: hook, next: "gg doctor --project <프로젝트 폴더>" });
}

async function doctorCommand(options) {
  const project = projectPath(options);
  let lock = null;
  let lockError = null;
  try { lock = await getLock(project); } catch (error) { lockError = error.message; }
  const [git, gvskb] = await Promise.all([commandAvailable("git"), commandAvailable("gvskb")]);
  const nodeVersion = process.version;
  const result = {
    status: lock ? "ready_for_verify" : "not_initialized",
    project,
    node: nodeVersion,
    git,
    checker: gvskb ? "available" : "not_installed",
    harness: lock?.value ?? null,
    message: lockError || (gvskb ? "하네스와 체커 실행 경로를 확인했습니다." : "체커가 없어 표준 보안 점검은 실행할 수 없습니다.")
  };
  if (lock) result.policy_failures = await policyCheck(project, lock.value);
  print(result);
  if (!lock || !gvskb) process.exitCode = EXIT.CHECKER_INCOMPLETE;
}

async function startCommand(options) {
  const project = projectPath(options);
  await getLock(project);
  if (!options.brief || options.brief === true) throw new Error("--brief에 업무 설명을 입력하세요.");
  const path = join(project, "evidence", "feature-brief.md");
  if (await pathExists(path)) throw new Error("이미 feature-brief.md가 있습니다. 기존 요구사항을 덮어쓰지 않습니다.");
  await writeFile(path, `# 업무 기능 요약\n\n${options.brief}\n\n## 확인할 질문\n\n- 누가 사용하나요?\n- 입력·확인·저장해야 할 것은 무엇인가요?\n- 종료 뒤에도 결과를 다시 찾아야 하나요?\n- 다른 사람의 현황·오류·이력을 관리해야 하나요?\n`, "utf8");
  print({ status: "created", artifact: path, next: "gg design --project <프로젝트 폴더>" });
}

async function designCommand(options) {
  const project = projectPath(options);
  await getLock(project);
  const designDir = join(project, "evidence", "design");
  await mkdir(designDir, { recursive: true });
  const artifacts = {
    screen_map: join(designDir, "screen-map.md"),
    function_spec: join(designDir, "screen-function-spec.md"),
    data_admin_decision: join(designDir, "data-and-admin-decision.md")
  };
  const contents = {
    screen_map: "# 화면 목록\n\n- 시작 화면\n- 핵심 업무 화면\n- 결과 또는 저장 화면\n- 관리자 화면: 필요할 때만 추가\n",
    function_spec: "# 화면 기능 명세\n\n각 화면에서 사용자가 입력하는 것, 클릭하는 것, 확인하는 결과를 적습니다.\n",
    data_admin_decision: "# 데이터·관리자 판단\n\n- 브라우저를 닫은 뒤에도 결과를 다시 찾아야 하나요?\n- 여러 사람이 같은 자료를 확인·수정하나요?\n- 한 사람이 처리 현황과 오류를 확인해야 하나요?\n\n답변에 따라 DB와 관리자 화면 필요 여부를 결정합니다.\n"
  };
  for (const [name, path] of Object.entries(artifacts)) if (!(await pathExists(path))) await writeFile(path, contents[name], "utf8");
  print({ status: "design_artifacts_ready", artifacts, next: "화면 시안 확인 후 gg build --project <프로젝트 폴더>" });
}

async function buildCommand(options) {
  const project = projectPath(options);
  const lock = (await getLock(project)).value;
  const failures = [...await policyCheck(project, lock), ...await runtimeCheck(lock)];
  const receipt = await writeReceipt(project, "build-check", { kind: "build_check", status: failures.length ? "failed" : "passed", failures });
  print({ status: failures.length ? "blocked" : "ready", failures, receipt });
  if (failures.length) process.exitCode = EXIT.POLICY_OR_RUNTIME;
}

async function verifyCommand(options) {
  const project = projectPath(options);
  const lock = (await getLock(project)).value;
  const policyFailures = await policyCheck(project, lock);
  const runtimeFailures = await runtimeCheck(lock);
  if (policyFailures.length || runtimeFailures.length) {
    const receipt = await writeReceipt(project, "verify", { kind: "verify", status: "blocked", policy_failures: policyFailures, runtime_failures: runtimeFailures });
    print({ status: "blocked", policy_failures: policyFailures, runtime_failures: runtimeFailures, receipt });
    process.exitCode = EXIT.POLICY_OR_RUNTIME;
    return;
  }
  const test = await runProjectTests(project, lock, Boolean(options["no-tests"]));
  if (test.status === "failed" || test.status === "blocked") {
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
    else if (command === "build") await buildCommand(options);
    else if (command === "verify") await verifyCommand(options);
    else if (command === "release") await releaseCommand(options);
    else fail(`알 수 없는 명령입니다: ${command}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), EXIT.SYSTEM);
  }
}

await main();
