# 실행 준비도 검토 — "실행형 하네스"로 쓸 수 있는가

> 상태: 실측 검토 기록. 체커 CLI 계약과 우선순위의 현재 기준은 `docs/07_integrated_execution_contract.md`다.

검토일: 2026-08-12
대상: `바이브코드 하네스` 전체 (파일 13개)
검토 방식: 문서 대조 + **변이 검사**(정책 위조 후 검증기 재실행) + **체커 CLI 실측**(실제 실행)
대조 대상: `C:\Users\first\vibecode-checker` (실제 구현), `C:\Users\first\vibe_harness_codex` (구 하네스, 파일 218개)

---

## 0. 총평

**설계 문서로는 수준이 높다. 그러나 "실행형 하네스"로는 아직 아무것도 실행되지 않는다.**

- 전체 13개 파일 중 실행 가능한 코드는 `scripts/validate-design.ps1` **64줄 하나**다.
- `gg init / start / design / build / verify / release` 여섯 명령 중 구현된 것은 **0개**다.
- 그리고 그 유일한 실행 코드는 **막아야 할 것을 막지 못한다**(§2에서 실측).

README와 `scripts/README.md`가 "설계 기준선이며 구현 완료를 주장하지 않는다"고 **명시한 것은 정직하고 그대로 유지해야 한다.** 다만 사용자가 요구하는 것은 실행형이므로, 현재 상태는 "쓸 만한가"를 판단할 단계 이전이다.

더 중요한 문제는 따로 있다. **이미 동작하는 자산이 옆 폴더에 있는데 승계되지 않았다.**

| | 새 하네스 | 구 하네스 (`C:\Users\first\vibe_harness_codex`) |
|---|---|---|
| 파일 수 | 13 | 218 |
| 실행 코드 | 64줄 (PS1 1개) | 약 2,200줄 (`gvskb_gate.py` 633, `gg-validate.ps1` 407, `harness-final-smoke.mjs` 372 …) |
| 골든 템플릿 | 0 | 6종 (webapp/dashboard/node-api/spa/upload/rag) |
| 스키마 | 0 | 3 (`harness.schema.json` 등) |
| CI 워크플로 | 0 | 1 (`validate-harness.yml`) |
| 평가 픽스처 | 0 | 4 (`evals/*.json`) |
| 패키지 게이트 | 문장 1줄 | 실행 스크립트 2개 (py/js, MONITOR·WARN·ENFORCE 내장) |

`docs/01` §2.1은 "계승할 장점"을 표로 적었지만 **경로도, 파일 단위 이관 목록도 없다.** 현재 상태는 계승이 아니라 **폐기 후 재작성**이다.

**판정: 정책 설계는 유지, 실행 계층은 구 하네스 자산 이관으로 시작해야 함. 지금부터 새로 만들면 이미 있는 2,200줄을 다시 쓰게 된다.**

---

## 1. 실측으로 확인한 결함

### C-1. 유일한 검증기가 정책 위조를 통과시킨다 ⚠ (변이 검사로 확인)

`validate-design.ps1`은 어댑터 드리프트 방지가 목적이다. 그런데 **정확히 그 드리프트를 놓친다.**

복제본에 다음 두 가지를 심고 재실행했다.

```yaml
# shared/harness-core.yaml
implementation_policy:
  allowed_languages:
    - python
    - javascript
    - typescript
    - go          # ← 심음
  denied_without_exception:
    - go          # ← 같은 파일 안에서 자기모순
```

```markdown
# adapters/codex/AGENTS.template.md
2. 기능 구현은 Python, JavaScript, TypeScript, Go, Rust 승인 트랙 안에서만 한다.   # ← 심음
```

실행 결과:

```
{"status":"passed","check":"vibecode_harness_design_consistency"}
```

**통과했다.** 원인은 두 가지다.

1. `$adapter -notmatch "Python, JavaScript, TypeScript"` — **부분 일치**라 뒤에 무엇을 붙여도 통과한다.
2. `$core -notmatch "(?m)^\s+- $language\s*$"` — 허용 언어 **존재만** 확인하고, 목록에 **없어야 할 것이 있는지**는 보지 않는다. `allowed_languages ∩ denied_without_exception ≠ ∅` 이라는 명백한 자기모순도 잡지 못한다.

부수 문제: `$profile`은 PowerShell 자동변수(`$PROFILE`)와 충돌한다. 동작은 하지만 세션 변수를 덮어쓴다.

> **검증기가 스스로 초록불을 만들고 있다.** 파일 존재 확인 + 부분 문자열 grep은 검증이 아니라 존재 확인이다.

**조치:** YAML을 파싱해 `allowed_languages`를 **집합으로 비교**하고, `allowed ∩ denied`가 비어 있는지 확인하고, 어댑터는 정확 일치(또는 생성물 해시 비교)로 바꾼다. 위 변이 3종을 픽스처로 고정해 "일부러 깨뜨렸을 때 실패하는지"를 회귀 테스트로 둔다.

### C-2. 검사 파일 0개 → 종료코드 0 (실측)

빈 폴더를 실제로 검사했다.

```
gvskb scan <빈폴더> --format json --stdout --fail-on block
[gvskb] ⚠ 검사된 파일이 없습니다 (스캔 대상 0개). …
EXIT=0
```

경고는 **stderr 한 줄**뿐이고 종료코드는 **0**이다. `--fail-on block`을 줘도 같다.

`gg verify`가 종료코드만 보고 판정하면, **경로를 잘못 준 검사가 "통과"가 된다.** 사용자는 검증받았다고 믿는다. 가장 조용하고 가장 위험한 고장이다.

**조치:** 하네스는 종료코드가 아니라 **JSON을 읽어야 한다.** `scanned_files == []` 이면 무조건 `checker_incomplete`.

### C-3. 스캔 JSON에 판정 필드가 없다 ⚠ (체커 쪽 보완 필요)

`gvskb scan --format json` 출력의 최상위 키 전부:

```
target, language, scenario, profile, summary, findings, scanned_files, skipped_files,
external_surface, scan_mode, engine_version, generated_at, ruleset_version, ruleset_digest,
ruleset_drift, intel_freshness, dependency_audit, duplicate_files, profile_fallback,
vendor_bundles, suppression_summary, disclaimer
```

**`verdict` / `gate_status`가 없다.** MCP `render_report`에는 있다(`server.py:541,641`). 즉 **AI 도구가 대화 중 부르는 경로에는 판정이 실려 오고, CI가 쓰는 CLI 경로에는 안 실려 온다.**

그래서 하네스가 CLI JSON만 보고 판정하려면 `summary.blocked`를 읽게 되는데, 체커의 `gate.py` 첫머리가 정확히 그 사고를 기록해 두었다.

> `ScanSummary.blocked`는 **소스 발견만** 본다. 의존성 감사는 스캔이 끝난 뒤에 붙는다. 그래서 의존성 CRITICAL 취약 패키지가 있어도 보고서 본문은 "배포 불가"인데 `summary.blocked`는 False였다. **같은 문서가 사람에게는 막으라고 하고 기계에게는 통과라고 답했다.**

**하네스가 `summary.blocked`를 읽으면 그 사고를 그대로 재현한다.**

**조치(둘 중 하나, 앞쪽 권장):**
1. **체커에 작은 변경** — `scan --format json` 출력에 `gate_status` 결과를 싣거나 `gvskb gate <report.json> --json` 서브커맨드를 추가한다. `gate.py`의 설계 원칙("판정은 한 곳에서만 계산한다")과 일치한다.
2. 하네스가 재구현 — **비권장.** 판정 로직은 이미 한 번 바뀌었고(2026-08-09), 복제본은 반드시 뒤처진다.

### C-4. `docs/05`가 제안한 체커 호출 계약이 실제 CLI와 다르다

`docs/05` §5 초안은 다음 명령을 전제한다.

```yaml
cmd: ["gvskb","scan-dependencies", …]
cmd: ["gvskb","scan-vendor-bundles", …]
cmd: ["gvskb","render-report", …]
```

**이 세 명령은 CLI에 존재하지 않는다.** 실제 서브커맨드는
`scan / check-package / report / rules / version / status / evaluate / config / doctor / sbom / ruleset / validate-rules / update / bundle / sync` 뿐이다.
`scan_dependencies`·`scan_vendor_bundles`·`render_report`는 **MCP 도구 이름**이며 CLI에는 대응이 없다.

그리고 `docs/05` B-3(벤더 번들 미탐)의 진단은 **CLI 경로에서는 성립하지 않는다.** 실제 코드(`cli.py:237,312-315`)는 `--check-deps`가 켜져 있으면 벤더 번들을 **자동으로** 감사한다.

```python
vendor_bundles = list(getattr(report, "vendor_bundles", None) or [])
...
if vendor_bundles:
    out.append(await audit_vendor_bundles(vendor_bundles, env_grade=env_grade))
```

**따라서 B-3의 올바른 조치는 "단계 추가"가 아니라 "필수 인자 못박기"다.** `--check-deps`를 빠뜨리면 벤더 번들·의존성이 **함께** 통째로 빠진다.

**실제 CLI에 맞춘 계약:**

```yaml
checker_contract:
  engine: "vibecode-checker (gvskb)"
  invocation: cli            # MCP 는 개발 중 AI 도구 전용. 훅·CI 는 항상 CLI.

  command:
    - gvskb
    - scan
    - "{target}"
    - --profile
    - "{profile}"
    - --format
    - json
    - --check-deps           # ← 없으면 의존성·벤더번들 둘 다 안 봄
    - --include-installed    # ← 없으면 전이 의존성 취약점을 놓침
    - --fail-on
    - "{fail_on}"
    # 릴리스 단계에서만: --sbom {path} --project-name {기관정식명칭} --env E2

  profiles:                  # 실재하는 5개에서만 고른다
    quick: dev-quick
    internal_tool: internal-db-query
    citizen_web: web-civil-service
    llm_chatbot: civil-complaint-chatbot
    release: public-default-strict     # 체커 기본값

  fail_on_by_level:          # 도입 초기 이탈 방지 — 기본값 warn 은 발견만 있어도 CI 를 빨갛게 만든다
    guided: never
    enforced: block
    release_locked: warn

  checker_exit_codes:        # 실제 값
    0: ok
    1: findings_warn
    2: findings_block
    64: usage_error
    66: not_found

  verdict_source: "JSON 을 읽는다. 종료코드만으로 판정하지 않는다(0파일도 0을 낸다)."
```

### C-5. 하네스의 차단 기준이 체커와 반대로 서 있다

체커는 2026-08-09에 차단 기준을 **다섯 개로 좁혔다.**

| 판정 | 조건 |
|---|---|
| **차단** | 악성 패키지 · 레지스트리 거부 · 레지스트리에 없는 이름 · CISA KEV 등재 · CVSS **CRITICAL** |
| **조건부** | CVSS HIGH 이하 · 쿨다운 · 판정 불가 · **소스 발견 전부** |
| **승인** | 조치할 것 없음 |

좁힌 이유가 `gate.py`에 실측으로 적혀 있다. 예전 기준(HIGH 하나면 차단)으로 **실측 4개 저장소가 전부 차단됐고, 차단 근거는 100% `high` 하나**였다. 악성 0건, KEV 0건, CRITICAL 0건. 게다가 수정본이 없는 패키지도 있어 **담당자가 게이트를 만족시킬 방법이 없었다.**

> 만족시킬 수 없는 게이트는 우회되거나 꺼진다.

그런데 `docs/05` §5 초안은 이렇게 제안했다.

```yaml
exit_40_checker_block: "decision == block 또는 severity in [critical, high] 존재"
```

**체커가 의도적으로 없앤 과잉 차단을 하네스가 되살리는 것이다.** 게다가 "소스 발견은 전부 조건부"라는 결정과도 정면으로 어긋난다. 이대로 가면 공무원 프로젝트는 대부분 첫 커밋에서 막히고, 하네스는 꺼진다. **안 쓰이는 도구는 효과가 0이다.**

**조치:** `exit 40 = checker_block`은 `gate_status.verdict == "blocked"` **에만** 건다. `conditional`은 기록 + `safe_fix` 제시로 처리하고, RELEASE_LOCKED에서만 사람 승인 조건으로 올린다.

---

## 2. 설계에 비어 있는 것 (실행 착수 전 채워야 함)

| # | 빠진 것 | 왜 문제인가 | 구 하네스에 있는 것 |
|---|---|---|---|
| 1 | **골든 템플릿 0개** | "개발 언어 강제"의 실질은 스캐폴드다. 허용 언어를 문장으로 적어도 **시작할 프로젝트 뼈대가 없으면 강제되지 않는다.** 사용자는 AI에게 "만들어줘"라고 하고 AI는 아무 구조나 만든다 | `shared/golden-templates/` 6종 (Dockerfile·tests·CLAUDE.md 포함) |
| 2 | **패키지 게이트 실행 경로 없음** | `institution-profile.yaml`의 `package_gate: "checker-mediated PyPI/npm verdict"`는 **문장일 뿐 실행되지 않는다** | `shared/enforcement/gvskb_gate.py` 633줄 — MONITOR/WARN/ENFORCE 내장 |
| 3 | **망분리 대응이 한 줄도 없음** | 실제 환경은 논리적 망분리 + 파일전송 방식 망연계다. `GVSKB_MODE=offline`, 인텔 캐시 stale 기준일, 반입 절차가 없으면 **첫 사용에서 깨진다** | `shared/references/network-profile.yaml` |
| 4 | **표준 점검 프로파일이 서술문** | `standard_check: "full project source and declared dependencies"` — 이름이 아니다. 체커 기본값은 `public-default-strict`인데 하네스는 이를 모른다 | 망 구간·노출 대상별 매핑 |
| 5 | **증적 JSON 스키마 없음** | `work-status.json`, `visual_review_receipt`가 산문으로만 존재. **Codex와 Claude가 같은 파일을 다른 형태로 쓴다.** 하네스의 존재 이유가 여기서 깨진다 | `shared/templates/*.schema.json` 3종 |
| 6 | **테스트·픽스처 0개** | `docs/04`의 재검증 계획 5종이 계획으로만 있다. 참고로 체커는 388개 테스트를 갖고 있다 | `evals/*.json` 4종 |
| 7 | **CI 워크플로 파일 없음** | "CI가 최종 차단"이 설계 전체의 신뢰 근거인데 **그 파일이 없다** | `.github/workflows/validate-harness.yml` |
| 8 | **`gg` 진입점 없음** | `scripts/README.md`가 "gg.ps1 또는 코드서명 로컬 에이전트"라고만 적음 | `shared/scripts/gg-validate.ps1` 407줄 등 |
| 9 | **레지스트리 연계 없음** | 사용자 요구는 "체커 **와 레지스트리와** 연계"인데 레지스트리 관련 정책이 전무. 체커에는 `--registry-bundle` 옵션이 실재한다 | `shared/references/trusted-registry-integration.yaml` |
| 10 | **인텔 신호 해석 규칙 유실** | `kev_checked=false`를 KEV 미매치로 읽으면 **거짓 안심**, `version_exact=false`로 차단하면 **과잉 차단**. 둘 다 도구를 못 쓰게 만든다 | 구 `AGENTS.md`에 원문 존재 |
| 11 | **집행 모드 축 소실** | GUIDED/ENFORCED/RELEASE_LOCKED는 **성숙도 축**이지 집행 강도 축이 아니다. "L2인데 롤아웃이 MONITOR면 차단인가 경고인가"에 답이 없다 | `harness-enforcement-contract.yaml` |
| 12 | **`_check-reports/` 3개 폴더가 비어 있음** | 하네스 자신을 체커로 검사한 흔적이 폴더만 남고 보고서가 없다. 증적을 요구하는 하네스가 자기 증적이 없다 | — |

### 언어 강제에 관한 별도 지적

확장자 검사만으로는 "개발 언어 강제"가 되지 않는다. `.go` 파일이 없어도 Python이 `subprocess`로 외부 바이너리를 부르거나, `package.json`의 스크립트가 다른 런타임을 끌어들이면 정책은 우회된다. `gg build` 검사 대상을 **변경 파일 확장자 + 의존성 매니페스트 + 런타임 선언 + 실행 스크립트** 넷으로 명시해야 한다.

---

## 3. 유지해야 할 것 (공정한 평가)

| 항목 | 평가 |
|---|---|
| README의 "설계 기준선, 구현 아님" 명시 | **정직하다.** 실행 코드가 생기기 전까지 이 문장을 지운 판본을 배포하지 않는다 |
| `trust-and-integrity.yaml` | 서명·해시·키 교체·폐기 목록·anti-downgrade. 경기도 포털 설계와 정합. **그대로 사용 가능** |
| `execution_safety` | "임의 shell 문자열 해석 금지", "lifecycle script 기본 비활성화", "첫 실행 사용자 승인" — 실제 공격면을 정확히 짚음 |
| `hook_safety` | 재진입 방지(영수증 + 환경 표식), 기존 훅 비파괴, `--no-verify` 기록 — 실무 함정을 알고 쓴 것 |
| `design-discovery.yaml` | 기술 용어 대신 업무 질문으로 DB·관리자를 판정. `no_visual_interface` 예외도 실용적 |
| `docs/04` 12개 실패 가정 | 특히 "미검증 소스의 test 명령 실행", "PowerShell 한글 인코딩 오탐"은 겪지 않으면 안 나오는 항목 |
| `unknown`을 안전으로 표시 금지 | 체커 원칙과 일치 |

---

## 4. 보완 순서

| 순위 | 항목 | 근거 | 규모 |
|---|---|---|---|
| **0** | `validate-design.ps1` 재작성 (YAML 파싱·집합 비교·`allowed ∩ denied` 검사) + **변이 픽스처 3종** | 지금 검증기는 **스스로 초록불을 만든다.** 이걸 두고 다른 걸 만들면 전부 검증되지 않은 채 쌓인다 | 반나절 |
| **1** | `checker-contract.yaml` 신설 — **§C-4의 실제 CLI 기준으로**. `docs/05` §5 초안은 폐기 | 계약 없이 만든 `gg verify`는 체커를 부르는 시늉만 한다 | 1일 |
| **2** | 체커에 `gate_status` JSON 노출 (또는 `gvskb gate --json`) | 없으면 하네스가 판정 로직을 복제하고, `gate.py`가 경고한 "사람과 기계에 다르게 답하는 문서"가 하네스에서 재현된다 | 체커 소폭 수정 |
| **3** | 구 하네스 자산 **파일 단위 이관 표** 확정 후 이관 | 골든 템플릿 6 · `gvskb_gate.py/js` · 스키마 3 · `network-profile.yaml` · 승인패키지/거부목록/대체안 · CI workflow · evals 4. **다시 쓰면 2,200줄을 다시 쓴다** | 2일 |
| **4** | `gg init` / `gg doctor` / `gg verify` 최소 실행기 | `verify`는 오케스트레이션만: 언어 검사 → 테스트 → `gvskb scan --check-deps --include-installed` → **JSON 파싱** → 종료코드 매핑 | 3~5일 |
| **5** | 망분리 프로파일, 집행 모드(MONITOR→WARN→ENFORCE), `conditional`/`requires_review` 통제수준별 매핑표 | 도입 실패(사용자 이탈) 방지 | 1일 |
| **6** | 증적 스키마 2종, `safe_fix` 출력 연결, 보고서 경로+해시만 기록(복사 금지) | 사용성·유지보수 | 1일 |

**0~2번을 끝내기 전에는 `gg verify` 구현에 착수하지 않는다.**

---

## 5. 이 검토의 한계

- `gg` 실행기가 없으므로 하네스의 **동작** 검증은 불가능했다. 검증한 것은 (a) `validate-design.ps1`의 실제 동작, (b) 체커 CLI의 실제 동작, (c) 두 설계 문서와 실제 코드의 대조까지다.
- `docs/05`의 지적 중 B-1(호출 계약 부재), B-2(exit code 뭉갬), H-1(0파일), H-3(인텔 신호), H-4(집행 모드), H-6(게이트 실행 경로), M-3(검증기 드리프트)은 **유효하며 이 문서가 실측으로 뒷받침한다.**
- 반면 `docs/05`의 B-3(벤더 번들)과 §5 계약 초안(존재하지 않는 CLI 명령, HIGH 차단)은 **실제 코드와 어긋나므로 이 문서의 §C-4·§C-5로 대체한다.**
- 여전히 미검토: `--tools both` 동시 사용 시 증적 충돌, 모노레포·다중 언어 프로젝트의 프로파일 선택, Windows 외 환경.
