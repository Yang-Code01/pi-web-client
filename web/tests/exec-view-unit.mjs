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
const base = { phase: "idle", streamChars: 0, selectedRound: null, now: Date.parse("2025-01-01T00:00:10Z") };

test("an idle view with no loaded turns has an empty previous-turn summary", () => {
  assert.deepEqual(execView({ ...base, items: [] }), {
    now: { kind: "idle", previousDurationMs: null, succeeded: null, activeTools: [] },
    timeline: [],
    rounds: [],
    selectedRound: null,
    plan: null,
  });
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
      { id: 1, subject: "已完成", status: "completed", activeForm: undefined, waitingOn: [] },
      { id: 2, subject: "正在写", status: "in_progress", activeForm: "正在写测试", waitingOn: [] },
      { id: 3, subject: "等前置", status: "pending", activeForm: undefined, waitingOn: [2] },
    ],
  });
});

test("a missing or empty plan snapshot degrades to no plan", () => {
  const items = [user("u1", "2025-01-01T00:00:00Z")];
  assert.equal(execView({ ...base, items }).plan, null);
  assert.equal(execView({ ...base, items, plan: { listedRound: "u1", tasks: [] } }).plan, null);
});
