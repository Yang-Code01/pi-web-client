/**
 * #663 「提交给好友」的体积护栏：三条上限的边界值、优先顺序，以及它们与服务端的同源。
 *
 * 这个函数是纯的（不碰 DOM、不碰 tr），所以边界值在这儿全测完，浏览器测试只断言「超限时
 * 按钮置灰、hint 带数值」这一条视觉结果。
 *
 *   node --experimental-strip-types --test web/tests/peer-guard-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_NOTE_BODY,
  MAX_NOTE_SHOTS,
  MAX_NOTE_TITLE,
} from "../../peer/src/note.ts";
import { NOTE_BODY_MAX, NOTE_SHOTS_MAX, NOTE_TITLE_MAX, notePeerGuard } from "../src/notes/peer-guard.ts";

test("上限与服务端同源", () => {
  assert.equal(NOTE_TITLE_MAX, MAX_NOTE_TITLE, "标题上限跟 peer/src/note.ts 对上了吗");
  assert.equal(NOTE_BODY_MAX, MAX_NOTE_BODY, "正文上限跟 peer/src/note.ts 对上了吗");
  assert.equal(NOTE_SHOTS_MAX, MAX_NOTE_SHOTS, "截图上限跟 peer/src/note.ts 对上了吗");
});

test("正常的记录能提交", () => {
  assert.equal(notePeerGuard("标题", "<p>正文</p>", 3), null);
  assert.equal(notePeerGuard("", "", 0), null, "空的也返回 null：空白由记录面板自己拦");
});

test("正文按 UTF-8 字节卡 200 KB 这道线", () => {
  assert.equal(notePeerGuard("t", "a".repeat(200_000), 0), null, "整 200_000 字节还能发");
  assert.deepEqual(notePeerGuard("t", "a".repeat(200_001), 0), { blocked: "body", actual: 200_001, limit: 200_000 });
  // 中文一个字 3 字节：按字节算，不按字数算。
  assert.equal(notePeerGuard("t", "汉".repeat(66_666), 0), null, "199_998 字节");
  assert.equal(notePeerGuard("t", "汉".repeat(66_667), 0)?.blocked, "body", "200_001 字节");
});

test("标题按字卡 200 这道线，先 trim", () => {
  assert.equal(notePeerGuard("标".repeat(200), "", 0), null);
  assert.deepEqual(notePeerGuard("标".repeat(201), "", 0), { blocked: "title", actual: 201, limit: 200 });
  assert.equal(notePeerGuard(`  ${"标".repeat(200)}  `, "", 0), null, "两端空白不算，跟服务端 trim 后一致");
});

test("截图张数卡 24 这道线", () => {
  assert.equal(notePeerGuard("t", "b", 24), null);
  assert.deepEqual(notePeerGuard("t", "b", 25), { blocked: "shots", actual: 25, limit: 24 });
});

test("同时超：先报正文，再报标题，最后才是截图", () => {
  const long = "a".repeat(200_001);
  assert.equal(notePeerGuard("标".repeat(300), long, 30)?.blocked, "body");
  assert.equal(notePeerGuard("标".repeat(300), "b", 30)?.blocked, "title");
});
