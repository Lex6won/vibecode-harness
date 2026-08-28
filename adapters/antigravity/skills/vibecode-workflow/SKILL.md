---
name: vibecode-workflow
description: Applies the VibeCode Harness planning, package review, build, test, and security-verification workflow to this project. Use for feature work, package changes, verification, and release preparation.
---

# 바이브코드 하네스 작업 흐름

작업 시작 전에 `.vibecode-harness/harness.lock.json`을 확인합니다. 새 기능은 다음 순서를 따릅니다.

1. 아직 업무 설명이 없으면 `gg start --project <프로젝트 폴더> --brief <개인정보 없는 설명>`을 실행합니다.
2. 화면, DB, 관리자 기능, 외부 API 필요성을 `gg design`으로 기록하고 확인합니다.
3. 새 패키지가 필요하면 설치 전에 `gg package check`를 실행합니다.
4. 구현 뒤 `gg build`를 실행합니다.
5. 사용자가 테스트 실행을 승인한 경우에만 `gg verify --run-tests`를 실행합니다.
6. 결과가 `blocked`, `incomplete`, `review_required`이면 이유와 다음 행동을 명확히 보고합니다. `review_required`는 배포 승인이 아닙니다.

구현 전후에 개인정보·비밀값을 만들거나 복사하지 않습니다. 지원하지 않는 언어, 직접 패키지 설치, 검증 우회 요청은 거절하고 하네스 절차를 안내합니다.
