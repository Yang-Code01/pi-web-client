/**
 * 有壳时 RpcChild 的认领窗口：
 * attach 落地前写下的帧先排队；认领后如果壳的 stdin 已经写不进去，不能让帧被悄悄丢掉 ——
 * 必须让等待中的 request 立刻失败，而不是等 5 秒超时。
 *
 * Run: node bridge/tests/rpc-linked-unit.mjs   (needs bridge/dist built)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RpcChild } from "../dist/rpc.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-rpc-link-"));
const logPath = path.join(tmp, "rpc.log");
let resolveAttach;

const link = {
  watch: () => () => {},
  attachSession: () =>
    new Promise((resolve) => {
      resolveAttach = resolve;
    }),
  spawnSession: () => {
    throw new Error("adopt 失败时不许新开进程");
  },
  stdin: () => false,
  ack: () => {},
  kill: () => {},
};

const rpc = new RpcChild({
  cli: "fake-pi",
  args: [],
  cwd: tmp,
  logPath,
  sessionId: "s1",
  link,
  adoptOnly: true,
});
rpc.start();
const asked = rpc.request("get_state", {}, 5000);
resolveAttach({
  pid: 42,
  pending: { fromSeq: 0, toSeq: 0, lines: [], overflowed: false },
  lastWritten: 0,
});
await assert.rejects(asked, /认领后补发失败/);
const claim = await rpc.whenLinked();
assert.ok("error" in claim, "认领失败要如实告诉 adopt()");
assert.match(String(claim.error.message), /认领后补发失败/);
assert.equal(rpc.alive, false, "补发失败等于这条链路已经死了");

// attach 快照说进程已经退出：不能把它当活进程认领成功。
const logPath3 = path.join(tmp, "rpc3.log");
let resolveAttach3;
const link3 = {
  watch: () => () => {},
  attachSession: () =>
    new Promise((resolve) => {
      resolveAttach3 = resolve;
    }),
  spawnSession: () => {
    throw new Error("adopt 失败时不许新开进程");
  },
  stdin: () => true,
  ack: () => {},
  kill: () => {},
};
const rpc3 = new RpcChild({
  cli: "fake-pi",
  args: [],
  cwd: tmp,
  logPath: logPath3,
  sessionId: "s3",
  link: link3,
  adoptOnly: true,
});
rpc3.start();
const claim3Promise = rpc3.whenLinked();
resolveAttach3({
  pid: 43,
  pending: { fromSeq: 0, toSeq: 0, lines: [], overflowed: false },
  lastWritten: 0,
  lastExit: { code: 1, signal: null },
});
const claim3 = await claim3Promise;
assert.ok("error" in claim3, "attach 说进程已经退出时 adopt() 必须失败");
assert.match(String(claim3.error.message), /已经退出/);
assert.equal(rpc3.alive, false, "已经退出的进程不能保持可用");

// 认领一直不落地时，队列必须有上限：超过就结算整条链路，而不是无限攒帧。
const logPath2 = path.join(tmp, "rpc2.log");
let resolveAttach2;
const link2 = {
  watch: () => () => {},
  attachSession: () =>
    new Promise((resolve) => {
      resolveAttach2 = resolve;
    }),
  spawnSession: () => {
    throw new Error("adopt 失败时不许新开进程");
  },
  stdin: () => true,
  ack: () => {},
  kill: () => {},
};
const rpc2 = new RpcChild({
  cli: "fake-pi",
  args: [],
  cwd: tmp,
  logPath: logPath2,
  sessionId: "s2",
  link: link2,
  adoptOnly: true,
});
rpc2.start();
for (let i = 0; i < 4096; i++) assert.equal(rpc2.fire("abort"), true, `第 ${i} 帧应该先能入队`);
assert.equal(rpc2.fire("abort"), false, "超过上限的这一帧要拒绝，而不是继续攒");
assert.equal(rpc2.alive, false, "积压超过上限要立刻结算，不能无限攒");
const claim2 = await rpc2.whenLinked();
assert.ok("error" in claim2, "积压超限也要如实告诉 adopt()");
assert.match(String(claim2.error.message), /积压/, "错误里要说清是认领前积压");
void resolveAttach2;

// 重放未确认行时，某一行同步把链路结算掉：后面的行不能再喂、也不能再 ack。
// 否则壳会把这些本应留给下一次接管重放的数据删掉，还会在退出后继续发事件。
const logPath4 = path.join(tmp, "rpc4.log");
let resolveAttach4;
const acks4 = [];
const link4 = {
  watch: () => () => {},
  attachSession: () =>
    new Promise((resolve) => {
      resolveAttach4 = resolve;
    }),
  spawnSession: () => {
    throw new Error("adopt 失败时不许新开进程");
  },
  stdin: () => true,
  ack: (_sessionId, seq) => acks4.push(seq),
  kill: () => {},
};
const rpc4 = new RpcChild({
  cli: "fake-pi",
  args: [],
  cwd: tmp,
  logPath: logPath4,
  sessionId: "s4",
  link: link4,
  adoptOnly: true,
});
rpc4.on("event", (msg) => {
  if (msg.type === "die") rpc4.finish("测试：重放中退出");
});
rpc4.start();
const claim4Promise = rpc4.whenLinked();
resolveAttach4({
  pid: 44,
  pending: {
    fromSeq: 1,
    toSeq: 2,
    lines: [
      { line: JSON.stringify({ type: "die" }), seq: 1 },
      { line: JSON.stringify({ type: "ui_request", id: "u-after-die" }), seq: 2 },
    ],
    overflowed: false,
  },
  lastWritten: 2,
});
const claim4 = await claim4Promise;
assert.ok("error" in claim4, "重放中退出也要如实告诉 adopt()");
assert.deepEqual(acks4, [], "退出后的行不能再 ack，否则壳会删掉下一次接管该重放的数据");

// 等写日志的流把手里的 fd 放掉再删临时目录（Windows 上删早了会触发 ENOENT error 事件）。
await new Promise((r) => setTimeout(r, 150));
fs.rmSync(tmp, { recursive: true, force: true });
console.log("rpc-linked-unit: ok");
