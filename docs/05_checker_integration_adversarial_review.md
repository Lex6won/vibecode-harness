# 체커 연계 구조 적대적 검증

> 상태: 발견 기록. §5의 CLI 호출 초안과 §6의 우선순위는 실제 CLI와 충돌하므로 현재 계약으로 사용하지 않는다. 유효한 체커 연계 계약은 `docs/07_integrated_execution_contract.md`, Windows 설치·포털·개인정보 기준은 `docs/09_windows_harness_implementation_baseline.md`를 따른다.

검증일: 2026-08-12
대상: `바이브코드 하네스` 설계 기준선 전체 (README, docs/01~04, shared/*, adapters/*, scripts/*)
검증 관점: **"이 하네스가 vibecode-checker와 연계해 실제로 역할을 할 수 있는가"**
대조 자료: `vibecode-checker` 실제 구현(v0.3.0, 룰 326개), 기존 `vibe_harness_codex` AGENTS.md, MCP 서버 사용 지침

---

## 0. 총평

**보안 설계의 방향은 좋다. 문제는 체커와의 인터페이스 계약이 통째로 비어 있다는 것이다.**

`trust-and-integrity.yaml`의 서명·해시·anti-downgrade·키 교체 규칙은 경기도 포털 설계(`docs/18`)와 정합하며, `execution_safety`의 "임의 shell 문자열을 해석하지 않는다", "lifecycle script 기본 비활성화"는 실무적으로 정확한 방어다. `04_adversarial_design_review.md`의 12개 실패 가정도 진짜 적대적 사고의 산물이다.

그러나 이 하네스의 존재 이유는 **"체커는 보안 판정 엔진이고 하네스는 그 결과를 개발 흐름에 연결한다"**(README 원칙 7)이다. 그런데 **연결 방법이 어디에도 적혀 있지 않다.**

- `gg verify`가 체커를 CLI로 부르는지 MCP로 부르는지 없다.
- 체커가 돌려주는 JSON의 **어떤 필드로 판정하는지** 없다.
- exit code 0/10/20/30/40은 정의했으나 **그 코드를 무엇으로부터 도출하는지** 없다.

현재 상태로 구현에 들어가면 **구현자마다 다른 연계가 나온다.** 그리고 아래 BLOCKER 3·4는 정책 미비가 아니라 **실제 미탐(놓침)을 만든다.**

**판정: 설계 기준선으로는 유효하나, 체커 연계 부분은 착수 전 보강 필요.**

---

## 1. BLOCKER — 구현 착수 전 반드시 해소

### B-1. 체커 호출 계약이 없다

`execution-contract.yaml`의 `gg_verify.validates`에 `checker_scan`이라는 **이름만** 있다.

실제 체커는 두 경로를 제공한다.

| 경로 | 형태 | 특성 |
|---|---|---|
| CLI | `gvskb scan <path> --profile dev-quick --format json --output <dir> --fail-on block` | 결정적, CI 적합 |
| MCP | `scan_path` / `scan_code` / `scan_dependencies` / `scan_vendor_bundles` / `render_report` | AI 도구 대화 중 호출 |

**하네스는 CI에서도 같은 검증을 재실행한다고 했으므로 CLI가 정답이다.** MCP는 개발 중 AI 도구용이다. 이 구분이 문서에 없으면 구현자가 MCP를 CI에 끌어들이거나 그 반대를 한다.

→ **조치:** `execution-contract.yaml`에 `checker_invocation` 블록을 신설해 명령·인자·프로파일·출력 경로·타임아웃을 고정한다.

### B-2. exit code 도출 규칙이 없고, 40이 두 상황을 뭉갠다

```yaml
40: checker_block_or_incomplete   # ← 현재
```

`block`(위험을 실제로 발견)과 `incomplete`(검사를 못 함)는 **완전히 다른 상황이고 사용자의 다음 행동도 다르다.** block은 코드를 고쳐야 하고, incomplete는 경로·확장자·네트워크를 확인해야 한다. 하나로 묶으면 사용자가 무엇을 할지 알 수 없다.

→ **조치:** `40 = checker_block`, `41 = checker_incomplete`로 분리. 각 코드가 체커 JSON의 어떤 값에서 나오는지 명시.

### B-3. `vendor_bundles` 미처리 — 실제 미탐 경로 ⚠

체커 MCP 지침은 이를 **필수**로 규정한다.

> `vendor_bundles`가 비어 있지 않으면 **반드시** `scan_vendor_bundles`에 그 값을 그대로 넘겨 검사하세요. `static/*.min.js` 같은 벤더 라이브러리는 소스 룰 검사에서 제외되지만 알려진 취약점이 붙고, `package.json`도 `node_modules`도 없는 프로젝트에서는 **이것이 유일한 컴포넌트 발견 경로**입니다.

하네스의 `gg_verify.validates`에는 이 단계가 **없다.**

공무원이 만드는 정적 웹 페이지에 `jquery.min.js`, `bootstrap.min.js`를 직접 넣는 것은 매우 흔하다. 그 프로젝트에는 `package.json`이 없다. **이 단계가 빠지면 취약한 라이브러리를 통째로 놓치고, 그 상태로 "통과"가 나간다.** 하네스가 없을 때보다 더 위험하다 — 사용자는 검증받았다고 믿기 때문이다.

→ **조치:** `gg_verify` 필수 단계에 벤더 번들 검사를 추가하고, 결과를 `dependency_audit`에 병합해 보고서에 반영한다.

### B-4. `package_gate`와 `scan_dependencies`를 혼동하고 있다

두 가지는 목적이 다르다.

| | 시점 | 대상 | 목적 |
|---|---|---|---|
| **패키지 게이트** | 새 패키지 **설치 전** | 추가하려는 패키지 1개 | 가짜·악성·미승인 차단 |
| **의존성 전수 검사** | 검증 시 | 현재 선언된 **전부** | 이미 들어와 있는 취약 버전 발견 |

하네스는 `package_gate` 하나만 두었다. 이러면 **하네스 도입 이전에 이미 들어와 있던 취약 패키지를 영원히 발견하지 못한다.** 기존 프로젝트에 하네스를 적용하는 경우가 실제로 가장 많다.

또 체커 지침은 "의존성 매니페스트가 '검사 제외'로 표시되면 `scan_dependencies`를 따로 호출하고 결과를 `dependency_audit`에 넣어야 보고서에 의존성 섹션이 들어간다"고 명시한다. 이 절차가 없으면 **보고서에 의존성 섹션 자체가 누락된다.**

→ **조치:** `gg_verify.validates`에 `dependency_audit`를 별도 항목으로 추가.

---

## 2. HIGH — 판정 정확도에 직접 영향

### H-1. 검사 파일 0개 처리 규칙이 없다

체커 원칙: *"검사된 파일이 0개면 '안전'이 아니라 경로·확장자를 확인하라는 뜻입니다."*

하네스에 이 매핑이 없다. 경로를 잘못 준 `gg verify`가 **0건 발견 = 통과**로 처리될 수 있다. 이는 가장 조용하고 위험한 고장이다.

→ `scanned_file_count == 0` 이면 무조건 `41 checker_incomplete`.

### H-2. `requires_review` 처리가 미정

체커는 `block` / `requires_review` / `warn` / `pass`를 낸다. `requires_review`는 **안전이 아니다.**

하네스는 이를 어느 exit code로 보낼지, 통제 수준별로 다르게 다룰지 정하지 않았다. L1에서는 경고, L3에서는 차단이 합리적이지만 **명시되지 않으면 구현자가 임의로 정한다.**

→ 통제 수준별 매핑표 필요: GUIDED=경고 / ENFORCED=경고+기록 / RELEASE_LOCKED=차단.

### H-3. 인텔 신호 해석 규칙이 유실됐다 — 계승 실패

기존 `vibe_harness_codex`의 AGENTS.md에는 다음이 명시되어 있다.

> `kev_checked=false`면 `in_kev=false`는 KEV 미매치의 증거가 아니다 / `version_exact=false`는 단독 차단 사유가 될 수 없다 / `source_scope`가 ENFORCE의 unknown 직접 의존성 차단 범위를 결정한다 / `registry_status`가 `ok`여야 레지스트리 allow 판정을 쓸 수 있다

새 하네스 `docs/01` §2.1은 이를 "체커·패키지 게이트"라는 한 칸으로 요약했고, **실제 규칙은 하나도 옮겨오지 않았다.** `04_adversarial_design_review.md`에 `registry_stale` 한 단어만 남아 있다.

이 규칙들이 없으면 **거짓 안심(kev_checked=false를 안전으로 읽음)** 과 **과잉 차단(version_exact=false로 차단)** 이 동시에 발생한다. 둘 다 도구를 못 쓰게 만든다.

→ `shared/policies/checker-signals.yaml` 신설로 원문 수준 복원.

### H-4. 집행 모드(MONITOR/WARN/ENFORCE) 축이 사라졌다

기존 하네스: `harness_enforcement.default_mode: MONITOR` → 2주 후 WARN → 커버리지 충족 시 ENFORCE.

새 하네스는 GUIDED / ENFORCED / RELEASE_LOCKED를 도입했는데 이건 **성숙도 축**이지 집행 강도 축이 아니다. 두 축은 곱해진다.

> L2 프로젝트인데 레지스트리 롤아웃이 MONITOR면 패키지 게이트는 차단인가 경고인가?

답이 없다. **도입 초기에 오탐으로 차단되면 사용자는 하네스를 꺼버린다.** 안 쓰이는 도구는 효과가 0이다.

→ 두 축의 교차표를 명시하고, 초기 기본값은 MONITOR로 시작한다.

### H-5. 표준 점검 프로파일 이름이 고정되지 않았다

```yaml
quick_profile: "dev-quick"                                   # ✔ 실재하는 프로파일명
standard_check: "full project source and declared dependencies"  # ✗ 서술이지 이름이 아님
```

체커에는 `internal-db-query`, `web-civil-service`, `public-default-strict` 등 실제 프로파일이 있고, 기존 하네스의 `network-profile.yaml`은 망 구간별로 이를 매핑한다. 새 `institution-profile.yaml`은 그 매핑을 참조하지 않는다.

→ 표준 점검의 **프로파일 이름을 고정**하고, 망 구간·노출 대상별 매핑을 institution-profile에 되살린다.

### H-6. 패키지 게이트에 실행 경로가 없다

`institution-profile.yaml`은 `package_gate: "checker-mediated PyPI/npm verdict"`라고 적었지만, 기존 하네스의 실제 게이트 스크립트(`shared/enforcement/gvskb_gate.py`, `gvskb_gate.js`)가 이 폴더에 **존재하지 않는다.**

`shared/`에는 정책 YAML 4개뿐이다. **패키지 게이트는 현재 문장일 뿐 실행되지 않는다.**

→ 게이트 스크립트를 이관하거나, `gg package` 명령이 체커 CLI를 직접 호출하도록 계약을 명시한다.

---

## 3. MEDIUM — 사용성·유지보수

### M-1. `safe_fix`를 개발 흐름에 연결하지 않는다

체커는 발견마다 `safe_fix`(안전한 수정 방향)를 제공하고, MCP 지침은 "decision/severity 순으로 정렬해 safe_fix를 그 순서대로 제안하라"고 규정한다.

하네스는 실패 시 **"실패 항목 수정 후 재검증"** 이라고만 한다. 체커가 이미 만들어 준 답을 버리고 사용자에게 판단을 떠넘기는 것이다. **"도구가 정하고 사용자는 코딩한다"는 원칙에 어긋난다.**

→ `gg verify` 실패 출력에 block → critical/high → 자동수정 가능 → 나머지 순으로 `safe_fix`를 그대로 제시.

### M-2. 보고서 저장 위치가 충돌한다

- 체커: `render_report`가 `<검사경로>/.check-reports/`에 **저장까지 수행**하며, 지침은 *"에이전트가 보고서를 별도 파일로 다시 저장하지 마세요 — 임의 위치·이름으로 만들면 기관의 점검 이력이 흩어집니다"* 라고 명시.
- 하네스: 증적을 `evidence/` 또는 `_workspace/`에 저장하도록 규정.

이 폴더에도 이미 `_check-reports/`가 있다. 하네스가 보고서를 evidence로 **복사하면 지침 위반**, 안 하면 증적이 흩어진다.

→ **복사하지 말고 참조한다.** `evidence/work-status.json`에 보고서의 **경로 + SHA-256 + 생성 시각**만 기록.

### M-3. `validate-design.ps1`이 드리프트를 못 잡는다

```powershell
if ($adapter -notmatch "Python, JavaScript, TypeScript") { throw "Adapter language policy drift detected" }
```

**부분 일치라서 `"Python, JavaScript, TypeScript, Go"`도 통과한다.** 드리프트 방지가 목적인데 정확히 그 드리프트를 놓친다. 파일 존재 확인 + 문자열 grep은 검증이 아니라 존재 확인이다.

또 `$profile`은 PowerShell **자동 변수**(`$PROFILE`)와 이름이 충돌한다. 동작은 하지만 세션 변수를 덮어쓰고 혼동을 유발한다.

→ YAML을 파싱해 `allowed_languages` **집합을 비교**한다. 변수명은 `$institutionProfile`로 변경.

### M-4. 증적 스키마가 산문으로만 존재한다

`evidence/work-status.json`, `visual_review_receipt`의 필드가 문장으로 서술되어 있고 JSON 스키마가 없다. 도구 두 개(Codex·Claude)가 같은 파일을 쓰는데 스키마가 없으면 **양쪽이 다른 형태로 쓴다.** 이 하네스의 존재 이유가 "도구 차이를 정책 차이로 만들지 않는 것"인데 여기서 깨진다.

→ `templates/work-status.schema.json`, `templates/visual-review-receipt.schema.json` 추가.

### M-5. 어댑터 생성 로직의 출력 명세가 없다

`AGENTS.template.md`·`CLAUDE.template.md`는 각 7줄이다. "`shared/harness-core.yaml`에서 생성된다"고 했으나 **생성기의 출력 명세가 없다.** 기존 `AGENTS.md`가 12KB인 것과 비교하면 무엇이 채워져야 하는지 알 수 없다.

→ 생성 결과에 반드시 포함될 섹션 목록을 `execution-contract.yaml`에 명시.

---

## 4. 유지할 것 (공정한 평가)

| 항목 | 평가 |
|---|---|
| README의 "설계 기준선, 구현 아님" 명시 | **정직하다.** 설계 파일로 구현 완료를 주장하지 않는다는 문장은 그대로 유지 |
| `trust-and-integrity.yaml` | 서명·해시·키 교체·폐기 목록·anti-downgrade가 포털 설계(docs/18 §4)와 정합. 그대로 사용 가능 |
| `execution_safety` | "임의 shell 문자열 해석 금지", "lifecycle script 기본 비활성화", "첫 실행 사용자 승인" — 실제 공격면을 정확히 짚음 |
| `hook_safety` | 재귀 방지(영수증+환경 표식), 기존 훅 비파괴, `--no-verify` 기록 — 실무 함정을 알고 쓴 것 |
| `04_adversarial_design_review.md` | 12개 실패 가정. 특히 "미검증 소스의 test 명령 실행", "PowerShell 한글 인코딩 오탐"은 실제로 겪지 않으면 안 나오는 항목 |
| `unknown`을 최신·안전으로 표시 금지 | 체커 원칙과 일치 |
| `design-discovery.yaml`의 업무 언어 질문 | 공무원에게 기술 선택을 요구하지 않는다는 원칙이 질문 형태로 구현됨. `no_visual_interface` 예외도 실용적 |

---

## 5. 제안하는 체커 호출 계약 (B-1 해소안)

`shared/policies/checker-contract.yaml` 신설 초안:

```yaml
checker_contract:
  engine: "vibecode-checker (gvskb)"
  minimum_version: "0.3.0"
  invocation: cli          # MCP는 개발 중 AI 도구 전용. CI·훅은 항상 CLI.

  profiles:
    quick: "dev-quick"
    standard: "<기관 확정 필요 — institution-profile에서 주입>"

  steps:                    # 순서 고정. 하나라도 건너뛰면 verify 실패.
    - id: source_scan
      cmd: ["gvskb","scan","{target}","--profile","{profile}","--format","json","--output","{outdir}"]
    - id: dependency_audit
      when: "source_scan.result.dependency_manifests_excluded == true"
      cmd: ["gvskb","scan-dependencies","{target}","--format","json"]
      merge_into: "dependency_audit"
    - id: vendor_bundles     # ← B-3. 생략 금지
      when: "source_scan.result.vendor_bundles is not empty"
      cmd: ["gvskb","scan-vendor-bundles","--input","{vendor_bundles}"]
      merge_into: "dependency_audit"
    - id: render
      cmd: ["gvskb","render-report","--input","{merged}","--format","html,json,markdown,sarif"]
      note: "체커가 <target>/.check-reports/ 에 저장한다. 하네스는 복사하지 않고 경로·해시만 기록한다."

  verdict_mapping:
    exit_0_pass:              "decision == pass 이고 scanned_file_count > 0"
    exit_40_checker_block:    "decision == block 또는 severity in [critical, high] 존재"
    exit_41_checker_incomplete:
      - "scanned_file_count == 0"
      - "registry_status != ok"
      - "intel stale (max_age_days 초과)"
      - "네트워크·인텔 확인 실패"
    requires_review:
      guided: warn
      enforced: warn_and_record
      release_locked: block

  signal_rules:              # ← H-3. 기존 하네스에서 복원
    kev_checked_false: "in_kev=false 를 KEV 미매치 증거로 쓰지 않는다"
    version_exact_false: "단독 차단 사유가 될 수 없다"
    registry_status_not_ok: "레지스트리 allow 판정을 사용하지 않는다"
    absolute_blocks: [malicious, registry_rejected, not_found, "in_kev=true"]
    typosquat_existing_package: "하네스에서는 경고. 단독 차단 사유 아님"

  enforcement_mode:          # ← H-4. 성숙도와 별개의 축
    default: MONITOR
    rollout: "MONITOR 2주 → 보안팀 확인 후 WARN → 커버리지 충족 시 ENFORCE"
```

---

## 6. 조치 우선순위

| 순서 | 항목 | 근거 |
|---|---|---|
| 1 | **B-3 벤더 번들 검사 추가** | 유일하게 **실제 미탐**을 만드는 항목. "검증받았다"는 잘못된 안심이 가장 위험 |
| 2 | **B-1 체커 호출 계약 신설** | 이것 없이 구현하면 전부 다시 만든다 |
| 3 | **B-2 exit code 분리, B-4 의존성 전수 검사** | 사용자 다음 행동이 갈린다 |
| 4 | **H-1 0파일, H-2 requires_review, H-3 인텔 신호** | 판정 정확도. 조용한 오판을 막는다 |
| 5 | H-4 집행 모드, H-5 프로파일명, H-6 게이트 실행 경로 | 도입 실패(사용자 이탈) 방지 |
| 6 | M-1~M-5 | 사용성·유지보수 |

**1~3번을 해소하기 전에는 `gg verify` 구현에 착수하지 않는다.** 계약 없이 만든 검증기는 체커를 부르는 시늉만 하게 된다.

---

## 7. 남는 한계 (검증자 주석)

- 본 검토는 **설계 문서 대조**다. `gg` 실행기가 없으므로 동작 검증은 불가능하다. 구현 후 fixture 기반 재검증이 필요하다.
- `04_adversarial_design_review.md`가 스스로 밝힌 한계 4가지(로컬 관리자 권한, AI 지침 준수, 공식 보안승인 대체 불가, 인텔 조회 시 패키지 메타데이터 전송)는 타당하며 반박하지 않는다.
- 본 검토가 **놓쳤을 수 있는 영역**: 다중 도구 동시 사용(`--tools both`) 시 증적 충돌, 모노레포·다중 언어 프로젝트에서의 프로파일 선택, Windows 외 환경. 이 세 가지는 별도 검토가 필요하다.
