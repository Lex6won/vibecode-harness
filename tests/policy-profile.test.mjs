import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { languageFailureForPath, runtimeFailureForCommand } from "../lib/policy-engine.mjs";

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

test("TypeScript PostgreSQL profile permits only TypeScript implementation sources", () => {
  assert.equal(languageFailureForPath("typescript_postgres", "src/App.tsx"), null);
  assert.equal(languageFailureForPath("typescript_postgres", "postgres/migrations/001.sql"), null);
  assert.match(languageFailureForPath("typescript_postgres", "src/server.js"), /JavaScript/);
  assert.match(languageFailureForPath("typescript_postgres", "worker.py"), /Python/);
  assert.match(runtimeFailureForCommand("typescript_postgres", "python tool.py"), /Python/);
  assert.equal(runtimeFailureForCommand("typescript_postgres", "supabase functions deploy hello"), null);
  assert.equal(languageFailureForPath("typescript_supabase", "src/App.tsx"), null, "legacy Supabase lock remains compatible");
});

test("TypeScript PostgreSQL project blocks JavaScript and Python bypasses", async () => {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-supabase-"));
  try {
    const init = await runGg(project, ["init", "--tools", "codex", "--runtime", "typescript_postgres", "--level", "L1"]);
    assert.equal(init.code, 0, init.stdout + init.stderr);
    await writeFile(join(project, "App.tsx"), "export const App = () => null;\n");
    await writeFile(join(project, "unsafe.js"), "export default 1;\n");
    await writeFile(join(project, "requirements.txt"), "requests==2.32.0\n");
    const build = await runGg(project, ["build"]);
    assert.equal(build.code, 10, build.stdout + build.stderr);
    assert.match(build.stdout, /JavaScript/);
    assert.match(build.stdout, /Python/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("local verification does not require a checker installed on the user PC", async () => {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-server-checker-"));
  try {
    const init = await runGg(project, ["init", "--tools", "codex", "--runtime", "typescript_web", "--level", "L1"]);
    assert.equal(init.code, 0, init.stdout + init.stderr);
    await writeFile(join(project, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
    await writeFile(join(project, "app.ts"), "export const ready = true;\n");
    await writeFile(join(project, "app.test.js"), "import test from 'node:test'; test('ready', () => {});\n");
    const verified = await runGg(project, ["verify", "--run-tests"]);
    assert.equal(verified.code, 0, verified.stdout + verified.stderr);
    assert.match(verified.stdout, /ready_for_portal_scan/);
    assert.match(verified.stdout, /server_scan_required/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a changed copied policy engine blocks project verification", async () => {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-policy-engine-tamper-"));
  try {
    const init = await runGg(project, ["init", "--tools", "codex", "--runtime", "typescript_web", "--level", "L1"]);
    assert.equal(init.code, 0, init.stdout + init.stderr);
    const engine = join(project, ".vibecode-harness", "lib", "policy-engine.mjs");
    await appendFile(engine, "\n// unauthorized change\n");
    const build = await runGg(project, ["build"]);
    assert.equal(build.code, 10, build.stdout + build.stderr);
    assert.match(build.stdout, /policy engine/i);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("desktop guidance and Lovable GitHub bridge are applied with explicit enforcement levels", async () => {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-tool-bridge-"));
  try {
    const init = await runGg(project, [
      "init", "--tools", "codex,claude-desktop,chatgpt-desktop,lovable",
      "--runtime", "typescript_postgres", "--level", "L1"
    ]);
    assert.equal(init.code, 0, init.stdout + init.stderr);
    const lock = JSON.parse(await readFile(join(project, ".vibecode-harness", "harness.lock.json"), "utf8"));
    assert.deepEqual(lock.tools, ["codex", "claude-desktop", "chatgpt-codex-desktop", "lovable-github"]);
    assert.match(await readFile(join(project, ".vibecode-harness", "tool-guides", "claude-desktop.md"), "utf8"), /Git gate/);
    assert.match(await readFile(join(project, "VIBECODE-LOVABLE.md"), "utf8"), /TypeScript/);
    const workflow = await readFile(join(project, ".github", "workflows", "vibecode-harness.yml"), "utf8");
    assert.match(workflow, /ubuntu-latest/);
    assert.match(workflow, /actions\/setup-node@v4/);
    const doctor = await runGg(project, ["doctor"]);
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /git_gate_required/);
    assert.match(doctor.stdout, /github_pr_gate_required/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("Lovable GitHub support refuses a non-TypeScript-PostgreSQL policy profile", async () => {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-lovable-profile-"));
  try {
    const result = await runGg(project, ["init", "--tools", "lovable", "--runtime", "typescript_web", "--level", "L1"]);
    assert.equal(result.code, 70, result.stdout + result.stderr);
    assert.match(result.stderr, /typescript_postgres/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("configure preserves a user-modified Lovable guidance file instead of deleting it", async () => {
  const project = await mkdtemp(join(tmpdir(), "vibecode-harness-lovable-preserve-"));
  try {
    const init = await runGg(project, ["init", "--tools", "codex,lovable", "--runtime", "typescript_postgres", "--level", "L1"]);
    assert.equal(init.code, 0, init.stdout + init.stderr);
    const guide = join(project, "VIBECODE-LOVABLE.md");
    await appendFile(guide, "\nUser-specific Lovable instruction.\n");
    const result = await runGg(project, ["configure", "--remove", "lovable"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(await readFile(guide, "utf8"), /User-specific/);
    assert.match(result.stdout, /lovable-github-guidance/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
