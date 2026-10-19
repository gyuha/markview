import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { bodyNotes, changeList, plainNotes, previousTag } from "./release-notes.mjs";

test("previousTag: 바로 앞 릴리스를 고르고 같은 버전·더 높은 버전·태그 아닌 것은 건너뛴다", () => {
  const tags = ["v0.2.2", "v0.2.3", "v0.10.0", "v0.3.0", "nightly", "v0.3.0-rc1"];
  // v0.10.0은 0.4.0보다 높아서 "앞 릴리스"가 아니다.
  assert.equal(previousTag(tags, "0.4.0"), "v0.3.0");
  assert.equal(previousTag(["v0.2.2", "v0.2.3", "v0.3.0"], "0.3.0"), "v0.2.3");
  assert.equal(previousTag(["v0.2.2", "v0.3.0"], "0.1.0"), null);
  assert.equal(previousTag([], "0.1.0"), null);
});

test("previousTag: 0.10이 0.9보다 뒤다(문자열이 아니라 숫자로 비교)", () => {
  assert.equal(previousTag(["v0.9.0", "v0.10.0"], "0.11.0"), "v0.10.0");
});

test("changeList: Release 커밋과 빈 제목은 뺀다", () => {
  assert.deepEqual(changeList(["Release v0.3.0", "탭 끌기 추가", "  ", "Release 0.2.3", "버그 수정 (#6)"]), ["탭 끌기 추가", "버그 수정 (#6)"]);
});

test("plainNotes: 목록을 만들고 비어 있으면 던진다", () => {
  assert.equal(plainNotes(["가", "Release v1.0.0", "나"]), "- 가\n- 나");
  assert.throws(() => plainNotes(["Release v1.0.0"]), /변경 사항/);
  assert.throws(() => plainNotes([]), /변경 사항/);
});

test("bodyNotes: 변경 사항·비교 링크·업데이트 안내", () => {
  const body = bodyNotes(["가"], { version: "0.4.0", repo: "gyuha/markview", prev: "v0.3.0" });
  assert.match(body, /## 변경 사항\n\n- 가/);
  assert.match(body, /https:\/\/github\.com\/gyuha\/markview\/compare\/v0\.3\.0\.\.\.v0\.4\.0/);
  assert.match(body, /업데이트/);
  // 첫 릴리스(이전 태그 없음)에는 비교 링크가 없다.
  assert.doesNotMatch(bodyNotes(["가"], { version: "0.1.0", repo: "gyuha/markview", prev: null }), /compare/);
});

test("CLI: 인수가 없으면 종료 코드 1", () => {
  const r = spawnSync("node", ["scripts/release-notes.mjs"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /사용/);
});
