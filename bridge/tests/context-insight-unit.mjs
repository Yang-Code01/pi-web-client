/**
 * 跨会话「上下文洞察」聚合：ctxlog → 会话级快照。
 *
 * 覆盖 provider Token / 费用、bill 八类、按日用量、技能事件去重、工具 / 命令账本，
 * 以及「旧日志没有 skill 事件时用 request.skills 兜底」。
 *
 * Run: node --experimental-transform-types --test bridge/tests/context-insight-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aggregateCtxLog, collectContextInsight } from "../src/context-insight.ts";

const line = (obj) => JSON.stringify(obj);
const request = (over = {}) => ({
  v: 3,
  seq: 1,
  ts: new Date(2026, 10, 1, 10).getTime(),
  kind: "request",
  turn: 1,
  step: 1,
  total: 100,
  cats: { sys: 50, tools: 20, user: 10, inject: 5, skill: 5, asst: 5, toolr: 5 },
  skills: ["grill-me"],
  lastUser: "第一问",
  ...over,
});
const usage = (over = {}) => ({
  v: 3,
  seq: 2,
  ts: new Date(2026, 10, 1, 10, 1).getTime(),
  kind: "usage",
  atSeq: 1,
  usage: { input: 100, output: 50, cacheRead: 800, cacheWrite: 50, reasoning: 10, totalTokens: 1000 },
  out: { reasoning: 10, answer: 30, calls: 20 },
  cost: 0.02,
  ...over,
});

test("aggregateCtxLog：provider Token / 费用 / bill / 按日 / 账本", () => {
  const agg = aggregateCtxLog([
    request(),
    usage(),
    { v: 3, seq: 3, ts: new Date(2026, 10, 1, 10, 2).getTime(), kind: "activity", activity: "command", tool: "bash", program: "git", durationMs: 20, status: "ok", atSeq: 1 },
    { v: 3, seq: 4, ts: new Date(2026, 10, 1, 10, 2).getTime(), kind: "activity", activity: "file", tool: "read", op: "read", path: "a.ts", atSeq: 1 },
    { v: 3, seq: 5, ts: new Date(2026, 10, 1, 10, 3).getTime(), kind: "event", event: "inject", label: "skill:grill-me", atSeq: 1 },
    request({ seq: 6, ts: new Date(2026, 10, 2, 10).getTime(), turn: 2, total: 200, skills: ["grill-me", "review"] }),
    usage({ seq: 7, atSeq: 6, ts: new Date(2026, 10, 2, 10, 1).getTime(), usage: { input: 200, output: 100, cacheRead: 1600, cacheWrite: 100, reasoning: 20, totalTokens: 2000 }, out: { reasoning: 20, answer: 60, calls: 20 }, cost: 0.04 }),
  ]);
  assert.equal(agg.requests, 2);
  assert.equal(agg.turns, 2);
  assert.equal(agg.tokens, 3000);
  assert.equal(agg.input, 300);
  assert.equal(agg.output, 150);
  assert.equal(agg.cacheRead, 2400);
  assert.equal(agg.cacheWrite, 150);
  assert.equal(agg.cost, 0.06);
  assert.equal(agg.costKnown, true);
  assert.equal(agg.context, 200);
  assert.equal(agg.peak, 200);
  assert.equal(agg.bill.sys, 100);
  assert.equal(agg.bill.toolCalls, 5 + 20 + 5 + 20, "toolResult + assistant calls");
  assert.equal(agg.bill.reasoning, 30);
  assert.equal(agg.bill.answers, 90);
  assert.deepEqual(Object.keys(agg.days).sort(), ["2026-11-01", "2026-11-02"]);
  assert.deepEqual(agg.days["2026-11-01"], { tokens: 1000, cost: 0.02, requests: 1, toolCalls: 2, toolsMs: 20 });
  assert.equal(agg.days["2026-11-02"].tokens, 2000);
  assert.equal(agg.tools.bash.n, 1);
  assert.equal(agg.cmds.git.n, 1);
  assert.equal(agg.files.read, 1);
  assert.equal(agg.skills["grill-me"].n, 1, "有 skill 事件时不再用 request.skills 重复计数");
  assert.equal(agg.skills.review.n, 1, "事件漏掉的技能名由 request.skills 补一条");
  assert.equal(agg.events.inject, 1);
  assert.equal(agg.lastUser, "第一问");
});

test("aggregateCtxLog：没有 skill 事件时用 request.skills 去重兜底", () => {
  const agg = aggregateCtxLog([
    request({ seq: 1, skills: ["a", "b"] }),
    request({ seq: 2, turn: 2, skills: ["a"] }),
  ]);
  assert.equal(agg.skills.a.n, 1);
  assert.equal(agg.skills.b.n, 1);
});

test("aggregateCtxLog：旧日志从 user preview 的 <skill name> 补技能", () => {
  const agg = aggregateCtxLog([
    request({ seq: 1, skills: [], items: [{ id: "u1", cat: "user", label: "user", tokens: 10, preview: '<skill name="code-review" location="/tmp/SKILL.md">正文…</skill>' }] }),
  ]);
  assert.equal(agg.skills["code-review"].n, 1);
});

test("collectContextInsight：扫 ctxlog、跳过随手问、带回 workspace 与会话元数据", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-insight-"));
  const id = "abcdef12-3456-7890-abcd-ef1234567890";
  const dir = path.join(root, id.slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.ctx.jsonl`),
    [
      line(request()),
      line(usage()),
      line({ v: 3, seq: 3, ts: 1, kind: "event", event: "inject", label: "skill:grill-me", atSeq: 1 }),
    ].join("\n") + "\n",
  );
  const sessions = [
    { id, name: "测试会话", cwd: "/repo/alpha", ws: "ws1", archived: false, running: true, updatedAt: 123, model: "m", preview: "预览" },
    { id: "ffffffff-1111-2222-3333-444444444444", name: "随手问", cwd: "/tmp", scratch: true, updatedAt: 1 },
  ];
  const data = await collectContextInsight({
    sessions,
    workspace: { groups: [{ id: "ws1", name: "Alpha", key: "/repo/alpha", manual: false, inRow: true }], overrides: {}, keys: {} },
    root,
  });
  assert.equal(data.sessions.length, 1, "scratch 不进洞察");
  const s = data.sessions[0];
  assert.equal(s.id, id);
  assert.equal(s.name, "测试会话");
  assert.equal(s.ws, "ws1");
  assert.equal(s.tokens, 1000);
  assert.equal(s.context, 100);
  assert.equal(s.skills["grill-me"].n, 1);
  assert.equal(data.workspace.groups[0].name, "Alpha");
});

test("collectContextInsight：没有 ctxlog 的会话也返回，Token 为 0", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-insight-empty-"));
  const data = await collectContextInsight({
    sessions: [{ id: "abcdef12-3456-7890-abcd-ef1234567890", name: "空会话", cwd: "/x", updatedAt: 1 }],
    workspace: { groups: [], overrides: {}, keys: {} },
    root,
  });
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].tokens, 0);
  assert.equal(data.sessions[0].requests, 0);
  assert.deepEqual(data.sessions[0].days, {});
});
