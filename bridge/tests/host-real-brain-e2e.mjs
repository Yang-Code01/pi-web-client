#!/usr/bin/env node
/**
 * 顶层 e2e（issue #634 的验收缝，**真壳 + 真脑 + 假 pi**）。
 *
 * `host-shell-e2e.mjs` 用假脑考壳的协议面；这一份把真的 `bridge/dist/index.js` 当脑塞进去，
 * 只把 pi 换成假的（`fixtures/chatty-pi.mjs`）。覆盖率上的差别就是「用户能感觉到的那几件事」
 * 真的走了一遍：WS → 脑 → 壳 → pi → 回来。
 *
 * 断言：
 *   1. 真脑在壳后面起来（内部端口 + 控制通道），页面地址仍然只有壳那一个；
 *   2. 发一轮对话：会话在跑、pi 的 pid 由壳持有；
 *   3. 换脑（跳过构建）：脑的 pid 变了、**pi 的 pid 没变**、这一轮还在跑、会话被新脑接管；
 *   4. 换脑前答过的审批不会在换脑后重问一遍（不被答两次，也不凭空消失）；
 *   5. 脑被 kill -9 之后，壳重拉一代并叫它接管在跑的会话（而不是当成空壳）；
 *   6. `POST /api/host/stop` 收掉整组（story 13 的接口），壳退出码 0。
 *
 * 跑之前先 `npm run build:bridge`。
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const HOST = path.join(ROOT, "bridge", "dist", "host.js");
const BRAIN = path.join(ROOT, "bridge", "dist", "index.js");
const FAKE_PI = path.join(import.meta.dirname, "fixtures", "chatty-pi.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-real-"));
const STATE = path.join(TMP, "state");
const ANSWERS = path.join(TMP, "answers.txt");
const CWD = path.join(TMP, "work");
fs.mkdirSync(CWD, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

async function until(fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
    await sleep(100);
  }
}

for (const f of [HOST, BRAIN, FAKE_PI]) {
  if (!fs.existsSync(f)) throw new Error(`缺少 ${f} —— 先 npm run build:bridge`);
}

// 口令固定 test：先让脑跑一次 --passphrase 写进这套临时 state（跟测试环境同一招）。
execFileSync(process.execPath, [BRAIN, "--passphrase", "test"], {
  env: { ...process.env, PI_WEB_STATE: STATE, PI_WEB_WHATS_NEW: "0" },
  stdio: "ignore",
  timeout: 30000,
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const origins = { origin: base, "sec-fetch-site": "same-origin" };
const logs = [];
const host = spawn(process.execPath, [HOST], {
  env: {
    ...process.env,
    PI_WEB_PORT: String(port),
    PI_WEB_STATE: STATE,
    // 真脑：不设 PI_HOST_BRAIN。pi 换成假的，别的都走真代码。
    PI_BIN: FAKE_PI,
    CHATTY_PI_ANSWERS: ANSWERS,
    CHATTY_PI_CONFIRM: "1",
    PI_HOST_OBSERVE_MS: "600",
    PI_WEB_OPEN: "0",
    PI_WEB_WHATS_NEW: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
host.stdout.on("data", (c) => logs.push(String(c)));
host.stderr.on("data", (c) => logs.push(String(c)));
let exitCode = null;
let exitSignal = null;
host.on("exit", (code, signal) => {
  // 被信号终止时 code 是 null。记成 0 会把「壳崩了」当成「正常停机」通过断言。
  exitCode = code ?? -1;
  exitSignal = signal;
});

const getJson = async (p) => {
  const res = await fetch(base + p);
  return res.json();
};
const post = async (p, extraHeaders = {}) => {
  const res = await fetch(base + p, { method: "POST", headers: { ...origins, ...extraHeaders }, body: "{}" });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/** 一条 WS 连接：把收到的帧攒起来，测试自己等。 */
async function connectWs(cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  const seen = [];
  ws.on("message", (buf) => {
    try {
      seen.push(JSON.parse(buf.toString()));
    } catch {
      /* 不是 JSON 就跳过 */
    }
  });
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  const waitFor = async (pred, what, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = seen.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
      await sleep(80);
    }
  };
  return { ws, seen, waitFor };
}

const answersSoFar = () => {
  try {
    return fs.readFileSync(ANSWERS, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

try {
  // 1. 壳先起，真脑接上
  await until(async () => {
    try {
      return (await getJson("/healthz")).brain?.ready;
    } catch {
      return false;
    }
  }, "真脑在壳后面就绪");
  const health0 = await getJson("/healthz");
  assert.ok(health0.pid > 0 && health0.brain.pid > 0, "壳与脑各有一个 pid");
  assert.notEqual(health0.pid, health0.brain.pid, "壳与脑是两个进程");

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "test" }),
  });
  assert.equal(login.status, 200, "口令 test 应该能登进来");
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  // 2. 开一个真会话，发一轮对话
  const page = await connectWs(cookie);
  await page.waitFor((m) => m.type === "hello", "ws hello");
  page.ws.send(JSON.stringify({ type: "create", cwd: CWD, name: "e2e 真脑会话" }));
  const created = await page.waitFor((m) => m.type === "session" || m.type === "session.state", "会话建好");
  const sessionId = created.session?.id ?? created.sessionId;
  assert.ok(sessionId, "应该拿到会话 id");

  page.ws.send(JSON.stringify({ type: "prompt", sessionId, text: "跑一个长任务" }));
  const live = await until(async () => {
    const st = await getJson("/api/host/status");
    const s = st.sessions?.find((x) => x.id === sessionId);
    return s?.pid && s.turnActive ? s : null;
  }, "会话在壳里跑起来（pid + turnActive）");
  const piPid = live.pid;
  assert.ok(piPid > 0, "shell 应该拿着 pi 的 pid");

  // 3. 换脑之前答掉那条审批，换脑之后它不能再问一遍
  const approval = await page.waitFor(
    (m) => m.type === "approval.add" && m.approval?.id === "u-confirm",
    "审批到页面",
  );
  page.ws.send(JSON.stringify({ type: "approve", sessionId, approvalId: approval.approval.id, decision: "approve" }));
  await until(() => answersSoFar().length === 1, "pi 收到一次回答");
  assert.deepEqual(answersSoFar(), ["u-confirm"], "回答应该原样带着 id 回到 pi");

  // 4. 换脑（跳过构建）：脑换了、pi 没换、这一轮还在跑
  const brainBefore = (await getJson("/api/host/status")).brain;
  const swapped = await post("/api/host/deploy?action=swap");
  assert.equal(swapped.status, 200, "swap 接口应该放行（本机 + 同源）");
  const brainAfter = await until(async () => {
    const b = (await getJson("/api/host/status")).brain;
    return b?.ready && b.pid !== brainBefore.pid ? b : null;
  }, "新一代脑接管");
  assert.notEqual(brainAfter.pid, brainBefore.pid, "脑必须是新的那一个");
  const afterSwap = await until(async () => {
    const st = await getJson("/api/host/status");
    const s = st.sessions?.find((x) => x.id === sessionId);
    return s?.owner === "current" ? s : null;
  }, "新脑接管这个会话");
  assert.equal(afterSwap.pid, piPid, "会话的 pi pid 不能变");
  assert.equal(afterSwap.turnActive, true, "换脑之后这一轮还得算在跑");

  // 5. 换脑之后重连页面：那一轮还在，答过的审批不会再冒出来
  try {
    page.ws.close();
  } catch {
    /* 已经断了 */
  }
  const page2 = await connectWs(cookie);
  await page2.waitFor((m) => m.type === "hello", "重连后的 hello");
  // 固定 sleep 是在赌重放帧的到达时间：慢机器上可能晚到（假阴性），快机器上白等。
  // 订阅拿到的会话快照里就带着新一代脑当前挂着的审批，直接断言它没有这一张。
  page2.ws.send(JSON.stringify({ type: "subscribe", sessionId }));
  const reopened = await page2.waitFor((m) => m.type === "session" && m.sessionId === sessionId, "重连后订阅到会话");
  const asked = (reopened.approvals ?? []).filter((a) => a.id === "u-confirm");
  assert.equal(asked.length, 0, "答过的审批不该在换脑后重放");
  assert.equal(answersSoFar().length, 1, "同一张审批不能被答两次");

  // 6. 脑被 kill -9：壳重拉一代，并叫它接管还在跑的会话（story 11）
  process.kill(brainAfter.pid, "SIGKILL");
  const respawned = await until(async () => {
    const b = (await getJson("/api/host/status")).brain;
    return b?.ready && b.pid !== brainAfter.pid ? b : null;
  }, "壳重拉一代脑");
  const adopted = await until(async () => {
    const st = await getJson("/api/host/status");
    const s = st.sessions?.find((x) => x.id === sessionId);
    return s?.owner === "current" ? s : null;
  }, "重拉的脑接管会话");
  assert.equal(adopted.pid, piPid, "重拉脑也不能换掉会话进程");
  assert.equal(adopted.turnActive, true, "重拉之后这一轮还要算在跑");
  process.kill(respawned.pid, "SIGKILL");
  await until(async () => {
    const b = (await getJson("/api/host/status")).brain;
    // 不能只等 ready：刚 kill 的那代还在 status 里挂着 ready=true，要等 pid 真的换掉。
    return b?.ready && b.pid !== respawned.pid ? b : null;
  }, "再拉一代脑");
  assert.equal(answersSoFar().length, 1, "整段流程里审批只被答过一次");

  // 7. 有壳时删工作树接口也不能掉进 405：它不换进程，脑自己就能干。
  // 换过两代脑之后登录 cookie 可能已经不算数，先重新登录，别让 401 把这条路由的断言遮住。
  const login2 = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "test" }),
  });
  assert.equal(login2.status, 200, "重新登录应该还能进");
  const cookie2 = (login2.headers.get("set-cookie") ?? "").split(";")[0];
  const rm = await post("/api/hotdeploy/remove-worktree", { cookie: cookie2 });
  assert.equal(rm.status, 400, "有壳时删工作树接口不该退化成 405");
  assert.equal(rm.body?.code, "hotdeploy_path", "空路径应该走到参数校验");

  // 8. 停机入口：整组一起收
  const stopped = await post("/api/host/stop");
  assert.equal(stopped.status, 200, "停机接口应该放行");
  await until(async () => exitCode !== null, "壳退出", 15000);
  assert.equal(exitCode, 0, exitSignal ? `主动停机被信号 ${exitSignal} 终止` : "主动停机应该是 0");
  console.log("host-real-brain-e2e: ok");
} catch (err) {
  console.error(String(err?.stack ?? err));
  console.error(`--- host 日志 ---\n${logs.join("").slice(-5000)}`);
  try {
    host.kill();
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
} finally {
  if (exitCode === null) {
    try {
      host.kill("SIGKILL");
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
