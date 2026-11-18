/**
 * 浏览器面板第一步（#503）：纯模型、无 DOM。
 *
 * 只测外部行为：给定会话 items，得到哪些卡片、什么状态、哪些子步骤。不测内部函数拆分。
 * Run: node --experimental-strip-types web/tests/browser-ops-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { browserOpsView } from "../src/browser-ops.ts";

const T0 = Date.parse("2026-11-18T10:00:00Z");
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const NOW = T0 + 600_000;

const user = (id, sec, text = "跑一下") => ({ id, kind: "user", text, images: [], ts: at(sec) });
const assistant = (id, sec, text) => ({ id, kind: "assistant", text, thinking: "", ts: at(sec) });
const tool = (id, sec, name, args, extra = {}) => ({
  id,
  kind: "tool",
  toolCallId: `call-${id}`,
  name,
  args,
  status: "ok",
  ts: at(sec),
  ...extra,
});
/** browser-use 的真实形状：外部工具名 + args.tool + args.args。 */
const bu = (id, sec, code, extra = {}) =>
  tool(id, sec, "mcp__browser_use", { tool: "browser_exec", args: { code } }, extra);

const base = { now: NOW };

test("会话里没有浏览器调用 → 空视图", () => {
  const view = browserOpsView({ ...base, items: [user("u1", 0), tool("t1", 1, "bash", { command: "ls" })] });
  assert.equal(view.cards.length, 0);
  assert.equal(view.total, 0);
  assert.equal(view.empty, true);
});

test("一次 browser_exec 成为一张卡片：工具名、起止、整次耗时、状态", () => {
  const view = browserOpsView({
    ...base,
    items: [user("u1", 0), bu("t1", 10, "print('hi')", { durationMs: 48_000 })],
  });
  assert.equal(view.cards.length, 1);
  const [card] = view.cards;
  assert.equal(card.tool, "mcp__browser_use");
  assert.equal(card.toolCallId, "call-t1");
  assert.equal(card.durationMs, 48_000);
  assert.equal(card.state, "done");
  assert.equal(card.output, "");
});

test("意图取自调用前模型最后一段话", () => {
  const view = browserOpsView({
    ...base,
    items: [
      user("u1", 0),
      assistant("a1", 5, "先确认对话框结构。"),
      assistant("a2", 6, "确认完再点按钮。"),
      bu("t1", 10, "print('hi')", { durationMs: 1_000 }),
    ],
  });
  assert.equal(view.cards[0].intent, "确认完再点按钮。");
});

test("没有前置 assistant 时意图是空串，不编", () => {
  const view = browserOpsView({ ...base, items: [user("u1", 0), bu("t1", 10, "print('hi')", { durationMs: 1 }) ] });
  assert.equal(view.cards[0].intent, "");
});

/** 一段代码 → 一张卡片，省掉每处重复的脚手架。 */
const stepsOf = (code) =>
  browserOpsView({ ...base, items: [user("u1", 0), bu("t1", 10, code, { durationMs: 1_000 })] }).cards[0].steps;

const shape = (step) => ({ kind: step.kind, target: step.target, name: step.name });

test("goto_url / wait_for_load / js 各自一步，网址进 target", () => {
  const steps = stepsOf(
    ["goto_url('http://172.28.1.60/record/my')", "wait_for_load(timeout=15)", "print(js('document.title'))"].join("\n"),
  );
  assert.deepEqual(steps.map(shape), [
    { kind: "nav", target: "http://172.28.1.60/record/my", name: undefined },
    { kind: "wait", target: undefined, name: undefined },
    { kind: "js", target: "document.title", name: undefined },
  ]);
});

test("多行脚本里的每一步都算，缩进与空行不影响", () => {
  const steps = stepsOf(
    [
      "info = page_info()",
      "    print('url =', info.get('url'))",
      "",
      "import time",
      "time.sleep(1.5)",
    ].join("\n"),
  );
  assert.deepEqual(steps.map((s) => s.kind), ["read", "print", "wait"]);
});

test("js 片段折成一行、截断 80 字", () => {
  const long = "document.querySelector('#account').value + '" + "\n".repeat(0) + "x'.repeat(200)";
  const steps = stepsOf(`js("""${long}""")`);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, "js");
  assert.ok(steps[0].target.length <= 80, steps[0].target);
  assert.ok(!steps[0].target.includes("\n"));
});

test("坐标点击与 CDP 方法各记一步", () => {
  const steps = stepsOf("click_at_xy(412, 318)\ncdp('Page.navigate', {'url': 'http://x/'})");
  assert.deepEqual(steps.map(shape), [
    { kind: "click", target: "412, 318", name: undefined },
    { kind: "cdp", target: "Page.navigate", name: undefined },
  ]);
});

test("认不出的自家函数记成 call，带上函数名", () => {
  const steps = stepsOf("ev = drain_events()");
  assert.deepEqual(steps.map(shape), [{ kind: "call", target: undefined, name: "drain_events" }]);
});

test("拆不动的代码整段落成 raw，不抛", () => {
  const steps = stepsOf("(((( 这行不是 python");
  assert.deepEqual(steps.map((s) => s.kind), ["raw"]);
  assert.ok(steps[0].target.includes("这行不是 python"));
});

const runningCard = (args, extra) =>
  browserOpsView({ ...base, items: [user("u1", 0), tool("t1", 0, "mcp__browser_use", args, { status: "running", ...extra })] })
    .cards[0];

test("还在跑：耗时按 now - 开始算，60 秒黄、120 秒红", () => {
  const args = { tool: "browser_exec", args: { code: "print('hi')" } };
  const started = T0;
  const fast = browserOpsView({ ...base, now: started + 5_000, items: [tool("t1", 0, "mcp__browser_use", args, { status: "running" })] }).cards[0];
  assert.equal(fast.state, "running");
  assert.equal(fast.durationMs, 5_000);
  const slow = browserOpsView({ ...base, now: started + 65_000, items: [tool("t1", 0, "mcp__browser_use", args, { status: "running" })] }).cards[0];
  assert.equal(slow.state, "slow");
  const stuck = browserOpsView({ ...base, now: started + 130_000, items: [tool("t1", 0, "mcp__browser_use", args, { status: "running" })] }).cards[0];
  assert.equal(stuck.state, "stuck");
});

test("无声：有输出过、20 秒没更新，running 上加标记；从没输出过就不算", () => {
  const args = { tool: "browser_exec", args: { code: "print('hi')" } };
  const withOutput = browserOpsView({
    ...base,
    now: T0 + 40_000,
    outputAt: { "call-t1": T0 + 10_000 },
    items: [tool("t1", 0, "mcp__browser_use", args, { status: "running", partialResult: "账号已填好" })],
  }).cards[0];
  assert.equal(withOutput.silent, true);
  assert.equal(withOutput.state, "running");
  assert.equal(withOutput.silentFor, 30_000);
  const quiet = runningCard(args, { status: "running", partialResult: "账号已填好" });
  assert.equal(quiet.silent, false);
  assert.equal(quiet.silentFor, null);
});

test("跑着的时候输出取这轮的 partial，不是最终 result；阈值可从外面改", () => {
  const args = { tool: "browser_exec", args: { code: "wait_for_load()" } };
  const running = browserOpsView({
    ...base,
    now: T0 + 8_000,
    thresholds: { slowMs: 5_000 },
    items: [tool("t1", 0, "mcp__browser_use", args, { status: "running", partialResult: "waiting for load…" })],
  }).cards[0];
  assert.equal(running.output, "waiting for load…");
  assert.equal(running.state, "slow");
  const done = browserOpsView({ ...base, items: [tool("t1", 0, "mcp__browser_use", args, { status: "ok", result: "ok", durationMs: 2_000 })] }).cards[0];
  assert.equal(done.output, "ok");
});

test("打转：同一动作连续三次 → 标 looping，那一步带 repeat=3", () => {
  const code = ["goto_url('http://x/')", "goto_url('http://x/')", "goto_url('http://x/')", "print('hi')"].join("\n");
  const card = browserOpsView({ ...base, items: [user("u1", 0), bu("t1", 10, code, { durationMs: 1_000 })] }).cards[0];
  assert.equal(card.looping, true);
  assert.equal(card.steps[0].repeat, 3);
});

test("失败的工具调用 → failed，不冒充 done", () => {
  const card = browserOpsView({ ...base, items: [user("u1", 0), bu("t1", 10, "print('hi')", { status: "error", isError: true, durationMs: 900 })] }).cards[0];
  assert.equal(card.state, "failed");
});

test("汇总行：次数、总耗时、最慢一次、当前在跑的是哪张", () => {
  const view = browserOpsView({
    ...base,
    now: T0 + 30_000,
    items: [
      user("u1", 0),
      bu("t1", 1, "print(1)", { durationMs: 10_000 }),
      bu("t2", 2, "print(2)", { durationMs: 20_000 }),
      bu("t3", 20, "print(3)", { status: "running" }),
    ],
  });
  assert.equal(view.total, 3);
  assert.equal(view.totalMs, 40_000);
  assert.equal(view.slowestMs, 20_000);
  assert.deepEqual(view.current, { state: "running", ms: 10_000 });
});

test("子代理的调用并进同一时间线，卡片标上子代理名", () => {
  const view = browserOpsView({
    ...base,
    items: [user("u1", 0), tool("m1", 1, "bash", { command: "ls" })],
    childRuns: [{ name: "browser-lane", items: [bu("c1", 5, "goto_url('http://x/')", { durationMs: 3_000 })] }],
  });
  assert.equal(view.cards.length, 1);
  assert.equal(view.cards[0].subagent, "browser-lane");
});

test("有头无头：args 里写了 headless 才标，没写是 null", () => {
  const quiet = browserOpsView({ ...base, items: [bu("t1", 1, "print(1)", { durationMs: 1 })] }).cards[0];
  assert.equal(quiet.headed, null);
  const headless = browserOpsView({
    ...base,
    items: [tool("t1", 1, "mcp__browser_use", { headless: true, tool: "browser_exec", args: { code: "print(1)" } }, { durationMs: 1 })],
  }).cards[0];
  assert.equal(headless.headed, false);
  const headed = browserOpsView({
    ...base,
    items: [tool("t1", 1, "mcp__browser_use", { headless: false, tool: "browser_exec", args: { code: "print(1)" } }, { durationMs: 1 })],
  }).cards[0];
  assert.equal(headed.headed, true);
  const unknown = browserOpsView({ ...base, items: [tool("t1", 1, "mcp__playwright", { url: "http://x/" }, { durationMs: 1 })] }).cards[0];
  assert.equal(unknown.headed, null);
});

test("Playwright 那种扁平参数：一个调用一步", () => {
  const view = browserOpsView({
    ...base,
    items: [tool("t1", 1, "mcp__playwright", { tool: "browser_click", element: "登录按钮" }, { durationMs: 1 })],
  });
  assert.deepEqual(view.cards[0].steps.map(shape), [{ kind: "click", target: "登录按钮", name: undefined }]);
});

test("白名单可改：自定义工具名也算，默认列表之外的不算", () => {
  const items = [user("u1", 0), tool("t1", 1, "mcp__my_bot", { url: "http://x/" }, { durationMs: 1 })];
  assert.equal(browserOpsView({ ...base, items }).cards.length, 0);
  assert.equal(browserOpsView({ ...base, items, tools: ["my_bot"] }).cards.length, 1);
});
