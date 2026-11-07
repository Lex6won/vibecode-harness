#!/usr/bin/env node
// 공개 저장소 위생 검사 — 소스만 두고, 실명·실제 주소·점검 대상 이름과 개발 문서가 들어오지 못하게 막는다.
// 금지 목록은 원문을 두지 않으려고 해시로 적는다. 항목을 더하려면 sha256("vibecode-hygiene-v1:" + 낱말) 앞 24자를 넣는다.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SALT = "vibecode-hygiene-v1:";
const FORBIDDEN = new Set([
  "0bea9e6529bac9f7d21ecf95",
  "25561d83804c2e36797c262b",
  "2601a700a6b72ba7865d2b90",
  "2b615542acb93ac4e5c4ed7c",
  "2b659dd5b950aab8bdb90f63",
  "31e958cf38ef8c9371fe04f7",
  "3819240b91adcb20c5083a69",
  "38d9cb2c5d90f05e3ef22fb9",
  "3b4327a35a2c2ad75a878ce2",
  "3b497de8acb74758d3803593",
  "48c0c8ab43ca8a250deb7402",
  "50c2f89c986ab5ffc5d6fbc5",
  "63da71b22b4997d84e800b49",
  "72e92339e83567b3974d0822",
  "7b38c40add72ace2fd97fae2",
  "91935143e0dca0f37b83e718",
  "91d78401e130891046935d26",
  "93039b7e3935f3eef04025e2",
  "95fa1c6cd78aa15f0fda15e7",
  "96a0cad9c0ca5982d14e683d",
  "a48ab7c76c1dc89b6255a451",
  "c9230fb81455c118dbb9015b",
  "ea41b8dd30a710b7f1a9f3f7",
  "ee0a4d25fbac4de945d2ca00",
]);
const HANGUL_LENGTHS = [3, 5];
const ALLOWED_DOCS = /^(README\.md|AGENTS\.md|LICENSE(\.md)?|SECURITY\.md)$/;
const SOURCE_DOC_DIRS = /^(shared|adapters|templates|installer|fixtures|tests|scripts)\//;
const REAL_MAIL = /[A-Za-z0-9._%+-]+@(gmail\.com|naver\.com|daum\.net|hanmail\.net|kakao\.com)\b/;
// 개발 PC 의 실제 계정 폴더 — 낱말 자체는 흔해서 경로 형태일 때만 본다.
const REAL_HOME_PATH = /[A-Za-z]:[\\/]+Users[\\/]+first\b/i;

const forbidden = (term) => FORBIDDEN.has(createHash("sha256").update(SALT + term, "utf8").digest("hex").slice(0, 24));

// 금지 목록과 대조할 후보: 낱말(대소문자 무시), 한글·영문이 붙은 낱말, 점으로 이은 호스트와 그 상위 주소, 한글 조각.
export function candidateTerms(text) {
  const terms = new Set();
  for (const token of text.match(/[A-Za-z0-9_]+/g) || []) {
    terms.add(token);
    terms.add(token.toLowerCase());
  }
  for (const mixed of text.match(/[가-힣]+[A-Za-z0-9_]+/g) || []) terms.add(mixed);
  for (const host of text.match(/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){2,}/g) || []) {
    const labels = host.toLowerCase().split(".");
    for (let index = 0; index + 3 <= labels.length; index += 1) terms.add(labels.slice(index).join("."));
  }
  for (const run of text.match(/[가-힣]+/g) || []) {
    for (const size of HANGUL_LENGTHS) {
      for (let index = 0; index + size <= run.length; index += 1) terms.add(run.slice(index, index + size));
    }
  }
  return terms;
}

export function hitsForbidden(text) {
  for (const term of candidateTerms(text)) if (forbidden(term)) return true;
  return REAL_HOME_PATH.test(text);
}

const git = (...args) => execFileSync("git", ["-c", "core.quotepath=false", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

export function findProblems() {
  const problems = [];
  for (const rel of git("ls-files").split(/\r?\n/).filter(Boolean)) {
    if (rel.startsWith("docs/")) problems.push(`개발 문서: ${rel}`);
    if (!rel.includes("/") && rel.endsWith(".md") && !ALLOWED_DOCS.test(rel)) problems.push(`개발 문서: ${rel}`);
    if (rel.endsWith(".md") && rel.includes("/") && !SOURCE_DOC_DIRS.test(rel)) problems.push(`개발 문서: ${rel}`);
    if (hitsForbidden(rel)) problems.push(`금지 낱말(파일 이름): ${rel}`);
    if (!existsSync(rel) || statSync(rel).size > 2 * 1024 * 1024) continue;
    const bytes = readFileSync(rel);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (hitsForbidden(text)) problems.push(`금지 낱말: ${rel}`);
    if (REAL_MAIL.test(text)) problems.push(`개인 메일 주소: ${rel}`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const problems = findProblems();
  if (problems.length) {
    console.error(`저장소 위생 검사 실패 — 공개 저장소에 올릴 수 없습니다:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "passed", test: "repo-hygiene" }));
}
