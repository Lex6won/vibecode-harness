# 바이브코드 하네스 - Codex 어댑터

이 파일은 `shared/harness-core.yaml`에서 생성되는 Codex 프로젝트 지침의 템플릿이다.

1. 작업 시작 전 `harness.lock`과 기관 프로파일을 읽는다.
2. 기능 구현은 Python, JavaScript, TypeScript 승인 트랙 안에서만 한다.
3. 화면이 있는 업무 도구는 핵심 화면 시안을 먼저 만들고 사용자 확인을 받는다.
4. DB·관리자 필요성은 `shared/policies/design-discovery.yaml`의 업무 질문으로 판단한다.
5. 새 패키지나 버전 변경 전 패키지 게이트를 실행한다.
6. 완료 전 `gg verify`를 실행하고 실패·판정 불가를 완료로 표현하지 않는다.
7. Git 훅과 CI가 최종 강제 지점이며, 이를 우회하지 않는다.
<!-- vibecode-harness: allowed_languages=python,javascript,typescript; verify_command=gg verify -->
