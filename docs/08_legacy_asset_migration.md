# 기존 하네스 자산 이관표

목적: 기존 `C:\Users\first\vibe_harness_codex`의 자산을 다시 작성하지 않고 선별 계승한다. 이 문서는 복사 승인표이며, 출처 검토 없이 실행 파일을 자동 이관하는 목록이 아니다.

| 기존 자산 | 새 위치 또는 역할 | 조치 | 선행 검증 |
|---|---|---|---|
| `shared/golden-templates/*` 6종 | `templates/golden/*` | 선별 이관 | Python, JavaScript, TypeScript 런타임·테스트·비밀값 점검 |
| `shared/enforcement/gvskb_gate.py` | 보류 | 이관 금지 | 체커의 공개 기계 판정 계약이 생기기 전에는 결과 필드를 재해석하지 않음 |
| `shared/enforcement/gvskb_gate.js` | 보류 | 이관 금지 | npm lifecycle 기본 비활성화와 lockfile 경로 확인 후 별도 승인 |
| `shared/references/network-profile.yaml` | `shared/references/` | 정책 이관 | 현재 기관 망 정책과 프로파일명 대조 |
| `shared/references/trusted-registry-integration.yaml` | `shared/references/` | 정책 이관 | 레지스트리 API 직접 호출 금지와 신호 계약 대조 |
| `shared/references/harness-enforcement-contract.yaml` | 참고 원본 | 분해 이관 | 새 `checker-signals.yaml`과 모드 교차표로 분리 |
| `shared/templates/*.schema.json` | `templates/` | 선별 이관 | 새 증적 스키마와 중복·충돌 제거 |
| `.github/workflows/validate-harness.yml` | `.github/workflows/` | 새 실행기 후 이관 | 실제 `gg verify`와 Windows runner에서 재검증 |
| `evals/*.json` | `tests/evals/` | 시드 이관 | 새 명령·프로파일·판정 이름으로 갱신 |

## 이관 금지

- `dev-quick`처럼 현재 체커에 없는 프로파일명
- 체커 판정을 `summary.blocked` 또는 severity로 다시 계산하는 코드
- 기존 정책을 덮어쓰는 AI 도구별 지침
- 원본 프로젝트의 비밀값, 실제 보고서 본문, 사용자 식별 정보

각 이관은 출처 경로, 원본 SHA-256, 수정 사유, 테스트 결과를 `evidence/work-status.json`에 남긴다.
