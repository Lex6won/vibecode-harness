# 다중 AI 도구, Windows EXE, 업데이트 운영

## 사용자 경험 목표

공식 Windows 설치본은 Node.js, Python, `vibecode-checker`, `gg.cmd`를 함께 포함한다. 사용자는 서명된 EXE를 설치한 뒤 시작 메뉴의 **VibeCode Harness 프로젝트 시작**을 선택하거나 `gg init --interactive`를 실행한다. 이 흐름에서 사용자가 정할 것은 프로젝트 폴더, 사용할 AI 도구, 개발 유형, 점검 수준뿐이다.

Codex, Claude Code, Google Antigravity 자체의 설치와 계정 로그인은 각 제품의 라이선스·조직 정책에 속하므로 하네스가 대신 설치하거나 로그인하지 않는다. 하네스는 선택된 도구가 아직 없으면 “구성 적용됨 / 도구 설치 필요”로 안내한다.

## 프로젝트 다중 적용

`gg init --tools all`은 공통 하네스를 한 번만 프로젝트에 복사하고 각 도구의 어댑터를 함께 만든다.

```text
project/
  .vibecode-harness/                 공통 정책, 실행기, 잠금 파일
  AGENTS.md                          Codex 지침
  .codex/vibecode-harness.md         Codex 보조 지침
  CLAUDE.md                          Claude Code 지침
  .claude/settings.json              Claude Code PreToolUse 훅
  .agents/plugins/vibecode-harness/  Antigravity 플러그인
  evidence/                          기획·설계·검증 증적
```

Antigravity 플러그인에는 규칙, 작업 스킬, `PreToolUse` 훅이 들어간다. 훅은 지원하지 않는 언어와 직접 패키지 설치 명령을 차단한다. Codex는 프로젝트 지침을 적용하고, Claude Code와 Antigravity는 지침에 더해 작업 전 훅을 적용한다. 어느 도구를 쓰더라도 최종 검증 기준은 공통 `gg build`, `gg verify`다.

기존 `AGENTS.md`, `CLAUDE.md`, Claude 설정, Antigravity의 동일 이름 플러그인은 덮어쓰지 않는다. 기존 Antigravity 플러그인이 있으면 `doctor`가 복구 필요 상태를 보여 주며, 사용자는 내용을 확인한 뒤 병합 또는 재적용한다.

`both`는 기존 호환성을 위해 Codex+Claude Code를 뜻한다. `all`은 Codex, Claude Code, Google Antigravity, Claude Desktop, ChatGPT/Codex Desktop, Lovable+GitHub의 여섯 도구 전체를 뜻한다. Lovable이 포함되므로 `all`의 기본 개발 언어 정책은 TypeScript/PostgreSQL 엄격형이다. Supabase는 PostgreSQL 기반의 선택 가능한 Lovable 연동이며, 직접 운영·관리형 PostgreSQL도 같은 언어 정책으로 사용할 수 있다. CLI에서는 `--tools codex,antigravity`처럼 필요한 조합도 쓸 수 있다.

## 공식 EXE 릴리스

GitHub의 `main` 변경은 개발 소스 변경일 뿐이며 사용자 PC를 바꾸지 않는다. EXE는 다음 조건을 모두 충족하는 승인 릴리스에서만 만든다.

1. 고정된 Git 태그와 커밋에서 테스트를 통과한다.
2. Node, Python, 체커, 하네스, `gg.cmd`를 번들에 넣는다.
3. 번들 manifest를 기관 Ed25519 키로 서명하고 `gg bundle verify`로 검증한다.
4. EXE를 Authenticode 코드서명하고 검증한다.
5. 포털에 EXE URL, 버전, SHA-256, 코드서명 상태, 릴리스 노트를 함께 게시한다.

개인 키와 코드서명 인증서는 저장소·빌드 산출물·사용자 PC에 넣지 않는다. 기관의 HSM 또는 승인된 비밀 저장소를 쓰는 별도 릴리스 환경에서만 서명한다.

## 업데이트 방식

설치된 하네스는 포털의 승인 릴리스 정보와 자신의 서명된 bundle manifest를 비교한다. 업데이트가 있으면 버전, 변경 내용, SHA-256, 코드서명 상태를 보여 주고 사용자가 **지금 업데이트** 또는 **나중에**를 선택한다. 설치 중인 EXE를 직접 덮어쓰지 않고, 새 설치기가 검증을 마친 뒤 원자적으로 교체한다.

긴급 보안 업데이트는 최소 허용 버전과 폐기 bundle ID를 manifest에 기록한다. 일반 PC에는 필수 업데이트 안내를 표시하되 설치 확인은 남긴다. 기관이 관리하는 PC만 MDM 등의 별도 관리 정책으로 무인 설치할 수 있다.

하네스 프로그램을 업데이트해도 이미 만든 프로젝트 정책·증적을 자동으로 덮어쓰지 않는다. 향후 프로젝트 업데이트 화면은 적용 대상과 정책 차이를 미리 보여 주고, 백업 뒤 재적용·`gg doctor`·`gg verify` 순서로 처리한다.

## 포털 반영 계약

포털의 `public/releases/release-index.json`은 설치 파일 상태뿐 아니라 `capabilities`를 표시한다. 현재는 지원 AI 도구, 프로젝트 설정 방식, 업데이트 원칙을 제공한다. 공식 EXE가 게시될 때만 `status`를 `installer_published`로 바꾸고, `installer.download_url`, `installer.version`, 64자리 SHA-256, `installer.signature_status: authenticode_verified`를 모두 채운다. 하나라도 없으면 포털은 다운로드를 제공하지 않는다.
