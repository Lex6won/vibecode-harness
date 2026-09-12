import assert from "node:assert/strict";
import test from "node:test";
import { isDirectPackageInstall, runtimeFailureForCommand } from "../lib/policy-engine.mjs";

/**
 * 명령줄을 어떻게 읽을 것인가.
 *
 * 무엇이 잘못돼 있었나: 명령줄 **문자열 전체**에 정규식을 걸었다. 그래서
 * 따옴표 안의 평범한 글자도 명령으로 읽혔다. 실제로 커밋 메시지에 'Python'
 * 이라는 낱말이 들어갔다는 이유로 커밋이 차단됐고, 나중에는 메시지에
 * 'npm install' 이라는 글자가 있다는 이유로 또 차단됐다 — 둘 다 패키지를
 * 설치하지도, 어떤 런타임을 실행하지도 않는 명령이었다.
 *
 * 우연히 걸리는 차단은 우연히 통과하는 것과 같은 문제다. 정책이 무엇을 막고
 * 무엇을 막지 않는지 아무도 말할 수 없게 되고, 그러면 사람들은 정책을
 * 신뢰하는 대신 우회하는 법을 배운다.
 *
 * 그래서 따옴표를 지키며 토큰으로 쪼개고 **명령 자리**에 있는 것만 본다.
 * 대신 셸 래퍼의 인자는 파고든다 — 거기까지 놓으면 검사는 형식만 남는다.
 */

const NARROW = "typescript_postgres";  // Python 미허용
const STANDARD = "gg_standard";        // 기관 표준 — 세 언어 모두 허용
const PYTHON_ONLY = "python_internal"; // Node 미허용

// ---------------------------------------------------------------------------
// 따옴표 안의 글자는 명령이 아니다
// ---------------------------------------------------------------------------

test("커밋 메시지에 든 낱말 때문에 차단되지 않는다", () => {
  const messages = [
    'git commit -m "fix: Python 런타임 안내 문구를 고침"',
    'git commit -m "게이트가 죽으면 npm install 이 그대로 진행됐다"',
    'git commit -m "go 언어는 다루지 않는다"',
    'echo "pip install 은 직접 하지 않습니다"'
  ];
  for (const command of messages) {
    assert.equal(runtimeFailureForCommand(NARROW, command), null, `차단되면 안 됩니다: ${command}`);
    assert.equal(isDirectPackageInstall(command), false, `설치로 읽히면 안 됩니다: ${command}`);
  }
});

test("검색어로 쓰인 낱말도 명령이 아니다", () => {
  assert.equal(runtimeFailureForCommand(NARROW, 'grep -rn "python" src/'), null);
  assert.equal(isDirectPackageInstall('grep -rn "npm install" docs/'), false);
});

// ---------------------------------------------------------------------------
// 실제 실행은 그대로 막힌다
// ---------------------------------------------------------------------------

test("실제 런타임 실행은 막힌다", () => {
  assert.match(runtimeFailureForCommand(NARROW, "python -m pytest -q"), /Python/);
  assert.match(runtimeFailureForCommand(NARROW, "pip --version"), /Python/);
  assert.match(runtimeFailureForCommand(NARROW, "go build ./..."), /승인되지 않은/);
  assert.match(runtimeFailureForCommand(PYTHON_ONLY, "npm test"), /Node\.js/);
});

test("구분자 뒤도 명령 자리다", () => {
  assert.match(runtimeFailureForCommand(NARROW, "cd src && python app.py"), /Python/);
  assert.match(runtimeFailureForCommand(NARROW, "ls ; pip list"), /Python/);
  assert.match(runtimeFailureForCommand(NARROW, "cat x | python -"), /Python/);
});

test("경로와 확장자가 붙어도 같은 실행 파일로 본다", () => {
  for (const command of ["C:/Python311/python.exe app.py", "/usr/bin/python3 app.py", "./venv/Scripts/pip.exe list"]) {
    assert.ok(runtimeFailureForCommand(NARROW, command), `놓쳤습니다: ${command}`);
  }
});

test("따옴표로 감싼 실행 파일 이름도 실행이다", () => {
  // 따옴표를 벗겨서 토큰으로 쓴다 — 이걸 놓치면 우회가 한 줄로 끝난다.
  assert.match(runtimeFailureForCommand(NARROW, '"python" app.py'), /Python/);
  assert.equal(isDirectPackageInstall('"npm" install left-pad'), true);
});

// ---------------------------------------------------------------------------
// 셸 래퍼 — 인자 안쪽까지 본다
// ---------------------------------------------------------------------------

test("셸 래퍼로 감싼 실행도 막힌다", () => {
  const wrapped = [
    'bash -c "python app.py"',
    "sh -c 'pip install evil'",
    'sudo python app.py',
    'env FOO=1 python app.py'
  ];
  for (const command of wrapped) {
    assert.ok(runtimeFailureForCommand(NARROW, command), `래퍼 안쪽을 놓쳤습니다: ${command}`);
  }
  assert.equal(isDirectPackageInstall('bash -c "pip install evil"'), true);
  assert.equal(isDirectPackageInstall("sh -c 'npm install left-pad'"), true);
});

// ---------------------------------------------------------------------------
// 직접 설치 판별
// ---------------------------------------------------------------------------

test("직접 설치는 그대로 잡는다", () => {
  for (const command of [
    "npm install left-pad",
    "npm.cmd install left-pad",
    "pnpm add left-pad",
    "yarn add left-pad",
    "pip install requests",
    "pip3 install requests",
    "python -m pip install requests",
    "npx create-react-app x"
  ]) {
    assert.equal(isDirectPackageInstall(command), true, `놓쳤습니다: ${command}`);
  }
});

test("설치가 아닌 것은 설치로 읽지 않는다", () => {
  for (const command of [
    "npm test",
    "npm run check",
    "npx --no-install eslint .",
    "pip list",
    "python -m pytest -q",
    "git commit -m \"install 안내를 고침\""
  ]) {
    assert.equal(isDirectPackageInstall(command), false, `설치로 잘못 읽었습니다: ${command}`);
  }
});

// ---------------------------------------------------------------------------
// 기관 표준에서는 두 축이 모두 열린다
// ---------------------------------------------------------------------------

test("gg_standard 는 두 생태계의 실행을 모두 허용한다", () => {
  for (const command of ["python -m pytest -q", "pip list", "npm test", "node --test", "npx --no-install eslint ."]) {
    assert.equal(runtimeFailureForCommand(STANDARD, command), null, `막히면 안 됩니다: ${command}`);
  }
  // 허용 언어라고 해서 직접 설치까지 허용되는 것은 아니다 — 그건 별개 검사다.
  assert.equal(isDirectPackageInstall("pip install requests"), true);
});

test("gg_standard 에서도 승인되지 않은 언어는 막힌다", () => {
  assert.match(runtimeFailureForCommand(STANDARD, "go build ./..."), /승인되지 않은/);
  assert.match(runtimeFailureForCommand(STANDARD, "cargo build"), /승인되지 않은/);
});

// ---------------------------------------------------------------------------
// 입력이 이상해도 통과로 바꿔 말하지 않는다
// ---------------------------------------------------------------------------

test("빈 입력과 닫히지 않은 따옴표를 다룬다", () => {
  assert.equal(runtimeFailureForCommand(NARROW, ""), null);
  assert.equal(runtimeFailureForCommand(NARROW, null), null);
  assert.equal(isDirectPackageInstall(undefined), false);
  // 닫히지 않은 따옴표 안은 인용문으로 본다 — 명령 자리로 승격시키지 않는다.
  assert.equal(isDirectPackageInstall('git commit -m "npm install'), false);
  // 다만 그 앞의 실제 명령은 그대로 보인다.
  assert.match(runtimeFailureForCommand(PYTHON_ONLY, 'npm run x -- "설명 npm install'), /Node\.js/);
});
