import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/sessions.ts";
import { policyView } from "../src/context-policy.ts";

/**
 * #484：「判定 → 动作」这一段在 Session 里，接的是 pi 的进程，不能用真的。这里只钉四件事：
 * 什么时候该压、什么时候该交接、两者同时武装时交接优先、以及重复触发不会连环发生。
 * 用 `new Session("pi", null, {id})` 这个构造 seam（同 ask-unit.mjs），rpc 换成一个只会应答的假件。
 */
function makeSession(id = "context-session-unit") {
  const session = new Session("pi", null, { id });
  const ws = [];
  const handoffs = [];
  const compacts = [];
  session.on("ws", (p) => ws.push(p));
  session.on("handoff", (p) => handoffs.push(p));
  session.rpc = {
    alive: true,
    request: async () => ({}),
    fire: () => {},
    kill: () => {},
  };
  session.compact = async () => {
    compacts.push(1);
  };
  return { session, ws, handoffs, compacts };
}

const view = (over) =>
  policyView({
    layers: {
      global: { autoCompactPercent: 70, autoHandoffEnabled: true, autoHandoffPercent: 85 },
      project: {},
      session: {},
      ...(over?.layers ?? {}),
    },
    compactionEnabled: over?.compactionEnabled ?? true,
    window: over?.window ?? 200_000,
    used: over?.used ?? 150_000,
  });

test("#484 到交接线时发 handoff 事件，而不是直接压缩", () => {
  const { session, handoffs, compacts } = makeSession();
  const v = view({ used: 175_000 }); // 87.5%：过交接线 85%
  assert.equal(v.decision.action, "handoff");
  session.maybeContextAction(v);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].percent, v.handoff.percent);
  assert.equal(compacts.length, 0);
});

test("#484 没到线什么都不做", () => {
  const { session, handoffs, compacts } = makeSession();
  session.maybeContextAction(view({ used: 100_000 }));
  assert.equal(handoffs.length, 0);
  assert.equal(compacts.length, 0);
});

test("#484 到压缩线且不在跑：压一次；再刷新不会重复压", () => {
  const { session, compacts, ws } = makeSession();
  const v = view({ layers: { global: { autoCompactPercent: 70 } }, window: 200_000, used: 145_000 });
  assert.equal(v.decision.action, "compact");
  session.maybeContextAction(v);
  session.maybeContextAction(v);
  assert.equal(compacts.length, 1);
  assert.ok(ws.some((p) => p.type === "notice" && /自动压缩/.test(p.text)));
});

test("#484 还在跑：压缩等到这一轮结束（不中断）", () => {
  const { session, compacts } = makeSession();
  session.state.running = true;
  session.maybeContextAction(view({ layers: { global: { autoCompactPercent: 70 } }, window: 200_000, used: 145_000 }));
  assert.equal(compacts.length, 0);
});

test("#484 随手问会话从不确定压缩（也不交接）", () => {
  const { session, compacts, handoffs } = makeSession();
  session.state.scratch = true;
  session.maybeContextAction(view({ used: 199_000 }));
  assert.equal(compacts.length, 0);
  assert.equal(handoffs.length, 0);
});

test("#484 已经交接出去的旧会话不再触发（链式交接不回到旧会话）", () => {
  const { session, compacts, handoffs } = makeSession();
  session.state.handoffTo = "next-id";
  session.maybeContextAction(view({ used: 199_000 }));
  assert.equal(compacts.length, 0);
  assert.equal(handoffs.length, 0);
});

test("#484 交接正在进行时不重复喊（占位先于 await）", () => {
  const { session, handoffs } = makeSession();
  session.handoffPending = true;
  session.maybeContextAction(view({ used: 199_000 }));
  assert.equal(handoffs.length, 0);
});

test("#484 交接失败后 5 分钟内不再自动重试", () => {
  const { session, handoffs } = makeSession();
  session.noteHandoffFailure();
  session.maybeContextAction(view({ used: 199_000 }));
  assert.equal(handoffs.length, 0);
});

test("#484 交接开着但没设百分比：不压制压缩（否则等于两个都关）", () => {
  const { session, compacts } = makeSession();
  const v = view({
    layers: { global: { autoCompactPercent: 70, autoHandoffEnabled: true } },
    window: 200_000,
    used: 145_000,
  });
  assert.equal(v.handoff, null); // 没设百分比 = 未武装（开关开着也不算数）
  assert.equal(v.decision.action, "compact");
  session.maybeContextAction(v);
  assert.equal(compacts.length, 1);
});
