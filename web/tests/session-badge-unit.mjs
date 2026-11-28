/**
 * 会话徽标的唯一判定（D453）：这一格现在该说哪句话。
 *
 * 只测纯函数层；画与点（第二枚可点的「评审中」、切会话 + 右栏切到代码评审页签）在
 * `probes/round9-badges.mjs` 的假桥探针里把关。
 *
 * 顺序是这一层的全部价值：说错一格，用户就会以为会话已经收工（`完成`）去干别的，
 * 或者被一枚不阻塞的 `评审中` 盖住了正在等他回答的问卷。
 *
 * Run: node --experimental-strip-types --test web/tests/session-badge-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sessionBadge } from "../src/session-badge.ts";

/** 一个什么都没发生的会话：没在跑、没跑完、没在等、没后台、没评审。 */
const idle = { running: false, done: false, approvals: 0 };
const badge = (over = {}) => sessionBadge({ ...idle, ...over });

test("在等你 > 会话在跑 > 后台 > 评审 > 完成：一次只露一格，最该说的那句", () => {
  const everything = { asks: 2, approvals: 3, locked: true, running: true, bg: { n: 2 }, review: 2, done: true };
  assert.equal(badge(everything).kind, "ask", "问你话的时候别的都不说");
  assert.equal(badge({ ...everything, asks: 0 }).kind, "approve", "等确认压过终端占用 / 运行中 / 评审");
  assert.equal(badge({ ...everything, asks: 0, approvals: 0 }).kind, "locked", "终端占用的会话不许被说成在跑");
  assert.equal(badge({ ...everything, asks: 0, approvals: 0, locked: false }).kind, "run", "会话自己在跑，评审让位");
  const bg = badge({ ...everything, asks: 0, approvals: 0, locked: false, running: false });
  assert.equal(bg.kind, "bg", "后台子代理跑完 pi 会自己接着做，排在评审前面");
  const review = badge({ ...everything, asks: 0, approvals: 0, locked: false, running: false, bg: null });
  assert.equal(review.kind, "review", "评审只压过「完成」与空位");
});

test("评审在跑：文案「评审中」，并跑两条写「评审中 2」，且它不是「在等你」", () => {
  const one = badge({ review: 1, done: true });
  assert.equal(one.kind, "review");
  assert.equal(one.text, "评审中");
  assert.equal(one.cls, "reviewing", "配色自带一档：与「运行中」的 run 不同");
  assert.equal(one.pending, false, "评审不阻塞人，不进「在等你」的角标 / 组红点");
  assert.match(one.title, /代码评审/, "tooltip 要说清进度去哪儿看");
  assert.equal(badge({ review: 2 }).text, "评审中 2", "多条带数字，与「后台 N」同一写法");
});

test("评审压过「完成」，但压不过会话自己：完成态 + 评审在跑说「评审中」", () => {
  assert.equal(badge({ done: true, review: 1 }).kind, "review");
  assert.equal(badge({ done: true, review: 1 }).text, "评审中");
  // 同一格在会话真的跑起来时立刻换回「运行中」（用户已经点明：会话优先）。
  assert.equal(badge({ done: false, running: true, review: 1 }).text, "运行中");
});

test("空位也露「评审中」：既没在跑也没跑完过的会话，评审在跑时不能一片空白", () => {
  const only = badge({ review: 1 });
  assert.ok(only, "没有 done / running / bg 也要有徽标");
  assert.equal(only.kind, "review");
  assert.equal(badge({ review: 1, done: false }).text, "评审中");
});

test("没有评审 / 评审收尾：与今天逐字一致（旧桥不发这一格也不许变样）", () => {
  assert.equal(badge({ review: null, done: true }).text, "完成");
  assert.equal(badge({ review: 0, done: true }).kind, "done");
  assert.equal(badge({ review: 0 }), null, "空闲会话的徽标位保持干净");
  assert.equal(badge({}), null);
  assert.equal(badge({ review: 1, running: true }).text, "运行中");
});

test("老字段一个不少：待回答 / 待确认 / 终端占用 / 运行中 / 后台 / 完成 的文案与配色", () => {
  assert.deepEqual([badge({ asks: 1 }).text, badge({ asks: 3 }).text], ["待回答", "待回答 3"]);
  assert.deepEqual([badge({ approvals: 1 }).text, badge({ approvals: 2 }).text], ["待确认", "待确认 2"]);
  assert.equal(badge({ asks: 1 }).cls, "wait");
  assert.equal(badge({ approvals: 1 }).cls, "wait");
  assert.equal(badge({ locked: true }).cls, "lock");
  assert.equal(badge({ running: true }).cls, "run");
  assert.equal(badge({ done: true }).cls, "done");
  assert.equal(badge({ bg: { n: 1, agent: "researcher" } }).title.includes("researcher"), true, "后台那枚要说清是谁");
});

test("能点的只有两枚：后台（看详情）与评审（去评审现场）", () => {
  assert.equal(badge({ review: 1 }).clickable, true);
  assert.equal(badge({ bg: { n: 1 } }).clickable, true);
  assert.equal(badge({ done: true }).clickable, false);
  assert.equal(badge({ running: true }).clickable, false);
  assert.equal(badge({ asks: 1 }).clickable, false);
});
