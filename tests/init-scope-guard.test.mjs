import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

/**
 * `gg init` 범위 보호.
 *
 * 무엇이 잘못돼 있었나: 사용자가 작업 폴더 전체(수십 개 저장소의 부모)나 홈
 * 디렉터리에서 init 을 실행하면 아무 경고 없이 그 전체가 한 프로젝트가 됐다.
 * 그러면 옆 저장소의 Go 파일 때문에 verify 가 막히고, 훅은 남의 저장소 파일까지
 * 이 lock 의 정책으로 판정한다. 정책이 틀린 것이 아니라 **적용 단위가 틀린 것**이다.
 *
 * 여기서 확인하는 것은 "거부하는가"만이 아니라 **거부할 때 아무것도 쓰지 않는가**,
 * 그리고 **승인했을 때 그 사실이 남는가** 이다.
 */

const harnessRoot = resolve(import.meta.dirname, "..");
const gg = join(harnessRoot, "bin", "gg.mjs");

function runGg(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [gg, ...args], { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function withTemp(prefix, body) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

/** 실제 git 없이도 "저장소"로 보이게 한다 — 판정은 `.git` 항목의 존재만 본다. */
async function fakeRepository(path) {
  await mkdir(join(path, ".git"), { recursive: true });
}

test("하위 저장소가 2개인 폴더는 init 을 거부하고 아무 파일도 쓰지 않는다", async () => {
  await withTemp("vibecode-harness-scope-nested-", async (root) => {
    await fakeRepository(join(root, "service-a"));
    await fakeRepository(join(root, "service-b"));
    const before = (await readdir(root)).sort();

    const result = await runGg(["init", "--project", root, "--tools", "all", "--runtime", "gg_standard", "--level", "L1"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /범위 과다/);
    assert.match(result.stderr, /하위 저장소 2개 포함/);
    // 감지된 하위 프로젝트 이름과 "하나를 고르라"는 안내가 있어야 한다.
    assert.match(result.stderr, /service-a/);
    assert.match(result.stderr, /service-b/);
    assert.match(result.stderr, /하위 프로젝트 폴더 하나를 골라/);
    assert.match(result.stderr, /--allow-broad-scope/);

    assert.deepEqual((await readdir(root)).sort(), before, "거부했으면 폴더 내용이 그대로여야 한다");
    await assert.rejects(stat(join(root, ".vibecode-harness")));
    await assert.rejects(stat(join(root, "evidence")));
    await assert.rejects(stat(join(root, "AGENTS.md")));
  });
});

test("깊이 2의 중첩 저장소도 센다 (예: work/a/.git + work/b/.git)", async () => {
  await withTemp("vibecode-harness-scope-depth2-", async (root) => {
    await fakeRepository(join(root, "work", "a"));
    await fakeRepository(join(root, "work", "b"));
    const result = await runGg(["init", "--project", root, "--tools", "codex", "--level", "L1"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /하위 저장소 2개 포함 \(work\/a, work\/b\)/);
  });
});

test("서로 다른 하위 폴더에 프로젝트 선언이 2개면 거부한다", async () => {
  await withTemp("vibecode-harness-scope-manifests-", async (root) => {
    await mkdir(join(root, "api"), { recursive: true });
    await mkdir(join(root, "worker"), { recursive: true });
    await writeFile(join(root, "api", "package.json"), "{\"name\":\"api\"}\n");
    await writeFile(join(root, "worker", "requirements.txt"), "requests==2.32.0\n");
    const result = await runGg(["init", "--project", root, "--tools", "codex", "--level", "L1"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /독립 프로젝트 선언 2개 포함 \(api, worker\)/);
    await assert.rejects(stat(join(root, ".vibecode-harness")));
  });
});

test("프로젝트 하나뿐인 폴더는 그대로 초기화된다", async () => {
  await withTemp("vibecode-harness-scope-single-", async (root) => {
    await fakeRepository(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "package.json"), "{\"name\":\"single\"}\n");
    await writeFile(join(root, "src", "app.js"), "export const ok = true;\n");
    const result = await runGg(["init", "--project", root, "--tools", "all", "--runtime", "gg_standard", "--level", "L1"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const lock = JSON.parse(await readFile(join(root, ".vibecode-harness", "harness.lock.json"), "utf8"));
    assert.equal(Object.hasOwn(lock, "broad_scope_override"), false, "승인이 필요 없었으면 승인 기록도 없어야 한다");
  });
});

test("--allow-broad-scope 는 초기화를 허용하고 그 승인을 lock 과 영수증에 남긴다", async () => {
  await withTemp("vibecode-harness-scope-override-", async (root) => {
    await fakeRepository(join(root, "one"));
    await fakeRepository(join(root, "two"));
    const result = await runGg(["init", "--project", root, "--tools", "codex", "--runtime", "gg_standard", "--level", "L1", "--allow-broad-scope"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const lock = JSON.parse(await readFile(join(root, ".vibecode-harness", "harness.lock.json"), "utf8"));
    assert.ok(lock.broad_scope_override, "승인 사실이 lock 에 있어야 한다");
    assert.deepEqual(lock.broad_scope_override.nested_repositories, ["one", "two"]);
    assert.match(lock.broad_scope_override.reasons.join("\n"), /하위 저장소 2개 포함/);
    assert.ok(lock.broad_scope_override.allowed_at);
    const receipts = (await readdir(join(root, "evidence"))).filter((name) => name.endsWith("-init.json"));
    assert.equal(receipts.length, 1);
    const receipt = JSON.parse(await readFile(join(root, "evidence", receipts[0]), "utf8"));
    assert.deepEqual(receipt.broad_scope_override.nested_repositories, ["one", "two"]);
  });
});

test("gg doctor 는 범위가 넓어진 기존 프로젝트에 WARN 을 내되 실패로 만들지 않는다", async () => {
  await withTemp("vibecode-harness-scope-doctor-", async (root) => {
    // 초기화 시점에는 프로젝트 하나였다.
    const init = await runGg(["init", "--project", root, "--tools", "codex", "--runtime", "gg_standard", "--level", "L1"]);
    assert.equal(init.code, 0, init.stdout + init.stderr);
    // 그 뒤 저장소 세 개가 아래에 생겼다.
    await fakeRepository(join(root, "alpha"));
    await fakeRepository(join(root, "beta"));
    await fakeRepository(join(root, "gamma"));

    const doctor = await runGg(["doctor", "--project", root]);
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
    const report = JSON.parse(doctor.stdout.slice(doctor.stdout.indexOf("{")));
    assert.equal(report.status, "ready_for_verify");
    assert.ok(Array.isArray(report.warnings));
    assert.match(report.warnings.join("\n"), /WARN 범위 과다: 하위 저장소 3개 포함 \(alpha, beta, gamma\)/);
    // 경고는 실패 목록에 들어가지 않는다.
    assert.equal(report.policy_failures.some((item) => /범위 과다/.test(item)), false);
  });
});

test("드라이브 루트와 홈 디렉터리는 파일을 쓰지 않고 거부한다", async () => {
  // 이 두 경로에는 실제로 아무것도 쓰면 안 되므로, 거부가 mkdir 보다 먼저인지가 핵심이다.
  const driveRoot = parse(resolve(tmpdir())).root;
  for (const target of [driveRoot, homedir()]) {
    // 이 PC 에서 그 경로가 이미 하네스 프로젝트라면 lock 보호가 먼저 거부한다 — 그건 다른 검사다.
    if (await stat(join(target, ".vibecode-harness", "harness.lock.json")).then(() => true, () => false)) continue;
    const result = await runGg(["init", "--project", target, "--tools", "codex", "--level", "L1"]);
    assert.notEqual(result.code, 0, `${target} 는 거부돼야 한다`);
    assert.match(result.stderr, /범위 과다/);
    assert.match(result.stderr, /프로젝트 폴더가 아닙니다/);
    await assert.rejects(stat(join(target, ".vibecode-harness", "harness.lock.json")));
  }
});
