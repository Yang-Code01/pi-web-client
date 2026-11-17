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
  ctxCommandRows,
  ctxCompactAfterSeq,
  ctxCompRows,
  ctxEvents,
  ctxFileRows,
  ctxFmt,
  ctxKpis,
  ctxRequests,
  ctxTotal,
  ctxBillRows,
  ctxBrowserView,
  ctxBodyMap,
  ctxDur,
  ctxPct,
  ctxSummary,
  ctxTiming,
  ctxTokenStats,
  ctxToolRows,
  ctxTrendRows,
  ctxUsageMap,
  isCtxRequest,
} from "../src/context.ts";
import { ctxSectionMarkdown, ctxSkillCatalog, ctxUnwrapSection, decodeEntities } from "../src/context-viz.ts";

/** 请求行工厂：不带 kind 也合法，模拟 PR #386 初版的旧日志。 */
const req = (over = {}) => ({
  v: 1,
  seq: 1,
  ts: 0,
  cwd: "/tmp",
  total: 0,
  cats: { sys: 0, tools: 0, user: 0, inject: 0, skill: 0, asst: 0, toolr: 0 },
  messages: 0,
  perMessage: [],
  ...over,
});

const ev = (seq, event, over = {}) => ({ v: 1, seq, ts: 0, kind: "event", event, ...over });
const file = (seq, over = {}) => ({ v: 1, seq, ts: 0, kind: "activity", activity: "file", ...over });
const cmd = (seq, over = {}) => ({ v: 1, seq, ts: 0, kind: "activity", activity: "command", ...over });

test("七类：顺序稳定、id 与色类一一对应", () => {
  assert.deepEqual(CTX_CATS.map((c) => c.id), ["sys", "tools", "user", "inject", "skill", "asst", "toolr"]);
  for (const c of CTX_CATS) assert.match(c.cls, /^c-[a-z]+$/);
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

test("ctxTotal：优先信扩展写的 total，缺失 / 0 时七类求和兜底", () => {
  const l = req({ total: 100, cats: { sys: 1, tools: 2, user: 3, inject: 4, skill: 5, asst: 6, toolr: 7 } });
  assert.equal(ctxTotal(l), 100, "写了 total 就用它");
  assert.equal(ctxTotal(req({})), 0, "全零兜底也是 0");
  assert.equal(ctxTotal(req({ total: 0, cats: { sys: 10, tools: 0, user: 0, inject: 0, skill: 0, asst: 0, toolr: 0 } })), 10, "total=0 时重算");
});

test("ctxCompRows：七行、百分比按七类内部占比算", () => {
  const rows = ctxCompRows(req({ cats: { sys: 50, tools: 50, user: 0, inject: 0, skill: 0, asst: 0, toolr: 0 } }));
  assert.equal(rows.length, 7);
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
  assert.deepEqual(rows[0], { path: "a.ts", ops: 3, reads: 1, writes: 2, searches: 0, added: 15, removed: 5, failed: 0, lastTs: 0 });
  assert.deepEqual(rows[1], { path: "b.ts", ops: 1, reads: 0, writes: 0, searches: 1, added: 0, removed: 0, failed: 1, lastTs: 0 });
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
  assert.deepEqual(rows[0], { program: "git", runs: 2, failed: 1, avgMs: 200, totalMs: 400, lastTs: 0 });
  assert.deepEqual(rows[1], { program: "node", runs: 1, failed: 0, avgMs: null, totalMs: 0, lastTs: 0 });
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


// ---------------------------------------------------------------- dsh-context 口径的派生视图

const usage = (atSeq, over = {}) => ({
  v: 2,
  seq: 100 + atSeq,
  ts: atSeq * 1000,
  kind: "usage",
  atSeq,
  model: "m1",
  stopReason: "toolUse",
  durationMs: 100,
  waitMs: 5,
  usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 4, reasoning: 8, totalTokens: 64 },
  out: { reasoning: 8, answer: 6, calls: 4 },
  ...over,
});

const item = (id, cat, tokens, over = {}) => ({ id, cat, label: id, tokens, kind: "text", ...over });

test("ctxUsageMap / ctxTokenStats：provider 用量与 billed 八类分开算", () => {
  const lines = [
    req({ seq: 1, turn: 1, step: 1, cats: { sys: 10, tools: 20, user: 30, inject: 40, skill: 5, asst: 50, toolr: 60 } }),
    usage(1),
    req({ seq: 2, turn: 2, step: 1, cats: { sys: 1, tools: 2, user: 3, inject: 4, skill: 5, asst: 6, toolr: 7 } }),
    usage(2, { usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1, totalTokens: 10 }, out: { reasoning: 1, answer: 2, calls: 3 } }),
  ];
  const map = ctxUsageMap(lines);
  assert.equal(map.size, 2);
  assert.equal(map.get(1).usage.totalTokens, 64);
  const t = ctxTokenStats(lines);
  assert.equal(t.bill.sys, 11);
  assert.equal(t.bill.toolCalls, 60 + 4 + 7 + 3, "工具结果 + assistant 工具参数");
  assert.equal(t.bill.reasoning, 9);
  assert.equal(t.bill.answers, 8);
  assert.equal(t.actual, 74);
  assert.equal(t.input, 11);
  assert.equal(t.output, 22);
  assert.equal(t.cacheRead, 33);
  assert.equal(t.cacheWrite, 8);
  assert.ok(t.cacheHit > 60 && t.cacheHit < 70);
  const rows = ctxBillRows(t);
  assert.equal(rows.length, 8);
  assert.equal(rows.find((r) => r.id === "toolCalls").label, "工具调用");
});

test("ctxTiming：等待 / 生成 / 工具执行按 usage 与 activity 汇总，TPS 用生成时长", () => {
  const lines = [
    req({ seq: 1 }),
    usage(1, { waitMs: 5, durationMs: 100, usage: { input: 0, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 8, totalTokens: 20 }, out: { reasoning: 8, answer: 6, calls: 6 } }),
    cmd(2, { durationMs: 20, status: "ok" }),
    file(3, { op: "read", path: "a.ts", durationMs: 10 }),
  ];
  const t = ctxTiming(lines);
  assert.equal(t.total, 135, "5 等待 + 100 生成 + 20 工具");
  assert.equal(t.rows.find((r) => r.id === "wait").ms, 5);
  assert.equal(t.rows.find((r) => r.id === "tool").ms, 30);
  assert.equal(t.tps, 200, "20 tokens / 0.1s");
  assert.equal(t.calls, 1);
  assert.equal(t.tools, 2);
  assert.equal(ctxDur(0), "0");
  assert.equal(ctxDur(1500), "1.5s");
  assert.equal(ctxDur(68000), "1m8s");
  assert.equal(ctxPct(0.05), "<0.1%");
});

test("ctxTrendRows：步骤逐请求；轮次取末步；delta 只保留增长部分", () => {
  const lines = [
    req({ seq: 1, turn: 1, step: 1, cats: { sys: 10, tools: 0, user: 10, inject: 0, skill: 0, asst: 0, toolr: 0 } }),
    req({ seq: 2, turn: 1, step: 2, cats: { sys: 10, tools: 20, user: 10, inject: 0, skill: 0, asst: 0, toolr: 0 } }),
    req({ seq: 3, turn: 2, step: 1, cats: { sys: 5, tools: 10, user: 4, inject: 0, skill: 0, asst: 0, toolr: 0 } }),
  ];
  const step = ctxTrendRows(lines, "step", "full");
  assert.equal(step.length, 3);
  assert.equal(step[1].total, 40);
  const delta = ctxTrendRows(lines, "step", "delta");
  assert.equal(delta[1].cats.tools, 20, "新增的 tools 20");
  assert.equal(delta[2].cats.sys, 0, "sys 少了，delta 不画负数");
  const turn = ctxTrendRows(lines, "turn", "full");
  assert.equal(turn.length, 2);
  assert.equal(turn[0].seq, 2, "第一轮取第 2 步");
  assert.equal(turn[1].total, 19);
});

test("ctxBrowserView：条目分组、基线 delta、旧日志 perMessage 兜底", () => {
  const lines = [
    req({ seq: 1, turn: 1, step: 1, cats: { sys: 10, tools: 20, user: 10, inject: 0, skill: 0, asst: 0, toolr: 0 }, items: [item("sys", "sys", 10), item("tool", "tools", 20), item("u1", "user", 10)] }),
    req({ seq: 2, turn: 1, step: 2, cats: { sys: 10, tools: 20, user: 10, inject: 0, skill: 0, asst: 0, toolr: 30 }, items: [item("sys", "sys", 10), item("tool", "tools", 20), item("u1", "user", 10), item("t1", "toolr", 30)] }),
  ];
  const full = ctxBrowserView(lines, 2, "step", "full");
  assert.equal(full.total, 70);
  assert.equal(full.cats.find((c) => c.id === "toolr").count, 1);
  const delta = ctxBrowserView(lines, 2, "step", "delta");
  assert.deepEqual(delta.items.map((i) => i.id), ["t1"], "只留新增的 toolResult");
  const fallback = ctxBrowserView([req({ seq: 1, cats: { sys: 10, tools: 20, user: 5, inject: 0, skill: 0, asst: 7, toolr: 0 }, perMessage: [{ role: "user", tokens: 5 }, { role: "assistant", tokens: 7 }] })], 1, "step", "full");
  assert.equal(fallback.items.length, 4, "没有 items 时 header + user + assistant 兜底");
  const v1 = ctxBrowserView([req({ seq: 2, cats: { sys: 10, tools: 20, user: 5, inject: 0, skill: 0, asst: 7, toolr: 0 }, perMessage: [{ role: "system", tokens: 10, blocks: 1, toolCalls: 0 }, { role: "user", tokens: 5, blocks: 1, toolCalls: 0 }] })], 2, "step", "full");
  assert.equal(v1.items.filter((i) => i.cat === "sys").length, 1, "旧日志 system 只出现一次");
  assert.equal(v1.items.filter((i) => i.cat === "inject").length, 0, "system 行不再算成注入");
  assert.equal(ctxBrowserView([], null, "step", "full").selected, null);
});

test("ctxSummary / ctxToolRows：工具账本含 bash / read / 其它工具，事件按 kind 计数", () => {
  const lines = [
    req({ seq: 1, turn: 1, step: 1, users: 2, cats: { sys: 0, tools: 0, user: 5, inject: 0, skill: 0, asst: 0, toolr: 0 } }),
    ev(2, "inject", { label: "skill:x", tokens: 12, atSeq: 1 }),
    ev(3, "model", { model: "b", previous: "a", atSeq: 1 }),
    cmd(4, { program: "git", status: "ok" }),
    file(5, { op: "read", path: "a.ts" }),
    { v: 2, seq: 6, ts: 0, kind: "activity", activity: "tool", tool: "plugin_manager", status: "failed" },
  ];
  const s = ctxSummary(lines);
  assert.equal(s.turns, 1);
  assert.equal(s.steps, 1);
  assert.equal(s.users, 2);
  assert.equal(s.events.inject, 1);
  assert.equal(s.events.model, 1);
  assert.deepEqual(s.toolRows.map((r) => [r.tool, r.runs]).sort(), [["bash", 1], ["plugin_manager", 1], ["read", 1]].sort());
  assert.equal(ctxToolRows(lines).find((r) => r.tool === "plugin_manager").failed, 1);
});

test("ctxSummary 技能加载：请求行的 skills 名去重，不再一直显示 0", () => {
  const lines = [
    req({ seq: 1, turn: 1, skills: ["grill-me", "review"] }),
    req({ seq: 2, turn: 2, skills: ["grill-me"] }),
    { ...req({ seq: 3, turn: 2 }), skills: [] },
    { v: 2, seq: 4, ts: 0, kind: "activity", activity: "tool", tool: "skill", skillName: "deploy" },
  ];
  const s = ctxSummary(lines);
  assert.equal(s.skills, 3, "grill-me / review / deploy 三个不同技能");
  assert.deepEqual(s.skillNames.sort(), ["deploy", "grill-me", "review"]);
});

test("ctxSummary 技能加载：旧日志没有 skills 字段时从 user preview 的 <skill name> 兜底", () => {
  const preview = '<skill name="grill-me" location="/tmp/SKILL.md">正文…</skill>';
  const s = ctxSummary([req({ seq: 1, items: [{ id: "u1", cat: "user", label: "user", tokens: 10, preview }] })]);
  assert.equal(s.skills, 1);
  assert.deepEqual(s.skillNames, ["grill-me"]);
});

test("ctxBodyMap / ctxBrowserView：body 行把正文合并回对应条目", () => {
  const lines = [
    req({ seq: 1, items: [item("u1", "user", 10, { preview: "短预览" }), item("tool:read", "tools", 20)] }),
    { v: 3, seq: 2, ts: 0, kind: "body", id: "u1", content: "这是用户消息的完整正文" },
    { v: 3, seq: 3, ts: 0, kind: "body", id: "tool:read", content: '{\n  "name": "read"\n}', tool: "read" },
  ];
  const bodies = ctxBodyMap(lines);
  assert.equal(bodies.size, 2);
  assert.equal(bodies.get("u1").content, "这是用户消息的完整正文");
  const view = ctxBrowserView(lines, 1, "step", "full");
  const u = view.items.find((i) => i.id === "u1");
  assert.equal(u.content, "这是用户消息的完整正文");
  assert.equal(u.preview, "短预览", "预览不被正文覆盖");
});

test("decodeEntities：只解常见命名实体与数字实体，其余原样留着", () => {
  assert.equal(decodeEntities("`as any` 不该出现在这里 &quot;引号&quot; &apos;单&apos;"), "`as any` 不该出现在这里 \"引号\" '单'");
  assert.equal(decodeEntities("&#39;&#x27;&lt;t&gt;&amp;&nbsp;!"), "'" + "'" + "<t>&" + " !");
  assert.equal(decodeEntities("&something;&"), "&something;&");
  assert.equal(decodeEntities(""), "");
});

test("ctxSkillCatalog：剥掉分节标签、解实体、按 名字+路径 去重", () => {
  const xml = [
    "<skills>",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>alpha</name>",
    "    <description>Say &quot;hi&quot; &amp; go</description>",
    "    <location>C:/a/SKILL.md</location>",
    "  </skill>",
    "  <skill>",
    "    <name>alpha</name>",
    "    <description>Say &quot;hi&quot; &amp; go</description>",
    "    <location>C:/a/SKILL.md</location>",
    "  </skill>",
    "  <skill>",
    "    <name>beta</name>",
    "    <description></description>",
    "  </skill>",
    "</available_skills>",
    "</skills>",
  ].join("\n");
  const cat = ctxSkillCatalog(xml);
  assert.equal(cat.skills.length, 2, "重复的 名字+路径 只留一条");
  assert.deepEqual(cat.skills[0], { name: "alpha", description: 'Say "hi" & go', location: "C:/a/SKILL.md" });
  assert.deepEqual(cat.skills[1], { name: "beta", description: "", location: "" });
  assert.ok(cat.intro.startsWith("The following skills"), "介绍段从 <skills> 之后开始");
  assert.ok(!cat.intro.includes("<available_skills>"), "介绍段不带技能清单");
  assert.ok(!cat.intro.includes("<skills>"), "分节标签已剥掉");
});

test("ctxSkillCatalog：不像技能清单时返回空，界面据此退回原文", () => {
  assert.deepEqual(ctxSkillCatalog("just some text").skills, []);
  assert.deepEqual(ctxSkillCatalog("").skills, []);
});

test("ctxUnwrapSection：只剥唯一且配对的首尾分节标签", () => {
  const rules = "<rules>\n- 中文优先\n- 用 tr()\n</rules>";
  assert.deepEqual(ctxUnwrapSection(rules), { tag: "rules", text: "- 中文优先\n- 用 tr()" });
  const cwd = "<cwd>E:/x</cwd>";
  assert.deepEqual(ctxUnwrapSection(cwd), { tag: "cwd", text: "E:/x" });
  // 收尾标签对不上就不动它（避免把正文里的半截标签当成外壳）
  assert.deepEqual(ctxUnwrapSection("<rules>\n正文\n</docs>"), { tag: "", text: "<rules>\n正文\n</docs>" });
  assert.deepEqual(ctxUnwrapSection("## 标题\n正文"), { tag: "", text: "## 标题\n正文" });
});

test("ctxSectionMarkdown：注入段按小节转 Markdown，project_context 每份文件一条分界行", () => {
  const src = [
    "<addendum>",
    "",
    "## 这个工作区的规矩",
    "",
    "- 产物写进会话目录",
    "",
    "<project_context>",
    String.raw`<project_instructions path="C:\Users\a\AGENTS.md">`,
    "# 全局偏好",
    "",
    "- 中文",
    "</project_instructions>",
    String.raw`<project_instructions path="E:\repo\AGENTS.md">`,
    "# pi-web-client",
    "",
    "- worktree",
    "</project_instructions>",
    "</project_context>",
    "",
    "</addendum>",
  ].join("\n");
  const md = ctxSectionMarkdown(src);
  assert.ok(!md.includes("<addendum>"), "外层分节标签剥掉，正文才走 Markdown");
  assert.ok(md.startsWith("## 这个工作区的规矩"));
  assert.ok(md.includes("\n" + String.raw`**C:\Users\a\AGENTS.md**`), "每份 AGENTS.md 有自己的分界行");
  assert.ok(md.includes("\n" + String.raw`**E:\repo\AGENTS.md**`));
  assert.ok(!md.includes("## C:"), "分界行不用标题，免得跟 AGENTS.md 自带的 ## / ### 抢层级");
  assert.ok(!md.includes("<project_instructions"), "标签不残留");
  assert.ok(!md.includes("\n\n\n"), "连续空行压成一行");
});
