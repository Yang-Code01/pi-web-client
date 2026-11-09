/**
 * #219：`session` 帧只带末尾一页历史。页该怎么切是可单测的纯逻辑，这里按 ticket 的验收逐条钉住：
 * 默认页、页首落在用户消息、工具调用再密也能把开头那条用户消息带回、逐页拼到底不重不漏、
 * 空历史 / 不足一页 / `limit` 超界都有确定结果。
 *
 *   node --experimental-strip-types bridge/tests/history-page-unit.mjs
 */
import assert from "node:assert/strict";
import { HISTORY_PAGE_SIZE, itemsFrame, pageBefore, tailPage } from "../src/history.ts";

const user = (id) => ({ id, kind: "user", text: id, images: [] });
const assistant = (id) => ({ id, kind: "assistant", text: id });
const tool = (id) => ({ id, kind: "tool", toolCallId: id, name: "read", args: "{}", result: "" });
const ids = (page) => page.items.map((it) => it.id);
// #242 给 `history` 多带了一份 `turns`；老断言只关心分页字段，折掉它再比。
const withoutTurns = ({ turns, ...rest }) => rest;

// ---------------------------------------------------------------- 空 / 不足一页

assert.deepEqual(withoutTurns(tailPage([])), { items: [], hasMore: false, total: 0 }, "空历史的末尾一页就是空的");
assert.equal(tailPage([]).hasMore, false);

const short = [user("u1"), assistant("a1"), tool("t1")];
assert.deepEqual(ids(tailPage(short)), ["u1", "a1", "t1"], "不足一页：全都给，不回空页");
assert.equal(tailPage(short).hasMore, false, "前面没有条目了，就别让界面画「载入更早」");
assert.equal(tailPage(short).total, 3);

// ---------------------------------------------------------------- 默认页

// 200 条里一条用户消息都没有（例如一整段工具调用）：只能按条数切。
const noUser = Array.from({ length: 200 }, (_, i) => (i % 5 === 0 ? tool(`t${i}`) : assistant(`a${i}`)));
const plain = tailPage(noUser);
assert.equal(plain.items.length, 60, `默认一页 ${HISTORY_PAGE_SIZE} 条`);
assert.equal(plain.hasMore, true, "前面还有 140 条");
assert.equal(plain.total, 200, "total 是整段条数，不是这一页的条数");
assert.equal(plain.items[0].id, "t140");
assert.equal(plain.items.at(-1).id, "a199", "末尾一页收在最新一条上");

// ---------------------------------------------------------------- 页首落在用户消息上

// 用户消息在窗口里：从窗口内**最早**那条用户消息开始，让一页读起来是完整的几轮。
const withUser = Array.from({ length: 200 }, (_, i) => (i % 10 === 5 ? user(`u${i}`) : assistant(`a${i}`)));
const paged = tailPage(withUser);
assert.equal(paged.items[0].id, "u145", "窗口是 [140,200)，里面最早的用户消息在 145");
assert.equal(paged.items.length, 55, "从用户消息切，所以不满 60");
assert.equal(paged.hasMore, true);
assert.equal(paged.total, 200);

// 工具调用特别密的一段：窗口里没有用户消息，就把前面最近的那条用户消息一起带回，
// 否则这一页会从半句工具输出开始（#218 里实测最重的一页 628 KB，允许超过 60 条）。
const heavy = [user("u0"), ...Array.from({ length: 89 }, (_, i) => tool(`t${i + 1}`)), assistant("a90")];
const rolled = tailPage(heavy);
assert.equal(rolled.items[0].id, "u0", "窗口里没用户消息：往前找最近的那条，页首仍然是用户消息");
assert.equal(rolled.items.length, 91, "多带回来的那些条目属于同一轮，不截断");
assert.equal(rolled.hasMore, false, "那条用户消息就是第一条了");

// 往前找的时候不该越过更早的用户消息：只有最近的那一条被带回。
const twoRounds = [user("u0"), ...Array.from({ length: 70 }, (_, i) => tool(`t${i}`)), user("u71"), ...Array.from({ length: 70 }, (_, i) => tool(`x${i}`))];
assert.equal(tailPage(twoRounds).items[0].id, "u71", "带回的是最近一条用户消息，不是最早那条");

// ---------------------------------------------------------------- limit

const all = tailPage(withUser, 500);
assert.deepEqual(ids(all), ids(tailPage(withUser, HISTORY_PAGE_SIZE)), "limit 超过一页：一页就是上限，不能再变长");
assert.equal(tailPage(withUser, 10).items[0].id, "u195", "limit 小的时候按 limit 切，仍优先落在用户消息上");
assert.equal(tailPage(withUser, 0).items[0].id, "u195", "limit 至少 1 条；这一条不是用户消息就照规矩退回最近的那条，别回空页把界面清屏");

// ---------------------------------------------------------------- 逐页拼到底

// 500 条、37 一轮：从末尾一页开始一页页往前取，拼起来必须与原文逐条相同（不重不漏、顺序不翻）。
const transcript = Array.from({ length: 500 }, (_, i) => {
  if (i % 37 === 0) return user(`u${i}`);
  return i % 5 === 0 ? tool(`t${i}`) : assistant(`a${i}`);
});
const pages = [tailPage(transcript)];
while (pages.at(-1).hasMore) {
  const before = pages.at(-1).items[0].id;
  pages.push(pageBefore(transcript, before));
}
const rebuilt = pages.reverse().flatMap((p) => p.items);
assert.deepEqual(ids({ items: rebuilt }), ids({ items: transcript }), "逐页拼到底 = 原文本身");
assert.equal(pages.filter((p) => p.hasMore).length, pages.length - 1, "只有第一页说「没有更早的」");

// ---------------------------------------------------------------- 游标找不到

// 会话被截断 / 换了另一条：游标对不上就回空页 + hasMore:false，不抛错（#220 的响应契约）。
assert.deepEqual(pageBefore(transcript, "不存在"), { items: [], hasMore: false });
assert.deepEqual(pageBefore([], "x"), { items: [], hasMore: false });
assert.deepEqual(pageBefore(transcript, transcript[0].id), { items: [], hasMore: false }, "游标是第一页第一条：没有更早的了");

// limit 同样夹在 [1, 一页]（没有用户消息的那段，页长就等于 limit）。
assert.equal(pageBefore(noUser, "a159", 999).items.length, HISTORY_PAGE_SIZE, "limit 超界按一页算");
assert.deepEqual(ids(pageBefore(noUser, "a159", 5)), ["a154", "t155", "a156", "a157", "a158"], "limit 小的时候就是那么几条（收在游标前面）");

// ---------------------------------------------------------------- 随手问整段下发

// 随手问没有「载入更早」的入口（#218 Out of Scope）：超过一页也必须整段下发，
// 否则累积到 61 条之后，前面的话会在唤醒/重连的整页替换里悄悄消失。
const long = Array.from({ length: 130 }, (_, i) => (i % 2 ? assistant(`a${i}`) : user(`u${i}`)));
const scratchFrame = itemsFrame(long, { full: true });
assert.equal(scratchFrame.items.length, 130, "随手问：130 条一次给全，不切页");
assert.equal(scratchFrame.items[0].id, "u0", "从第一条开始，前面没有被丢掉");
assert.deepEqual(withoutTurns(scratchFrame.history), { hasMore: false, total: 130 }, "没有更早的：界面上不会出现「载入更早」");
assert.deepEqual(itemsFrame(long).items, tailPage(long).items, "普通会话默认仍是末尾一页（行为不变）");
assert.deepEqual(withoutTurns(itemsFrame(long).history), { hasMore: true, total: 130 }, "普通会话的 history 照旧");

// ---------------------------------------------------------------- 整段轮次索引（#242）

// 120 轮：首帧正文仍只带末尾一页，但 `history.turns` 要说清整段有多少轮、分别是谁。
const longSession = [];
for (let i = 0; i < 120; i++) {
  longSession.push(user(`u${i}`));
  longSession.push(assistant(`a${i}`));
}
const firstFrame = itemsFrame(longSession);
assert.equal(firstFrame.history.hasMore, true, "120 轮的会话首帧只有末尾一页（这张票不改分页）");
assert.equal(firstFrame.history.turns.length, 120, "首帧的 turns 是整段 120 轮，不是这一页的轮数");
assert.deepEqual(
  firstFrame.history.turns.map((t) => t.id),
  longSession.filter((it) => it.kind === "user").map((it) => it.id),
  "turns 的 id 与顺序和条目流里的用户消息一致",
);

// 一条文字：折回成一行（换行 / 连续空白压平）、超过 80 字截断补 `…`；纯图片轮只算张数。
const messy = `第一行\n  第二行 ${"x".repeat(200)}`;
const withImages = { id: "u-img", kind: "user", text: "", images: [{ mimeType: "image/png" }, { mimeType: "image/jpeg" }, { mimeType: "image/webp" }] };
const indexFrame = itemsFrame([
  { id: "u-long", kind: "user", text: messy, images: [] },
  assistant("a-long"),
  { id: "u-short", kind: "user", text: "  好的  ", images: [] },
  withImages,
]);
const turns = indexFrame.history.turns;
assert.deepEqual(turns.map((t) => t.id), ["u-long", "u-short", "u-img"], "非用户条目（助手 / 工具）不占轮次");
assert.equal(turns[0].text, `第一行 第二行 ${"x".repeat(71)}…`, "长文本折回一行、截到 80 字并补 …");
assert.equal(turns[0].text.length, 80, "截断后的长度就是 80（79 字 + …）");
assert.ok(!/[\n\r]/.test(turns[0].text) && !/\s{2}/.test(turns[0].text), "换行与连续空白都压平了");
assert.equal(turns[1].text, "好的", "短文本只压空白，不补省略号");
assert.equal(turns[1].images, 0, "纯文字轮 images 是 0");
assert.deepEqual(turns[2].text, "", "纯图片轮没有文字");
assert.equal(turns[2].images, 3, "纯图片轮 images 数就是图片张数");

// 随手问（整段下发）同样带索引，且与普通会话算出的是同一份。
assert.deepEqual(itemsFrame(longSession, { full: true }).history.turns, firstFrame.history.turns, "随手问整段下发时索引同样覆盖整段");

// 没有用户条目：给空数组，不是缺字段（新前端可以直接读）。
const noTurns = tailPage([assistant("a1"), tool("t1")]);
assert.deepEqual(noTurns.turns, [], "没有用户条目的会话给空数组");
assert.ok("turns" in itemsFrame([assistant("a1")]).history, "字段必须在帧里，而不是 undefined");

// `history.before` 的分页响应形状不变：不带 turns（老前端与协议契约都不受影响）。
assert.deepEqual(Object.keys(pageBefore(transcript, transcript[10].id)).sort(), ["hasMore", "items"], "history.before 的响应形状不变");

console.log("history-page-unit: ok");
