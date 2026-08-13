# Windows 설치 번들

이 폴더는 일반 공무원용 Windows 설치기를 만드는 **배포 관리용 소스**다. 사용자 PC에 Python·Node.js가 없어도 실행하려면 승인된 Node 런타임, Python 런타임, 체커 독립 실행 번들을 이 번들에 포함해야 한다.

## 배포 순서

1. 격리된 기관 빌드 환경에서 GitHub 승인 태그를 checkout한다.
2. 검증된 `node.exe`, `python.exe`, 체커 독립 실행 배포물을 `runtime/node.exe`, `runtime/python.exe`, `checker/gvskb.exe`에 넣는다.
3. 배포물의 버전을 `bundle-components.json`에 기록한다. 예시는 `bundle-components.example.json`이다.
4. 기관 HSM 또는 비밀 저장소의 Ed25519 개인키로 `scripts/sign-release-bundle.mjs`를 실행한다. 개인키는 이 저장소, 포털, 설치 번들, 사용자 PC에 저장하지 않는다.
5. `node bin/gg.mjs bundle verify --bundle <번들> --trust <기관 공개키 목록>`이 성공한 번들만 Inno Setup으로 패키징한다.
6. 설치 파일은 기관 Authenticode 인증서로 서명하고, 포털에는 해당 설치 파일과 manifest·SHA-256만 게시한다.

## 설치기 전제

- Inno Setup과 `signtool.exe`는 이 저장소에 포함하지 않는다.
- `vibecode-checker`는 별도 저장소의 승인된 독립 실행 배포물을 사용한다. Python 소스를 임의로 복사하거나 GitHub `main`을 사용자 PC에서 실행하지 않는다.
- 공개키 목록은 코드서명된 설치기에 포함한다. 운영 공개키가 비어 있으면 설치·업데이트는 반드시 실패해야 한다.
