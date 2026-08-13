# 바이브코드 하네스

> 공무원이 Codex 또는 Claude Code로 업무 도구를 만들 때, 기획·화면 설계·구현·테스트·보안 점검을 같은 순서로 진행하도록 돕는 실행형 개발 도구입니다.

바이브코드 하네스는 다음을 프로젝트에 적용합니다.

- 허용 개발 언어: **Python, JavaScript, TypeScript**
- 화면이 있는 업무 도구의 설계 확인 절차
- 새 패키지 사용 전 보안 확인 절차
- 구현 후 테스트와 `vibecode-checker` 보안 점검
- Codex와 Claude Code가 읽는 프로젝트 지침, Claude Code 작업 전 Hook, 가능한 경우 Git 커밋 전 점검

## 3단계로 시작하기

### 1. 설치하기

현재 설치 스크립트는 **Windows**에서 사용할 수 있습니다. Git을 설치하지 않아도 됩니다.

1. 이 저장소에서 **Code > Download ZIP**을 선택합니다.
2. 받은 ZIP 파일을 모두 풉니다.
3. 압축을 푼 폴더에서 PowerShell을 열고 아래 명령을 실행합니다.

```powershell
Unblock-File .\install.ps1
.\install.ps1 -InstallPrerequisites -AllowGitHubPilotSource
```

설치 과정에서 필요한 경우 Windows가 Node.js LTS와 Python 3.13 설치를 안내합니다. 설치 창의 승인 여부는 사용자가 직접 결정합니다. 설치가 끝나면 하네스와 보안 체커 상태를 자동으로 확인합니다.

설치 파일은 다음 위치에 만들어집니다.

```text
%LOCALAPPDATA%\Gyeonggi\VibeCodeHarness\github-pilot
```

이미 설치한 경우에도 새 ZIP을 다시 받은 뒤 같은 명령을 실행하면, 기존 설치를 백업한 후 새 파일로 교체합니다.

### 2. 프로젝트에 적용하기

PowerShell에서 아래처럼 하네스 명령 위치를 변수로 지정합니다. 예시는 TypeScript 기반 내부 업무 도구에 Codex와 Claude Code를 함께 적용하는 경우입니다.

```powershell
$gg = "$env:LOCALAPPDATA\Gyeonggi\VibeCodeHarness\github-pilot\gg.cmd"

& $gg init --project C:\work\my-service --tools both --runtime typescript_web --level L2
& $gg doctor --project C:\work\my-service
```

`init`은 프로젝트 안에 정책과 실행기를 복사하고, 선택한 AI 도구의 지침을 적용합니다. 이미 있는 `AGENTS.md`, `CLAUDE.md`, Claude 설정, Git Hook은 덮어쓰지 않습니다.

| 항목 | 선택 값 | 언제 선택하나요 |
|---|---|---|
| AI 도구 | `codex`, `claude`, `both` | Codex만, Claude Code만, 또는 둘 다 사용할 때 |
| 개발 방식 | `python_internal` | 내부 업무 처리·데이터 처리 중심 도구 |
|  | `node_web` | JavaScript 기반 웹 도구 |
|  | `typescript_web` | TypeScript 기반 웹 도구, 일반적인 웹 업무 도구에 권장 |
| 점검 수준 | `L1` | 아이디어 또는 간단한 시제품 |
|  | `L2` | 내부 업무 도구, 테스트와 보안 점검을 함께 수행 |
|  | `L3` | 이관·배포 전 더 엄격한 점검이 필요한 경우 |

### 3. 순서대로 개발하기

```powershell
# 1) 만들 업무를 개인정보 없이 짧게 설명합니다.
& $gg start --project C:\work\my-service --brief "민원 처리 현황을 확인하는 내부 웹 도구"

# 2) 화면, DB, 관리자 기능이 필요한지 결정합니다.
& $gg design --project C:\work\my-service --database no --admin no --external-api no --confirm

# 3) 새 패키지를 쓰기 전에 확인합니다.
& $gg package check --project C:\work\my-service --ecosystem npm --name example-package --version 1.2.3

# 4) 구현한 뒤 정책과 실행 환경을 확인합니다.
& $gg build --project C:\work\my-service

# 5) 테스트와 보안 점검을 실행합니다.
& $gg verify --project C:\work\my-service --run-tests

# 6) 이관 또는 배포 전에 검토 자료를 만듭니다.
& $gg release --project C:\work\my-service
```

## 하네스가 하는 일

### 기획과 설계

`gg start`는 업무 목적을 기록하고, `gg design`은 화면·기능·DB·관리자 기능이 필요한지 확인하는 설계 파일을 만듭니다. 화면이 있는 도구는 핵심 화면 시안을 확인한 뒤 구현 단계로 넘어갑니다.

업무 설명에는 실명, 연락처, 주민등록번호, 비밀번호, API 키, 토큰을 입력하지 마세요. 하네스는 흔한 개인정보·비밀값 형태를 발견하면 해당 설명의 저장을 중단합니다.

### 개발 언어와 환경

프로젝트에 적용한 뒤 `gg build`와 `gg verify`는 Python, JavaScript, TypeScript 외의 소스 파일과 허용되지 않은 실행 명령을 확인합니다. 정책 파일이나 하네스 실행 파일이 바뀐 경우에도 검증을 멈추고 확인을 요구합니다.

### AI 코딩 도구 연결

| 도구 | 하네스 적용 방식 |
|---|---|
| Codex | 프로젝트의 `AGENTS.md`와 `.codex/vibecode-harness.md`를 적용합니다. |
| Claude Code | 프로젝트의 `CLAUDE.md`와 작업 전 Hook을 적용합니다. 승인되지 않은 언어 파일 생성, 직접 패키지 설치 등은 Hook이 막습니다. |
| ChatGPT/Codex 데스크톱, Claude Desktop | 현재 하네스가 전용 설정을 자동으로 적용하지 않습니다. 보안 체커 MCP 연결은 체커 README의 도구별 안내를 따릅니다. |

Git 저장소이고 기존 Hook 설정과 충돌하지 않는 경우에는 커밋 전에 `gg verify --hook`을 실행하는 Hook도 적용합니다. 기존 Hook이 있으면 덮어쓰지 않고 수동 확인이 필요하다고 알려줍니다.

### 패키지와 보안 점검

새 npm 또는 PyPI 패키지를 사용하기 전에는 `gg package check`로 이름과 정확한 버전을 확인합니다. 이 명령은 패키지를 설치하지 않습니다.

`gg verify --run-tests`는 다음을 순서대로 확인합니다.

1. 허용 언어, 런타임, 정책 파일, 설계 확인 기록
2. 프로젝트의 테스트 명령
3. `vibecode-checker`의 코드·의존성 점검

L2와 L3에서는 테스트를 생략할 수 없습니다. 체커가 없거나 검사 범위·의존성 점검이 불완전하면 성공으로 처리하지 않고 `incomplete`로 표시합니다. 체커가 차단 종료 코드를 반환하면 검증은 중단됩니다.

## 결과 읽는 법

| 결과 | 뜻 | 다음 행동 |
|---|---|---|
| `ready` | 언어·런타임·정책·설계 조건을 통과했습니다. | 구현 또는 다음 점검으로 진행합니다. |
| `blocked` | 정책, 테스트 또는 체커 차단 조건에 문제가 있습니다. | 표시된 문제를 고친 뒤 다시 실행합니다. |
| `incomplete` | 체커, 검사 대상, 의존성 점검 등 일부 확인을 마치지 못했습니다. | 누락된 항목을 확인한 뒤 다시 실행합니다. |
| `review_required` | 자동 점검은 끝났지만 이관·배포 전 사람 검토가 필요합니다. | 최신 보안 점검 결과와 미해결 항목을 확인합니다. |

하네스 증적은 프로젝트의 `evidence/` 폴더에 저장됩니다. 체커 보고서를 별도로 만들려면 다음처럼 실행합니다.

```powershell
gvskb scan C:\work\my-service --check-deps -o 보안점검.md
```

체커는 `보안점검.md`와 인쇄용 `보안점검.html`을 함께 만듭니다. 보고서에는 발견 항목, 이유, 수정 방향, 의존성 점검 결과가 한국어로 정리됩니다.

## 개인정보와 파일 처리

- 하네스가 만드는 기획·설계·검증 증적과 체커 보고서는 사용자의 프로젝트 폴더 또는 사용자가 지정한 PC 위치에 저장됩니다.
- 하네스는 프로젝트 원본 소스나 보고서 본문을 자체 서버로 전송하지 않습니다.
- 온라인 의존성 점검을 사용할 때는 체커가 취약점 정보를 확인하기 위해 **패키지 이름과 버전**을 조회할 수 있습니다. 원본 소스와 보고서 본문은 전송하지 않습니다.
- Codex, Claude Code 등 AI 도구에 직접 입력하는 내용은 각 도구의 처리 정책을 따릅니다. 개인정보, 비밀번호, 인증정보, 실제 API 키를 입력하지 마세요.

## 자주 묻는 문제

### `gvskb` 또는 체커를 찾을 수 없다고 나옵니다

하네스 설치 폴더에서 설치 명령을 다시 실행합니다.

```powershell
.\install.ps1 -InstallPrerequisites -AllowGitHubPilotSource
```

그 뒤 프로젝트에서 `& $gg doctor --project C:\work\my-service`를 실행해 상태를 확인합니다.

### PowerShell이 `install.ps1` 실행을 막습니다

다운로드한 파일의 차단 표시를 해제한 뒤 다시 실행합니다.

```powershell
Unblock-File .\install.ps1
```

### 테스트가 실행되지 않습니다

L2 이상에서는 프로젝트에 테스트 명령이 필요합니다. `package.json`의 `scripts.test` 또는 Python 프로젝트의 테스트 환경을 먼저 준비한 뒤 `gg verify --run-tests`를 다시 실행하세요.

## 더 알아보기

- 보안 체커: [Lex6won/vibecode-checker](https://github.com/Lex6won/vibecode-checker)
- Windows 설치 상세 안내: [docs/18_github_pilot_install.md](./docs/18_github_pilot_install.md)
- 체커의 MCP 연결과 보고서 읽는 법: 체커 저장소 README
