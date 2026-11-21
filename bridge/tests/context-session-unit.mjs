import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// ---------------------------------------------------------------- D358：ctxlog 只读尾部窗口

/**
 * 一个 8 MB 的组成日志：每行 ~230 字节，最后 2 MB 约 9000 行。
 * 这条用例钉两件事 —— 订阅那一刻读的量有上限，以及 (size, mtime) 没变就不再读盘。
 */
test("D358 大会话的 ctxlog 只读尾部窗口，`omitted` 报出没下发的字节数", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "pw-ctxlog-"));
  const prev = process.env.PI_WEB_STATE;
  process.env.PI_WEB_STATE = state;
  try {
    const id = "aaaabbbb-1111-2222-3333-444455556666";
    const file = path.join(state, "ctxlog", id.slice(0, 8), `${id}.ctx.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pad = "x".repeat(150);
    const rows = [];
    for (let i = 1; i <= 40_000; i++) rows.push(JSON.stringify({ v: 3, seq: i, kind: "activity", label: `row ${i} ${pad}` }));
    fs.writeFileSync(file, `${rows.join("\n")}\n`);
    const size = fs.statSync(file).size;
    assert.ok(size > 7 * 1024 * 1024, `夹具要够大（实测 ${size} 字节）`);

    const { session, ws } = makeSession(id);
    const lines = session.readContextLog();
    // 尾部 2 MB：行不能再多，也不能把半行当一行吞进来。
    assert.ok(lines.length > 1000 && lines.length < 40_000, `只该读到尾部一段（读到 ${lines.length} 行）`);
    assert.ok(lines.at(-1).seq === 40_000, "最后一行必须是文件末尾那行");
    const bytes = lines.reduce((n, l) => n + JSON.stringify(l).length, 0);
    assert.ok(bytes < 3 * 1024 * 1024, `读到的对象不该超过窗口量级（${(bytes / 1048576).toFixed(1)}MB）`);

    await session.emitContextLog(true);
    const frame = ws.find((p) => p.type === "ctxlog");
    assert.ok(frame, "订阅后要有 ctxlog 帧");
    assert.equal(frame.full, true);
    assert.equal(frame.total, lines.length);
    assert.ok(frame.omitted > 5 * 1024 * 1024, `omitted 要报出被截掉的字节（${frame.omitted}）`);
    assert.equal(frame.lines.length, lines.length);

    // 文件没动 → 第二次是一条缓存捷径（同一个数组），也绝不重读盘。
    const again = session.readContextLog();
    assert.equal(again, lines, "size/mtime 未变时返回同一份缓存");

    // 追加一行 → 缓存失效，新行必须在。
    fs.appendFileSync(file, `${JSON.stringify({ v: 3, seq: 40_001, kind: "activity", label: "tail" })}\n`);
    const grown = session.readContextLog();
    assert.equal(grown.at(-1).seq, 40_001, "追加之后要看得到新行");
  } finally {
    if (prev === undefined) delete process.env.PI_WEB_STATE;
    else process.env.PI_WEB_STATE = prev;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("D358 小文件（小于窗口）整份都在，omitted 是 0", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "pw-ctxlog-"));
  const prev = process.env.PI_WEB_STATE;
  process.env.PI_WEB_STATE = state;
  try {
    const id = "ccccdddd-1111-2222-3333-444455556666";
    const file = path.join(state, "ctxlog", id.slice(0, 8), `${id}.ctx.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [1, 2, 3].map((i) => JSON.stringify({ v: 3, seq: i, kind: "activity", label: `r${i}` })).join("\n") + "\n");
    const { session, ws } = makeSession(id);
    await session.emitContextLog(true);
    const frame = ws.find((p) => p.type === "ctxlog");
    assert.equal(frame.omitted, 0);
    assert.deepEqual(frame.lines.map((l) => l.seq), [1, 2, 3]);
  } finally {
    if (prev === undefined) delete process.env.PI_WEB_STATE;
    else process.env.PI_WEB_STATE = prev;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("D358 窗口被顶出去之后，增量帧不会把旧行当新行重发（要么只发新行，要么整段替换）", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "pw-ctxlog-"));
  const prev = process.env.PI_WEB_STATE;
  process.env.PI_WEB_STATE = state;
  try {
    const id = "eeeeffff-1111-2222-3333-444455556666";
    const file = path.join(state, "ctxlog", id.slice(0, 8), `${id}.ctx.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pad = "y".repeat(200);
    const row = (i) => JSON.stringify({ v: 3, seq: i, kind: "activity", label: `r${i} ${pad}` });
    let seq = 0;
    const write = (n) => {
      const rows = [];
      for (let i = 0; i < n; i++) rows.push(row(++seq));
      fs.appendFileSync(file, `${rows.join("\n")}\n`);
    };
    write(9000); // ~2.5 MB：已经超过 2 MB 窗口
    const { session, ws } = makeSession(id);
    await session.emitContextLog(true);
    const full = ws.filter((p) => p.type === "ctxlog").at(-1);
    assert.equal(full.full, true);

    // 再写 25k 行（~6 MB）：整段旧窗口都被顶出去，基线那行已经不在文件里了。
    write(25_000);
    ws.length = 0;
    await session.emitContextLog(false);
    const inc = ws.filter((p) => p.type === "ctxlog").at(-1);
    assert.ok(inc, "追加之后要有一帧");
    assert.equal(inc.full, true, "窗口翻过基线时按整段重发（前端 full 是替换，不会叠加）");
    assert.ok(inc.lines.length > 1000 && inc.lines.length < 20_000, `整段也只有窗口那么大（${inc.lines.length} 行）`);

    // 再追加一点点：这次基线还在窗口里，应该只是「新行」。
    write(20);
    ws.length = 0;
    await session.emitContextLog(false);
    const small = ws.filter((p) => p.type === "ctxlog").at(-1);
    assert.ok(small, "再追加也要有一帧");
    assert.equal(small.full, false, "基线还在窗口里 → 只发新增");
    assert.equal(small.lines.length, 20, `只该发这 20 行（发了 ${small.lines.length}）`);
    assert.equal(small.lines.at(-1).seq, seq);
  } finally {
    if (prev === undefined) delete process.env.PI_WEB_STATE;
    else process.env.PI_WEB_STATE = prev;
    fs.rmSync(state, { recursive: true, force: true });
  }
});
