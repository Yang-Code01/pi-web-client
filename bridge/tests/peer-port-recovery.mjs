#!/usr/bin/env node
/**
 * 端口被占之后要能恢复（回归测试，D-见 PR）。
 *
 * 真实故障：peer 子进程绑定端口时撞上 EADDRINUSE（另一份 peer / 探针），退出码 2，
 * bridge 记下「端口被占用」就再也不 fork；占用者退出后端口空着，页面上的「重试」
 * 却只转发到 peer 自己的 `/peer/refresh` —— 进程根本不在，必然 fetch failed。
 * 内网通一直挂着，只能重启整个 bridge。
 *
 * 这里守两条路：
 *   A 自动：占用者走了，端口探测发现空出来就重新 fork（PI_PEER_PORT_PROBE_MS 收紧到 300ms）；
 *   B 手动：页面「重试」= POST /api/peer/restart，能立刻把它拉起来。
 *
 * 只碰隔离目录与 freePort()：PI_WEB_STATE / PI_AGENT_DIR / PI_PEER_STATE / 组播端口全部独立，
 * 不会和生产那份内网通互相发现。
 *
 * 前置：`npm run build`（需要 bridge/dist/host.js 与 peer/dist/index.js）。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "../../tools/free-port.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "peer-port-recovery");
const HOST = path.join(REPO, "bridge", "dist", "host.js");
const PEER = path.join(REPO, "peer", "dist", "index.js");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed = true;
    console.error("  FAIL", msg);
  }
};

for (const [what, file] of [
  ["bridge/dist/host.js", HOST],
  ["peer/dist/index.js", PEER],
]) {
  if (!fs.existsSync(file)) {
    console.error(`没找到 ${what}：先跑 npm run build`);
    process.exit(2);
  }
}

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error(`超时：${label}`);
}

/** 模拟「另一份 peer 在跑」：和 peer 一样绑 0.0.0.0。 */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "0.0.0.0", () => resolve(srv));
  });
}

/**
 * 放掉占位服务。
 *
 * 得先 `closeAllConnections()`：桥每 PORT_PROBE_MS 就 `net.connect` 一次，这些连接在
 * `server.close()` 眼里都是「还没断」的，不给它们收尾就会卡在这里，而 `close()` 的回调
 * 一辈子等不到（第一版就这么撞了）。
 */
const release = (srv) =>
  new Promise((resolve) => {
    let called = false;
    let t;
    const fin = () => {
      if (called) return;
      called = true;
      clearTimeout(t);
      resolve();
    };
    srv.closeAllConnections?.();
    srv.close(fin);
    t = setTimeout(() => {
      srv.getConnections?.((e, n) => console.error(`  警告：5s 内 close() 没回调（getConnections=${e ? String(e) : n}）`));
      fin();
    }, 5000);
    t.unref?.();
  });

/** 杀掉壳的整棵进程树：脑和 peer 都是它的后代（Windows 没有进程组）。 */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 15000 });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已经没了 */
    }
  }
}

async function startBridge({ name, probeMs, peerPort }) {
  const root = path.join(ROOT, name);
  fs.rmSync(root, { recursive: true, force: true });
  const state = path.join(root, "state");
  const agent = path.join(root, "agent");
  const peerState = path.join(root, "peer-state");
  fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });
  fs.mkdirSync(peerState, { recursive: true });

  const port = await freePort();
  const announce = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [HOST], {
    cwd: REPO,
    env: {
      ...process.env,
      PI_WEB_PORT: String(port),
      PI_WEB_STATE: state,
      PI_WEB_TUNNEL: "0",
      PI_AGENT_DIR: agent,
      PI_PEER_PORT: String(peerPort),
      PI_PEER_STATE: peerState,
      PI_PEER_ANNOUNCE_PORT: String(announce),
      PI_PEER_PORT_PROBE_MS: String(probeMs),
      PI_HOST_OBSERVE_MS: "300",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const out = [];
  child.stdout.on("data", (b) => out.push(b.toString()));
  child.stderr.on("data", (b) => out.push(b.toString()));

  const stop = async () => {
    killTree(child.pid);
    await until(() => child.exitCode !== null || child.signalCode !== null, 8000, `${name} 退出`).catch(() => {});
    await sleep(300);
  };

  try {
    await until(async () => (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) })).ok, 30000, "bridge up");
  } catch (err) {
    await stop();
    throw new Error(`${err.message}\n${out.join("")}`);
  }
  return {
    base,
    peerPort,
    out,
    stop,
    /** `/api/peer` 的这一句话就是页面状态条读到的全部内容。 */
    view: async () => (await fetch(`${base}/api/peer`, { signal: AbortSignal.timeout(3000) })).json(),
  };
}

const occupied = (v) => v?.enabled === true && v?.running === false && /被占用/.test(v?.reason ?? "");
const running = (v) => v?.running === true;

try {
  // ---------------------------------------------------------------- A. 自动恢复
  log("A 段：端口被占 → 占用者退出 → 自动恢复");
  // 先占住端口再起壳：反过来的话，peer 可能在 occupy() 之前就绑上，测试变成时快时慢的彩票。
  let blocker = await occupy(await freePort());
  const a = await startBridge({ name: "auto", probeMs: 300, peerPort: blocker.address().port });
  try {
    try {
      await until(async () => occupied(await a.view()), 15000, "A 出现「被占用」");
    } catch (err) {
      // 超时时把现场带出来：页面读到的那句话 + 壳自己的输出
      console.error("  A 现场 view:", JSON.stringify(await a.view().catch((e) => String(e))));
      console.error("  A 现场 占用端口:", a.peerPort, "\n  A 现场 壳输出:", a.out.join(""));
      throw err;
    }
    log("A:", JSON.stringify(await a.view()));
    await release(blocker);
    blocker = null;
    await until(async () => running(await a.view()), 8000, "A 端口释放后自动起来");
    log("A:", JSON.stringify(await a.view()));
    check(true, "占用者走了之后自动重新 fork（≤8s）");
  } finally {
    if (blocker) await release(blocker).catch(() => {});
    await a.stop();
  }

  // ---------------------------------------------------------------- B. 手动重试
  log("B 段：端口被占 → 占用者退出 → 点「重试」立刻恢复（自动探测设成 10 分钟，窗口内不会插手）");
  const bPeerPort = await freePort();
  blocker = await occupy(bPeerPort);
  const b = await startBridge({ name: "manual", probeMs: 600_000, peerPort: bPeerPort });
  try {
    await until(async () => occupied(await b.view()), 15000, "B 出现「被占用」");
    await release(blocker);
    blocker = null;
    await sleep(1500);
    const before = await b.view();
    log("B 释放后（还没点重试）:", JSON.stringify(before));
    check(!running(before), "自动探测未到点时不会自己重启（这一段专测手动路径）");

    const res = await fetch(`${b.base}/api/peer/restart`, { method: "POST", signal: AbortSignal.timeout(6000) });
    const body = await res.json().catch(() => null);
    log("B POST /api/peer/restart:", res.status, JSON.stringify(body));
    check(res.ok && body?.ok === true, "重试端点接受请求");

    await until(async () => running(await b.view()), 8000, "B 点重试后起来");
    log("B:", JSON.stringify(await b.view()));
    check(true, "点「重试」能重新 fork 已经退出的 peer");
  } finally {
    if (blocker) await release(blocker).catch(() => {});
    await b.stop();
  }
} catch (err) {
  failed = true;
  console.error("FAIL", err.message);
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? "\n结果：FAIL — 端口被占后仍然恢复不了" : "\n结果：ok — 端口被占后能恢复");
process.exit(failed ? 1 : 0);
