/**
 * 内网通 outbox / 回执 / 收文件的回归测试（fix/peer-outbox）。
 *
 * 一、Outbox 单元（直接 import `peer/dist/outbox.js`，假的 deliver）：
 *   1. 同一个人：队头吃一个可重试失败，后面的不许越过它先送到（保序）；
 *   2. 不同的人：一个人的投递卡住，不拖住发给别人的；
 *   3. 投递前按 nodeId 现查地址（对端换了 IP / 端口）。
 * 二、两份真 peer 的 e2e：
 *   4. 记录包送达后 A 侧状态是 `delivered`（以前一直是空的）；
 *   5. B 下线期间 A 发的消息，B 换了端口回来后要能送到（以前一直投旧端口）；
 *   6. 发一个文件：两边都落卡片，哈希对得上（收方改成边收边算之后）。
 *
 * 用法：node bridge/tests/peer-outbox.mjs   （先 npm run build:peer）
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freePort } from "../../tools/free-port.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.PEER_DIST || path.resolve(here, "..", "..", "peer", "dist");
const ENTRY = path.join(DIST, "index.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "peer-outbox-"));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, extra = "") => {
  if (ok) log(`ok   ${what}`);
  else {
    failed += 1;
    log(`FAIL ${what} ${extra}`);
  }
};

if (!fs.existsSync(ENTRY)) {
  console.error(`没找到 ${ENTRY}：先跑 npm run build:peer`);
  process.exit(2);
}

// ------------------------------------------------------------------ 一、Outbox 单元
process.env.PI_PEER_STATE = path.join(ROOT, "unit");
fs.mkdirSync(process.env.PI_PEER_STATE, { recursive: true });
const { Outbox } = await import(pathToFileURL(path.join(DIST, "outbox.js")).href);
const item = (id, peerId, extra = {}) => ({ id, peerId, addr: "10.0.0.1", port: 1, kind: "text", payload: {}, at: Date.now(), tries: 0, nextAt: 0, ...extra });

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return null;
}

{
  // 1. 保序：m1 第一次 409，m2 不许先到。两条都已在落盘的队列里（重启后补投的真实形状），
  // 这样同一轮 flush 就会看到它们俩 —— 旧代码在这一轮里跳过 m1 直接投 m2。
  fs.writeFileSync(path.join(process.env.PI_PEER_STATE, "outbox.json"), JSON.stringify([item("m1", "P"), item("m2", "P")]));
  const arrived = [];
  let m1Tries = 0;
  const box = new Outbox({
    log: () => {},
    deliver: async (it) => {
      if (it.id === "m1" && m1Tries++ === 0) return { ok: false, retryable: true, error: "409" };
      arrived.push(it.id);
      return { ok: true };
    },
    settled: () => {},
  });
  box.start();
  await until(() => arrived.length === 2, 10_000);
  check(arrived.join(",") === "m1,m2", "同一个人：队头重试期间后面的不越过它", `实际 ${arrived.join(",")}`);
  box.stop();
}

{
  // 2. 不同的人互不等：X 卡 3 秒，Y 应当立刻送到。
  const at = {};
  const t0 = Date.now();
  const box = new Outbox({
    log: () => {},
    deliver: async (it) => {
      if (it.peerId === "X") await sleep(3000);
      at[it.id] = Date.now() - t0;
      return { ok: true };
    },
    settled: () => {},
  });
  box.start();
  box.add(item("x1", "X"));
  box.add(item("y1", "Y"));
  await until(() => at.x1 !== undefined && at.y1 !== undefined, 8000);
  check(at.y1 !== undefined && at.y1 < 1000, "不同的人：一个卡住不拖别人", `y1 用了 ${at.y1} ms`);
  box.stop();
}

{
  // 3. 现查地址。
  let sentTo = "";
  const box = new Outbox({
    log: () => {},
    deliver: async (it) => {
      sentTo = `${it.addr}:${it.port}`;
      return { ok: true };
    },
    settled: () => {},
    locate: () => ({ addr: "10.0.0.9", port: 9 }),
  });
  box.start();
  box.add(item("a1", "Z"));
  await until(() => sentTo, 3000);
  check(sentTo === "10.0.0.9:9", "投递前按 nodeId 现查地址", `实际 ${sentTo}`);
  box.stop();
}

// ------------------------------------------------------------------ 二、两份真 peer
const ANN = await freePort();
const procs = [];
function start(name, port) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PI_PEER_STATE: path.join(ROOT, name), PI_PEER_PORT: String(port), PI_PEER_ANNOUNCE_PORT: String(ANN), PI_PEER_NICKNAME: name },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => process.env.PEER_E2E_VERBOSE && process.stdout.write(`[${name}] ${b}`));
  child.stderr.on("data", (b) => process.stdout.write(`[${name}!] ${b}`));
  procs.push(child);
  return child;
}
const stopAll = () => procs.forEach((p) => { try { p.kill(); } catch { /* 已经退了 */ } });
process.on("exit", stopAll);
const get = async (port, p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
const post = async (port, p, body) =>
  (await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
async function waitFor(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return null;
}

try {
  const PA = await freePort();
  const PB = await freePort();
  const PB2 = await freePort();
  start("A", PA);
  const b = start("B", PB);
  const aId = await waitFor(async () => (await get(PA, "/status")).nodeId);
  const bId = await waitFor(async () => (await get(PB, "/status")).nodeId);
  const seen = await waitFor(async () => (await get(PA, "/status")).online.find((p) => p.nodeId === bId));
  check(Boolean(seen), "A 看见 B");

  // 4. 记录包回执
  const note = await post(PA, "/note", { peer: bId, note: { title: "回执", body: "<p>x</p>", kind: "bug", status: "pending", shots: [] } });
  const noteState = await waitFor(async () => {
    const e = (await get(PA, `/messages?peer=${bId}`)).entries.find((x) => x.id === note.id);
    return e?.state === "delivered" ? e.state : null;
  }, 10_000);
  check(noteState === "delivered", "记录包送达后 A 侧是「已送达」");

  // 6. 文件（先做：后面要杀 B）
  const file = path.join(ROOT, "blob.bin");
  const bytes = Buffer.alloc(2.5 * 1024 * 1024 + 123);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) & 0xff;
  fs.writeFileSync(file, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const sent = await post(PA, "/files/send", { peer: bId, path: file });
  const got = await waitFor(async () => (await get(PB, `/messages?peer=${aId}`)).entries.find((e) => e.id === sent.id && e.kind === "file"), 15_000);
  check(got?.file?.sha256 === sha && got.file.size === bytes.length, "文件收到，哈希与大小对得上");
  const mine = await waitFor(async () => (await get(PA, `/messages?peer=${bId}`)).entries.find((e) => e.id === sent.id), 5000);
  check(Boolean(mine), "发送方也落了文件卡片");

  // 5. B 下线 → A 发 → B 换端口回来
  b.kill();
  await sleep(1500);
  const later = await post(PA, "/send", { peer: bId, text: "换端口之后" });
  check(later.ok === true, "B 下线后仍能入队");
  start("B", PB2);
  const moved = await waitFor(async () => (await get(PA, "/status")).online.find((p) => p.nodeId === bId && p.port === PB2));
  check(Boolean(moved), "A 学到 B 的新端口");
  const arrived = await waitFor(async () => (await get(PB2, `/messages?peer=${aId}`)).entries.some((e) => e.text === "换端口之后"), 30_000);
  check(Boolean(arrived), "换端口前排队的消息送到了新端口");
} finally {
  stopAll();
}

log(failed ? `${failed} 项失败` : "全部通过");
process.exit(failed ? 1 : 0);
