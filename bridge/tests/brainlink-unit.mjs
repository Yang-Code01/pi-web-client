/**
 * BrainLink 的失败路径单测（不需要真壳）：
 * ① 壳断开时，挂着的 spawn/attach 立刻 reject 成「连接断开」，不等 15 秒超时；
 * ② hello 在握手前断开也立刻 reject，不等 10 秒；
 * ③ 失败应答的类型必须和调用方等的 failType 对上，错配要报出来。
 *
 * Run: node bridge/tests/brainlink-unit.mjs   (needs bridge/dist built)
 */
import assert from "node:assert/strict";
import { BrainLink } from "../dist/brainlink.js";

function fakeConn() {
  return {
    alive: true,
    sent: [],
    msg: null,
    close: null,
    onMessage(fn) {
      this.msg = fn;
    },
    onClose(fn) {
      this.close = fn;
    },
    send(msg) {
      this.sent.push(msg);
    },
    shutdown() {
      this.alive = false;
      this.close?.();
    },
  };
}

// ① spawn 挂起时壳断开
{
  const conn = fakeConn();
  const link = new BrainLink(conn);
  const asked = link.spawnSession({ sessionId: "s1", argv: [], cwd: "/tmp", env: {} });
  assert.equal(conn.sent[0]?.t, "spawn");
  conn.shutdown();
  await assert.rejects(asked, /壳连接断开/);
}

// ② hello 还没等到 welcome 就断开
{
  const conn = fakeConn();
  const link = new BrainLink(conn);
  const hello = link.hello({ buildId: "b1", internalPort: 9 });
  conn.shutdown();
  await assert.rejects(hello, /握手完成前断开/);
}

// ③ 失败帧类型错配：attach-failed 不该结算成 spawn 的失败
{
  const conn = fakeConn();
  const link = new BrainLink(conn);
  const asked = link.spawnSession({ sessionId: "s2", argv: [], cwd: "/tmp", env: {} });
  const rid = conn.sent[0]?.rid;
  conn.msg({ t: "attach-failed", rid, reason: "wrong" });
  await assert.rejects(asked, /调用方等的是 spawn-failed/);
}

// ④ 对上了就按原样拒绝
{
  const conn = fakeConn();
  const link = new BrainLink(conn);
  const asked = link.attachSession("s3");
  const rid = conn.sent[0]?.rid;
  conn.msg({ t: "attach-failed", rid, reason: "no-child" });
  await assert.rejects(asked, /^Error: no-child$/);
}

console.log("brainlink-unit: ok");
