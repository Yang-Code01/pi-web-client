import test from "node:test";
import assert from "node:assert/strict";
import { asciiSlug, runStamp, safeFileStem } from "../lib/slug.mjs";

test("asciiSlug keeps latin words and drops CJK", () => {
  assert.equal(asciiSlug("修复 New Session 闪一下"), "new-session");
  assert.equal(asciiSlug("#616 技能 e2e"), "616-e2e");
  assert.equal(asciiSlug("A_B.C"), "a-b-c");
});

test("asciiSlug always returns a usable directory name", () => {
  assert.equal(asciiSlug("登录后列表跳动"), "run");
  assert.equal(asciiSlug("---"), "run");
  assert.equal(asciiSlug(""), "run");
  assert.equal(asciiSlug("a".repeat(100)).length, 40);
});

test("safeFileStem keeps Chinese and removes path separators", () => {
  assert.equal(safeFileStem("登录后列表跳动 / bug"), "登录后列表跳动 - bug");
  assert.equal(safeFileStem('a<b>c:d"e/f\\g|h?i*j'), "a-b-c-d-e-f-g-h-i-j");
  assert.equal(safeFileStem("  .login bug.  "), "login bug");
});

test("safeFileStem falls back and avoids Windows reserved names", () => {
  assert.equal(safeFileStem(""), "e2e");
  assert.equal(safeFileStem(" ... "), "e2e");
  assert.equal(safeFileStem("CON"), "_CON");
  assert.equal(safeFileStem("con.txt"), "_con.txt");
  assert.equal(safeFileStem("a".repeat(200)).length, 80);
});

test("runStamp is local time and sortable", () => {
  assert.equal(runStamp(new Date(2026, 10, 22, 0, 7, 5)), "20261122-000705");
  assert.equal(runStamp(new Date(2026, 0, 2, 3, 4, 5)), "20260102-030405");
});
