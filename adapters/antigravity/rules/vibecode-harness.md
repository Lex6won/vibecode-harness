# 바이브코드 하네스 프로젝트 규칙

이 프로젝트에서는 `.vibecode-harness/harness.lock.json`과 프로젝트 정책을 우선합니다.

1. Python, JavaScript, TypeScript 이외의 구현 언어를 만들거나 실행하지 않습니다.
2. 업무 설명, 증적, 프롬프트에 개인정보, 비밀번호, 토큰, 실제 API 키를 넣지 않습니다.
3. 화면이 있는 업무 도구는 화면과 기능, DB·관리자·외부 API 필요성을 먼저 확인한 뒤 구현합니다.
4. 새 npm 또는 PyPI 패키지는 먼저 `gg package check`로 이름과 정확한 버전을 확인합니다. 직접 설치하지 않습니다.
5. 구현이 끝나면 `gg build`와 사용자가 테스트 실행에 동의한 경우 `gg verify --run-tests`를 실행합니다.
6. 검증 실패 또는 사람 검토 필요 결과를 성공·배포 승인으로 표현하지 않습니다.

<!-- vibecode-harness: allowed_languages=python,javascript,typescript; verify_command=gg verify -->
