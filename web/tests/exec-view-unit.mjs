import test from "node:test";
import assert from "node:assert/strict";
import { execView } from "../src/exec-view.ts";

const user = (id, ts, text = `round ${id}`) => ({ id, ts, kind: "user", text, images: [] });
const assistant = (id, ts, text = "done") => ({ id, ts, kind: "assistant", text, thinking: "" });
const tool = (id, ts, status, extra = {}) => ({
  id,
  ts,
  kind: "tool",
  toolCallId: `call-${id}`,
  name: "bash",
  args: { command: id },
  status,
  ...extra,
});
const base = { phase: "idle", streamChars: 0, selectedRound: null, now: Date.parse("2025-01-01T00:00:10Z"), stats: null, roundStats: {} };

test("an idle view with no loaded turns has an empty previous-turn summary", () => {
  assert.deepEqual(execView({ ...base, items: [], stats: null, roundStats: {} }), {
    now: { kind: "idle", previousDurationMs: null, succeeded: null, activeTools: [] },
    timeline: [],
    rounds: [],
    selectedRound: null,
    plan: null,
    metrics: {
      durationMs: null,
      toolCount: 0,
      failureCount: 0,
      cost: null,
      tokens: null,
      main: { cost: null, tokens: null },
      subagents: { cost: 0, tokens: 0 },
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
    },
  });
});

test("session context usage is visible before the first turn", () => {
  const view = execView({
    ...base,
    items: [],
    stats: { tokens: { total: 15 }, cost: 0.01, contextTokens: 1000, contextWindow: 200000 },
  });

  assert.equal(view.metrics.cost, null);
  assert.equal(view.metrics.tokens, null);
  assert.equal(view.metrics.contextTokens, 1000);
  assert.equal(view.metrics.contextWindow, 200000);
  assert.equal(view.metrics.contextPercent, 0.5);
});

test("idle view summarizes the loaded previous turn duration and failures", () => {
  const view = execView({
    ...base,
    items: [
      user("u1", "2025-01-01T00:00:00Z"),
      tool("t1", "2025-01-01T00:00:03Z", "error", { isError: true, durationMs: 1200 }),
      assistant("a1", "2025-01-01T00:00:08Z"),
    ],
  });

  assert.equal(view.now.kind, "idle");
  assert.equal(view.now.previousDurationMs, 8000);
  assert.equal(view.now.succeeded, false);
  assert.deepEqual(view.rounds, [{ id: "u1", ordinal: 1 }]);
});

test("current round duration advances with the clock while active", () => {
  const view = execView({
    ...base,
    phase: "thinking",
    items: [user("u1", "2025-01-01T00:00:00Z")],
  });

  assert.equal(view.metrics.durationMs, 10000);
});

test("thinking and writing phases expose streamed character count and recent summary", () => {
  const items = [user("u1", "2025-01-01T00:00:00Z")];
  assert.deepEqual(
    execView({ ...base, items, phase: "thinking", streamChars: 17, streamSummary: "先检查现有实现。" }).now,
    { kind: "thinking", characters: 17, summary: "先检查现有实现。", activeTools: [] },
  );
  assert.deepEqual(
    execView({ ...base, items, phase: "writing", streamChars: 42, streamSummary: "改动已经验证。" }).now,
    { kind: "writing", characters: 42, summary: "改动已经验证。", activeTools: [] },
  );
});

test("a running tool exposes its args and elapsed time while timeline is newest first", () => {
  const view = execView({
    ...base,
    phase: "tool",
    items: [
      user("u1", "2025-01-01T00:00:00Z"),
      tool("t1", "2025-01-01T00:00:02Z", "error", { durationMs: 1500 }),
      tool("t2", "2025-01-01T00:00:07Z", "running"),
    ],
  });

  assert.equal(view.now.kind, "tool");
  assert.deepEqual(view.now.activeTools, [{ id: "t2", name: "bash", args: { command: "t2" }, elapsedMs: 3000 }]);
  assert.deepEqual(view.timeline.map((row) => row.id), ["t2", "t1"]);
  assert.deepEqual(view.timeline.map((row) => row.durationMs), [3000, 1500]);
  assert.equal(view.timeline[0].status, "running");
  assert.equal(view.timeline[1].status, "error");
});

test("skills are labeled as skill steps, and older rounds use only loaded items", () => {
  const view = execView({
    ...base,
    selectedRound: "u1",
    phase: "thinking",
    items: [
      user("u1", "2025-01-01T00:00:00Z"),
      { id: "s1", ts: "2025-01-01T00:00:01Z", kind: "skill", name: "review", description: "Review" },
      assistant("a1", "2025-01-01T00:00:02Z"),
      user("u2", "2025-01-01T00:00:03Z"),
      tool("t2", "2025-01-01T00:00:04Z", "running"),
    ],
  });

  assert.deepEqual(view.rounds, [
    { id: "u1", ordinal: 1 },
    { id: "u2", ordinal: 2 },
  ]);
  assert.equal(view.selectedRound, "u1");
  assert.equal(view.now.kind, "idle");
  assert.deepEqual(view.timeline.map((row) => row.label), ["review"]);
  assert.equal(view.timeline[0].kind, "skill");
  assert.equal(view.timeline[0].args, "");
  assert.equal(view.timeline[0].durationMs, null);
});

test("round metrics subtract its baseline and count only non-todo tools and tool failures", () => {
  const start = { tokens: { total: 100 }, cost: 0.2, contextTokens: 1000, contextWindow: 10000 };
  const current = { tokens: { total: 175 }, cost: 0.45, contextTokens: 9000, contextWindow: 10000 };
  const view = execView({
    ...base,
    items: [
      user("u1", "2025-01-01T00:00:00Z"),
      tool("t1", "2025-01-01T00:00:02Z", "ok"),
      { ...tool("todo", "2025-01-01T00:00:03Z", "ok"), name: "todo" },
      { id: "s1", ts: "2025-01-01T00:00:04Z", kind: "skill", name: "review", description: "Review" },
      tool("t2", "2025-01-01T00:00:06Z", "error", { isError: true }),
      assistant("a1", "2025-01-01T00:00:08Z"),
    ],
    stats: current,
    roundStats: { u1: { baseline: start, final: current } },
  });

  assert.deepEqual(view.metrics, {
    durationMs: 8000,
    toolCount: 2,
    failureCount: 1,
    cost: 0.25,
    tokens: 75,
    main: { cost: 0.25, tokens: 75 },
    subagents: { cost: 0, tokens: 0 },
    contextTokens: 9000,
    contextWindow: 10000,
    contextPercent: 90,
  });
});

test("historical round metrics use that round's final snapshot", () => {
  const oldStart = { tokens: { total: 100 }, cost: 0.2, contextTokens: 1000, contextWindow: 10000 };
  const oldEnd = { tokens: { total: 140 }, cost: 0.45, contextTokens: 5000, contextWindow: 10000 };
  const current = { tokens: { total: 900 }, cost: 3, contextTokens: 8000, contextWindow: 10000 };
  const view = execView({
    ...base,
    selectedRound: "u1",
    items: [
      user("u1", "2025-01-01T00:00:00Z"),
      assistant("a1", "2025-01-01T00:00:04Z"),
      user("u2", "2025-01-01T00:00:05Z"),
      assistant("a2", "2025-01-01T00:00:09Z"),
    ],
    stats: current,
    roundStats: {
      u1: { baseline: oldStart, final: oldEnd },
      u2: { baseline: oldEnd, final: current },
    },
  });

  assert.equal(view.selectedRound, "u1");
  assert.deepEqual(view.metrics, {
    durationMs: 4000,
    toolCount: 0,
    failureCount: 0,
    cost: 0.25,
    tokens: 40,
    main: { cost: 0.25, tokens: 40 },
    subagents: { cost: 0, tokens: 0 },
    contextTokens: 5000,
    contextWindow: 10000,
    contextPercent: 50,
  });
});

test("waiting phase is distinct from idle", () => {
  const view = execView({ ...base, phase: "waiting", items: [user("u1", "2025-01-01T00:00:00Z")] });
  assert.equal(view.now.kind, "waiting");
});

test("plan progress excludes deleted tasks and resolves its listing round across the full index", () => {
  const view = execView({
    ...base,
    items: [user("u70", "2025-01-01T00:00:00Z")],
    plan: {
      listedRound: "u2",
      tasks: [
        { id: 1, subject: "已完成", status: "completed" },
        { id: 2, subject: "正在写", activeForm: "正在写测试", status: "in_progress" },
        { id: 3, subject: "等前置", status: "pending", blockedBy: [1, 2, 4, 99] },
        { id: 4, subject: "已删除", status: "deleted" },
      ],
    },
    planRounds: [{ id: "u2", ordinal: 2 }, { id: "u70", ordinal: 70 }],
  });

  assert.deepEqual(view.plan, {
    done: 1,
    total: 3,
    listedRound: "u2",
    listedRoundOrdinal: 2,
    activeTaskId: 2,
    tasks: [
      { id: 1, subject: "已完成", status: "completed", activeForm: undefined, waitingOn: [], stepCount: 0 },
      { id: 2, subject: "正在写", status: "in_progress", activeForm: "正在写测试", waitingOn: [], stepCount: 0 },
      { id: 3, subject: "等前置", status: "pending", activeForm: undefined, waitingOn: [2], stepCount: 0 },
    ],
  });
});

test("steps follow the in-progress plan task at their start and todo calls are not steps", () => {
  const snapshot = (activeId) => ({
    listedRound: "u1",
    tasks: [
      { id: 1, subject: "实现", status: activeId === 1 ? "in_progress" : "pending" },
      { id: 2, subject: "验证", status: activeId === 2 ? "in_progress" : "pending" },
    ],
  });
  const view = execView({
    ...base,
    items: [
      user("u1", "2025-01-01T00:00:00Z"),
      { ...tool("todo-1", "2025-01-01T00:00:01Z", "ok"), name: "todo", plan: snapshot(1) },
      tool("t1", "2025-01-01T00:00:02Z", "ok"),
      { id: "s1", ts: "2025-01-01T00:00:03Z", kind: "skill", name: "review", description: "Review" },
      { ...tool("todo-2", "2025-01-01T00:00:04Z", "ok"), name: "todo", plan: snapshot(2) },
      tool("t2", "2025-01-01T00:00:05Z", "ok"),
      { ...tool("todo-3", "2025-01-01T00:00:06Z", "ok"), name: "todo", plan: { listedRound: "u1", tasks: snapshot(null).tasks } },
      tool("t3", "2025-01-01T00:00:07Z", "ok"),
    ],
  });

  assert.deepEqual(view.timeline.map((row) => [row.id, row.planTaskId]), [
    ["t3", null],
    ["t2", 2],
    ["s1", 1],
    ["t1", 1],
  ]);
  assert.deepEqual(view.plan.tasks.map((task) => [task.id, task.stepCount]), [[1, 2], [2, 1]]);
});

test("historical and cross-round plan views use the latest snapshot through the selected round", () => {
  const firstPlan = {
    listedRound: "u1",
    tasks: [{ id: 1, subject: "跨轮任务", status: "in_progress" }],
  };
  const laterPlan = {
    listedRound: "u1",
    tasks: [{ id: 1, subject: "跨轮任务", status: "completed" }, { id: 2, subject: "后续任务", status: "in_progress" }],
  };
  const items = [
    user("u1", "2025-01-01T00:00:00Z"),
    { ...tool("todo-1", "2025-01-01T00:00:01Z", "ok"), name: "todo", plan: firstPlan },
    tool("t1", "2025-01-01T00:00:02Z", "ok"),
    user("u2", "2025-01-01T00:00:03Z"),
    tool("t2", "2025-01-01T00:00:04Z", "ok"),
    { ...tool("todo-2", "2025-01-01T00:00:05Z", "ok"), name: "todo", plan: laterPlan },
    tool("t3", "2025-01-01T00:00:06Z", "ok"),
    user("u3", "2025-01-01T00:00:07Z"),
    tool("t4", "2025-01-01T00:00:08Z", "ok"),
  ];
  const planRounds = [{ id: "u1", ordinal: 1 }, { id: "u2", ordinal: 2 }, { id: "u3", ordinal: 3 }];

  const historical = execView({ ...base, items, selectedRound: "u1", planRounds, plan: laterPlan });
  assert.deepEqual(historical.plan.tasks.map((task) => task.id), [1]);
  assert.deepEqual(historical.timeline.map((row) => [row.id, row.planTaskId]), [["t1", 1]]);

  const inherited = execView({ ...base, items, selectedRound: "u2", planRounds, plan: laterPlan });
  assert.deepEqual(inherited.plan.tasks.map((task) => [task.id, task.status]), [[1, "completed"], [2, "in_progress"]]);
  assert.deepEqual(inherited.timeline.map((row) => [row.id, row.planTaskId]), [["t3", 2], ["t2", 1]]);

  const laterWithoutTodo = execView({ ...base, items, selectedRound: "u3", planRounds, plan: laterPlan });
  assert.deepEqual(laterWithoutTodo.plan.tasks.map((task) => task.id), [1, 2]);
  assert.deepEqual(laterWithoutTodo.timeline.map((row) => [row.id, row.planTaskId]), [["t4", 2]]);
});

test("a missing or empty plan snapshot degrades to no plan", () => {
  const items = [user("u1", "2025-01-01T00:00:00Z")];
  assert.equal(execView({ ...base, items }).plan, null);
  assert.equal(execView({ ...base, items, plan: { listedRound: "u1", tasks: [] } }).plan, null);
});
