import assert from "node:assert/strict";
import test from "node:test";
import { candidateTerms, findProblems, hitsForbidden } from "../scripts/repo-hygiene.mjs";

test("공개 저장소에 개발 문서·실명·점검 대상 이름이 없다", () => {
  assert.deepEqual(findProblems(), []);
});

test("위생 검사가 금지 낱말을 실제로 잡는다", () => {
  assert.equal(hitsForbidden(`담당: ${["gg", "00", "18"].join("")}@x`), true);
  assert.equal(hitsForbidden("정상 문장 hello_world 123"), false);
});

test("위생 검사 후보에 대소문자·혼합 낱말·호스트 상위 주소가 들어간다", () => {
  const terms = candidateTerms("Abc 가나ABC host.sub.example.go.kr");
  for (const term of ["abc", "가나ABC", "host.sub.example.go.kr", "sub.example.go.kr", "example.go.kr"]) assert.equal(terms.has(term), true, term);
  assert.equal(terms.has("go.kr"), false);
  assert.equal(hitsForbidden(["C:", "Users", "first", "x"].join("\\")), true);
  assert.equal(hitsForbidden(["C:", "Users", "User", "x"].join("\\")), false);
});
