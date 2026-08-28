# 공식 EXE 배포 승인과 실행 절차

## 원칙

GitHub `main`의 변경은 개발 변경일 뿐이다. 사용자 PC에 배포되는 하네스는 **승인된 태그**, **서명된 번들 manifest**, **Authenticode 서명 EXE**가 모두 갖춰진 경우에만 포털에 게시한다. GitHub Actions의 Release preflight는 소스·태그·회귀 테스트만 검증하며, 서명이나 포털 게시를 하지 않는다.

## 결재 요청 전에 준비할 것

1. `main`에 병합할 변경을 확정하고 `npm test`, `npm run validate:design`, `npm run test:design`을 통과시킨다.
2. `package.json` 버전, Inno Setup `AppVersion`, 릴리스 태그를 같은 `x.y.z` 버전으로 맞춘다.
3. `templates/release-approval-record.example.json`을 복사해 릴리스 후보 기록을 만든다. 실제 개인 연락처나 비밀값은 기록하지 않는다.
4. 승인된 배포물만 사용한다. Node, Python, `vibecode-checker`는 정확한 버전과 SHA-256을 기록하고, GitHub `main`에서 런타임이나 체커를 내려받아 공식 EXE에 넣지 않는다.
5. 기관 공개키 목록과 HSM 또는 승인된 키 보관소에서 bundle manifest를 서명할 수 있는지 확인한다. 개인 키와 코드서명 인증서는 저장소에 넣지 않는다.

## 승인 순서

| 단계 | 책임자 | 확인·승인 내용 | 남길 증적 |
|---|---|---|---|
| 1. 기능 후보 확정 | 서비스 오너 | 기능 범위, 지원 도구(Codex·Claude Code·Antigravity), 사용자 안내 | 태그·변경 요약 |
| 2. 보안 검토 | 보안 또는 AX 담당 | 체커 결과, 의존성 점검, 정책 변경, 개인정보·비밀값 미포함 | 체커 보고서·검토 기록 |
| 3. 운영 검토 | 운영 담당 | Windows 신규 설치, 시작 메뉴의 프로젝트 설정, 업데이트·복구·롤백 가능 여부 | 설치 시험 결과 |
| 4. 릴리스 승인 | 릴리스 관리자 | 신뢰된 번들 서명, 코드서명 대상, SHA-256, 게시 대상 URL | 승인 기록·서명 정보 |
| 5. 게시 승인 | 서비스 오너와 릴리스 관리자 | 포털 문구·버전·다운로드·릴리스 노트 최종 확인 | 포털 게시 시각 |

모든 승인자는 역할로 기록해도 되지만, 승인 시각·대상 버전·대상 커밋은 반드시 남긴다. 미승인 상태에서 `installer_published`를 설정하지 않는다.

## 배포 실행

1. 승인된 태그를 checkout하고 `node scripts/release-preflight.mjs --tag vX.Y.Z`를 실행한다.
2. 격리된 기관 빌드 환경에서 승인된 런타임과 체커를 번들 폴더에 넣고 `bundle-components.json`에 버전을 기록한다.
3. HSM 또는 승인된 키 보관소로 `scripts/sign-release-bundle.mjs`를 실행한다.
4. `node bin/gg.mjs bundle verify --bundle <번들> --trust <기관 공개키 목록>`이 `verified`인지 확인한다.
5. `scripts/build-windows-installer.ps1`로 EXE를 만들고 Authenticode 서명·검증한다.
6. `node scripts/release-preflight.mjs --tag vX.Y.Z --bundle <번들> --trust <공개키 목록> --installer <EXE>`로 최종 준비 상태와 EXE SHA-256을 기록한다.
7. 격리된 Windows PC에서 EXE 신규 설치, **VibeCode Harness 프로젝트 시작**, `gg doctor`, Codex·Claude Code·Antigravity 각각의 프로젝트 적용을 확인한다.
8. 승인 기록을 완료한 뒤에만 포털의 `release-index.json`에 EXE URL·버전·SHA-256·`authenticode_verified`·릴리스 노트를 게시한다.

## 업데이트와 롤백

일반 업데이트는 포털에서 알리고 사용자가 설치를 승인한다. 긴급 업데이트는 최소 허용 버전 또는 폐기 bundle ID를 서명 manifest에 기록하고, 관리 PC에는 기관 MDM 정책으로 배포할 수 있다. 문제가 생기면 포털 다운로드를 먼저 닫고, 이전 승인 EXE를 복구 대상으로 안내하며, 릴리스 승인 기록의 rollback 항목에 조치 시각과 이유를 남긴다.
