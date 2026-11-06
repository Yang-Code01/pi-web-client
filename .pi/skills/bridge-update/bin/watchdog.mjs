#!/usr/bin/env node
/**
 * D154：bridge 看门狗。由 Windows 计划任务每分钟跑一次（见 install-watchdog.ps1）。
 * 只在 `/healthz` 一段时间不通时拉起 `node bridge/dist/index.js`；不 build、不 pull、不杀任何进程。
 *
 *   node watchdog.mjs [--dir <repo>] [--port 7864]
 *   node watchdog.mjs --stop     # 人为停机（写 stopped.flag，看门狗不再拉起）
 *   node watchdog.mjs --start    # 解除 --stop
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "../../../..");
const WORK = path.join(REPO, ".scratch", "bridge-update");
const LOCK = path.join(WORK, "restart.lock");
const FLAG = path.join(WORK, "stopped.flag");
const LOG = path.join(WORK, "watchdog.log");
const STAMP = path.join(WORK, "watchdog.last-start");

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const PORT = Number(argOf("--port", process.env.PI_WEB_PORT || 7864));
// 拉起来的进程必须落在「我们盯着的那一个」端口上：--port 与 PI_WEB_PORT 不一致时，
// 子进程会去抢默认的 7864（EADDRINUSE），然后我们永远等不到自己那个端口。
process.env.PI_WEB_PORT = String(PORT);

function log(...parts) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1_000_000) fs.writeFileSync(LOG, "");
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${parts.join(" ")}\n`);
  } catch {}
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function markStopped(stopped, why) {
  fs.mkdirSync(WORK, { recursive: true });
  if (stopped) fs.writeFileSync(FLAG, `${new Date().toISOString()} ${why ?? ""}\n`);
  else fs.rmSync(FLAG, { force: true });
  log(stopped ? "stopped: 已挂停机标志，看门狗不再拉起" : "started: 停机标志已清除");
  console.log(stopped ? "stopped" : "started");
}

async function healthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function lockFresh() {
  const lock = readJson(LOCK);
  return lock && typeof lock.at === "string" && Date.now() - Date.parse(lock.at) < 5 * 60 * 1000;
}

function cooledDown() {
  const raw = fs.existsSync(STAMP) ? Number(fs.readFileSync(STAMP, "utf8").trim()) : 0;
  return Number.isFinite(raw) && Date.now() - raw < 5 * 60 * 1000;
}

async function main() {
  if (process.argv.includes("--stop")) return markStopped(true, "watchdog --stop");
  if (process.argv.includes("--start")) return markStopped(false);

  fs.mkdirSync(WORK, { recursive: true });
  if (fs.existsSync(FLAG)) return;
  if (lockFresh()) {
    log("skip: 正在更新（restart.lock 新鲜）");
    return;
  }
  if (await healthy()) return;
  if (cooledDown()) {
    log("skip: 5 分钟内已拉过一次，还在冷静期");
    return;
  }
  if (!fs.existsSync(path.join(REPO, "bridge", "dist", "index.js"))) {
    log("skip: 没有 bridge/dist/index.js，先跑 npm run build");
    return;
  }

  fs.writeFileSync(STAMP, String(Date.now()));
  const out = fs.openSync(LOG, "a");
  const child = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: REPO,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  log(`healthz 不通，已拉起 pid ${child.pid ?? "?"}`);
}

main().catch((e) => log("FATAL", e?.stack ?? e?.message ?? String(e)));
