import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  POLICY_PROFILES,
  RUNTIME_PROFILE_TO_POLICY,
  hasImplementationSource,
  languageFailureForPath,
  policyProfileForRuntime
} from "../lib/policy-engine.mjs";

/**
 * 기관 표준 혼합 트랙(gg_standard).
 *
 * 왜 필요했나: 기관 프로파일은 python · javascript · typescript 를 기능 언어로,
 * PyPI 와 npm 을 패키지 생태계로 선언한다. 그런데 선택 가능한 runtime 은 전부
 * 그보다 좁아 **선언된 표준을 표현할 트랙이 없었다.** 세 언어를 담는 프로파일은
 * `general` 뿐인데 그것은 runtime 미지정 시 떨어지는 fallback 이라, 표준을
 * "정해지지 않은 상태"로 두는 셈이었다.
 *
 * 이 트랙에서 Python 은 예외나 제한 허용이 아니라 **PyPI 축의 정식 기능 언어**다.
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

// ---------------------------------------------------------------------------
// 정책 테이블
// ---------------------------------------------------------------------------

test("gg_standard is a selectable runtime, not the unspecified fallback", () => {
  assert.equal(RUNTIME_PROFILE_TO_POLICY.gg_standard, "gg_standard");
  assert.equal(policyProfileForRuntime("gg_standard"), "gg_standard");
  // 표준을 fallback 으로 표현하지 않는다 — 미지정만 general 로 간다.
  assert.equal(policyProfileForRuntime("does_not_exist"), "general");
  assert.notEqual(policyProfileForRuntime("gg_standard"), "general");
});

test("gg_standard treats Python, JavaScript and TypeScript as equal first-class languages", () => {
  for (const path of [
    "shared/enforcement/gvskb_gate.py",
    "shared/enforcement/gvskb_gate.js",
    "src/server.js",
    "src/scan-summary.mjs",
    "src/App.tsx",
    "src/types.ts"
  ]) {
    assert.equal(languageFailureForPath("gg_standard", path), null, `${path} 는 기관 표준 트랙에서 허용되어야 한다`);
  }
});

test("gg_standard still blocks languages the institution profile requires an exception for", () => {
  // institution-profile.yaml: exception_required_for = java, go, php, ruby, csharp, rust
  for (const path of ["Main.java", "main.go", "index.php", "app.rb", "Program.cs", "main.rs"]) {
    assert.match(
      languageFailureForPath("gg_standard", path) || "",
      /정책에서 허용하지 않습니다/,
      `${path} 는 예외 검토 대상이므로 막혀야 한다`
    );
  }
});

test("gg_standard recognizes both ecosystems' implementation sources", () => {
  assert.equal(hasImplementationSource("gg_standard", "gate.py"), true, "PyPI 축");
  assert.equal(hasImplementationSource("gg_standard", "server.js"), true, "npm 축");
  assert.equal(hasImplementationSource("gg_standard", "app.tsx"), true, "npm 축(TS)");
  assert.deepEqual(POLICY_PROFILES.gg_standard.package_manager, ["npm", "pip"]);
  assert.deepEqual(POLICY_PROFILES.gg_standard.allowed_runtime_families, ["node", "python"]);
});

test("policy-profiles.json and the policy engine agree on gg_standard", async () => {
  // 같은 표가 JSON 과 JS 두 곳에 있다. 한쪽만 고치면 init 이 배포하는 정책과
  // verify 가 집행하는 정책이 갈라진다.
  const declared = JSON.parse(await readFile(join(harnessRoot, "shared", "policy-profiles.json"), "utf8"));
  const fromJson = declared.profiles.gg_standard;
  assert.ok(fromJson, "policy-profiles.json 에 gg_standard 가 있어야 한다");
  assert.deepEqual(fromJson.allowed_languages, POLICY_PROFILES.gg_standard.allowed_languages);
  assert.deepEqual(fromJson.allowed_package_ecosystems, ["pypi", "npm"]);
});

// ---------------------------------------------------------------------------
// 실제 프로젝트에서의 동작
// ---------------------------------------------------------------------------

test("gg init accepts gg_standard and records it in the lock", async () => {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-ggstd-"));
  const init = await runGg(project, ["init", "--tools", "codex", "--runtime", "gg_standard", "--level", "L1"]);
  assert.equal(init.code, 0, init.stdout + init.stderr);

  const lock = JSON.parse(await readFile(join(project, ".vibecode-harness", "harness.lock.json"), "utf8"));
  assert.equal(lock.runtime_profile, "gg_standard");
  assert.equal(lock.policy_profile, "gg_standard");
  assert.deepEqual(lock.allowed_languages, ["python", "javascript", "typescript"]);
});

test("a gg_standard project keeps both package gates without a language failure", async () => {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-ggstd-both-"));
  const init = await runGg(project, ["init", "--tools", "codex", "--runtime", "gg_standard", "--level", "L1"]);
  assert.equal(init.code, 0, init.stdout + init.stderr);

  // 포털의 실제 구조 — 게이트 한 쌍 + 양쪽 의존성 선언.
  await writeFile(join(project, "gvskb_gate.py"), "def main():\n    return 0\n");
  await writeFile(join(project, "gvskb_gate.js"), "export default 1;\n");
  await writeFile(join(project, "requirements.txt"), "pyyaml==6.0.2\n");
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", private: true }, null, 2));

  const verify = await runGg(project, ["verify", "--skip-checker", "--no-tests"]);
  const output = verify.stdout + verify.stderr;
  assert.doesNotMatch(output, /허용하지 않습니다: gvskb_gate\.py/, "PyPI 축 게이트가 언어 위반으로 잡히면 안 된다");
  assert.doesNotMatch(output, /Python 의존성 선언을 발견했습니다/, "requirements.txt 는 이 트랙에서 정상이다");
});

test("other runtimes still reject Python — gg_standard is the only mixed track", async () => {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-ggstd-narrow-"));
  const init = await runGg(project, ["init", "--tools", "codex", "--runtime", "typescript_postgres", "--level", "L1"]);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  await writeFile(join(project, "worker.py"), "print(1)\n");

  const verify = await runGg(project, ["verify", "--skip-checker", "--no-tests"]);
  assert.match(verify.stdout + verify.stderr, /worker\.py/, "좁은 트랙의 기존 동작은 그대로여야 한다");
});
