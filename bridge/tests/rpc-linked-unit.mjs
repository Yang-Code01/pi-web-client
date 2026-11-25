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

// 等写日志的流把手里的 fd 放掉再删临时目录（Windows 上删早了会触发 ENOENT error 事件）。
await new Promise((r) => setTimeout(r, 150));
fs.rmSync(tmp, { recursive: true, force: true });
console.log("rpc-linked-unit: ok");
