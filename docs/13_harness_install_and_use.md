# 하네스 설치와 사용 방법

## 누구를 위한 도구인가

경기도 및 경기도 바이브 코딩 지원 플랫폼을 이용하는 시군 공무원이 Codex 또는 Claude Code로 업무 도구를 만들 때 사용한다. 하네스는 보안 게이트만이 아니라 다음 개발 흐름을 프로젝트에 적용한다.

1. 허용된 개발 언어와 실행 환경 선택
2. 업무 목적, 화면, 기능, DB·관리자 필요성 확인
3. 패키지 도입 전 점검
4. 구현·테스트·체커 점검·사람 검토 기록

원본 소스, 보고서, 프롬프트는 사용자 PC에 남긴다. 개인정보, 비밀값, 실사용자 정보는 업무 설명과 증적에 입력하지 않는다.

## 설치 상태

### 공식 Windows 설치본이 등록된 경우

1. 기관 포털에서 버전, SHA-256, 코드서명 확인 상태를 확인한다.
2. Windows 설치 파일을 내려받아 실행한다.
3. 설치 후 PowerShell에서 다음 명령으로 상태를 확인한다.

```powershell
gg doctor --project C:\work\my-service
```

공식 설치본은 Node, Python, 체커 런타임을 함께 포함하는 것이 목표다. `doctor`가 `repair_required` 또는 `unknown`이면 업데이트가 아니라 포털의 공식 복구 설치를 사용한다.

### 현재 개발자 시범 환경

현재 저장소는 공식 EXE가 등록되기 전이므로 다음 도구가 필요하다.

- Windows PowerShell
- Node.js 22 이상
- `gvskb` 체커
- Git 프로젝트에 적용할 경우 Git
- Codex CLI 또는 Claude Code 중 사용할 AI 코딩 도구

하네스 폴더에서 다음과 같이 실행한다.

```powershell
git clone https://github.com/Lex6won/vibecode-harness.git
cd vibecode-harness
.\gg.ps1 doctor --project C:\work\my-service
```

이 방법은 개발자 시범용이다. `git pull`이나 GitHub ZIP을 기관 공식 설치·업데이트 방식으로 사용하지 않는다.

## 새 프로젝트 적용

### 1. 개발 도구와 환경을 선택한다

TypeScript 웹 도구를 Codex와 Claude Code에 적용하는 예시다.

```powershell
.\gg.ps1 init --project C:\work\my-service --tools both --runtime typescript_web --level L2
```

선택 값은 다음과 같다.

| 항목 | 값 | 의미 |
|---|---|---|
| `--tools` | `codex`, `claude`, `antigravity`, `claude-desktop`, `chatgpt-desktop`, `lovable`, `both`, `all` | 사용할 AI 코딩 도구 또는 연동 방식 |
| `--runtime` | `python_internal` | Python 내부 업무·자동화 |
|  | `node_web` | JavaScript 기반 웹·API |
|  | `typescript_postgres` | JavaScript·TypeScript·PostgreSQL 공통 프로필 (`typescript_supabase`는 기존 프로젝트 호환 별칭) |
|  | `typescript_web` | TypeScript 기반 웹·업무 도구 |
| `--level` | `L1`, `L2`, `L3` | 안내, 검증, 릴리스 준비 수준 |

기본 허용 언어는 Python, JavaScript, TypeScript다. Java, Go, PHP, Ruby, C#, Rust는 기본 정책에서 차단한다. 정식 예외는 정책 파일을 직접 고치는 방식이 아니라 기관 승인 번들로만 적용한다.

`init`은 다음을 만든다.

- `.vibecode-harness/`: 정책, 실행기, 잠금 파일
- `AGENTS.md`, `.codex/vibecode-harness.md`: Codex 지침
- `CLAUDE.md`, `.claude/settings.json`: Claude Code 지침과 훅
- `evidence/`: 계획·검증 기록

기존 `AGENTS.md`, `CLAUDE.md`, Claude 설정, Git pre-commit 훅은 덮어쓰지 않고 보존 또는 백업한다.

## 개발 흐름

### 2. 업무와 설계를 먼저 정리한다

```powershell
.\gg.ps1 start --project C:\work\my-service --brief "반복 업무 현황을 확인하는 내부 도구"
.\gg.ps1 design --project C:\work\my-service --database no --admin no --external-api no --confirm
```

업무 설명에는 실제 이름, 이메일, 전화번호, 주민등록번호, API 키, 비밀번호, 토큰을 넣지 않는다. DB·관리자·외부 API는 필요할 때만 `yes`로 선택한다. L2 이상은 화면 시안 확인 기록이 있어야 구현 단계로 갈 수 있다.

### 3. 패키지를 설치하기 전에 확인한다

```powershell
.\gg.ps1 package check --project C:\work\my-service --ecosystem npm --name example-package --version 1.2.3
```

이 명령은 패키지를 설치하지 않는다. 체커가 악성·거부·존재하지 않는 패키지, KEV 등 명확한 위험을 확인한다. 패키지 사용 자체를 금지하는 것이 아니라, 안전성 확인 후 승인된 절차로 설치하도록 돕는 기능이다.

### 4. 구현하고 검증한다

```powershell
.\gg.ps1 build --project C:\work\my-service
.\gg.ps1 verify --project C:\work\my-service --run-tests
.\gg.ps1 release --project C:\work\my-service
```

- `build`: 언어·런타임·정책·설계 확인
- `verify --run-tests`: 사용자가 명시적으로 동의한 테스트, 체커의 소스·의존성 점검, 증적 완전성 확인
- `release`: 자동 배포 승인 대신 사람 검토가 필요한 이관 자료를 생성

테스트는 프로젝트 코드를 실행하므로 `--run-tests`를 명시할 때만 실행한다. 테스트 실패, 정책 위변조, 체커 미설치, 체커 검사 불완전은 통과로 처리하지 않는다.

## Codex와 Claude Code 적용 범위

### Codex

`--tools codex` 또는 `both`를 선택하면 `AGENTS.md`와 `.codex/vibecode-harness.md`가 적용된다. Codex는 작업 시작 시 지침을 읽고, 하네스 명령을 통해 설계·구현·검증 흐름을 따른다.

### Claude Code

`--tools claude` 또는 `both`를 선택하면 `CLAUDE.md`와 `.claude/settings.json`의 `PreToolUse` 훅이 적용된다. 훅은 허용하지 않은 언어 파일, 차단된 런타임, 직접 패키지 설치 명령을 개발 중에 차단한다.

### 데스크톱 앱과 Lovable

Claude Desktop 및 ChatGPT/Codex Desktop은 프로젝트 안내 문서와 공통 Git 게이트로 지원한다. 데스크톱 앱의 모든 파일 작업을 사전 차단한다고 주장하지 않으며, `gg build`와 Git 커밋·PR 검증이 언어·런타임 정책의 강제 지점이다.

Lovable은 `--tools lovable --runtime typescript_postgres`로 시작한다. 하네스는 JavaScript·TypeScript 구현과 PostgreSQL SQL 마이그레이션을 허용한다. Supabase를 연결한 경우에도 Edge Function 구현은 JavaScript 또는 TypeScript 범위에서 관리한다. 하네스는 GitHub PR 검증 워크플로와 `VIBECODE-LOVABLE.md`를 만들며, Lovable은 전용 작업 브랜치에 동기화하고 통과한 PR만 `main`에 병합한다.

## 문제가 생겼을 때

| 상태 | 해야 할 일 |
|---|---|
| `not_initialized` | 프로젝트 폴더에서 `gg init` 실행 |
| `not_installed` | 체커 또는 공식 설치본 상태 확인 |
| `repair_required` | 포털에서 공식 복구 설치 |
| `unknown` | 네트워크·서명·manifest 확인 후 다시 시도, 안전으로 간주하지 않음 |
| `checker_incomplete` | 체커 설치, 검사 범위, 의존성 감사 상태 확인 |
| `review_required` | 보고서와 증적을 사람이 확인하고 조치 기록 |

공식 설치·업데이트 기능은 승인된 Windows 번들에서만 제공한다. GitHub `main`의 변경은 사용자 PC에 자동 반영되지 않는다.
