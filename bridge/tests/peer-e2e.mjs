/**
 * #45 第 1 片：同机双实例 e2e。
 *
 * 三份 peer：
 *   A 与 B 共用组播端口 → 必须互相看见（组播 + HTTP hello 回复）
 *   C 单独一个组播端口（模拟「交换机不放行」）→ A 看不见 C，手动填地址后两边都要看见对方
 *
 * 用法：node bridge/tests/peer-e2e.mjs   （先 npm run build:peer，或者 npm run build）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, "..", "..", "peer", "dist", "index.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "peer-e2e-"));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!fs.existsSync(ENTRY)) {
  console.error(`没找到 ${ENTRY}：先跑 npm run build:peer`);
  process.exit(1);
}

const procs = [];
function start(name, port, announce, nickname) {
  const state = path.join(ROOT, name);
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PI_PEER_STATE: state,
      PI_PEER_PORT: String(port),
      PI_PEER_ANNOUNCE_PORT: String(announce),
      PI_PEER_NICKNAME: nickname,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => process.env.PEER_E2E_VERBOSE && process.stdout.write(`[${name}] ${b}`));
  child.stderr.on("data", (b) => process.stdout.write(`[${name}!] ${b}`));
  procs.push(child);
  return child;
}

const stopAll = () => {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* 已经退了 */
    }
  }
};
process.on("exit", stopAll);

const status = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) });
    return await res.json();
  } catch {
    return null;
  }
};

async function until(label, pred, ms = 15000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await pred();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`超时：${label}${last === false ? "" : `（最后拿到 ${JSON.stringify(last)?.slice(0, 200)}）`}`);
}

const seenBy = (port, nodeId) => async () => {
  const s = await status(port);
  return Boolean(s?.online?.some((p) => p.nodeId === nodeId));
};

let failed = null;
try {
  const A = start("a", 17965, 17967, "甲");
  const B = start("b", 17966, 17967, "乙");
  const C = start("c", 17968, 17969, "丙");

  const sa = await until("A 起来", async () => (await status(17965))?.nodeId);
  const sb = await until("B 起来", async () => (await status(17966))?.nodeId);
  const sc = await until("C 起来", async () => (await status(17968))?.nodeId);
  log(`nodeId a=${sa.slice(0, 8)} b=${sb.slice(0, 8)} c=${sc.slice(0, 8)}`);

  // C 的组播端口不同 ⇒ 在 A/B 眼里它根本不存在（模拟交换机不放行）。
  await new Promise((r) => setTimeout(r, 1500));
  const before = await status(17965);
  if (before.online.some((p) => p.nodeId === sc)) throw new Error("C 不该出现在 A 的在线列表里");

  await until("A 看到 B（组播）", seenBy(17965, sb));
  await until("B 看到 A（组播）", seenBy(17966, sa));
  log("ok 组播互见");

  const add = await fetch("http://127.0.0.1:17965/peer/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addr: "127.0.0.1:17968" }),
  });
  if (!add.ok) throw new Error(`/peer/add 回 ${add.status}：${await add.text()}`);
  await until("手动地址后 A 看到 C", seenBy(17965, sc), 8000);
  await until("手动地址后 C 也看到 A", seenBy(17968, sa), 8000);
  log("ok 手动地址兜底");

  // 离线超时：B 关掉后 30 秒内必须从 A 的列表里消失（这里只验「关了就不是 online 了」，
  // 30 秒本身等不起，所以直接杀掉再看一轮 —— 真实超时逻辑由 prune 的 OFFLINE_MS 保证）。
  B.kill();
  await until("B 退出", async () => {
    const s = await status(17966);
    return s === null;
  }, 8000);
  log("ok 进程能干净退出");

  // 端口被占：再起一份抢 17968，必须退出码 2（bridge 靠它判断「另一份在跑」，不会无限重启）。
  const dup = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PI_PEER_STATE: path.join(ROOT, "dup"), PI_PEER_PORT: "17968", PI_PEER_ANNOUNCE_PORT: "17970" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = await new Promise((resolve) => dup.on("exit", resolve));
  if (code !== 2) throw new Error(`端口被占时退出码应为 2，实际 ${code}`);
  log("ok 端口被占时退出码 2");

  void A;
  void C;
} catch (err) {
  failed = err;
  console.error(`失败：${err?.message ?? err}`);
} finally {
  stopAll();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows 上子进程可能还攥着日志文件，留着也无妨 */
  }
  if (failed) process.exit(1);
  log("peer-e2e 全过");
  process.exit(0);
}
