import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildCheckerEvidence, checkerGateEvidence } from "../lib/checker-evidence.mjs";

/**
 * 체커 증적 영수증.
 *
 * 두 가지를 동시에 지켜야 한다.
 *
 *  1. **판정 정책 불변** — 이 하네스는 배포를 승인하지 않는다. 체커가 approved
 *     라고 해도 `final_verdict` 는 review_required 다.
 *  2. **근거 보존** — 예전에는 그 한 줄만 남아, 나중에 "무엇을 근거로 검토
 *     대상이 되었나"를 영수증만으로 추적할 수 없었다.
 *
 * 둘은 충돌하지 않는다. 판정을 바꾸지 않으면서 근거를 적으면 된다.
 */

const harnessRoot = resolve(import.meta.dirname, "..");

function reportWith(gate, extra = {}) {
  return {
    schema_version: 1,
    profile: "public-default-strict",
    summary: { finding_count: 3 },
    gate,
    ...extra
  };
}

function evidenceFor(gate, extra) {
  return buildCheckerEvidence({
    checker: "system_gvskb",
    report: reportWith(gate, extra),
    scannedFileCount: 12,
    declaredDependencyCount: 4,
    reportSha256: "a".repeat(64)
  });
}

// ---------------------------------------------------------------------------
// 판정 정책은 어떤 경우에도 바뀌지 않는다
// ---------------------------------------------------------------------------

test("final_verdict stays review_required for every checker verdict", () => {
  for (const verdict of ["blocked", "conditional", "approved", "undetermined"]) {
    const evidence = evidenceFor({ verdict, reason: "r", block_reasons: [] });
    assert.equal(
      evidence.final_verdict, "review_required",
      `${verdict} 에서도 하네스는 승인하지 않는다`
    );
  }
});

test("final_verdict cannot be overridden by the caller", () => {
  // 호출자가 실수로 바꿀 수 있는 값이면 정책이 아니라 기본값일 뿐이다.
  const evidence = buildCheckerEvidence({
    checker: "system_gvskb",
    report: reportWith({ verdict: "approved" }),
    scannedFileCount: 1,
    declaredDependencyCount: 0,
    reportSha256: "b".repeat(64),
    final_verdict: "allow"
  });
  assert.equal(evidence.final_verdict, "review_required");
});

// ---------------------------------------------------------------------------
// 근거는 네 경우 모두 보존된다
// ---------------------------------------------------------------------------

test("blocked: verdict, reason and package-level block reasons are all kept", () => {
  const blockReasons = [{
    package: "pyyaml",
    version: "5.3.1",
    criteria: ["critical"],
    labels: ["CVSS CRITICAL 취약점"],
    recommended_version: "5.4"
  }];
  const evidence = evidenceFor({
    verdict: "blocked",
    reason: "배포 불가 — CVSS CRITICAL 취약점에 해당하는 패키지가 있습니다(pyyaml 5.3.1).",
    block_reasons: blockReasons
  });
  assert.equal(evidence.checker_gate_verdict, "blocked");
  assert.match(evidence.checker_gate_reason, /pyyaml/);
  assert.deepEqual(evidence.checker_block_reasons, blockReasons);
  assert.equal(evidence.final_verdict, "review_required");
});

test("conditional: reason is kept even though nothing blocks", () => {
  const evidence = evidenceFor({
    verdict: "conditional",
    reason: "차단 사유는 없습니다. 확인이 필요한 항목이 있습니다(소스 높은 위험 9건).",
    block_reasons: []
  });
  assert.equal(evidence.checker_gate_verdict, "conditional");
  assert.match(evidence.checker_gate_reason, /확인이 필요한/);
  assert.deepEqual(evidence.checker_block_reasons, []);
});

test("approved: recorded as approved by the checker, still review_required here", () => {
  const evidence = evidenceFor({ verdict: "approved", reason: "조치할 항목이 없습니다.", block_reasons: [] });
  assert.equal(evidence.checker_gate_verdict, "approved");
  assert.equal(evidence.final_verdict, "review_required");
});

test("unknown: a checker without gate records null, never approved", () => {
  // 구버전 체커. '없음'과 'approved' 는 다르다 — 없는 것을 통과로 바꿔 말하지 않는다.
  const evidence = buildCheckerEvidence({
    checker: "system_gvskb",
    report: { profile: "public-default-strict", summary: { finding_count: 0 } },
    scannedFileCount: 5,
    declaredDependencyCount: 0,
    reportSha256: "c".repeat(64)
  });
  assert.equal(evidence.checker_gate_verdict, null);
  assert.notEqual(evidence.checker_gate_verdict, "approved");
  assert.equal(evidence.checker_gate_reason, "");
  assert.deepEqual(evidence.checker_block_reasons, []);
  assert.equal(evidence.checker_schema_version, null);
  assert.equal(evidence.final_verdict, "review_required");
});

test("malformed gate fields degrade to the unknown shape instead of leaking", () => {
  const evidence = evidenceFor({ verdict: 42, reason: { nope: true }, block_reasons: "not-a-list" });
  assert.equal(evidence.checker_gate_verdict, null);
  assert.equal(evidence.checker_gate_reason, "");
  assert.deepEqual(evidence.checker_block_reasons, []);
});

test("checkerGateEvidence tolerates a missing report entirely", () => {
  assert.deepEqual(checkerGateEvidence(null), {
    checker_schema_version: null,
    checker_version: null,
    checker_gate_verdict: null,
    checker_gate_reason: "",
    checker_block_reasons: [],
    checker_conditional_criteria: [],
    checker_intel_gap: null,
    checker_dependency_check: null
  });
});

// ---------------------------------------------------------------------------
// 기존 필드는 그대로 남는다 (회귀)
// ---------------------------------------------------------------------------

test("existing receipt fields are unchanged", () => {
  const evidence = evidenceFor({ verdict: "conditional", reason: "r", block_reasons: [] }, { profile_fallback: null });
  assert.equal(evidence.kind, "checker_evidence");
  assert.equal(evidence.checker, "system_gvskb");
  assert.equal(evidence.profile, "public-default-strict");
  assert.equal(evidence.scanned_file_count, 12);
  assert.equal(evidence.finding_count, 3);
  assert.equal(evidence.declared_dependency_count, 4);
  assert.equal(evidence.profile_fallback, false);
  assert.equal(evidence.report_sha256, "a".repeat(64));
});

// ---------------------------------------------------------------------------
// 배포 정합 — 새 lib 모듈이 프로젝트로 복사되어야 한다
// ---------------------------------------------------------------------------

test("gg init copies the evidence module and records its hash", async () => {
  const source = await readFile(join(harnessRoot, "bin", "gg.mjs"), "utf8");
  assert.match(source, /cp\(CHECKER_EVIDENCE_PATH/, "init 이 모듈을 프로젝트로 복사해야 한다");
  assert.match(source, /checker_evidence_sha256: await sha256/, "lock 에 지문을 남겨야 한다");
  assert.match(source, /lock\.checker_evidence_sha256/, "verify 가 변조를 잡아야 한다");
});

test("the help text no longer claims the checker has no verdict field", () => {
  // 체커에 gate.verdict 가 생긴 뒤에도 도움말이 "판정 필드가 없다"고 말하고 있었다.
  return readFile(join(harnessRoot, "bin", "gg.mjs"), "utf8").then((source) => {
    assert.doesNotMatch(source, /공식 최종 판정 필드가 없으므로/);
    assert.match(source, /체커의 배포 판정\(gate\)은 영수증에 근거와 함께/);
  });
});
