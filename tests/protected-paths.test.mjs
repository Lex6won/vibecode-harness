import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { isDirectPackageInstall, isProtectedPath, protectedPathCommandFailure, protectedPathFailure, runtimeFailureForCommand } from "../lib/policy-engine.mjs";

/**
 * 47차 — 하네스 보호 파일과 설치 명령 확장.
 *
 * 무엇이 잘못돼 있었나: 훅은 `.json` 을 허용 확장자로 보았고 lock 의 해시는 lock 자신이 들고
 * 있었다. 그래서 Claude 가 `.claude/settings.json` 에서 훅 항목을 지우거나 `harness.lock.json`
 * 의 `policy_profile` 을 바꾸면 그 뒤로는 아무것도 막히지 않았다. 또 설치 명령 탐지가
 * `npm install|add`·`pip install` 네 가지뿐이라 `npm i`·`npm ci`·`uv`·`poetry`·`bun` 이 통과했다.
 */

const hook = resolve(import.meta.dirname, "..", "bin", "claude-pre-tool.mjs");

function invoke(payload) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [hook], { shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

// ---------------------------------------------------------------------------
// 보호 경로
// ---------------------------------------------------------------------------

test("보호 경로 판정", () => {
  for (const path of [
    ".vibecode-harness/harness.lock.json",
    "C:\\work\\svc\\.vibecode-harness\\policy\\package-policy.json",
    ".claude/settings.json",
    "sub/.claude/settings.local.json",
    ".githooks/pre-commit",
    ".github/workflows/vibecode-harness.yml",
    "/home/u/svc/.vibecode-harness/bin/gg.mjs"
  ]) {
    assert.ok(isProtectedPath(path), `보호 경로여야 한다: ${path}`);
    assert.match(protectedPathFailure(path), /gg update/);
  }
  for (const path of ["src/app.ts", ".claude/vibecode-harness.md", ".github/workflows/deploy.yml", "docs/settings.json", "harness.lock.json.md", ""]) {
    assert.equal(isProtectedPath(path), false, `보호 경로가 아니어야 한다: ${path}`);
    assert.equal(protectedPathFailure(path), null);
  }
});

test("보호 경로에 쓰는 명령은 막고 읽는 명령은 통과", () => {
  for (const command of [
    "echo '{}' > .claude/settings.json",
    "cat x >> .vibecode-harness/harness.lock.json",
    "rm -rf .vibecode-harness",
    "del .githooks\\pre-commit",
    "mv .claude/settings.json .claude/settings.bak",
    "Set-Content -Path .claude/settings.json -Value '{}'",
    "Remove-Item .vibecode-harness -Recurse",
    "sed -i 's/general/x/' .vibecode-harness/harness.lock.json",
    "node -e \"require('fs').writeFileSync('.vibecode-harness/harness.lock.json','{}')\"",
    "python -c \"open('.claude/settings.json','w').write('{}')\"",
    "cp settings.json .claude/settings.json",
    "tee .githooks/pre-commit < /dev/null"
  ]) {
    assert.match(protectedPathCommandFailure(command) || "", /보호 파일/, `막혀야 한다: ${command}`);
  }
  for (const command of [
    "cat .claude/settings.json",
    "Get-Content .vibecode-harness/harness.lock.json",
    "type .githooks\\pre-commit",
    "ls .vibecode-harness",
    "git diff .vibecode-harness/harness.lock.json",
    "node .vibecode-harness/bin/gg.mjs verify --project .",
    "npm test",
    ""
  ]) {
    assert.equal(protectedPathCommandFailure(command), null, `통과해야 한다: ${command}`);
  }
});

test("훅: Write·NotebookEdit·Bash·PowerShell 도구에서 보호 파일을 막는다", async () => {
  const write = await invoke({ tool_name: "Write", tool_input: { file_path: ".claude/settings.json", content: "{}" } });
  assert.equal(write.code, 2);
  assert.match(write.stderr, /보호 파일/);
  const notebook = await invoke({ tool_name: "NotebookEdit", tool_input: { notebook_path: ".vibecode-harness/notes.ipynb" } });
  assert.equal(notebook.code, 2);
  const bash = await invoke({ tool_name: "Bash", tool_input: { command: "rm .vibecode-harness/harness.lock.json" } });
  assert.equal(bash.code, 2);
  const powershell = await invoke({ tool_name: "PowerShell", tool_input: { command: "Remove-Item .claude\\settings.json" } });
  assert.equal(powershell.code, 2);
  const read = await invoke({ tool_name: "Bash", tool_input: { command: "cat .claude/settings.json" } });
  assert.equal(read.code, 0, read.stderr);
});

test("훅: PowerShell 도구의 설치·런타임 명령도 Bash 와 같이 막는다", async () => {
  const install = await invoke({ tool_name: "PowerShell", tool_input: { command: "npm i firebase" } });
  assert.equal(install.code, 2);
  assert.match(install.stderr, /gg package check/);
  const runtime = await invoke({ tool_name: "PowerShell", tool_input: { command: "go run ." } });
  assert.equal(runtime.code, 2);
  const notebookGo = await invoke({ tool_name: "NotebookEdit", tool_input: { notebook_path: "analysis.ipynb" } });
  assert.equal(notebookGo.code, 0, notebookGo.stderr);
});

// ---------------------------------------------------------------------------
// 설치 명령 확장
// ---------------------------------------------------------------------------

test("확장된 설치 명령을 잡는다", () => {
  for (const command of [
    "npm i left-pad", "npm ci", "npm -g install left-pad", "npm --prefix . install", "npm install-ci-test", "npm exec create-vite", "npm x cowsay",
    "pnpm i", "pnpm add zod", "pnpm dlx create-vite",
    "yarn", "yarn add zod", "yarn install --frozen-lockfile", "yarn dlx create-vite",
    "bun add zod", "bun install", "bun i zod", "bunx create-vite",
    "pipx install black", "py -m pip install requests", "python3 -m pip install -U requests", "python -m pip --no-cache-dir install requests",
    "uv pip install requests", "uv add requests", "uv sync", "uv tool install ruff",
    "poetry add requests", "poetry install", "pipenv install requests", "conda install numpy",
    "cd app && npm i", "bash -c 'uv add requests'"
  ]) {
    assert.equal(isDirectPackageInstall(command), true, `놓쳤습니다: ${command}`);
  }
});

test("설치가 아닌 것은 여전히 설치로 읽지 않는다", () => {
  for (const command of [
    "npm test", "npm run build", "npm ls", "npm view zod", "npx --no-install eslint .", "pnpm test", "yarn test", "yarn run build",
    "pip list", "pip show requests", "uv run pytest", "uv lock", "poetry run pytest", "poetry show", "conda list",
    "python -m pytest -q", "py -m pytest", 'git commit -m "npm i 안내"', "echo 'bun add' > README.md"
  ]) {
    assert.equal(isDirectPackageInstall(command), false, `설치로 잘못 읽었습니다: ${command}`);
  }
});

test("deno · bun · perl 실행은 승인되지 않은 런타임이다", () => {
  for (const command of ["deno run app.ts", "bun run app.ts", "perl script.pl", "lua init.lua"]) {
    assert.match(runtimeFailureForCommand("gg_standard", command) || "", /승인되지 않은/, command);
  }
  assert.equal(runtimeFailureForCommand("gg_standard", "node app.mjs"), null);
});
