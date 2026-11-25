#!/usr/bin/env node
/**
 * 顶层 e2e（issue #634 的验收缝）：**真壳 + 假脑 + 假 pi**。
 *
 * 考的是用户能感觉到的那几件事，不是实现细节：
 *   1. 端口在壳手里：壳一起来 /healthz 就有，哪怕脑还没接上；
 *   2. 换脑不该丢请求：脑缺席时请求排队，而不是立刻拔线；
 *   3. 会话的管道在壳手里：脑发 spawn → 壳起进程 → 输出回到脑，写进去的帧也能往返；
 *   4. `x-pi-peer` 由壳写，客户端伪造的那个不算数；
 *   5. 停机能把整组（壳 + 脑 + 子进程）收干净。
 *
 * 真脑要用真 pi、真 state 目录，跑一遍太贵；「老脑排队的帧交给新脑」由
 * `host-broker-unit.mjs` 直接对着 broker 断言。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { controlPath } from "../dist/host/control.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const HOST = path.join(ROOT, "bridge", "dist", "host.js");
const BRAIN = path.join(import.meta.dirname, "fixtures", "fake-brain.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-e2e-"));
// 换脑要同时跑两代假脑：一代一个文件，按 pid 取。
const BRAINS = path.join(TMP, "brains");
fs.mkdirSync(BRAINS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

async function until(fn, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
    await sleep(80);
  }
}

function readBrain(pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(BRAINS, `brain-${pid}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** 当前只有一代时的便利读法（取最新的那个文件）。 */
function stats() {
  try {
    const files = fs
      .readdirSync(BRAINS)
      .filter((f) => /^brain-\d+\.json$/.test(f)) // 原子写的 .tmp 别混进来
      .map((f) => ({ f, t: fs.statSync(path.join(BRAINS, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(BRAINS, files[0].f), "utf8"));
  } catch {
    return null;
  }
}

async function brainOf(pid) {
  return until(() => (readBrain(pid)?.port ? readBrain(pid) : null), `假脑 ${pid} 的 stats`);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const logs = [];
const host = spawn(process.execPath, [HOST], {
  env: {
    ...process.env,
    PI_WEB_PORT: String(port),
    PI_HOST_BRAIN: BRAIN,
    PI_FAKE_BRAIN_OUT_DIR: BRAINS,
    // 换脑前的观察期在测试里缩短到 800 ms。
    PI_HOST_OBSERVE_MS: "800",
    // 壳的账本写在 state 目录里：指到临时目录，别污染真 state。
    PI_WEB_STATE: path.join(TMP, "state"),
    PI_WEB_OPEN: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
host.stdout.on("data", (c) => logs.push(String(c)));
host.stderr.on("data", (c) => logs.push(String(c)));

const get = async (url) => {
  const res = await fetch(base + url);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = async (url, headers = {}) => {
  const res = await fetch(base + url, { method: "POST", headers });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const brainGet = async (p, pid) => {
  const s = pid ? readBrain(pid) : stats();
  if (!s?.port) throw new Error("假脑还没报端口");
  const res = await fetch(`http://127.0.0.1:${s.port}${p}`);
  return res.json();
};

let exitCode = null;
let exitSignal = null;
host.on("exit", (code, signal) => {
  // 信号终止时 code 是 null。记成 0 会把壳崩溃当成正常停机。
  exitCode = code ?? -1;
  exitSignal = signal;
});

try {
  // 1. 端口由壳持有：脑进程还没起完，healthz 就得有回音。
  await until(async () => {
    try {
      const r = await get("/healthz");
      return r.body?.ok;
    } catch {
      return false;
    }
  }, "壳的 /healthz 起来");
  const health = await get("/healthz");
  assert.equal(health.body.pid, host.pid, "healthz 报的 pid 应该是壳自己");
  // 本机别的端口也是别的页面：Origin 不是本服务自己的 host:port，就不能停壳。
  const cross = await post("/api/host/stop", { origin: "http://localhost:9999" });
  assert.equal(cross.status, 403, "其它 localhost 端口的页面不能跨源停壳");
  // 被拒绝的握手不能留下一个「候选脑」：同一包里紧跟 shutdown 也不能把壳停掉。
  const bad = net.connect(controlPath(port));
  await new Promise((resolve, reject) => {
    bad.once("connect", resolve);
    bad.once("error", reject);
  });
  bad.write(
    `${JSON.stringify({ t: "hello", proto: 999, pid: process.pid, buildId: "bad", internalPort: 1 })}\n` +
      `${JSON.stringify({ t: "shutdown", scope: "all" })}\n`,
  );
  await sleep(300);
  const still = await get("/healthz");
  assert.equal(still.status, 200, "proto 被拒后不能再执行 shutdown");
  bad.destroy();
  // 2. 脑接上之后，状态里能看到它。
  await until(async () => (await get("/api/host/status")).body?.brain?.ready, "假脑就绪");
  const status = await get("/api/host/status");
  assert.equal(status.body.brain.buildId, "fake-brain-1");
  assert.ok(status.body.brain.pid > 0, "status 里应该有脑的 pid");

  // 3. 壳把请求转给脑，并按真实对端写 x-pi-peer（客户端伪造的那个不算数）。
  const plain = await get("/echo");
  assert.equal(plain.body.peer, "loopback", "本机直连应该被标成 loopback");
  assert.equal(plain.body.path, "/echo");
  const spoof = await fetch(`${base}/echo`, { headers: { "x-pi-peer": "remote" } });
  const spoofed = await spoof.json();
  assert.equal(spoofed.peer, "loopback", "客户端自带 x-pi-peer 必须被剥掉重写");
  // 隧道流量是从本机连进来的，只能靠 cf-* 认得出来；它必须算 remote（严的那一侧）。
  const tunnel = await fetch(`${base}/echo`, { headers: { "cf-ray": "test" } });
  assert.equal((await tunnel.json()).peer, "remote", "隧道流量不能算成本机直连");

  // 4. 管道：脑让壳起一个假 pi，输出回到脑里。
  await brainGet("/spawn?sessionId=s1");
  await until(async () => {
    const s = stats();
    return s && s.lines >= 2 ? s : null;
  }, "假 pi 的 tick 回到脑");
  const spawned = stats();
  assert.ok(spawned.spawned?.pid > 0, "壳应该把子进程 pid 告诉脑");
  assert.equal(spawned.spawnFailed, null);

  // 5. 写进去的帧能往返（壳写 stdin → 假 pi 回 echo → 壳转回脑）。
  await brainGet("/write?sessionId=s1&text=ping-roundtrip");
  const echoed = await until(async () => {
    const s = stats();
    if (!s?.echos?.length) return null;
    return s.echos.some((line) => line.includes("ping-roundtrip")) ? s : null;
  }, "写入的帧回到脑");
  assert.ok(echoed.written > 0, "壳应该在写完之后回 written{seq}");

  // 6. 子进程死了，壳要通知脑（页面据此把气泡标红，而不是永远转圈）。
  await brainGet("/kill?sessionId=s1&mode=now");
  await until(async () => (stats()?.childExits?.length ?? 0) >= 1, "子进程退出的通知");
  assert.equal(stats().childExits[0].sessionId, "s1");

  // 7. 同一个会话再 attach：壳把 pid 和未确认窗口一起交回来。
  await brainGet("/spawn?sessionId=s2");
  await until(async () => (await get("/api/host/status")).body?.sessions?.some((s) => s.id === "s2" && s.pid), "s2 起起来");
  await brainGet("/attach?sessionId=s2");
  const attached = await until(async () => stats()?.attached, "attach 的回报");
  assert.ok(Number.isInteger(attached.fromSeq) && Number.isInteger(attached.toSeq), "attach 要带确认窗口的序号");
  assert.equal(attached.lines.length, Math.max(0, attached.toSeq - attached.fromSeq + 1), "窗口里该有的行数要对得上");
  assert.ok(stats().attachPid > 0, "attach 要带子进程 pid");
  assert.equal(attached.fromSeq, attached.lines.length ? attached.lines[0].seq : attached.toSeq + 1, "空窗口也要用 fromSeq = toSeq + 1 明说");

  // 8. 换脑：老脑停掉 ack 先攒出未确认的窗口，壳拉新一代接替，新脑 attach 要拿回它。
  const oldPid = (await get("/api/host/status")).body.brain.pid;
  await brainGet("/pause-ack?on=1", oldPid);
  await brainGet("/spawn?sessionId=s3", oldPid);
  // 换脑前挂着一张问卷：换完之后新脑必须还能把它交还出来（D385）。
  await brainGet("/spawn?sessionId=s4&ask=1", oldPid);
  await until(async () => (readBrain(oldPid)?.lines ?? 0) >= 4, "s4 的问卷行进了壳");
  await until(async () => readBrain(oldPid)?.lines >= 3, "s3 的 tick 攒起来");
  await sleep(400); // 让几行排进未确认窗口
  await brainGet("/deploy?action=swap", oldPid);
  const nextBrain = await until(async () => {
    const b = (await get("/api/host/status")).body?.brain;
    return b?.ready && b.pid !== oldPid ? b : null;
  }, "新一代脑接管");
  await brainOf(nextBrain.pid);
  assert.equal(
    (await get("/api/host/status")).body.brain.buildId,
    "fake-brain-1",
    "换上的还是同一份构建",
  );
  // 老脑应该被明确告知让位，而不是悄悄被断线。
  await until(async () => readBrain(oldPid)?.retired >= 1, "老脑收到 retire");
  // 页面地址不变：公网口一直在壳手里。
  assert.equal((await get("/echo")).body.peer, "loopback", "换脑之后仍然由壳写对端头");
  // 还没答的问卷也一起交回来：页面那张表单换脑后照样能答。
  await brainGet("/attach?sessionId=s4", nextBrain.pid);
  const uiCarried = await until(async () => {
    const st = readBrain(nextBrain.pid);
    return st?.attachedUi?.length ? st.attachedUi : null;
  }, "s4 的问卷交回新脑");
  assert.ok(String(uiCarried[0]).includes("u-ask"), "交回来的应该是原来那条 extension_ui_request");
  assert.equal(
    uiCarried.filter((line) => String(line).includes("u-ask")).length,
    1,
    "同一张问卷只能交一次（pending 与 pendingUi 不许重复投递）",
  );
  // 新脑接回 s3：老脑没确认的行必须原样交给它。
  await brainGet("/attach?sessionId=s3", nextBrain.pid);
  const carried = await until(async () => readBrain(nextBrain.pid)?.attached, "新脑 attach 的回报");
  assert.ok(carried.lines.length > 0, "换脑时未确认的行不能丢");
  assert.equal(
    carried.lines[0].seq,
    carried.fromSeq,
    "窗口第一行的序号要跟 fromSeq 对上",
  );
  // 换脑之后写入照样往返（owner 换了，管道没换）。
  await brainGet("/write?sessionId=s3&text=after-swap", nextBrain.pid);
  await until(async () => {
    const s = readBrain(nextBrain.pid);
    return s?.echos?.some((line) => line.includes("after-swap")) ? s : null;
  }, "换脑后的写入往返");

  // 9. 账本：用量落到 state 目录，换代之后还在（D385）。
  await brainGet("/usage?sessionId=s1&total=321", nextBrain.pid);
  const ledgerFile = path.join(TMP, "state", "host", "usage.jsonl");
  await until(async () => {
    try {
      return fs.readFileSync(ledgerFile, "utf8").includes('"s":"s1"');
    } catch {
      return false;
    }
  }, "用量写进账本");
  assert.match(fs.readFileSync(ledgerFile, "utf8"), /"total":321/, "账本要留下这一笔");

  // 10. 停机：整组一起收，壳干净退出。
  await post("/api/host/stop");
  await until(async () => exitCode !== null, "壳退出", 8000);
  assert.equal(exitCode, 0, exitSignal ? `主动停机被信号 ${exitSignal} 终止` : "主动停机应该是 0");
  console.log("host-shell-e2e: ok");
} catch (err) {
  console.error(String(err?.stack ?? err));
  console.error(`--- host 日志 ---\n${logs.join("").slice(-4000)}`);
  console.error(`--- 假脑状态 ---\n${JSON.stringify(stats(), null, 2)}`);
  try {
    host.kill();
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
} finally {
  if (exitCode === null) {
    try {
      host.kill();
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
