# 바이브코드 하네스

> 공공기관 업무 도구를 Codex와 Claude Code로 만들 때, 같은 개발 언어·실행 환경·검증 절차를 적용하는 실행형 프로젝트 하네스.

## 현재 단계

이 폴더는 실행형 하네스의 기준선과 개발자용 실행기다. `gg init`, `gg doctor`, `gg start`, `gg design`, `gg build`, `gg verify`, `gg release`를 제공한다. 체커는 이 저장소에서 수정하지 않으며, 체커의 공개 기계 판정 계약이 없다는 한계도 실행 결과에 그대로 표시한다.

현재 실행기는 Node.js 22 이상과 별도 `gvskb` 설치가 있는 개발자 파일럿용으로도 동작한다. 승인 번들 manifest, Ed25519 서명·파일 해시 검증, 업데이트 하한선, Windows 설치기 차단형 템플릿과 Authenticode 빌드 계약은 구현했다. 다만 Python·Node.js가 없는 일반 공무원 PC에 배포할 실제 EXE에는 기관 코드서명 인증서, 승인 공개키, 내장 Node·Python 런타임, 체커 독립 실행 파일, 새 Windows 계정 실증이 필요하다. 이 전제는 [Windows 구현 기록](./docs/11_windows_release_implementation.md)에서 관리한다.

## 핵심 원칙

1. 정책의 원본은 `shared/harness-core.yaml` 하나다.
2. Codex와 Claude Code는 서로 다른 제품이지만, 언어·런타임·패키지·체커·테스트 기준은 같다.
3. 기능 구현 언어는 Python, JavaScript, TypeScript만 허용한다.
4. 공무원은 화면을 먼저 보며 요구사항을 구체화한다. 화면 확인 없이 복잡한 구현으로 바로 가지 않는다.
5. DB·관리자 기능은 기술 용어가 아니라 업무 질문으로 필요성을 판정한다.
6. 로컬 지침은 안내이고, 현재 강제 구조는 `gg build`, `gg verify`, 안전한 Git 훅, 선택형 CI 템플릿이다. 기관의 보호 브랜치와 승인 번들 레지스트리는 별도 P0 배포 과제로 남아 있다.
7. 체커는 외부 보안 판정 엔진이다. 현재 CLI JSON에 안정적인 최종 판정 필드가 없으므로, 하네스는 판정을 재계산하지 않고 최종 승인·차단을 보류한다.

## 목표 구조

```text
공통 정책·실행기
├─ Codex 어댑터: AGENTS.md, .codex/vibecode-harness.md
  ├─ Claude Code 어댑터: CLAUDE.md, .claude/settings.json, Hooks
  ├─ 설계 우선 흐름: 화면 시안 -> 기능·데이터 결정 -> 구현
  ├─ 공통 검증: 언어·런타임·패키지·테스트·체커·시나리오
  └─ 강제 지점: Git 훅 -> PR CI -> 승인 릴리스
```

## 사용자 명령 목표

| 명령 | 사용자가 하는 일 | 하네스 결과 |
|---|---|---|
| `gg init` | 사용할 AI 도구와 프로젝트 유형 선택 | 공통 정책·어댑터·템플릿·Git 훅 설치 |
| `gg start` | 만들 업무를 일상 언어로 설명 | 질문 결과, 성숙도, 화면 목록, 개발 트랙 |
| `gg design` | 화면 시안을 보고 확인·수정 | 화면 기능 설계, DB·관리자 필요성 결정 |
| `gg build` | 승인한 화면·기능을 구현 | 실행 가능한 소스와 변경 기록 |
| `gg verify` | 구현 결과 확인 | 테스트, 체커, 시나리오, 증적 결과 |
| `gg release` | 이관·배포 준비 | 최종 보고서, SBOM, 승인 요청 자료 |

## 바로 실행하기

Windows PowerShell에서 하네스 폴더로 이동한 뒤 실행합니다.

```powershell
.\gg.ps1 init --project C:\work\my-service --tools both --runtime typescript_web --level L2
.\gg.ps1 doctor --project C:\work\my-service
.\gg.ps1 start --project C:\work\my-service --brief "반복 업무 현황을 확인하는 내부 도구"
.\gg.ps1 design --project C:\work\my-service --database no --admin no --external-api no --confirm
.\gg.ps1 build --project C:\work\my-service
.\gg.ps1 verify --project C:\work\my-service --run-tests
```

`init`은 프로젝트 안에 정책 사본과 잠금 파일, Codex·Claude Code 지침, 증적 폴더를 만들고 Git 저장소라면 기존 훅 설정을 덮어쓰지 않는 범위에서 pre-commit 훅을 설치한다. `build`와 `verify`는 Python·JavaScript·TypeScript 외의 소스 파일, 정책 변조, 잘못된 런타임, 테스트 실패를 차단한다.

`verify`는 `gvskb` 체커를 호출해 검사 범위와 의존성 증적을 확인한다. 체커를 생략하면 성공하지 않고 `checker_incomplete`로 끝난다. L2 이상에서는 테스트 생략도 차단한다. 테스트는 프로젝트 코드를 실행하므로 사용자가 `--run-tests`로 명시할 때만 실행한다. 체커가 공식 `--fail-on block` 종료 코드를 반환하면 커밋을 차단한다. 현재 체커 CLI JSON에는 공개된 최종 기계 판정 필드가 없으므로, 체커가 정상 실행된 경우에도 자동 배포 승인은 하지 않으며 `gg release`에서 사람 검토를 요구한다.

새 패키지는 먼저 `gg package check --ecosystem npm|pypi --name <이름> --version <정확한 버전>`으로 점검한다. 이 명령은 패키지를 설치하지 않는다. 설치 전 검사·예외·잠금파일 변경을 하나의 승인 절차로 묶는 Windows 설치기 기능은 아직 P0 배포 과제다.

## 현재 검증 범위

`npm test`, `npm run validate:design`, `npm run test:design`은 실행기 회귀, 정책 위변조, 어댑터 드리프트를 검사한다. 실제 `gvskb` 판정은 테스트에서 모사하되, 사용자 PC에서는 설치된 체커 CLI가 원본 검사와 의존성 감사를 수행한다.

상세 설계는 [실행형 하네스 설계](./docs/01_execution_harness_design.md), [화면 중심 설계 흐름](./docs/02_visual_first_design.md), [도구별 어댑터·강제 모델](./docs/03_adapter_and_enforcement.md), [적대적 설계 검증 기록](./docs/04_adversarial_design_review.md)을 따른다. 일반 공무원용 Windows 설치·강제 적용·업데이트의 구현 기준은 [Windows 구현 기준선](./docs/09_windows_harness_implementation_baseline.md)으로 확정한다. 승인 번들·키 교체·정책 위변조 방지는 `shared/policies/trust-and-integrity.yaml`에 정의한다.
