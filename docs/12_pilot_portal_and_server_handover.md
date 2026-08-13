# 시범 포털과 기관 서버 이관 계획

## 목적과 범위

`public/`은 하네스 설치·사용을 안내하는 정적 시범 포털이다. GitHub Pages와 Vercel에서 같은 파일을 배포할 수 있다. 소스 검사, 체커 실행, 하네스 실행, 보고서 저장은 이 포털에서 하지 않는다. 모두 사용자 PC에서만 수행한다.

시범 포털은 공식 설치 파일이 없으면 다운로드 버튼을 열지 않는다. `public/releases/release-index.json`의 `status`, 설치 파일 URL, SHA-256, Authenticode 확인 상태가 모두 충족될 때만 버튼이 활성화된다.

## GitHub Pages 시범 운영

1. GitHub 저장소 **Settings > Pages**에서 Source를 `GitHub Actions`로 선택한다.
2. `main`의 `public/` 변경은 `.github/workflows/deploy-pages.yml`로 배포된다.
3. 배포 주소는 Actions 실행 결과의 `page_url`에서 확인한다.
4. 시범 운영 중에는 `release-index.json`을 `installer_not_published` 상태로 유지한다. 검증되지 않은 EXE나 GitHub `main` ZIP을 연결하지 않는다.

## Vercel 시범 운영

1. Vercel에서 이 GitHub 저장소를 Import한다.
2. Framework preset은 `Other`, Build Command는 비워 두고, Output Directory는 `public`으로 지정한다.
3. Preview 배포로 화면과 `release-index.json` 갱신 동작을 먼저 확인한다.
4. Production 도메인은 시범 안내용으로만 사용한다. 실제 설치 파일을 올릴 경우에도 기관 승인·코드서명·해시 검증이 끝난 파일만 연결한다.

`vercel.json`은 릴리스 인덱스를 캐시하지 않고, `nosniff`, `DENY` frame, `no-referrer` 헤더를 적용한다.

## 승인 설치 파일 등록 계약

기관 승인 절차가 끝난 경우에만 `release-index.json`을 아래 형태로 갱신한다.

```json
{
  "schema_version": 1,
  "environment": "production",
  "status": "installer_published",
  "message": "승인된 Windows 설치 파일을 사용할 수 있습니다.",
  "installer": {
    "version": "1.0.0",
    "download_url": "https://portal.gg.go.kr/downloads/Gyeonggi-VibeCode-Harness-Setup-1.0.0.exe",
    "sha256": "64자리_소문자_SHA256",
    "signature_status": "authenticode_verified",
    "release_notes_url": "https://portal.gg.go.kr/releases/1.0.0"
  }
}
```

포털은 이 정보의 **표시와 다운로드 링크 제공**만 담당한다. 설치기 내부의 Authenticode·Ed25519 manifest 검증이 최종 신뢰 판단이다. 포털 데이터만 바꿔 다운로드 URL을 바꾸는 것은 릴리스 승인 절차가 아니다.

## 연말 기관 서버 이관 절차

### 이관 전에 확정할 항목

1. 기관 도메인, TLS 인증서, WAF·방화벽 규칙, 운영·검증·개발 환경을 분리한다.
2. Authenticode 인증서와 Ed25519 릴리스 개인키의 HSM 또는 비밀관리 체계를 승인한다. 개인키는 GitHub, Vercel, 포털, 사용자 PC에 두지 않는다.
3. 체커 담당 저장소에서 Windows 독립 실행 파일 또는 포함형 Python 런타임을 공식 릴리스로 제공한다.
4. Node 22, Python, 체커 런타임의 버전·SHA-256·라이선스·취약점 확인 기록을 승인한다.
5. 승인 번들 레지스트리의 변경 권한을 릴리스 관리자에게만 부여하고, `main` 푸시와 사용자 업데이트를 분리한다.
6. 중앙 전송 메타데이터의 항목, 보존 기간, 접근 권한, 개인정보 영향 여부를 보안·개인정보 담당 부서와 확정한다.

### 이관 구현 순서

1. 이 저장소의 `public/`을 기관 웹 서버 또는 CDN에 배포한다.
2. `release-index.json`은 기관 승인 레지스트리 API 또는 읽기 전용 배포 파일로 대체한다. 응답은 TLS와 `no-store`를 적용한다.
3. 승인 파이프라인은 격리된 Windows 빌드 환경에서 `npm test`, 설계·변이 검사, 체커 점검, `scripts/sign-release-bundle.mjs`, `scripts/build-windows-installer.ps1`, Authenticode 검증 순서로 실행한다.
4. 설치 파일·manifest·SHA-256·릴리스 노트를 기관 파일 저장소에 게시한다.
5. 새 Windows 사용자 계정에서 설치, `gg doctor`, Codex, Claude Code, 업데이트, 복구 설치, 제거를 실증한다.
6. 통합 관리자는 원본 소스·보고서 본문 없이 승인 번들 ID, 버전, 점검 시각, 상태, 규칙별 집계만 조회하도록 연결한다.

### 운영 전 차단 조건

- 코드서명 검증 실패 또는 서명키 운영 절차 부재
- 체커 독립 실행 파일 또는 포함형 Python 런타임 미승인
- 새 Windows 계정에서 설치·복구·제거 검증 미통과
- GitHub `main` 또는 임의 URL에서 직접 업데이트하는 흐름
- 원본 소스, 프로젝트 경로, GitHub URL, 프롬프트, 보고서 본문을 중앙 서버에 보내는 설계

## 시범 운영에서 확인할 항목

- 모바일·데스크톱에서 안내와 상태 문구가 읽히는지
- 설치 파일이 없을 때 다운로드가 닫혀 있는지
- 인덱스 로드 실패 시 설치 파일을 제공하지 않는지
- 승인된 인덱스를 등록했을 때 버전·해시·링크가 정확히 표시되는지
- GitHub Pages와 Vercel 배포 결과가 같은지

기관 서버 이관 후에도 하네스와 체커의 실제 실행은 사용자 PC에서만 한다. 포털은 배포·상태·안내·최소 메타데이터를 담당하는 경계로 유지한다.
