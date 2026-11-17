/**
 * #487：交接时预填的会话名 —— 票号取最后一段，分支 ref 原样。
 *
 * 只测这两条规则本身；「它真的进了新会话面板、建出来的会话在左栏叫什么」
 * 由浏览器探针 `probes/jira-handoff-name.mjs` 断言，这里不启浏览器。
 *
 * Run: node web/tests/session-name-unit.mjs
 * （纯函数在 `web/src/session-name.ts`，不 import 任何 DOM。）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sessionNameFromBranchRef, sessionNameFromIssueKey } from "../src/session-name.ts";

test("票号：只留最后一个连字符之后的原文", () => {
  const cases = [
    ["CASPH30INC-17967", "17967"],
    ["ABC_DEF-12", "12"],
    ["PROJ-1", "1"],
    ["PROJ-hotfix", "hotfix"],
    ["E2E", "E2E"],
    ["PROJ--5", "5"],
  ];
  for (const [key, want] of cases) assert.equal(sessionNameFromIssueKey(key), want, key);
});

test("票号：前后空白不进名字", () => {
  assert.equal(sessionNameFromIssueKey("  PROJ-1234  "), "1234");
  assert.equal(sessionNameFromIssueKey(" PROJ-1234"), "1234");
});

test("票号：取完是空的就返回空串（调用方按「不填」处理）", () => {
  assert.equal(sessionNameFromIssueKey("PROJ-"), "");
  assert.equal(sessionNameFromIssueKey("PROJ-   "), "");
  assert.equal(sessionNameFromIssueKey(""), "");
  assert.equal(sessionNameFromIssueKey("   "), "");
});

test("分支 ref：整条原样，斜杠与 ~ 都留着", () => {
  const cases = ["feat/skill-inject-viz", "origin/main", "main", "a1b2c3d", "HEAD~2", "fix/e2e-speed"];
  for (const ref of cases) assert.equal(sessionNameFromBranchRef(ref), ref);
});

test("分支 ref：只去前后空白，空串还是空串", () => {
  assert.equal(sessionNameFromBranchRef("  feat/x  "), "feat/x");
  assert.equal(sessionNameFromBranchRef(""), "");
  assert.equal(sessionNameFromBranchRef("   "), "");
});
