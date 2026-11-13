/**
 * #384 Context 面板的纯函数：三类 ctxlog 行 → KPI / 组成 / 趋势 / 事件 / 活动。
 *
 * 只吃 CtxLine（扩展落盘的 JSON 行），不碰 DOM / WS —— 浏览器侧呈现由 probes 把关。
 *
 * Run: node --experimental-transform-types --test web/tests/context-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CTX_CATS,
  ctxCatLabel,
  ctxCommandRows,
  ctxCompactAfterSeq,
  ctxCompRows,
  ctxEvents,
  ctxFileRows,
  ctxFmt,
  ctxKpis,
  ctxRequests,
  ctxTotal,
  isCtxRequest,
} from "../src/context.ts";

/** 请求行工厂：不带 kind 也合法，模拟 PR #386 初版的旧日志。 */
const req = (over = {}) => ({
  v: 1,
  seq: 1,
  ts: 0,
  cwd: "/tmp",
  total: 0,
  cats: { sys: 0, tools: 0, user: 0, inject: 0, asst: 0, toolr: 0 },
  messages: 0,
  perMessage: [],
  ...over,
});

const ev = (seq, event, over = {}) => ({ v: 1, seq, ts: 0, kind: "event", event, ...over });
const file = (seq, over = {}) => ({ v: 1, seq, ts: 0, kind: "activity", activity: "file", ...over });
const cmd = (seq, over = {}) => ({ v: 1, seq, ts: 0, kind: "activity", activity: "command", ...over });

test("六类：顺序稳定、id 与色类一一对应", () => {
  assert.deepEqual(CTX_CATS.map((c) => c.id), ["sys", "tools", "user", "inject", "asst", "toolr"]);
  for (const c of CTX_CATS) assert.match(c.cls, /^c-[a-z]+$/);
  assert.equal(ctxCatLabel("sys"), "系统提示");
  assert.equal(ctxCatLabel("toolr"), "工具结果");
  assert.equal(ctxCatLabel("nope"), "其它", "未知 id 兜底");
});

test("ctxRequests：只收请求行，旧日志（没有 kind）按 request 兼容", () => {
  const all = [
    req({ seq: 1, kind: "request", total: 100 }),
    ev(2, "compact", { before: 100, atSeq: 1 }),
    req({ seq: 3, total: 200 }), // 旧行：只有 cats
    file(4, { op: "read", path: "a.ts" }),
  ];
  assert.equal(isCtxRequest(all[0]), true);
  assert.equal(isCtxRequest(all[2]), true);
  assert.equal(isCtxRequest(all[1]), false);
  assert.equal(isCtxRequest(all[3]), false);
  assert.deepEqual(ctxRequests(all).map((l) => l.seq), [1, 3]);
});

test("ctxTotal：优先信扩展写的 total，缺失 / 0 时六类求和兜底", () => {
  const l = req({ total: 100, cats: { sys: 1, tools: 2, user: 3, inject: 4, asst: 5, toolr: 6 } });
  assert.equal(ctxTotal(l), 100, "写了 total 就用它");
  assert.equal(ctxTotal(req({})), 0, "全零兜底也是 0");
  assert.equal(ctxTotal(req({ total: 0, cats: { sys: 10, tools: 0, user: 0, inject: 0, asst: 0, toolr: 0 } })), 10, "total=0 时重算");
});

test("ctxCompRows：六行、百分比按六类内部占比算", () => {
  const rows = ctxCompRows(req({ cats: { sys: 50, tools: 50, user: 0, inject: 0, asst: 0, toolr: 0 } }));
  assert.equal(rows.length, 6);
  assert.equal(rows[0].id, "sys");
  assert.equal(rows[0].tokens, 50);
  assert.equal(rows[0].pct, 50);
  assert.equal(rows[1].pct, 50);
  assert.equal(rows[2].pct, 0, "零类也要占一行");
  const sum = rows.reduce((s, r) => s + r.pct, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, "占比加总 = 100%");
});

test("ctxEvents：只认显式事件行；token 总量骤降不再误判为压缩", () => {
  const lines = [
    req({ seq: 1, total: 100 }),
    ev(2, "model", { model: "b", previous: "a", atSeq: 1 }),
    req({ seq: 3, total: 180 }),
    req({ seq: 4, total: 40 }), // 骤降 78%，但没有事件行 → 不算压缩
    ev(5, "compact", { before: 180, reason: "threshold", atSeq: 4 }),
    ev(6, "compact_failed", { reason: "overflow", aborted: false, atSeq: 4 }),
  ];
  const out = ctxEvents(lines);
  assert.equal(out.length, 3, "只有 3 条显式事件");
  assert.deepEqual(out.map((e) => e.kind), ["model", "compact", "compact_failed"]);
  assert.equal(out[1].before, 180);
  assert.equal(out[1].reason, "threshold");
  assert.equal(out[1].atSeq, 4);
  assert.equal(out[0].model, "b");
  assert.equal(out[0].previous, "a");
  assert.deepEqual(ctxEvents([req({ seq: 1 }), req({ seq: 2, total: 1 })]), [], "没有事件行就是空");
});

test("ctxCompactAfterSeq：✂ 挂在压缩事件之后的下一次请求，不挂在事件行本身", () => {
  const lines = [
    req({ seq: 1, total: 100 }),
    ev(2, "compact", { atSeq: 1 }),
    ev(3, "compact_failed", { atSeq: 1 }),
    req({ seq: 4, total: 40 }),
    ev(5, "model", { atSeq: 4 }),
    req({ seq: 6, total: 50 }),
  ];
  const s = ctxCompactAfterSeq(lines);
  assert.deepEqual([...s], [4], "两类压缩都指向 seq=4；换模型不打 ✂");
  assert.equal(s.has(2), false);
  assert.equal(s.has(6), false);
});

test("ctxKpis：当前 / 峰值 / 次数 / 均值 / 真实预算余量", () => {
  const lines = [req({ seq: 1, total: 100 }), req({ seq: 2, total: 300 }), req({ seq: 3, total: 200 })];
  const k = ctxKpis(lines, 1000, null, 800);
  assert.equal(k.current, 200, "无实测值时用最后一轮");
  assert.equal(k.peak, 300);
  assert.equal(k.peakSeq, 2);
  assert.equal(k.requests, 3);
  assert.equal(k.avg, 200);
  assert.equal(k.budget, 800);
  assert.equal(k.tillCompact, 600, "桥的真实预算 - current，不再是 window * 0.92");

  const measured = ctxKpis(lines, 1000, 12345, 800);
  assert.equal(measured.current, 12345, "有实测值（stats.context.tokens）优先");
  assert.equal(measured.tillCompact, 0, "实测值超了预算就 0，不出负数");

  const nobudget = ctxKpis(lines, 1000, null, null);
  assert.equal(nobudget.budget, null);
  assert.equal(nobudget.tillCompact, null, "没设预算就没有距压缩");
  assert.equal(ctxKpis([], 1000, null, 800).requests, 0, "空序列不出 NaN");
});

test("ctxFileRows：按路径聚合读 / 写 / 检索、+/− 行与失败，按次数排序", () => {
  const rows = ctxFileRows([
    file(1, { op: "read", path: "a.ts" }),
    file(2, { op: "write", path: "a.ts", added: 12 }),
    file(3, { op: "search", path: "b.ts", status: "failed" }),
    file(4, { op: "edit", path: "a.ts", added: 3, removed: 5 }),
    cmd(5, { program: "git" }), // 命令行不能混进文件活动
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { path: "a.ts", ops: 3, reads: 1, writes: 2, searches: 0, added: 15, removed: 5, failed: 0 });
  assert.deepEqual(rows[1], { path: "b.ts", ops: 1, reads: 0, writes: 0, searches: 1, added: 0, removed: 0, failed: 1 });
  assert.deepEqual(ctxFileRows([req({ seq: 1 })]), [], "没有活动行就是空");
});

test("ctxCommandRows：按程序名聚合次数、失败、平均耗时；缺耗时返回 null", () => {
  const rows = ctxCommandRows([
    cmd(1, { program: "git", durationMs: 100, status: "ok" }),
    cmd(2, { program: "git", durationMs: 300, status: "failed" }),
    cmd(3, { program: "node" }),
    file(4, { op: "read", path: "a.ts" }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { program: "git", runs: 2, failed: 1, avgMs: 200 });
  assert.deepEqual(rows[1], { program: "node", runs: 1, failed: 0, avgMs: null });
  assert.deepEqual(ctxCommandRows([req({ seq: 1 })]), []);
});

test("ctxFmt：k / 万两级缩写", () => {
  assert.equal(ctxFmt(0), "0");
  assert.equal(ctxFmt(999), "999");
  assert.equal(ctxFmt(1000), "1.0k");
  assert.equal(ctxFmt(99500), "100k", "≥10000 四舍五入到整 k（99.5k 进位 100k）");
  assert.equal(ctxFmt(100000), "100k");
  assert.equal(ctxFmt(178400), "178k");
});
