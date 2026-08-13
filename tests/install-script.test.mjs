import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

const harnessRoot = resolve(import.meta.dirname, "..");
const installer = join(harnessRoot, "install.ps1");
const gg = join(harnessRoot, "bin", "gg.mjs");

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("GitHub pilot installer has explicit source acknowledgement and no bypass execution", async () => {
  const source = await readFile(installer, "utf8");
  assert.match(source, /AllowGitHubPilotSource/);
  assert.match(source, /InstallPrerequisites/);
  assert.match(source, /OpenJS\.NodeJS\.LTS/);
  assert.match(source, /Python\.Python\.3\.13/);
  assert.match(source, /vibecode-checker\/archive\/refs\/heads\/main\.zip/);
  assert.match(source, /staging-\$PID/);
  assert.doesNotMatch(source, /ExecutionPolicy\s+Bypass/i);
  assert.doesNotMatch(source, /Invoke-Expression|\bIEX\b/i);
  assert.doesNotMatch(source, /Remove-Item/i);
});

test("GitHub pilot installer is valid PowerShell syntax", async () => {
  const escaped = installer.replace(/'/g, "''");
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await run(executable, ["-NoProfile", "-NonInteractive", "-Command", `[void][scriptblock]::Create([IO.File]::ReadAllText('${escaped}')); Write-Output 'parsed'`]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /parsed/);
});

test("GitHub pilot installer refuses an unacknowledged moving source", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibecode-harness-pilot-refusal-"));
  const destination = join(root, "installed");
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const result = await run(executable, ["-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", installer, "-InstallDir", destination, "-SkipChecker"]);
    assert.notEqual(result.code, 0, result.stdout + result.stderr);
    await assert.rejects(stat(destination));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor discovers a checker installed in the per-user Python Scripts directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibecode-harness-user-script-"));
  try {
    const scripts = join(root, "Python", "Python313", "Scripts");
    await mkdir(scripts, { recursive: true });
    await copyFile(process.execPath, join(scripts, "gvskb.exe"));
    const result = await run(process.execPath, [gg, "doctor", "--project", root], {
      env: { ...process.env, APPDATA: root }
    });
    assert.notEqual(result.code, 70, result.stdout + result.stderr);
    assert.match(result.stdout, /python_user_scripts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub pilot installer installs a runnable harness without a checker", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibecode-harness-pilot-install-"));
  const destination = join(root, "installed");
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const result = await run(executable, [
      "-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", installer,
      "-InstallDir", destination,
      "-SkipChecker",
      "-AllowGitHubPilotSource"
    ]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.ok((await stat(join(destination, "gg.cmd"))).isFile());
    assert.ok((await stat(join(destination, ".vibecode-harness-install.json"))).isFile());
    assert.ok((await stat(join(destination, "bin", "gg.mjs"))).isFile());
    const receipt = JSON.parse(await readFile(join(destination, ".vibecode-harness-install.json"), "utf8"));
    assert.equal(receipt.installation_kind, "github_pilot");
    assert.equal(receipt.checker_source, "not_requested");
    assert.equal(receipt.source_directory, harnessRoot);
    const project = join(root, "project");
    const init = await run(process.execPath, [join(destination, "bin", "gg.mjs"), "init", "--project", project, "--tools", "both", "--runtime", "typescript_web", "--level", "L2"]);
    assert.equal(init.code, 0, init.stdout + init.stderr);
    await (await import("node:fs/promises")).writeFile(join(project, "package.json"), JSON.stringify({ name: "pilot-install-test", private: true, type: "module", scripts: { test: "node --test" } }));
    await (await import("node:fs/promises")).writeFile(join(project, "app.ts"), "export const ready = true;\n");
    const start = await run(process.execPath, [join(destination, "bin", "gg.mjs"), "start", "--project", project, "--brief", "Internal service status screen"]);
    assert.equal(start.code, 0, start.stdout + start.stderr);
    const design = await run(process.execPath, [join(destination, "bin", "gg.mjs"), "design", "--project", project, "--database", "no", "--admin", "no", "--external-api", "no", "--confirm"]);
    assert.equal(design.code, 0, design.stdout + design.stderr);
    const build = await run(process.execPath, [join(destination, "bin", "gg.mjs"), "build", "--project", project]);
    assert.equal(build.code, 0, build.stdout + build.stderr);
    const update = await run(executable, [
      "-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", installer,
      "-InstallDir", destination,
      "-SkipChecker",
      "-AllowGitHubPilotSource"
    ]);
    assert.equal(update.code, 0, update.stdout + update.stderr);
    const updatedReceipt = JSON.parse(await readFile(join(destination, ".vibecode-harness-install.json"), "utf8"));
    assert.match(updatedReceipt.previous_install_backup, /backup-/);
    assert.ok((await stat(updatedReceipt.previous_install_backup)).isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
