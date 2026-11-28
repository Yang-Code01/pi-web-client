#!/usr/bin/env node
/**
 * 回归：长会话里扩展发了成千上万条「只播报、不等回答」的 UI 帧（setStatus / setWidget /
 * notify），之后点「接管会话」/ 换脑 adopt 一直报「link: 壳 attached 超时」。
 *
 * 根因：壳把所有 extension_ui_request 都当成「还没答的问卷」攒在 pendingUi 里，而这类帧
 * 永远不会有 extension_ui_response 来消掉它。attach 时整包塞进一帧 `attached`，超过控制
 * 通道单行 8 MiB 的上限，被脑那一侧的 LineSplitter 当残行丢掉 —— 脑等满 15 秒超时。
 *
 * 真壳 + 假脑 + 假 pi（tiny-pi 开场连发 TINY_PI_STATUS 条 16 KB 的播报帧，外加一张真问卷）。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ControlConn } from "../dist/host/control.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const HOST = path.join(ROOT, "bridge", "dist", "host.js");
const BRAIN = path.join(import.meta.dirname, "fixtures", "fake-brain.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-ui-"));
const BRAINS = path.join(TMP, "brains");
fs.mkdirSync(BRAINS, { recursive: true });
// 600 × ~16 KB ≈ 9.8 MB：只要壳把它们留着，attached 那一帧必然越过 8 MiB。
const FIRE = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  const kids = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  for (const line of String(kids.stdout ?? "").split(/\s+/)) if (line) killTree(Number(line));
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已经没了 */
  }
}

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

function stats() {
  try {
    const files = fs.readdirSync(BRAINS).filter((f) => /^brain-\d+\.json$/.test(f));
    if (!files.length) return null;
    // 跟 host-shell-e2e 一样按 mtime 取最新的一份：两代假脑同时活着时，`files[0]` 可能拿到
    // 上一代那份（它可能停在半路、还没写 port）。
    const newest = files
      .map((f) => ({ f, t: fs.statSync(path.join(BRAINS, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0].f;
    return JSON.parse(fs.readFileSync(path.join(BRAINS, newest), "utf8"));
  } catch {
    return null;
  }
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
const brainGet = async (p) => {
  // 假脑在「改名覆盖」失败时会退化成直写（Windows 上正被读就会 EPERM），读的那一瞬可能撞上
  // 半截 JSON、stats() 返回 null。那不是「没报端口」，等下一轮就好 —— 在这里当场断言失败会
  // 变成偶发红（必须紧跟在 host-shell-e2e 后面跑才复现）。
  // 外层更早的时候已经等过一次「假脑报端口」了，这里等的是**另**一回事：轮询期间碰巧读到半截
  // JSON。所以别沿用那句文案 —— 半截 JSON 和「假脑压根没起来」是两码事，报错会指错地方；
  // 超时也别比外层的 20s 短，否则真正的失败点会被这个更早的超时盖住。
  const port = await until(() => stats()?.port ?? null, "读假脑端口（stats() 反复读到半截 JSON）");
  return (await fetch(`http://127.0.0.1:${port}${p}`)).json();
};

try {
  await until(async () => {
    try {
      return (await get("/api/host/status")).body?.brain?.ready;
    } catch {
      return false;
    }
  }, "假脑就绪");
  await until(() => stats()?.port, "假脑报端口");

  await brainGet(`/spawn?sessionId=s1&ask=1&status=${FIRE}&bytes=16384`);
  // 播报帧全部过了壳（脑照常 ack），窗口清空 —— 剩下的只可能是 pendingUi 那一份。
  await until(() => (stats()?.lines ?? 0) >= FIRE + 1, "播报帧全部到脑", 30000);

  const t0 = Date.now();
  await brainGet("/attach?sessionId=s1");
  const ui = await until(() => stats()?.attachedUi ?? (stats()?.spawnFailed ? [] : null), "attach 的回报（症状：壳 attached 超时）", 10000);
  assert.equal(stats().spawnFailed, null, "attach 不该被拒");
  console.log(`attach 回帧 ${Date.now() - t0} ms，交回 ${ui.length} 条 UI 帧`);
  assert.ok(
    ui.some((line) => String(line).includes('"u-ask"')),
    "没答的问卷（select）必须交回新脑",
  );
  assert.equal(
    ui.filter((line) => String(line).includes("u-fire-")).length,
    0,
    "只播报不等回答的 setStatus / setWidget / notify 不该当成问卷重放",
  );
  // 第二道：就算真有一大包没答的问卷 / 快满的未确认窗口，控制通道也得吞得下 attached。
  // 原来跟子进程输出共用 8 MiB 的残行上限，超过就被整帧丢掉 —— 跟上面是同一个症状。
  const srv = net.createServer((sock) => {
    new ControlConn(sock).send({ t: "attached", rid: "big", pad: "y".repeat(12 * 1024 * 1024) });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const conn = new ControlConn(net.connect(srv.address().port, "127.0.0.1"));
  const bigT = await new Promise((r) => {
    // 收到就清掉兜底定时器，否则进程要白等 5 秒才退。
    const timer = setTimeout(() => r("timeout"), 5000);
    conn.onMessage((m) => {
      clearTimeout(timer);
      r(m.t);
    });
  });
  conn.socket.destroy();
  srv.close();
  assert.equal(bigT, "attached", "12 MiB 的 attached 帧不能被控制通道当残行丢掉");
  console.log("host-ui-replay-e2e: ok");
} catch (err) {
  console.error(String(err?.stack ?? err));
  console.error(`--- 假脑 ---
${JSON.stringify({ ...stats(), attachedUi: undefined, lastLine: undefined, attached: undefined }).slice(0, 800)}`);
  console.error(`--- host 日志 ---\n${logs.join("").slice(-3000)}`);
  process.exitCode = 1;
} finally {
  killTree(host.pid);
  await Promise.race([new Promise((r) => host.once("exit", r)), sleep(5000)]);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
