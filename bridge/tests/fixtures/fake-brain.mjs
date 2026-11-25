#!/usr/bin/env node
/**
 * e2e 用的假脑：只说控制通道那几句话，外加一个小 HTTP 服务给测试当遥控器。
 * 真脑要用真 pi、真 state 目录，跑一遍太贵；这里只验证「壳」那一半。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const sock = process.env.PI_HOST_LINK;
// 换脑测试会同时跑两代假脑：各自写各自的 stats，谁也别覆盖谁。
const outDir = process.env.PI_FAKE_BRAIN_OUT_DIR;
const out = outDir ? path.join(outDir, `brain-${process.pid}.json`) : process.env.PI_FAKE_BRAIN_OUT;
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
// 别抢用 tests/fixtures/fake-pi.mjs：那是排得很满的真实回归夹具（boot-queue 等一大票在用）。
const fakePi = path.join(here, "tiny-pi.mjs");

const stats = {
  lines: 0,
  lastLine: null,
  echos: [],
  lastStderr: null,
  attached: null,
  spawned: null,
  spawnFailed: null,
  written: null,
  activations: 0,
  retired: 0,
  childExits: [],
  deploy: null,
  pending: null,
  paused: false,
};

const writeStats = () => {
  if (!out) return;
  const text = JSON.stringify(stats);
  // Windows 上「改名覆盖一个正被读的文件」会偶发 EPERM；而杀掉子进程之后不会再有
  // 下一条消息来修补文件，一次失败就等于测试永远读不到 child-exit。所以退化直写。
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.writeFileSync(`${out}.tmp`, text);
      fs.renameSync(`${out}.tmp`, out);
      return;
    } catch {
      try {
        fs.writeFileSync(out, text);
        return;
      } catch {
        /* 下一轮再试 */
      }
    }
  }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const sessionId = url.searchParams.get("sessionId") ?? "s1";
  let body = {};
  if (url.pathname === "/spawn") {
    send({
      t: "spawn",
      rid: "r-spawn",
      sessionId,
      argv: [fakePi],
      cwd: process.cwd(),
      env: url.searchParams.get("ask") === "1" ? { TINY_PI_ASK: "1" } : {},
    });
    body = { ok: true };
  } else if (url.pathname === "/usage") {
    send({
      t: "usage",
      sessionId,
      usage: { input: 10, output: 5, total: Number(url.searchParams.get("total") ?? 15), cost: 0 },
    });
    body = { ok: true };
  } else if (url.pathname === "/attach") {
    send({ t: "attach", rid: "r-attach", sessionId });
    body = { ok: true };
  } else if (url.pathname === "/write") {
    send({
      t: "stdin",
      sessionId,
      data: JSON.stringify({ type: "ping", id: "p1", text: url.searchParams.get("text") ?? "hi" }) + "\n",
    });
    body = { ok: true };
  } else if (url.pathname === "/kill") {
    send({ t: "kill", sessionId, mode: url.searchParams.get("mode") ?? "now" });
    body = { ok: true };
  } else if (url.pathname === "/pause-ack") {
    // 停掉 ack：壳那边就会攒出未确认窗口，换脑时要原样交给新脑。
    stats.paused = url.searchParams.get("on") === "1";
    body = { ok: true, paused: stats.paused };
  } else if (url.pathname === "/deploy") {
    send({ t: "deploy", action: url.searchParams.get("action") ?? "run" });
    body = { ok: true };
  } else if (url.pathname === "/bye") {
    send({ t: "bye" });
    body = { ok: true };
  } else if (url.pathname === "/echo") {
    // 把壳转进来的头原样回显：测试靠它判断 x-pi-peer 是谁写的。
    body = { path: url.pathname, peer: req.headers["x-pi-peer"] ?? null, host: req.headers.host ?? null };
  } else {
    body = stats;
  }
  writeStats();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const internalPort = server.address().port;
// 测试要知道往哪个口发遥控指令，先把这个数留在快照里。
stats.port = internalPort;

const socket = net.connect(sock);
let buf = "";
const send = (obj) => {
  if (!socket.destroyed) socket.write(JSON.stringify(obj) + "\n");
};

function handle(msg) {
  switch (msg.t) {
    case "welcome":
      send({ t: "ready" });
      stats.welcome = { hostBuildId: msg.hostBuildId, publicPort: msg.publicPort, swap: Boolean(msg.swap) };
      break;
    case "line":
      stats.lines += 1;
      stats.lastLine = msg.line;
      // ticks 每秒好几条，会把 lastLine 盖掉：回应只留一份，测试才看得到。
      if (String(msg.line).includes("\"response\"")) stats.echos.push(msg.line);
      if (!stats.paused) send({ t: "ack", sessionId: msg.sessionId, seq: msg.seq });
      break;
    case "stderr":
      stats.lastStderr = String(msg.text ?? "");
      break;
    case "attached": {
      stats.attached = msg.pending;
      // 问卷有两条送达路径：未确认窗口里的原行、pendingUi 的重放。新脑两处都会处理，
      // 所以这里按「交接出去的全部问卷」记录，重复就是壳的错。
      const fromPending = (msg.pending?.lines ?? [])
        .map((l) => l.line)
        .filter((line) => String(line).includes('"extension_ui_request"'));
      stats.attachedUi = [...fromPending, ...(msg.pendingUi ?? [])];
      stats.attachPid = msg.pid;
      break;
    }
    case "spawned":
      stats.spawned = { pid: msg.pid, rid: msg.rid };
      break;
    case "spawn-failed":
    case "attach-failed":
      stats.spawnFailed = msg.reason;
      break;
    case "written":
      stats.written = msg.seq;
      break;
    case "child-exit":
      stats.childExits.push({ sessionId: msg.sessionId, code: msg.code, signal: msg.signal });
      break;
    case "activate":
      stats.activations += 1;
      break;
    case "retire":
      stats.retired += 1;
      break;
    case "deploy-state":
      stats.deploy = msg;
      break;
    case "shutdown":
      process.exit(0);
      break;
    default:
      stats.unknown = msg.t;
  }
  writeStats();
}

socket.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  for (;;) {
    const i = buf.indexOf("\n");
    if (i < 0) break;
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* 假脑不负责容错 */
    }
  }
});
socket.on("close", () => process.exit(0));

send({ t: "hello", proto: 1, buildId: "fake-brain-1", pid: process.pid, internalPort });
writeStats();
