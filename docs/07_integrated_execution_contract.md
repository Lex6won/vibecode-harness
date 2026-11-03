# 통합 실행 계약

상태: 체커 연계 기준선. `docs/05`와 `docs/06`은 발견과 실측을 남긴 검토 기록이다. Windows 설치·포털·개인정보 경계는 `docs/09_windows_harness_implementation_baseline.md`가 우선한다.

중요한 현재 한계: 현 실행기의 `gg verify`는 프로젝트에 선언된 `npm test` 또는 `pytest`를 현재 사용자 권한으로 실행한다. 이는 미검증 소스에 안전하지 않다. 자동 Git 훅과 기관 배포에는 사용하지 않으며, 승인된 명령·사용자 확인·격리 실행으로 바꾸기 전까지 P0 미해결 항목으로 취급한다.

## 1. 결정

1. Git 훅과 CI는 MCP가 아니라 문서화된 `gvskb` CLI를 호출한다.
2. 체커는 외부 엔진이며 이 하네스에서 수정하지 않는다.
3. (2026-11-03 개정) 체커 0.5.4 부터 `gvskb scan --format json` 은 `gate.verdict`(approved · conditional · blocked · undetermined)를 공식 기계 판정으로 낸다. 0.6.0 은 `gate.intel_gap`·`dependency_check` 를, 0.6.1 은 `gvskb status --json` 의 `gate_contract`(표·종료코드·필드)를 더한다. 하네스는 **0.6.0 이상**만 받는다 — 그 아래에서는 패키지 검사가 `--check-deps` 옵션일 때만 돌아 기본 호출이 패키지를 조용히 건너뛴다.
4. 하네스는 `summary.blocked`, 개별 심각도, HTML, Markdown을 조합해 체커 판정을 재현하지 않는다. `gate.verdict` 를 `shared/policies/checker-contract.yaml` 의 표대로 옮겨 적고(approved·conditional → review_required, blocked → blocked, undetermined → undetermined), 종료 코드는 교차 확인에만 쓴다. 종료 코드 3(판정 불가)을 차단으로 적지 않는다.
5. 간편 점검은 하네스의 제한된 대상 범위다. 존재하지 않는 `dev-quick` 프로파일을 사용하지 않으며, 실제 체커 프로파일을 사용한다.
6. 표준 점검은 실제 대상 프로파일과 `--include-installed`를 사용한다. 패키지 검사는 체커 기본(local, 네트워크 0)이며 `--check-deps`(= `--deps online` 별칭)는 **넘기지 않는다**. 외부 조회·망분리·서명 필수 같은 기관 설정은 `institution-profile.yaml` 의 `security.checker_env` 로 체커 환경변수(`GVSKB_DEPS_MODE`, `GVSKB_MODE`, `GVSKB_INTEL_REQUIRE_SIGNATURE`, `GVSKB_INTEL_DIR`)에 넘긴다. 벤더 번들 감사는 기본 패키지 검사에 포함된다.

## 2. 현재 실행 경계

```text
gg verify
  -> 정책, 언어, 런타임, 테스트, 시나리오 검증
  -> gvskb status --json (버전 >= 0.6.0 확인, 위협정보 상태)
       버전 미달 -> 41 checker_incomplete
  -> gvskb scan (CLI JSON, 기본 local 패키지 검사 + --include-installed)
  -> 빈 스캔, profile_fallback, 파일 제한, 필수 의존성 증적 누락 확인
       불완전 -> 41 checker_incomplete
  -> gate.verdict 읽기(종료 코드는 교차 확인)
       blocked -> 40 checker_block
       undetermined(위협정보 없음 등) -> 41 checker_incomplete (차단이 아니라 '검사 못 함')
       approved · conditional -> 0 review_required (조건부 사유는 영수증 checker_conditional_criteria)
  -> 보고서는 프로젝트 PC에만 보관하고 경로, SHA-256, 생성 시각만 증적으로 남김
```

이 구조는 체커의 판정 로직을 복제하지 않는다. `gg verify`는 정책·테스트·검사 증적의 완전성을 검증하고 체커의 `gate.verdict` 를 표대로 옮겨 적는다. 어느 판정도 하네스에서 승인으로 바뀌지 않는다 — 영수증의 `final_verdict` 는 언제나 `review_required` 이고, 배포·이관은 포털의 사람 검토로 끝낸다.

## 3. 연동 조건 (2026-11-03 충족)

예전 §3 이 요구한 조건은 체커 0.6.1 에서 모두 충족됐다.

1. 체커가 문서화된 기계 판정 필드(`gate.verdict`)와 계약(`gate_contract`)을 공개한다.
2. `approved`, `conditional`, `blocked`, `undetermined` 의 뜻과 버전 호환 정책(필드 추가는 `schema_version` 을 올리지 않음)이 명시돼 있다.
3. 빈 폴더, 의존성 감사, 파일 제한, 위협정보 없음·오래됨, 조건부 결과를 포함한 체커 측 회귀 시험이 있다(체커 `tests/test_round46_*`, `test_round47_contract.py`).
4. 하네스는 그 공개 계약을 소비만 한다(`lib/checker-evidence.mjs`). 체커 저장소 테스트가 하네스의 표를 체커 표와 대조한다.
5. 승인 경계는 바뀌지 않았다 — 하네스는 여전히 승인하지 않는다.

## 4. 간편·표준 점검

| 구분 | 목적 | 범위 | 사용자에게 보여줄 결과 |
|---|---|---|---|
| 간편 점검 | 개발 중 빠른 확인 | 사용자가 지정한 변경 범위와 선언된 의존성 | 확인 완료, 조치 필요, 또는 범위 확인 필요 |
| 표준 점검 | 커밋·이관 전 전체 확인 | 전체 소스, 선언·설치 의존성, 벤더 번들 | 증적 완료, 조치 필요, 또는 사람 검토 필요 |

간편 점검은 표준 점검을 대체하지 않는다. 표준 점검 결과도 자동 배포 승인으로 표현하지 않는다.

## 5. 구현 순서와 완료 기준

1. 구조 검증기와 변이 테스트로 정책 드리프트를 막는다.
2. 기존 하네스 자산을 파일 단위로 검토·이관한다. 출처, SHA-256, 수정 이유, 검증 결과를 남긴다.
3. `gg init`, `gg doctor`, `gg verify` 최소 실행기를 구현한다. `gg verify`의 테스트 실행은 승인된 명령·사용자 확인·격리 환경으로 제한하며, 임의 프로젝트 명령을 자동 Git 훅에서 실행하지 않는다.
4. Git 훅과 CI가 같은 `gg verify`를 깨끗한 환경에서 재실행한다.
5. 최종 배포 판정은 `checker_review_required`로 두고 포털의 사람 검토로 넘긴다(계약은 있으나 승인 권한은 하네스에 없다).

## 6. 증적과 개인정보

원본 소스, 압축파일, 비밀값, 개인정보, 보고서 본문은 하네스 증적에 저장하지 않는다. 체커 보고서는 프로젝트 PC의 지정 위치에만 저장한다. 하네스 증적에는 로컬 경로, SHA-256, 생성 시각, 스캔 범위, 프로파일, 불완전 사유만 기록한다.
