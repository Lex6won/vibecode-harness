# Codex·Claude Code 어댑터와 강제 모델

> 문서 역할: 도구별 목표 어댑터와 강제 모델. 현재 실행기는 Codex 지침 파일, Claude Code Hook의 신규 생성·기존 JSON 병합 백업, 선택형 프로젝트 CI 템플릿까지 구현했다. 데스크톱 앱 어댑터와 기관 보호 브랜치·코드서명 설치기는 구현 전이며 `docs/09_windows_harness_implementation_baseline.md`의 우선순위를 따른다.

## 1. 도구 차이를 정책 차이로 만들지 않는다

Codex와 Claude Code는 지침 파일과 자동화 기능이 다르다. 그러나 개발 언어, 런타임, 패키지, 체커, 테스트, 릴리스 기준은 같아야 한다.

| 항목 | Codex CLI·VS Code | Claude Code | ChatGPT/Codex 데스크톱·Claude Desktop | 공통 기준 |
|---|---|---|---|
| 지침 | `AGENTS.md` | `CLAUDE.md` | 제품·버전별 안내 화면 | `shared/harness-core.yaml` |
| 체커 연결 | 지원되는 Codex 설정 파일 | 지원되는 Claude Code MCP 설정 | 지원되는 데스크톱 앱 MCP 설정 | `gvskb-server` |
| 즉시 제어 | 공통 `gg` 명령 안내 | Hook으로 명령·종료 전 확인 | 지원되는 경우 MCP 조언 | `gg verify` |
| 최종 차단 | Git 훅·CI | Git 훅·CI | Git 훅·CI | 같은 CI workflow |

Claude Code Hook은 직접 패키지 설치나 비허용 언어 파일 생성을 빠르게 차단할 수 있다. Codex는 지침을 통해 같은 명령을 우선 실행하게 하고, Git 훅·CI에서 동일한 검증을 강제한다. 따라서 Claude 전용 Hook은 보안의 유일한 근거가 될 수 없다.

## 2. 설치 흐름

```text
gg init --tools codex
gg init --tools claude
gg init --tools both
  -> 공통 정책과 harness.lock 설치
  -> 선택한 어댑터 생성
  -> 설치된 AI 도구만 체커 MCP 설정을 별도 사용자 승인 후 등록
  -> Git 훅 설치
  -> gg doctor로 언어·런타임·체커 확인
```

`both`는 같은 프로젝트에서 허용한다. 한쪽 도구로 만든 소스와 증적을 다른 도구가 이어서 검증할 수 있다.

데스크톱 앱은 CLI 어댑터의 부산물이 아니다. 앱별 설정 형식·MCP 지원 버전·설정 위치를 검증하는 전용 어댑터를 구현한 뒤에만 자동 등록한다. 지원하지 않는 버전은 "미지원"과 공식 수동 등록 안내를 표시하며 설정 파일을 추측해 수정하지 않는다.

## 3. Git과 CI의 책임

| 지점 | 강제 내용 |
|---|---|
| pre-commit | 현재는 단순 `gg verify` 연결, 목표는 비실행 정적 확인과 증적 확인 |
| pre-push | 목표: 변경 범위 점검과 패키지 게이트 |
| PR CI | 목표: 깨끗한 환경에서 언어·런타임·테스트·시나리오·표준 체커 재실행 |
| release CI | 목표: 전체 체커 HTML·JSON, SBOM, manifest, 사람 승인 확인 |

`--no-verify`로 로컬 훅을 우회할 수 있으므로, 기관 저장소는 직접 main push와 관리자 우회를 제한하고 필수 PR 검사를 보호 규칙으로 설정해야 한다.

Git 훅 설치는 기존 훅을 덮어쓰지 않는다. 프로젝트 전용 hooks 경로, 백업·병합 확인, 검증 영수증 기반 재진입 방지를 사용한다. 정책 파일이나 어댑터가 수정된 경우에도 CI는 승인된 번들의 정책 해시와 생성 결과를 독립적으로 비교한다.

## 4. 구현 순서

1. 공통 정책에서 Codex·Claude 언어 정책 차이를 제거한다. (부분 구현)
2. `gg init`, `gg doctor`, `gg verify` 최소 실행기를 구현한다. (부분 구현)
3. Codex 지침 생성기와 Claude 지침·Hook 생성기를 구현하고, 기존 설정 병합·해제·상태 진단을 추가한다.
4. 데스크톱 앱별 MCP 어댑터를 지원 버전 단위로 구현한다.
5. `gg doctor`와 `gg verify`로 생성 파일·Hook·정책·실행기 해시를 검증한다.
6. Git 훅과 GitHub Actions 재사용 workflow를 구현한다.
7. L1·L2·L3 대표 프로젝트로 모든 지원 도구의 동일 결과를 적대적으로 검증한다.

## 5. 수용 기준

- 같은 `institution-profile.yaml`에서 Codex·Claude Code 모두 Python·JavaScript·TypeScript 정책을 같은 결과로 표시한다.
- 두 도구 모두 `gg verify` 실패 시 완료·커밋·릴리스 준비를 주장하지 않는다.
- Claude Hook이 없는 환경에서도 Git·CI 검증으로 같은 병합·릴리스 기준을 적용한다.
- 화면·DB·관리자 필요성의 질문과 결정이 `evidence/work-status.json`에 남는다.
- 새 패키지·런타임·비허용 언어 추가는 로컬 또는 CI에서 명확한 실패 코드와 대체 경로를 제공한다.
