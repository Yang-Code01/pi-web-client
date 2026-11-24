/**
 * 帧词表 + 帧表（D388）：桥与页面之间那条 WS 上的 9 个「最要命」的帧，谁改什么字段、谁该重画什么。
 *
 * Run: node --experimental-strip-types web/tests/frames-unit.mjs
 *
 * 这一层只测纯函数。DOM 那颗在探针里把关（pending-badge / rail-ask / round5-asklost /
 * copilot-panel-resubscribe …），基线读数见 `.scratch/frame-vocab/baseline.txt`。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyFrame,
  approvalAddFrame,
  approvalRemoveFrame,
  askAddFrame,
  askRemoveFrame,
  copilotFrame,
  ctxlogFrame,
  lostAskHere,
  piStatusFrame,
  statsFrame,
  usageFrame,
} from "../src/frames.ts";

const S1 = "s1";
const S2 = "s2";

/** 一个能当 FrameView 用的假 App：只实现表会碰的那点东西。 */
function view(over = {}) {
  const v = {
    currentId: S1,
    session: { id: S1, running: false },
    sessions: [
      { id: S1, approvals: 0, asks: 0 },
      { id: S2, approvals: 0, asks: 0 },
    ],
    approvals: [],
    asks: [],
    askDrafts: new Map(),
    askLost: null,
    lastAnsweredAsk: null,
    askFolded: true,
    askAutoFolded: true,
    askDockMuted: true,
    usage: { contextTokens: null, contextWindow: 200_000 },
    stats: { tokens: null, cost: null },
    policy: null,
    copilot: null,
    ctxLogs: new Map(),
    rate: 0,
    turnAt: null,
    runSince: null,
    activity: "",
    stepCount: 3,
    execStreamChars: 5,
    execStreamText: "abc",
    phase: "idle",
    events: [],
    execTabLive: () => true,
    setExecPhase(phase) {
      v.phase = phase;
    },
    applyQueueTabEvent(event) {
      v.events.push(event);
    },
    ...over,
  };
  return v;
}

// ---------------------------------------------------------------- usage / stats / copilot

test("usage：这一轮的 output / 秒数算出速率，起始时刻用完就清掉", () => {
  const v = view({ turnAt: 1_000 });
  const out = applyFrame(v, usageFrame(S1, { output: 200 }), 3_000);
  assert.deepEqual(out, ["modelchip"]);
  assert.equal(v.rate, 100);
  assert.equal(v.turnAt, null);
});

test("usage：没有起始时刻 / 没有 output / 不是当前会话，都不算", () => {
  const noStart = view();
  assert.deepEqual(applyFrame(noStart, usageFrame(S1, { output: 200 }), 3_000), []);
  assert.equal(noStart.rate, 0);
  const noOut = view({ turnAt: 1_000 });
  assert.deepEqual(applyFrame(noOut, usageFrame(S1, { output: 0 }), 3_000), []);
  assert.equal(noOut.turnAt, 1_000, "没算成的时候起始时刻要留着，下一帧还能算");
  const other = view({ turnAt: 1_000 });
  assert.deepEqual(applyFrame(other, usageFrame(S2, { output: 200 }), 3_000), []);
  assert.equal(other.rate, 0);
});

test("stats：写进 stats / usage，重画顺序是 roundstats → modelchip → queue → context", () => {
  const v = view();
  const out = applyFrame(
    v,
    statsFrame(S1, { tokens: { input: 10, output: 20, total: 30 }, cost: 0.5, context: { tokens: 40, contextWindow: 200_000 }, policy: { maxTokens: 1 } }),
  );
  assert.deepEqual(out, ["roundstats", "modelchip", "queue", "context"]);
  assert.deepEqual(v.stats, { tokens: { input: 10, output: 20, total: 30 }, cost: 0.5 });
  assert.deepEqual(v.usage, { contextTokens: 40, contextWindow: 200_000 });
  assert.deepEqual(v.policy, { maxTokens: 1 });
});

test("stats：不带 policy 是「这一帧没说」，带 null 才是「清掉」", () => {
  const kept = view({ policy: { maxTokens: 1 } });
  applyFrame(kept, statsFrame(S1, { tokens: null, cost: null, context: null }));
  assert.deepEqual(kept.policy, { maxTokens: 1 });
  const cleared = view({ policy: { maxTokens: 1 } });
  applyFrame(cleared, statsFrame(S1, { tokens: null, cost: null, context: null, policy: null }));
  assert.equal(cleared.policy, null);
});

test("stats：context 里没给 contextWindow 时保留上一个（别把上下文条清成 0）", () => {
  const v = view();
  applyFrame(v, statsFrame(S1, { tokens: null, cost: null, context: { tokens: 40 } }));
  assert.deepEqual(v.usage, { contextTokens: 40, contextWindow: 200_000 });
});

test("stats / copilot：不是当前会话就什么都不画", () => {
  const v = view();
  assert.deepEqual(applyFrame(v, statsFrame(S2, { tokens: { total: 1 }, cost: 1, context: null })), []);
  assert.deepEqual(applyFrame(v, copilotFrame(S2, { hasCopilot: true, credits: 1, requests: 1, lastAt: null, otherCost: 0 })), []);
  assert.equal(v.stats.tokens, null);
});

test("copilot：hasCopilot 不为 true 就当没有（旧 bridge 不发这个帧）", () => {
  const yes = view();
  assert.deepEqual(applyFrame(yes, copilotFrame(S1, { hasCopilot: true, credits: 4.5, requests: 2, lastAt: null, otherCost: 0 })), [
    "roundstats",
    "modelchip",
    "queue",
  ]);
  assert.equal(yes.copilot.credits, 4.5);
  const no = view({ copilot: { hasCopilot: true } });
  applyFrame(no, copilotFrame(S1, { hasCopilot: false }));
  assert.equal(no.copilot, null);
});

test("stats / copilot：exec 页签没开着时不重画队列", () => {
  const v = view({ execTabLive: () => false });
  assert.deepEqual(applyFrame(v, statsFrame(S1, { tokens: null, cost: null, context: null })), ["roundstats", "modelchip", "context"]);
  assert.deepEqual(applyFrame(v, copilotFrame(S1, { hasCopilot: true })), ["roundstats", "modelchip"]);
});

// ---------------------------------------------------------------- ctxlog

test("ctxlog：增量只收有数字 seq 的行，full 整份替换", () => {
  const v = view();
  v.ctxLogs.set(S1, [{ seq: 1, kind: "a" }]);
  assert.deepEqual(applyFrame(v, ctxlogFrame(S1, { full: false, total: 3, lines: [{ seq: 1 }, { seq: 2 }, { other: "x" }] })), ["context"]);
  // 桥自己负责不重发（D215 的增量语义），页面只按原样追加、丢掉没有 seq 的行。
  assert.deepEqual(v.ctxLogs.get(S1), [{ seq: 1, kind: "a" }, { seq: 1 }, { seq: 2 }]);
  applyFrame(v, ctxlogFrame(S1, { full: true, total: 1, lines: [{ seq: 9 }] }));
  assert.deepEqual(v.ctxLogs.get(S1), [{ seq: 9 }]);
});

test("ctxlog：别的会话的行也存（切过去要画全量），但不重画", () => {
  const v = view();
  assert.deepEqual(applyFrame(v, ctxlogFrame(S2, { full: false, total: 1, lines: [{ seq: 1 }] })), []);
  assert.deepEqual(v.ctxLogs.get(S2), [{ seq: 1 }]);
});

// ---------------------------------------------------------------- pi.status

test("pi.status 开跑：清流、复位本轮计数、那一串重画都报出来", () => {
  const v = view();
  assert.deepEqual(applyFrame(v, piStatusFrame(S1, true), 0), [
    "hint",
    "continue",
    "retell",
    "failcta",
    "placeholder",
    "top",
    "sessions",
    "queue",
    "tabs",
    "modelchip",
  ]);
  assert.equal(v.session.running, true);
  assert.equal(v.phase, "waiting");
  assert.equal(v.activity, "思考中");
  assert.equal(v.stepCount, 0);
  assert.deepEqual([v.execStreamChars, v.execStreamText], [0, ""]);
  assert.equal(typeof v.runSince, "number");
});

test("pi.status 空闲：阶段回 idle、活动清空、速率时钟清掉", () => {
  const v = view({ turnAt: 5 });
  applyFrame(v, piStatusFrame(S1, false));
  assert.equal(v.session.running, false);
  assert.equal(v.phase, "idle");
  assert.equal(v.activity, "");
  assert.equal(v.turnAt, null);
});

test("pi.status：不是当前会话只改那颗胶囊 + 5 个无条件重画", () => {
  const v = view({ session: { id: S2, running: true } });
  assert.deepEqual(applyFrame(v, piStatusFrame(S2, false)), ["top", "sessions", "queue", "tabs", "modelchip"]);
  assert.equal(v.session.running, false);
  assert.equal(v.phase, "idle", "别的会话跑完不该改当前会话的阶段");
  assert.equal(v.activity, "");
});

// ---------------------------------------------------------------- approval.*

test("approval.add：当前会话进本地队列并推队列页签，计数加在列表上", () => {
  const v = view();
  const out = applyFrame(v, approvalAddFrame(S1, { id: "a1" }));
  assert.deepEqual(out, ["approvals", "queue", "tabs", "hint", "sessions"]);
  assert.deepEqual(v.approvals, [{ id: "a1" }]);
  assert.equal(v.sessions[0].approvals, 1);
  assert.deepEqual(v.events, [{ type: "approvals", count: 1 }]);
});

test("approval.add 别的会话：只计数，不动当前队列（D156 的另一半）", () => {
  const v = view();
  const out = applyFrame(v, approvalAddFrame(S2, { id: "a2" }));
  assert.deepEqual(out, ["approvals", "queue", "tabs", "hint", "sessions"]);
  assert.deepEqual(v.approvals, []);
  assert.equal(v.sessions[1].approvals, 1);
  assert.deepEqual(v.events, []);
});

test("approval.remove：从本地队列删掉、计数减回去（不减就永远「待确认」）", () => {
  const v = view({ approvals: [{ id: "a1" }, { id: "a9" }] });
  v.sessions[0].approvals = 1;
  const out = applyFrame(v, approvalRemoveFrame(S1, "a1", "approve"));
  assert.deepEqual(out, ["hint", "approvals", "queue", "tabs", "sessions"]);
  assert.deepEqual(v.approvals, [{ id: "a9" }]);
  assert.equal(v.sessions[0].approvals, 0);
  assert.deepEqual(v.events, [{ type: "approvals", count: 1 }]);
});

// ---------------------------------------------------------------- ask.*

const ask1 = { id: "q1", sessionId: S1, sessionName: "S1", questions: [{ id: "k1", prompt: "先问那个" }], createdAt: 0 };

test("ask.add：追加、复位折叠、给队列页签一个 arrived", () => {
  const v = view();
  const out = applyFrame(v, askAddFrame(S1, ask1, "tool"));
  assert.deepEqual(out, ["asks", "queue", "tabs", "sessions", "nowchip"]);
  assert.deepEqual(v.asks, [ask1]);
  assert.equal(v.sessions[0].asks, 1);
  assert.deepEqual([v.askFolded, v.askAutoFolded, v.askDockMuted], [false, false, false]);
  assert.deepEqual(v.events, [{ type: "asks", count: 1, arrived: true }]);
});

test("ask.add 别的会话：只计数 + 重画列表", () => {
  const v = view();
  assert.deepEqual(applyFrame(v, askAddFrame(S2, { ...ask1, sessionId: S2 }, "tool")), ["sessions"]);
  assert.deepEqual(v.asks, []);
  assert.equal(v.sessions[1].asks, 1);
});

test("ask.remove：填过答案就留一块残影（问卷没答完就关了）", () => {
  const v = view({ asks: [ask1], askFolded: false });
  v.askDrafts.set("q1", { active: 0, drafts: new Map([["k1", { id: "k1", label: "甲", value: "A" }]]) });
  const out = applyFrame(v, askRemoveFrame(S1, "q1", { status: "cancelled", reason: "工具被中断" }));
  assert.deepEqual(out, ["asks", "queue", "tabs", "sessions"]);
  assert.deepEqual(v.asks, []);
  assert.equal(v.sessions[0].asks, 0);
  assert.deepEqual(v.askLost, { sessionId: S1, id: "q1", title: "先问那个", reason: "工具被中断", lines: ["先问那个\n→ 甲"] });
});

test("ask.remove：自己刚答的不算「丢了」，空的也不留残影", () => {
  const mine = view({ asks: [ask1], lastAnsweredAsk: "q1" });
  mine.askDrafts.set("q1", { active: 0, drafts: new Map([["k1", { id: "k1", label: "甲", value: "A" }]]) });
  applyFrame(mine, askRemoveFrame(S1, "q1", { status: "answered", answers: { k1: "A" } }));
  assert.equal(mine.askLost, null);
  assert.equal(mine.lastAnsweredAsk, null);

  const empty = view({ asks: [ask1] });
  applyFrame(empty, askRemoveFrame(S1, "q1", { status: "answered", answers: {} }));
  assert.equal(empty.askLost, null);
});

test("ask.remove 别的会话：不建残影，但计数照样回落", () => {
  const v = view({ asks: [ask1] });
  v.sessions[1].asks = 1;
  v.askDrafts.set("q1", { active: 0, drafts: new Map([["k1", { id: "k1", label: "甲", value: "A" }]]) });
  applyFrame(v, askRemoveFrame(S2, "q1", { status: "cancelled", reason: "x" }));
  assert.equal(v.sessions[1].asks, 0, "那张卡上的「待回答」必须掉下来");
  assert.equal(v.askLost, null, "只给当前会话留残影");
});

test("残影只属于丢问卷的那个会话：切到别的会话不画它", () => {
  const lost = { sessionId: S1, id: "q1", title: "先问那个", reason: "工具被中断", lines: ["先问那个\n→ 甲"] };
  assert.deepEqual(lostAskHere(view({ askLost: lost })), lost, "自己的会话里照画");
  assert.equal(lostAskHere(view({ askLost: lost, currentId: S2 })), null, "别的会话不画");
  assert.equal(lostAskHere(view({ askLost: lost, currentId: null })), null, "没开会话也不画");
  // 同一会话里又来了一份问卷：先答新的，残影别抢位置。
  const busy = view({ askLost: lost, asks: [ask1] });
  assert.equal(lostAskHere(busy), null);
  assert.equal(lostAskHere(view({ askLost: null })), null);
});

test("不认识的帧：什么都不画（119 个还没搬进表的帧走这条路）", () => {
  const v = view();
  assert.deepEqual(applyFrame(v, { type: "catalog" }), []);
  assert.deepEqual(applyFrame(v, { type: "connect" }), []);
});

// ---------------------------------------------------------------- 构造器：键名漂移守卫

const keys = (o) => Object.keys(o).sort();

test("9 个构造器发出去的键名与类型是钉死的（桥与页面对不上就是这里先红）", () => {
  assert.deepEqual(keys(usageFrame(S1, null)), ["sessionId", "type", "usage"]);
  assert.deepEqual(keys(statsFrame(S1, {})), ["sessionId", "type"]);
  assert.deepEqual(keys(copilotFrame(S1, { hasCopilot: true })), ["hasCopilot", "sessionId", "type"]);
  assert.deepEqual(keys(ctxlogFrame(S1, { full: true, total: 0, lines: [] })), ["full", "lines", "sessionId", "total", "type"]);
  assert.deepEqual(keys(piStatusFrame(S1, true)), ["running", "sessionId", "type"]);
  assert.deepEqual(keys(approvalAddFrame(S1, {})), ["approval", "sessionId", "type"]);
  assert.deepEqual(keys(approvalRemoveFrame(S1, "a", "approve")), ["decision", "id", "sessionId", "type"]);
  assert.deepEqual(keys(askAddFrame(S1, {}, "t")), ["ask", "sessionId", "tool", "type"]);
  assert.deepEqual(keys(askRemoveFrame(S1, "q", { status: "answered", answers: {} })), ["answers", "id", "sessionId", "status", "type"]);
  assert.deepEqual(keys(askRemoveFrame(S1, "q", { status: "cancelled", reason: "x" })), ["id", "reason", "sessionId", "status", "type"]);
});

test("构造器发出来的帧回到表里，仍然是那一帧（同一份词表两端都认）", () => {
  const v = view();
  assert.deepEqual(applyFrame(v, piStatusFrame(S1, false)).length > 0, true);
  assert.deepEqual(applyFrame(v, statsFrame(S2, { tokens: { total: 1 } })), []);
  assert.deepEqual(applyFrame(view({ turnAt: 0 }), usageFrame(S1, { output: 10 }), 2_000), ["modelchip"]);
});

// ---------------------------------------------------------------- 表与 App 的对齐守卫

const appSrc = () => readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
const framesSrc = () => readFileSync(new URL("../src/frames.ts", import.meta.url), "utf8");

/** `export interface FrameView { … }` 里的字段名与三个方法名。 */
function frameViewNames() {
  const src = framesSrc();
  const at = src.indexOf("export interface FrameView {");
  assert.ok(at > 0, "frames.ts 里找不到 FrameView");
  const body = src.slice(at, src.indexOf("\n}", at));
  return body
    .split("\n")
    .map((line) => /^ {2}([A-Za-z]+)(\?)?\s*[:(]/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);
}

test("FrameView 的每个字段/方法在 App 里都是 private 的（表只碰 App 真有的东西）", () => {
  const names = frameViewNames();
  assert.ok(names.length >= 20, `FrameView 只认出 ${names.length} 个名字，提取坏了`);
  for (const name of names) {
    // `private askDrafts = new Map…` 与 `private execTabLive(): boolean {` 两种都得认
    const re = new RegExp(`^ {2}private ${name}\\b`, "m");
    assert.ok(re.test(appSrc()), `FrameView.${name} 在 app.ts 里没有对应的 private ${name}`);
  }
});

test("每个 RedrawKey 在 App 的 redraw() 里都有对应的绘制", () => {
  const src = framesSrc();
  const at = src.indexOf("export type RedrawKey =");
  const body = src.slice(at, src.indexOf(";", at));
  const keyList = [...body.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(keyList.length >= 15, `RedrawKey 只认出 ${keyList.length} 个键，提取坏了`);
  const app = appSrc();
  for (const k of keyList) assert.ok(app.includes(`case "${k}":`), `redraw() 少了 case "${k}"`);
});
