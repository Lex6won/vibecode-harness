# 바이브코드 하네스

> 공무원이 Codex, Claude Code, Google Antigravity로 업무 도구를 만들 때, 기획·화면 설계·구현·테스트·보안 점검을 같은 순서로 진행하도록 돕는 실행형 개발 하네스입니다.

바이브코드 하네스의 목표는 “앱을 빨리 만드는 것”에서 끝나지 않습니다. AI로 만든 결과물이 나중에 검증되고, 보완되고, 운영으로 갈 수 있도록 처음부터 공통 개발 약속과 증적을 남기게 합니다.

![Windows](https://img.shields.io/badge/Windows-supported-blue.svg)
![Node](https://img.shields.io/badge/Node.js-22+-green.svg)
![Languages](https://img.shields.io/badge/languages-Python%20%7C%20JavaScript%20%7C%20TypeScript-orange.svg)
![Checker](https://img.shields.io/badge/vibecode--checker-integrated-informational.svg)
![Evidence](https://img.shields.io/badge/evidence-local%20only-success.svg)

## 이 도구가 하는 일

1. **시작** — 만들 업무를 개인정보 없이 정리하고, AI 코딩 도구가 읽을 프로젝트 지침을 만듭니다.
2. **설계** — 화면, 기능, DB, 관리자 화면, 외부 API가 필요한지 먼저 확인하게 합니다.
3. **집행** — 개발 언어를 **Python, JavaScript, TypeScript**로 제한하고, 허용되지 않은 언어·런타임·정책 변경을 막습니다.
4. **패키지 확인** — 새 npm·PyPI 패키지를 쓰기 전에 `vibecode-checker`로 이름과 버전을 확인하게 합니다.
5. **검증** — 구현 뒤 테스트와 `vibecode-checker` 코드·의존성 점검을 함께 실행합니다.
6. **증적** — 기획, 설계, 테스트, 보안 점검 결과를 프로젝트의 `evidence/` 폴더에 남깁니다.

하네스는 보안 승인 도구가 아닙니다. 보안 위험을 직접 판정하는 주체도 아닙니다. 하네스는 개발 현장에서 정해진 순서와 기준을 **집행**하고, 체커가 만든 사실 기반 결과와 사람이 검토할 증적을 연결합니다.

## 왜 필요한가

바이브코딩은 구현 속도를 크게 높였습니다. 하지만 정식 운영까지 가려면 소스, 패키지, 테스트, 보안 점검, DB 변경, 운영 책임, 유지보수 계획이 함께 준비되어야 합니다. 이 경로가 없으면 개인 PC, 임시 서버, 외부 서비스에 결과물이 흩어지고 작은 문제가 바이브코딩 전체의 신뢰를 흔들 수 있습니다.

하네스는 이 문제를 “금지”로 풀지 않습니다. 개발자는 빠르게 만들되, 운영 후보가 될 수 있도록 처음부터 다음 약속을 남기게 합니다.

- 허가된 개발 언어와 런타임 안에서 시작합니다.
- 실제 개인정보·비밀값을 프롬프트나 증적에 넣지 않습니다.
- 화면과 기능을 먼저 확인하고 구현합니다.
- 새 패키지는 설치 전에 확인합니다.
- 테스트와 보안 점검을 건너뛰지 않습니다.
- 검증 결과를 사람이 다시 볼 수 있게 남깁니다.

## 하네스·체커·관리 포털의 역할

발표자료의 3자 구조를 하네스 기준으로 정리하면 다음과 같습니다.

| 도구 | 역할 | 하지 않는 일 |
|---|---|---|
| **하네스** | 개발 현장에서 언어·설계·패키지·테스트·보안 점검 순서를 집행합니다. | 취약점 자체 판정, 운영 승인, 관리 포털 직접 조회 |
| **vibecode-checker** | 코드, 의존성, 패키지 위험을 검사하고 한국어 보고서와 결과를 만듭니다. | 기관의 승인·예외·운영 인수 결정 |
| **관리 포털** | 프로젝트, 승격 신청, 증적 메타, 승인·예외·운영 책임을 기록합니다. | 원본 소스 보관, 비밀값 보관, 자동 운영 승인 |

하네스는 체커를 호출해 사실을 확인합니다. 관리 포털은 별도 서비스에서 결과 메타와 승인 흐름을 관리합니다. 하네스가 관리 포털을 직접 신뢰해 로컬 검사를 건너뛰는 구조는 목표가 아닙니다.

## 운영으로 가는 3존 흐름

하네스는 3존 거버넌스 중 **개발존**에서 쓰는 도구입니다.

| 구역 | 목적 | 하네스와의 관계 |
|---|---|---|
| **개발존** | 공무원이 빠르게 만들고 확인하는 곳 | 하네스가 프로젝트 시작, 설계, 구현, 테스트, 체커 점검을 돕습니다. |
| **검증존** | 운영과 같은 조건에서 다시 빌드·테스트·검증하는 곳 | 하네스 증적, 테스트 결과, 체커 결과를 검증 자료로 사용합니다. |
| **운영존** | 실제 사용자에게 안정적으로 서비스하는 곳 | 하네스 통과만으로 운영하지 않고, 사람의 승인과 운영 인수를 거칩니다. |

운영으로 가는 대상은 개발 PC의 임시 실행 상태가 아닙니다. 특정 커밋, 의존성 잠금파일, 테스트 결과, 체커 결과, 필요한 경우 DB migration과 배포 산출물이 함께 검증되어야 합니다.

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

### AI 코딩 도구에게 설치를 맡기는 경우

터미널을 사용할 수 있는 Codex 또는 Claude Code라면 다음처럼 요청해도 됩니다.

```text
https://github.com/Lex6won/vibecode-harness 저장소를 받아서 README에 따라 Windows용 하네스를 설치하고,
설치 후 gg doctor로 상태를 확인해줘. 기존 프로젝트 파일은 덮어쓰지 말고, 결과를 요약해줘.
```

다만 설치 중 Node.js나 Python 설치 창이 뜨면 사용자가 직접 승인해야 합니다.

### 2. 프로젝트에 적용하기

PowerShell에서 아래처럼 하네스 명령 위치를 변수로 지정합니다. 예시는 TypeScript 기반 내부 업무 도구에 Codex, Claude Code, Google Antigravity를 함께 적용하는 경우입니다.

```powershell
$gg = "$env:LOCALAPPDATA\Gyeonggi\VibeCodeHarness\github-pilot\gg.cmd"

& $gg init --project C:\work\my-service --tools all --runtime typescript_supabase --level L2
& $gg doctor --project C:\work\my-service
```

`init`은 프로젝트 안에 정책과 실행기를 복사하고, 선택한 AI 도구의 지침과 훅을 적용합니다. 이미 있는 `AGENTS.md`, `CLAUDE.md`, Claude 설정, Antigravity 플러그인, Git Hook은 덮어쓰지 않습니다. 터미널에서 질문에 답하며 시작하려면 `& $gg init --interactive`를 실행합니다.

| 항목 | 선택 값 | 언제 선택하나요 |
|---|---|---|
| AI 도구 | `codex`, `claude`, `antigravity`, `claude-desktop`, `chatgpt-desktop`, `lovable`, `both`, `all` | 하나만 또는 여러 도구를 같은 프로젝트에 적용할 때. `both`는 Codex+Claude Code, `all`은 지원하는 여섯 도구 전체입니다. `all`과 Lovable은 TypeScript/Supabase 엄격형을 사용합니다. |
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

## 하네스가 프로젝트에 만드는 것

| 파일·폴더 | 용도 |
|---|---|
| `AGENTS.md` | Codex가 읽는 프로젝트 작업 지침 |
| `.codex/vibecode-harness.md` | Codex에 하네스 사용을 명시하는 보조 지침 |
| `CLAUDE.md` | Claude Code가 읽는 프로젝트 작업 지침 |
| `.claude/settings.json` | Claude Code 작업 전 Hook 설정 |
| `.agents/plugins/vibecode-harness/` | Google Antigravity의 프로젝트 규칙, 스킬, 작업 전 Hook |
| `.vibecode-harness/` | 프로젝트에 고정된 하네스 실행기, 정책, lock 파일 |
| `.githooks/pre-commit` | 가능한 경우 커밋 전 `gg verify --hook` 실행 |
| `evidence/` | 기획, 설계, 검증, 체커 증적 저장 |

## AI 코딩 도구 연결

| 도구 | 하네스 적용 방식 |
|---|---|
| Codex | 프로젝트의 `AGENTS.md`와 `.codex/vibecode-harness.md`를 적용합니다. |
| Claude Code | 프로젝트의 `CLAUDE.md`와 작업 전 Hook을 적용합니다. 승인되지 않은 언어 파일 생성, 직접 패키지 설치 등은 Hook이 막습니다. |
| Google Antigravity | 프로젝트의 `.agents/plugins/vibecode-harness/`에 규칙, 스킬, 작업 전 Hook을 적용합니다. 지원하지 않는 언어와 직접 패키지 설치 명령은 Hook이 차단합니다. |
| Claude Desktop | 프로젝트 정책 안내를 적용하고 Git 게이트에서 언어·런타임을 강제합니다. 일반 파일 작업을 가로채는 훅을 보장하지 않습니다. |
| ChatGPT/Codex Desktop | 로컬 체크아웃의 `AGENTS.md`와 프로젝트 정책, Git 게이트를 사용합니다. 로그인 정보·토큰은 읽지 않습니다. |
| Lovable + GitHub | `typescript_supabase` 엄격 프로필과 전용 동기화 브랜치·GitHub PR 게이트를 적용합니다. Lovable 내부 지침은 안내이며 PR 게이트가 강제 지점입니다. |

Git 저장소이고 기존 Hook 설정과 충돌하지 않는 경우에는 커밋 전에 `gg verify --hook`을 실행하는 Hook도 적용합니다. 기존 Hook이 있으면 덮어쓰지 않고 수동 확인이 필요하다고 알려줍니다.

## 패키지와 보안 점검

새 npm 또는 PyPI 패키지를 사용하기 전에는 `gg package check`로 이름과 정확한 버전을 확인합니다. 이 명령은 패키지를 설치하지 않습니다.

`gg verify --run-tests`는 다음을 순서대로 확인합니다.

1. 허용 언어, 런타임, 정책 파일, 설계 확인 기록
2. 프로젝트의 테스트 명령
3. `vibecode-checker`의 코드·의존성 점검

L2와 L3에서는 테스트를 생략할 수 없습니다. 체커가 없거나 검사 범위·의존성 점검이 불완전하면 성공으로 처리하지 않고 `incomplete`로 표시합니다. 체커가 차단 종료 코드를 반환하면 검증은 중단됩니다.

체커 보고서를 별도로 만들려면 다음처럼 실행합니다.

```powershell
gvskb scan C:\work\my-service --check-deps -o 보안점검.md
```

체커는 `보안점검.md`와 인쇄용 `보안점검.html`을 함께 만듭니다. 보고서에는 발견 항목, 이유, 수정 방향, 의존성 점검 결과가 한국어로 정리됩니다.

## 결과 읽는 법

| 결과 | 뜻 | 다음 행동 |
|---|---|---|
| `ready` | 언어·런타임·정책·설계 조건을 통과했습니다. | 구현 또는 다음 점검으로 진행합니다. |
| `blocked` | 정책, 테스트 또는 체커 차단 조건에 문제가 있습니다. | 표시된 문제를 고친 뒤 다시 실행합니다. |
| `incomplete` | 체커, 검사 대상, 의존성 점검 등 일부 확인을 마치지 못했습니다. | 누락된 항목을 확인한 뒤 다시 실행합니다. |
| `review_required` | 자동 점검은 끝났지만 이관·배포 전 사람 검토가 필요합니다. | 최신 보안 점검 결과와 미해결 항목을 확인합니다. |

`review_required`는 실패가 아닙니다. 하네스와 체커가 만든 증적을 사람이 확인하고, 운영 승격 여부를 별도 절차에서 결정해야 한다는 뜻입니다.

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

### 운영 배포까지 자동으로 해 주나요?

아닙니다. 하네스는 개발존에서 운영 후보가 될 수 있는 증적을 만드는 도구입니다. 실제 운영 승격은 검증존, 관리 포털, 서비스 오너, 보안·AX·운영 담당자의 승인 절차가 필요합니다.

## 더 알아보기

- 보안 체커: [Lex6won/vibecode-checker](https://github.com/Lex6won/vibecode-checker)
- Windows 설치 상세 안내: [docs/18_github_pilot_install.md](./docs/18_github_pilot_install.md)
- 다중 AI 도구·공식 EXE·업데이트 운영: [docs/19_multi_tool_install_and_updates.md](./docs/19_multi_tool_install_and_updates.md)
- 공식 EXE 배포 승인·서명·포털 게시: [docs/20_release_approval_and_deployment.md](./docs/20_release_approval_and_deployment.md)
- 체커의 MCP 연결과 보고서 읽는 법: 체커 저장소 README
