import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { Broker } from "../dist/host/broker.js";
import { Children } from "../dist/host/children.js";

const broker = new Broker();
const children = new Children(broker, {
  line() {},
  stderr() {},
  exit() {},
});

const missing = path.join(os.tmpdir(), `pi-no-such-${process.pid}-${Date.now()}`);
const spec = { sessionId: "s", argv: [], cwd: missing, env: {} };

// cwd 不存在时 spawn 同步拿不到 pid。失败不能留下 broker 条目，否则下一次同 id 会被当成已有会话。
assert.throws(() => children.start(spec), /pi 进程没起来/);
assert.deepEqual(broker.sessions(), [], "spawn 失败后 broker 里不该留下空会话");
assert.equal(children.has("s"), false, "spawn 失败后不该认为进程在跑");

// 同一个 id 还能重新拉起（证明失败路径没把 procs / broker 卡死）。
const pid = children.start({ ...spec, cwd: process.cwd(), argv: ["-e", "setTimeout(() => {}, 200)"] });
assert.ok(pid > 0, "失败过的会话应该还能重新 spawn");
assert.deepEqual(broker.sessions(), ["s"], "成功后才写 broker 条目");
children.kill("s", true);
while (children.has("s")) await new Promise((r) => setTimeout(r, 20));
assert.ok(children.lastExit("s"), "旧进程退出后要留下 lastExit 给还没接管的脑");

// 同一会话重新 spawn 之后，上一代的退出码不能跟着新 pid 一起交给 attach。
const pid2 = children.start({ ...spec, cwd: process.cwd(), argv: ["-e", "setTimeout(() => {}, 200)"] });
assert.ok(pid2 > 0, "同一会话应该能在旧进程退出后重新拉起");
assert.equal(children.lastExit("s"), null, "新一代进程不该继承上一代的退出记录");
children.kill("s", true);
while (children.has("s")) await new Promise((r) => setTimeout(r, 20));

console.log("children-unit: ok");
