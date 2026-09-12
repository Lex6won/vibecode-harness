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
 */

/** 체커 결과에서 근거 필드를 뽑는다. 없는 값은 지어내지 않는다. */
export function checkerGateEvidence(report) {
  const gate = report && typeof report === "object" ? report.gate : null;
  return {
    // 계약 세대 — 나중에 "어떤 형식의 결과를 읽었나"를 되짚을 수 있게 한다.
    checker_schema_version: Number.isInteger(report?.schema_version) ? report.schema_version : null,
    // blocked | conditional | approved | undetermined | null(구버전 체커)
    //
    // null 과 "approved" 는 다르다. 필드가 없던 시절의 결과를 '승인'으로 읽으면
    // 조용히 느슨해진다 — 없는 것은 없는 것으로 적는다.
    checker_gate_verdict: typeof gate?.verdict === "string" ? gate.verdict : null,
    checker_gate_reason: typeof gate?.reason === "string" ? gate.reason : "",
    checker_block_reasons: Array.isArray(gate?.block_reasons) ? gate.block_reasons : []
  };
}

/**
 * 영수증 본문을 만든다.
 *
 * `final_verdict` 는 인자로 받지 않는다 — 호출자가 실수로 바꿀 수 있는 값이면
 * 정책이 아니라 기본값일 뿐이다. 여기서 상수로 고정한다.
 */
export function buildCheckerEvidence({ checker, report, scannedFileCount, declaredDependencyCount, reportSha256, exitCode }) {
  // 차단 여부는 체커의 종료 코드에서 **유도한다** — 호출자가 따로 말해주는 값이면
  // 영수증과 실제 실행 결과가 갈라질 수 있다. 종료 코드를 모르면 모른다고 적는다.
  const knownExit = Number.isInteger(exitCode);
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
    checker_status: knownExit ? (exitCode === 0 ? "review_required" : "blocked") : null,
    ...checkerGateEvidence(report),
    // 불변 — 이 하네스는 승인하지 않는다.
    // 위의 checker_status 는 체커가 무엇을 돌려줬는지이고, 이것은 하네스의 판정이다.
    final_verdict: "review_required"
  };
}
