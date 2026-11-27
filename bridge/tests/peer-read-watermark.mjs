/**
 * 已读水位要清掉「比最后一条更早、但落盘更晚」的消息。
 *
 * 真实形状（2026-11-27 本机 `~/.pi-peer/history/90255371-….jsonl`）：对方先发文件、
 * 后发带截图的记录包，但记录包走 text 通道、文件走 begin/chunk/end 通道，**文件后到**。
 * 落盘顺序 = 到达顺序，`at` = 发送方的时间，于是最后一行（文件）的 `at` 比它上面那条
 * 记录包**更早**。页面把「最后一条」当水位打过来（`web/src/peer/main.ts` 的 `markRead`），
 * 后端按 `{at,id}` 比较，那条更早的记录包就永远落在水位之后 —— 未读徽标卡在 1 清不掉。
 *
 * 用法：node bridge/tests/peer-read-watermark.mjs   （先 npm run build:peer）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "../../tools/free-port.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, "..", "..", "peer", "dist", "index.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "peer-read-watermark-"));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!fs.existsSync(ENTRY)) {
  console.error(`没找到 ${ENTRY}：先跑 npm run build:peer`);
  process.exit(1);
}

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "aaaaaaaa-1111-4111-8111-111111111111";
const PORT = await freePort();
const ANNOUNCE = await freePort();
const state = path.join(ROOT, "state");
fs.mkdirSync(path.join(state, "history"), { recursive: true });

const from = { nodeId: PEER, nickname: "小王", hostname: "xiaowang-pc", port: 7865 };
const T = Date.now() - 60_000;
const note = {
  id: "01a21ad8-8aa2-769c-8d15-7d2c9023e485",
  at: T + 1011,
  from,
  to: { kind: "node", id: ME },
  kind: "note",
  note: { title: "pi无法通知", body: "<p>pi无法发送通知</p>", kind: "bug", status: "pending", shots: [] },
};
// 文件后到，但 `at` 比上面那条记录包早 —— 这就是卡住未读的那一行。
const file = {
  id: "01a21ad8-8ab0-7717-a548-4b4c9e8bd186",
  at: T,
  from: { nodeId: PEER },
  to: { kind: "node", id: ME },
  kind: "file",
  file: { name: "shot-1 (9).png", size: 324113, mime: "image/png" },
};
const historyFile = path.join(state, "history", `${PEER}.jsonl`);
fs.writeFileSync(historyFile, `${JSON.stringify(note)}\n${JSON.stringify(file)}\n`);
// 页面已经为这个会话打过一次水位、且打的正是「最后一条」：这就是用户「已经读过」之后的状态。
fs.writeFileSync(path.join(state, "threads.json"), JSON.stringify({ [PEER]: { readAt: file.at, readId: file.id } }));
fs.writeFileSync(
  path.join(state, "peers.json"),
  JSON.stringify({ [PEER]: { nickname: "小王", hostname: "xiaowang-pc", port: 7865, friend: true, favorite: false, incoming: false, outgoing: false, at: T } }),
);

const child = spawn(process.execPath, [ENTRY], {
  env: {
    ...process.env,
    PI_PEER_STATE: state,
    PI_PEER_PORT: String(PORT),
    PI_PEER_ANNOUNCE_PORT: String(ANNOUNCE),
    PI_PEER_NICKNAME: "probe",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (b) => process.env.PEER_E2E_VERBOSE && process.stdout.write(`[peer] ${b}`));
child.stderr.on("data", (b) => process.stdout.write(`[peer!] ${b}`));

const api = (p) => `http://127.0.0.1:${PORT}${p}`;
const thread = async () => (await (await fetch(api("/threads"))).json()).threads?.[0];
/** 页面 `markRead()` 干的事：拿「最后一条」的 {at,id} 当水位。 */
const markRead = (last) =>
  fetch(api("/threads/read"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: PEER, at: last.at, id: last.id }),
  });

const until = async (what, fn, ms = 6000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await fn().catch(() => false);
    if (got) return got;
    if (Date.now() > end) throw new Error(`等不到「${what}」`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

let failed = null;
try {
  await until(
    "peer 起来",
    async () => (await fetch(api("/status"), { signal: AbortSignal.timeout(800) })).ok,
  );

  const before = await thread();
  if (!before) throw new Error("/threads 里没有这个会话");
  // 卡住的正是那条「更早发出、更晚到达」的记录包：水位已经打在最后一条文件上，它仍然是未读。
  if (before.unread !== 1) throw new Error(`前置状态应是 1 条未读，实际 ${before.unread}`);
  if (before.last?.kind !== "file") throw new Error(`最后一条应是后到的文件，实际 ${JSON.stringify(before.last)}`);
  log(`ok 前置：未读 1，最后一条是「${before.last.file?.name}」（at 比上面那条记录包早）`);

  const res = await markRead(before.last);
  if (!res.ok) throw new Error(`打水位失败：${res.status} ${await res.text()}`);

  await until("打完水位未读归零", async () => (await thread())?.unread === 0);
  log("ok 打水位之后未读归零（后到但更早的那条也被清掉）");

  // 水位之后真来了新消息，还是得算未读 —— 兜底不能把会话整段清空。
  fs.appendFileSync(
    historyFile,
    `${JSON.stringify({ id: "01a21ad8-8ac0-7717-a548-4b4c9e8bd186", at: T + 5000, from, to: { kind: "node", id: ME }, kind: "text", text: "水位之后" })}\n`,
  );
  await until("新来的那条算 1 条未读", async () => (await thread())?.unread === 1);
  log("ok 水位之后新来的消息仍然算未读");

  await markRead((await thread()).last);
  await until("再打一次水位又归零", async () => (await thread())?.unread === 0);
  log("ok 再打一次水位归零");
} catch (err) {
  failed = err;
  console.error(`失败：${err?.message ?? err}`);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 200));
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows 上子进程可能还攥着文件 */
  }
  if (failed) process.exit(1);
  log("peer-read-watermark 全过");
  process.exit(0);
}
