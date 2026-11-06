import assert from "node:assert/strict";
import test from "node:test";
import { findProblems, hitsForbidden } from "../scripts/repo-hygiene.mjs";

test("공개 저장소에 개발 문서·실명·점검 대상 이름이 없다", () => {
  assert.deepEqual(findProblems(), []);
});

test("위생 검사가 금지 낱말을 실제로 잡는다", () => {
  assert.equal(hitsForbidden(`담당: ${["gg", "00", "18"].join("")}@x`), true);
  assert.equal(hitsForbidden("정상 문장 hello_world 123"), false);
});
