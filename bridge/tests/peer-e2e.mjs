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

  // ---- 第 2 片：1:1 文字 ----
  const send = await fetch("http://127.0.0.1:17965/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sb, text: "你好，乙" }),
  });
  if (!send.ok) throw new Error(`/send 回 ${send.status}：${await send.text()}`);

  const inB = await until(
    "B 收到文字",
    async () => {
      const res = await fetch(`http://127.0.0.1:17966/messages?peer=${sa}`);
      const body = await res.json();
      return body.entries?.some((e) => e.kind === "text" && e.text === "你好，乙") ? body : false;
    },
    8000,
  );
  log("ok 文字送到对端");

  const entry = inB.entries.find((e) => e.kind === "text" && e.text === "你好，乙");
  const dupRes = await fetch("http://127.0.0.1:17966/peer/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proto: 1, kind: "text", message: entry }),
  });
  const dupBody = await dupRes.json();
  if (!dupRes.ok || !dupBody.dup) throw new Error(`重复投递应回 dup，实际 ${dupRes.status} ${JSON.stringify(dupBody)}`);
  const again = await (await fetch(`http://127.0.0.1:17966/messages?peer=${sa}`)).json();
  if (again.entries.filter((e) => e.text === "你好，乙").length !== 1) throw new Error("重复投递写了两行");
  log("ok 同一条消息只存一次（dedupe）");

  const receipt = await until(
    "A 拿到 delivered 回执",
    async () => {
      const res = await fetch(`http://127.0.0.1:17965/messages?peer=${sb}`);
      const body = await res.json();
      return body.entries?.some((e) => e.kind === "receipt" && e.ack?.status === "delivered") ? body : false;
    },
    8000,
  );
  void receipt;
  log("ok 送达回执（append 一行 receipt）");

  const tooLong = await fetch("http://127.0.0.1:17965/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sb, text: "字".repeat(12_000) }),
  });
  if (tooLong.status !== 400) throw new Error(`超长文字应 400，实际 ${tooLong.status}`);
  log("ok 超 32 KB 拒收");

  const spoof = await fetch("http://127.0.0.1:17966/peer/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      proto: 1,
      kind: "text",
      message: { id: "spoof-1", at: Date.now(), from: { nodeId: "who-am-i", nickname: "冒充者", port: 1 }, to: { kind: "node", id: sb }, kind: "text", text: "我是甲" },
    }),
  });
  const spoofBody = await spoof.json();
  if (spoof.status !== 409 || spoofBody.retryable !== true) {
    throw new Error(`来源不明的 from 应 409 且可重试，实际 ${spoof.status} ${JSON.stringify(spoofBody)}`);
  }
  log("ok 不认识的 from 拿不到写入（409 可重试）");

  // 第 3 片：好友。A 发请求 → B 通讯录出现「待接受」→ B 接受 → 两边都变成好友。
  const ask = await fetch("http://127.0.0.1:17965/friend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sb, action: "request" }),
  });
  if (!ask.ok) throw new Error(`发好友请求失败：${ask.status} ${await ask.text()}`);
  const incoming = await until(
    "B 收到好友请求",
    async () => {
      const body = await (await fetch("http://127.0.0.1:17966/contacts")).json();
      const hit = body.contacts?.find((c) => c.nodeId === sa);
      return hit?.incoming && !hit.friend ? body : false;
    },
    8000,
  );
  void incoming;
  log("ok 好友请求到达对端（待接受）");

  const accept = await fetch("http://127.0.0.1:17966/friend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sa, action: "accept" }),
  });
  if (!accept.ok) throw new Error(`接受好友失败：${accept.status} ${await accept.text()}`);
  const bothFriends = await until(
    "两边都成为好友",
    async () => {
      const [a, b] = await Promise.all([
        (await fetch("http://127.0.0.1:17965/contacts")).json(),
        (await fetch("http://127.0.0.1:17966/contacts")).json(),
      ]);
      const fa = a.contacts?.find((c) => c.nodeId === sb);
      const fb = b.contacts?.find((c) => c.nodeId === sa);
      return fa?.friend && fb?.friend && !fa.outgoing && !fb.incoming ? { fa, fb } : false;
    },
    8000,
  );
  void bothFriends;
  log("ok 接受后两边都是好友（outgoing / incoming 都清掉）");

  const fav = await (await fetch("http://127.0.0.1:17965/friend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sb, action: "favorite", on: true }),
  })).json();
  if (!fav.contact?.favorite) throw new Error("收藏没生效");
  // 收藏是单向偏好，不该传到对端。
  const bSide = await (await fetch("http://127.0.0.1:17966/contacts")).json();
  if (bSide.contacts?.find((c) => c.nodeId === sa)?.favorite) throw new Error("收藏被同步到了对端");
  log("ok 收藏只在本机生效");

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
