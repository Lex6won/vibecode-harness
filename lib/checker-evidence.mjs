/**
 * 체커 증적 영수증 구성 — 판정은 바꾸지 않고 **근거만** 보존한다.
 *
 * 이 하네스는 배포를 승인하지 않는다. `final_verdict` 는 언제나
 * `review_required` 이고 그 정책은 바뀌지 않는다(기관 프로파일:
 * "feedback and recorded review; never called an approval").
 *
 * 문제는 예전 영수증이 그 한 줄만 남겼다는 것이다. 체커는 `gate` 에 배포 판정과
 * 사유·차단 근거를 싣는데 하네스가 그것을 버렸고, 그래서 나중에 "무엇을 근거로
 * 검토 대상이 되었나"를 영수증만으로 추적할 수 없었다. 결재 증적으로 쓰는
 * 문서에서 근거가 빠지는 것은 값을 틀리게 적는 것 다음으로 나쁘다.
 *
 * 그래서 **판정은 그대로 두고 근거를 함께 적는다.**
 *
 * 47차(2026-11-03) — 체커 0.6 계약 정렬. 예전에는 `checker_status` 를 종료코드
 * 하나로 정했다(0 이 아니면 전부 blocked). 그래서 체커가 "위협정보가 없어 패키지를
 * 보지 못했다"(종료코드 3, verdict undetermined)고 말해도 영수증은 '차단'이라고
 * 적었다 — 검사하지 못한 것과 막힌 것은 다른 사실이고, 둘을 같은 말로 적으면
 * 담당자는 엉뚱한 곳을 고친다. 이제 판정은 **`gate.verdict` 에서 읽고** 종료코드는
 * 교차 확인에만 쓴다. 표는 체커가 `gvskb status --json` 의 `gate_contract` 로 내보내는
 * 것과 같아야 하며, 체커 저장소 테스트가 이 파일의 표를 그 값과 대조한다.
 */

/** 체커 최소 버전 — 이 아래에서는 패키지 검사가 옵션(`--check-deps`)이라 기본 호출이 조용히 빈다. */
export const MIN_CHECKER_VERSION = "0.6.0";

/**
 * 체커 `gate.verdict` → 하네스 `checker_status`.
 * 승인·조건부는 모두 '사람 검토'다(하네스는 승인하지 않는다). 차단은 차단, 판정 불가는 판정 불가.
 */
export const CHECKER_STATUS_BY_VERDICT = Object.freeze({ approved: "review_required", conditional: "review_required", blocked: "blocked", undetermined: "undetermined" });

/** 체커 `gvskb scan` 종료코드(`--fail-on warn` 기본) → verdict. `--fail-on block` 이면 conditional 도 0 으로 온다. */
export const EXIT_CODE_TO_VERDICT = Object.freeze({ 0: "approved", 1: "conditional", 2: "blocked", 3: "undetermined" });

/** 상태의 '나쁨' 순서 — 종료코드와 verdict 가 어긋나면 더 나쁜 쪽을 쓴다. */
const STATUS_SEVERITY = Object.freeze({ blocked: 3, undetermined: 2, review_required: 1 });

/**
 * 체커 버전 → [major, minor, patch] (+ `prerelease` 속성). 못 읽으면 null.
 *
 * `vibecode-checker (gvskb) 0.6.1` 형식을 먼저, 아니면 **문자열 처음부터** `x.y.z` 여야 한다(M4) —
 * 예전 느슨한 정규식은 `"Python 3.11.9 / gvskb 0.5.3"` 에서 3.11.9 를 집어 0.5 체커를 통과시켰다.
 * `0.6.0rc1`·`0.6.0.dev1` 은 0.6.0 **미만**으로 본다.
 */
export function parseCheckerVersion(text) {
  const source = String(text || "").trim();
  const match = source.match(/^vibecode-checker \(gvskb\) (\d+)\.(\d+)\.(\d+)(\S*)/) || source.match(/^(\d+)\.(\d+)\.(\d+)(\S*)$/);
  if (!match) return null;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])];
  parsed.prerelease = Boolean(match[4]);
  return parsed;
}

/** `version` 이 `MIN_CHECKER_VERSION` 이상인가. 버전을 못 읽으면 false — 모르는 것은 통과가 아니다. */
export function checkerVersionSatisfies(version, minimum = MIN_CHECKER_VERSION) {
  const actual = parseCheckerVersion(version);
  const required = parseCheckerVersion(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > required[index]) return true;
    if (actual[index] < required[index]) return false;
  }
  return !actual.prerelease;
}

/** 종료코드만으로 정한 상태(구버전 체커 — gate 가 없을 때). 모르는 코드는 null. */
export function checkerStatusFromExitCode(exitCode) {
  if (!Number.isInteger(exitCode)) return null;
  const verdict = EXIT_CODE_TO_VERDICT[exitCode];
  return verdict ? CHECKER_STATUS_BY_VERDICT[verdict] : null;
}

/**
 * verdict 와 종료코드를 함께 보고 상태를 정한다.
 *
 * 반환 `{ status, conflict }`. `conflict` 는 둘이 서로 모순일 때만 `{ exit_code, verdict }`.
 * 모르는 verdict 값은 `undetermined` 로 다룬다 — 체커가 새 판정을 만들었는데 하네스가
 * 그것을 통과로 읽는 일은 없어야 한다.
 */
export function resolveCheckerStatus({ verdict, exitCode }) {
  const knownVerdict = typeof verdict === "string" && Object.hasOwn(CHECKER_STATUS_BY_VERDICT, verdict);
  const fromVerdict = typeof verdict === "string" ? (knownVerdict ? CHECKER_STATUS_BY_VERDICT[verdict] : "undetermined") : null;
  const fromExit = checkerStatusFromExitCode(exitCode);
  if (!fromVerdict) return { status: fromExit, conflict: null };
  // `--fail-on block` 아래에서는 conditional 이 0 으로 오고, `--fail-on warn` 아래에서는 1 로 온다 —
  // 둘 다 review_required 라 모순이 아니다. 모순은 **상태가 다를 때**다.
  if (fromExit && fromExit !== fromVerdict) {
    const worse = STATUS_SEVERITY[fromExit] > STATUS_SEVERITY[fromVerdict] ? fromExit : fromVerdict;
    return { status: worse, conflict: { exit_code: exitCode, verdict } };
  }
  return { status: fromVerdict, conflict: null };
}

/** `report.dependency_check`(체커 0.6) 에서 영수증에 남길 것만 추린다. 없으면 null. */
export function dependencyCheckEvidence(report) {
  const check = report && typeof report === "object" ? report.dependency_check : null;
  if (!check || typeof check !== "object") return null;
  const intel = check.intel && typeof check.intel === "object" ? check.intel : {};
  const refresh = check.auto_refresh && typeof check.auto_refresh === "object" ? check.auto_refresh : null;
  return {
    mode: typeof check.mode === "string" ? check.mode : null,
    requested_mode: typeof check.requested_mode === "string" ? check.requested_mode : null,
    packages_parsed: Number.isInteger(check.packages_parsed) ? check.packages_parsed : null,
    intel_state: typeof intel.state === "string" ? intel.state : null,
    intel_as_of: typeof intel.as_of === "string" ? intel.as_of : null,
    intel_age_days: Number.isInteger(intel.age_days) ? intel.age_days : null,
    // 시도하지 않은 갱신(망분리·하루 1회 제한)은 '실패'가 아니다 — null 로 둔다.
    auto_refresh_ok: refresh ? (refresh.attempted === false ? null : Boolean(refresh.ok)) : null
  };
}

/** 체커 결과에서 근거 필드를 뽑는다. 없는 값은 지어내지 않는다. */
export function checkerGateEvidence(report) {
  const gate = report && typeof report === "object" ? report.gate : null;
  return {
    // 계약 세대 — 나중에 "어떤 형식의 결과를 읽었나"를 되짚을 수 있게 한다.
    checker_schema_version: Number.isInteger(report?.schema_version) ? report.schema_version : null,
    checker_version: typeof report?.engine_version === "string" ? report.engine_version : null,
    // blocked | conditional | approved | undetermined | null(구버전 체커)
    //
    // null 과 "approved" 는 다르다. 필드가 없던 시절의 결과를 '승인'으로 읽으면
    // 조용히 느슨해진다 — 없는 것은 없는 것으로 적는다.
    checker_gate_verdict: typeof gate?.verdict === "string" ? gate.verdict : null,
    checker_gate_reason: typeof gate?.reason === "string" ? gate.reason : "",
    checker_block_reasons: Array.isArray(gate?.block_reasons) ? gate.block_reasons : [],
    checker_conditional_criteria: Array.isArray(gate?.conditional_criteria) ? gate.conditional_criteria : [],
    // "" | "stale" | "missing" | null(구버전) — 판정 불가가 왜 났는지를 키로 남긴다.
    checker_intel_gap: typeof gate?.intel_gap === "string" ? gate.intel_gap : null,
    checker_dependency_check: dependencyCheckEvidence(report)
  };
}

/**
 * 영수증 본문을 만든다.
 *
 * `final_verdict` 는 인자로 받지 않는다 — 호출자가 실수로 바꿀 수 있는 값이면
 * 정책이 아니라 기본값일 뿐이다. 여기서 상수로 고정한다.
 */
export function buildCheckerEvidence({ checker, report, scannedFileCount, declaredDependencyCount, reportSha256, exitCode }) {
  const knownExit = Number.isInteger(exitCode);
  const gateEvidence = checkerGateEvidence(report);
  const resolved = resolveCheckerStatus({ verdict: gateEvidence.checker_gate_verdict, exitCode: knownExit ? exitCode : null });
  return {
    kind: "checker_evidence",
    checker,
    profile: report?.profile,
    scanned_file_count: scannedFileCount,
    finding_count: report?.summary?.finding_count ?? null,
    declared_dependency_count: declaredDependencyCount,
    profile_fallback: Boolean(report?.profile_fallback),
    report_sha256: reportSha256,
    checker_exit_code: knownExit ? exitCode : null,
    // 체커가 무엇을 돌려줬는지 — gate.verdict 가 1차, 종료코드는 교차 확인.
    checker_status: resolved.status,
    checker_status_conflict: resolved.conflict,
    ...gateEvidence,
    // 불변 — 이 하네스는 승인하지 않는다.
    // 위의 checker_status 는 체커가 무엇을 돌려줬는지이고, 이것은 하네스의 판정이다.
    final_verdict: "review_required"
  };
}
