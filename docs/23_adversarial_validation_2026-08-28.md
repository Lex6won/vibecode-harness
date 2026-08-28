# Harness Manager · 다중 도구 적대적 검증 기록

## 범위

이번 검증은 Harness Manager, 정책 프로필, 다중 도구 어댑터, Lovable Git
브리지, 로컬 체커 제거, 서명 번들 계약 변경이 기존 프로젝트와 설치 경로를
훼손하지 않는지 확인한다. 포털 서버 체커의 판정 자체는 이 저장소 범위 밖이다.

## 자동 검증 결과

- `npm test`: 62개 통과
- `npm run validate:design`: 통과
- `npm run test:design`: 정책 변이 4종 모두 거부
- `npm run release:preflight -- --tag v0.2.0`: 소스 사전 점검 통과
- `git diff --check`: 공백 오류 없음

## 공격·실수 시나리오와 결과

| 시나리오 | 기대 결과 | 검증 결과 |
|---|---|---|
| TypeScript/Supabase 프로젝트에 `.js`, `.py`, Python 의존성 추가 | 빌드 차단 | 차단 |
| Claude Code·Antigravity에서 Go 등 금지 파일 생성 | 작업 전 차단 | 차단 |
| `npm install`, `pip install`, `npx create-*`로 미승인 패키지 실행 | 작업 전 차단 | 차단 |
| `npx --no-install`으로 이미 설치된 로컬 도구 실행 | 허용 | 허용 |
| 프로젝트 사본의 정책 엔진을 변경 | `gg build` 차단 | 차단 |
| 사용자가 수정한 `VIBECODE-LOVABLE.md` 뒤 Lovable 해제 | 사용자 수정 파일 보존 | 보존 |
| 기존 Antigravity 플러그인 존재 | 덮어쓰지 않고 복구 필요 표시 | 보존 |
| 기존 Claude 설정 존재 | 백업 후 Harness 훅만 병합/제거 | 보존 |
| 로컬 PC에 체커·Python 없음 | 로컬 정책 검증 가능, 포털 점검 필요 표시 | 통과 |
| 서명 뒤 번들 파일 변경 | 설치·업데이트 검증 거부 | 차단 |
| 번들에 개인 키 파일 포함 | manifest 생성 거부 | 차단 |

## 지원 수준의 한계

Claude Code와 Google Antigravity는 작업 전 훅으로 즉시 차단한다. Codex,
Claude Desktop, ChatGPT/Codex Desktop은 프로젝트 지침과 Git 게이트를
사용한다. 따라서 이 데스크톱 앱의 모든 파일 작업을 하네스가 가로챈다고
표시하지 않는다.

Lovable은 GitHub 동기화와 PR 게이트를 사용해야 강제 대상이다. GitHub를
연결하지 않은 Lovable 프로젝트는 안내만 적용되며 관리·승인 대상이 아니다.

## 아직 실행할 수 없는 정식 배포 검증

다음 자산이 아직 제공되지 않아 실제 EXE 생성·서명·게시·신규 Windows 계정
시험은 수행하지 않았다.

1. 승인된 Windows용 Node 런타임 번들 및 서명된 bundle manifest
2. bundle manifest용 기관 HSM 또는 기관 키 사용 권한
3. Authenticode 인증서 지문과 타임스탬프 URL
4. Inno Setup이 설치된 격리 Windows 빌드 PC
5. GitHub Release 게시 권한 및 승인 기록

이 자산이 제공되면 `release:preflight` → 서명 번들 검증 → EXE 빌드·
Authenticode 검증 → 신규 Windows 설치 → GitHub Release 게시 순으로
진행한다. Python과 보안 체커는 사용자 EXE에 포함하지 않는다.
