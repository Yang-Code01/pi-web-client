/**
 * #384 Context 面板的纯函数：组成分类、KPI、压缩事件识别、格式化。
 *
 * 这些函数只吃 CtxLine（扩展落盘的 JSON 行），不吃 DOM —— 浏览器侧的呈现由 probes 把关。
 *
 * Run: node --experimental-transform-types --test web/tests/context-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CTX_CATS, ctxCatLabel, ctxCompRows, ctxEvents, ctxFmt, ctxKpis, ctxTotal, isCompactionDrop } from "../src/context.ts";

/** 轻量工厂：合并成一行合法的 CtxLine（用 JSDoc 注解，避免 TS 语法——.mjs 只能走 transform-types 的率直子集）。 */
const line = (over = {}) => ({
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

test("六类：顺序稳定、id 与色类一一对应", () => {
  assert.deepEqual(CTX_CATS.map((c) => c.id), ["sys", "tools", "user", "inject", "asst", "toolr"]);
  for (const c of CTX_CATS) assert.match(c.cls, /^c-[a-z]+$/);
  assert.equal(ctxCatLabel("sys"), "系统提示");
  assert.equal(ctxCatLabel("toolr"), "工具结果");
  assert.equal(ctxCatLabel("nope"), "其它", "未知 id 兜底");
});

test("ctxTotal：优先信扩展写的 total，缺失 / 0 时六类求和兜底", () => {
  const l = line({ total: 100, cats: { sys: 1, tools: 2, user: 3, inject: 4, asst: 5, toolr: 6 } });
  assert.equal(ctxTotal(l), 100, "写了 total 就用它");
  assert.equal(ctxTotal(line({})), 0, "全零兜底也是 0");
  assert.equal(ctxTotal(line({ total: 0, cats: { sys: 10, tools: 0, user: 0, inject: 0, asst: 0, toolr: 0 } })), 10, "total=0 时重算");
});

test("ctxCompRows：六行、百分比按六类内部占比算", () => {
  const rows = ctxCompRows(line({ cats: { sys: 50, tools: 50, user: 0, inject: 0, asst: 0, toolr: 0 } }));
  assert.equal(rows.length, 6);
  assert.equal(rows[0].id, "sys");
  assert.equal(rows[0].tokens, 50);
  assert.equal(rows[0].pct, 50);
  assert.equal(rows[1].pct, 50);
  assert.equal(rows[2].pct, 0, "零类也要占一行");
  const sum = rows.reduce((s, r) => s + r.pct, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, "占比加总 = 100%");
});

test("isCompactionDrop：total 骤降超 40% 算压缩", () => {
  const a = line({ seq: 10, total: 100000 });
  const b = line({ seq: 11, total: 40000 });
  const c = line({ seq: 12, total: 90000 });
  assert.equal(isCompactionDrop(a, b), true, "100k → 40k 是压缩");
  assert.equal(isCompactionDrop(a, c), false, "100k → 90k 不是");
  assert.equal(isCompactionDrop(undefined, a), false, "第一行没有前置");
});

test("ctxEvents：每个骤降点一条，记前后值", () => {
  const lines = [
    line({ seq: 1, total: 100 }),
    line({ seq: 2, total: 180 }),
    line({ seq: 3, total: 40 }), // ✂
    line({ seq: 4, total: 60 }),
    line({ seq: 5, total: 150 }),
    line({ seq: 6, total: 30 }), // ✂
  ];
  const ev = ctxEvents(lines);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].seq, 3);
  assert.equal(ev[0].before, 180);
  assert.equal(ev[0].after, 40);
  assert.equal(ev[1].seq, 6);
  assert.equal(ev[1].kind, "compact");
});

test("ctxKpis：当前 / 峰值 / 次数 / 均值 / 距自动压缩", () => {
  const lines = [line({ seq: 1, total: 100 }), line({ seq: 2, total: 300 }), line({ seq: 3, total: 200 })];
  const k = ctxKpis(lines, 1000, null);
  assert.equal(k.current, 200, "无实测值时用最后一轮");
  assert.equal(k.peak, 300);
  assert.equal(k.peakSeq, 2);
  assert.equal(k.requests, 3);
  assert.equal(k.avg, 200);
  assert.equal(k.tillCompact, 1000 * 0.92 - 200);

  const measured = ctxKpis(lines, 1000, 12345);
  assert.equal(measured.current, 12345, "有实测值（stats.context.tokens）优先");
  assert.equal(measured.tillCompact, 0, "实测值超了阈值就 0，不出负数");

  const nowin = ctxKpis(lines, null, null);
  assert.equal(nowin.tillCompact, null, "不知道窗口就没有距压缩");
  assert.equal(ctxKpis([], 1000, null).requests, 0, "空序列不出 NaN");
});

test("ctxFmt：k / 万两级缩写", () => {
  assert.equal(ctxFmt(0), "0");
  assert.equal(ctxFmt(999), "999");
  assert.equal(ctxFmt(1000), "1.0k");
  assert.equal(ctxFmt(99500), "100k", "≥10000 四舍五入到整 k（99.5k 进位 100k）");
  assert.equal(ctxFmt(100000), "100k");
  assert.equal(ctxFmt(178400), "178k");
});
