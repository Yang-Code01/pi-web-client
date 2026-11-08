/**
 * #219：`session` 帧只带末尾一页历史。页该怎么切是可单测的纯逻辑，这里按 ticket 的验收逐条钉住：
 * 默认页、页首落在用户消息、工具调用再密也能把开头那条用户消息带回、逐页拼到底不重不漏、
 * 空历史 / 不足一页 / `limit` 超界都有确定结果。
 *
 *   node --experimental-transform-types bridge/tests/history-page-unit.mjs
 */
import assert from "node:assert/strict";
import { HISTORY_PAGE_SIZE, pageBefore, tailPage } from "../src/history.ts";

const user = (id) => ({ id, kind: "user", text: id });
const assistant = (id) => ({ id, kind: "assistant", text: id });
const tool = (id) => ({ id, kind: "tool", toolCallId: id, name: "read", args: "{}", result: "" });
const ids = (page) => page.items.map((it) => it.id);

// ---------------------------------------------------------------- 空 / 不足一页

assert.deepEqual(tailPage([]), { items: [], hasMore: false, total: 0 }, "空历史的末尾一页就是空的");
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

console.log("history-page-unit: ok");
