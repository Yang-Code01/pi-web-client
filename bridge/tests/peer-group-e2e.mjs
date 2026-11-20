/**
 * 内网通「Teams 化」一组：备注同步到会话、固定消息、基础群聊（建群 / 发消息 / 改名 / 拉人 / 文件 / 退群）。
 *
 * 三份 peer 共用一个组播端口，互相看得见。
 * 用法：node bridge/tests/peer-group-e2e.mjs   （先 npm run build:peer）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, "..", "..", "peer", "dist", "index.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "peer-group-"));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!fs.existsSync(ENTRY)) {
  console.error(`没找到 ${ENTRY}：先跑 npm run build:peer`);
  process.exit(1);
}

const procs = [];
function start(name, port, announce, nickname) {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PI_PEER_STATE: path.join(ROOT, name),
      PI_PEER_PORT: String(port),
      PI_PEER_ANNOUNCE_PORT: String(announce),
      PI_PEER_NICKNAME: nickname,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => {
    if (process.env.PEER_E2E_VERBOSE) process.stdout.write(`[${name}] ${b}`);
  });
  child.stderr.on("data", (b) => process.stdout.write(`[${name}!] ${b}`));
  procs.push(child);
  return child;
}
process.on("exit", () => {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* 已经退了 */
    }
  }
});

const get = async (port, p) => (await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(3000) })).json();
async function post(port, p, body, expect = 200) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== expect) throw new Error(`${p} 应 ${expect}，实际 ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const status = async (port) => {
  try {
    return await get(port, "/status");
  } catch {
    return null;
  }
};
async function until(label, pred, ms = 15000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await pred().catch(() => null);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`超时：${label}${last ? `（最后 ${JSON.stringify(last).slice(0, 200)}）` : ""}`);
}
const msgs = async (port, peer) => (await get(port, `/messages?peer=${encodeURIComponent(peer)}&limit=200`)).entries ?? [];
const thread = async (port, id) => (await get(port, "/threads")).threads?.find((t) => t.nodeId === id);

const PA = 17981;
const PB = 17982;
const PC = 17983;
const ANN = 17984;

let failed = null;
try {
  start("a", PA, ANN, "甲");
  start("b", PB, ANN, "乙");
  start("c", PC, ANN, "丙");
  const a = await until("A 起来", async () => (await status(PA))?.nodeId);
  const b = await until("B 起来", async () => (await status(PB))?.nodeId);
  const c = await until("C 起来", async () => (await status(PC))?.nodeId);
  for (const [port, others] of [
    [PA, [b, c]],
    [PB, [a, c]],
    [PC, [a, b]],
  ]) {
    await until(`互见 ${port}`, async () => {
      const s = await status(port);
      return others.every((id) => s?.online?.some((p) => p.nodeId === id));
    });
  }
  log("ok 三台互见");

  // ---- 备注：会话列表里的名字跟着通讯录备注走，不再被对方自报的昵称盖掉。 ----
  await post(PA, "/send", { peer: b, text: "你好乙" });
  await post(PA, "/friend", { peer: b, action: "rename", name: "小乙" });
  await until("A 的会话行显示备注", async () => (await thread(PA, b))?.nickname === "小乙");
  log("ok 备注同步到会话列表");

  // ---- 固定消息（1:1）：A 固定，B 那边也看到 pinned；取消后两边都没了。 ----
  const first = (await msgs(PA, b)).find((e) => e.kind === "text");
  await until("B 收到第一条", async () => (await msgs(PB, a)).some((e) => e.id === first.id));
  await post(PA, "/pin", { peer: b, id: first.id, on: true });
  if (!(await msgs(PA, b)).find((e) => e.id === first.id)?.pinned) throw new Error("A 本机没固定上");
  await until("B 也看到固定", async () => (await msgs(PB, a)).find((e) => e.id === first.id)?.pinned);
  await post(PB, "/pin", { peer: a, id: first.id, on: false });
  await until("A 看到取消固定", async () => !(await msgs(PA, b)).find((e) => e.id === first.id)?.pinned);
  log("ok 固定 / 取消固定双向同步");

  // ---- 建群：B、C 都收到名单与灰条。 ----
  const created = await post(PA, "/groups", { action: "create", name: "项目组", members: [b, c] });
  const gid = created.group.id;
  if (!gid.startsWith("grp-")) throw new Error(`群 id 不对：${gid}`);
  for (const port of [PB, PC]) {
    await until(`${port} 收到群`, async () => {
      const t = await thread(port, gid);
      return t?.nickname === "项目组" && t.group?.members?.length === 3 ? t : false;
    });
  }
  const sysB = (await msgs(PB, gid)).find((e) => e.kind === "sys");
  if (sysB?.sys?.op !== "create") throw new Error(`B 应有「创建」灰条：${JSON.stringify(sysB)}`);
  log("ok 建群：成员都收到名单");

  // ---- 群消息：A 发、B C 收；B 回、A C 收；落在群会话里而不是 1:1。 ----
  const sent = await post(PA, "/send", { peer: gid, text: "大家好" });
  for (const port of [PB, PC]) {
    await until(`${port} 收到群消息`, async () => (await msgs(port, gid)).some((e) => e.id === sent.id && e.to?.kind === "group"));
  }
  await until("A 的群消息变成已送达", async () => (await msgs(PA, gid)).find((e) => e.id === sent.id)?.state === "delivered");
  const reply = await post(PB, "/send", { peer: gid, text: "收到", replyTo: { id: sent.id, from: "甲", excerpt: "大家好" } });
  for (const port of [PA, PC]) {
    await until(`${port} 收到 B 的群回复`, async () => (await msgs(port, gid)).some((e) => e.id === reply.id && e.from.nodeId === b));
  }
  if ((await msgs(PC, b)).some((e) => e.id === reply.id)) throw new Error("群消息不该落到 1:1 会话");
  log("ok 群消息三方互通");

  // ---- 群里的回应 / 固定 / 撤回都落在群会话。 ----
  await post(PC, "/react", { peer: gid, id: sent.id, emoji: "👍", on: true });
  await until("A 看到 C 的回应", async () => (await msgs(PA, gid)).find((e) => e.id === sent.id)?.reactions?.[0]?.who?.includes(c));
  await post(PC, "/pin", { peer: gid, id: reply.id, on: true });
  await until("A、B 看到群固定", async () => {
    const [x, y] = await Promise.all([msgs(PA, gid), msgs(PB, gid)]);
    return x.find((e) => e.id === reply.id)?.pinned && y.find((e) => e.id === reply.id)?.pinned;
  });
  const oops = await post(PB, "/send", { peer: gid, text: "发错了" });
  await until("C 收到要撤回的那条", async () => (await msgs(PC, gid)).some((e) => e.id === oops.id));
  await post(PB, "/recall", { peer: gid, id: oops.id });
  await until("A、C 看到撤回", async () => {
    const [x, y] = await Promise.all([msgs(PA, gid), msgs(PC, gid)]);
    return x.find((e) => e.id === oops.id)?.recalled && y.find((e) => e.id === oops.id)?.recalled;
  });
  log("ok 群里回应 / 固定 / 撤回");

  // ---- 群文件：A 发一张图，B C 都在群会话里收到。 ----
  const png = path.join(ROOT, "dot.png");
  fs.writeFileSync(
    png,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
  );
  const file = await post(PA, "/files/send", { peer: gid, path: png, name: "dot.png" });
  for (const port of [PB, PC]) {
    await until(`${port} 收到群文件`, async () => (await msgs(port, gid)).some((e) => e.id === file.id && e.kind === "file"));
  }
  await until("A 自己的群文件卡片", async () => (await msgs(PA, gid)).some((e) => e.id === file.id && e.kind === "file"));
  log("ok 群文件");

  // ---- 改名 + 退群。 ----
  await post(PB, "/groups", { action: "rename", id: gid, name: "新项目组" });
  for (const port of [PA, PC]) await until(`${port} 看到改名`, async () => (await thread(port, gid))?.nickname === "新项目组");
  await post(PC, "/groups", { action: "leave", id: gid });
  if (!(await thread(PC, gid))?.group?.left) throw new Error("C 退群后本机应标 left");
  await post(PC, "/send", { peer: gid, text: "还能发吗" }, 400);
  for (const port of [PA, PB]) {
    await until(`${port} 看到 C 退群`, async () => (await thread(port, gid))?.group?.members?.length === 2);
  }
  const afterLeave = await post(PA, "/send", { peer: gid, text: "C 走了" });
  await until("B 收到退群后的消息", async () => (await msgs(PB, gid)).some((e) => e.id === afterLeave.id));
  await new Promise((r) => setTimeout(r, 800));
  if ((await msgs(PC, gid)).some((e) => e.id === afterLeave.id)) throw new Error("退群的人不该再收到群消息");
  // 拉回来：C 重新在名单里，能收能发。
  await post(PA, "/groups", { action: "invite", id: gid, members: [c] });
  await until("C 被拉回", async () => (await thread(PC, gid))?.group?.left === false);
  const back = await post(PC, "/send", { peer: gid, text: "我回来了" });
  await until("A 收到 C 回群后的消息", async () => (await msgs(PA, gid)).some((e) => e.id === back.id));
  log("ok 改名 / 退群 / 重新拉人");

  // 记录包在群里不支持：明确报错而不是悄悄发成 1:1。
  await post(PA, "/note", { peer: gid, note: { title: "t", body: "<p>x</p>", kind: "idea", status: "pending", shots: [] } }, 400);
  log("ok 群里拒绝记录包");

  // ---- 重要 / 紧急 + 话题回复：字段跟着消息走；紧急让免打扰的会话也带 urgent。 ----
  await post(PB, "/threads/patch", { peer: gid, muted: true });
  const loud = await post(PA, "/send", { peer: gid, text: "今天上线", priority: "urgent" });
  await until("B 收到紧急消息", async () => (await msgs(PB, gid)).find((e) => e.id === loud.id)?.priority === "urgent");
  await until("B 的会话行带 urgent", async () => (await thread(PB, gid))?.urgent === true);
  const topicReply = await post(PB, "/send", { peer: gid, text: "几点？", topic: loud.id });
  await until("A 收到话题回复", async () => (await msgs(PA, gid)).find((e) => e.id === topicReply.id)?.topic === loud.id);
  await post(PA, "/send", { peer: gid, text: "x", topic: "no-such-topic-0000" }, 400);
  const at = await post(PC, "/send", { peer: gid, text: "@乙 看一下" });
  await until("B 的会话行带 mention", async () => (await thread(PB, gid))?.mention === true && at.id);
  log("ok 紧急 / 话题 / @ 标记");

  // ---- 已读回执：B、C 读到 A 的消息，A 的气泡上 readBy 有他们；1:1 同理。 ----
  const readMe = await post(PA, "/send", { peer: gid, text: "谁看了？" });
  await until("B 收到", async () => (await msgs(PB, gid)).some((e) => e.id === readMe.id));
  await post(PB, "/threads/read", { peer: gid, at: readMe.at, id: readMe.id });
  await until("A 看到 B 已读", async () => (await msgs(PA, gid)).find((e) => e.id === readMe.id)?.readBy?.includes(b));
  if ((await msgs(PA, gid)).find((e) => e.id === readMe.id)?.readBy?.includes(c)) throw new Error("C 还没读");
  await until("C 收到", async () => (await msgs(PC, gid)).some((e) => e.id === readMe.id));
  await post(PC, "/threads/read", { peer: gid, at: readMe.at, id: readMe.id });
  await until("A 看到 B、C 都已读", async () => (await msgs(PA, gid)).find((e) => e.id === readMe.id)?.readBy?.length === 2);
  // 旧水位不会把新的盖回去：更早的消息也算已读。
  if (!(await msgs(PA, gid)).find((e) => e.id === afterLeave.id)?.readBy?.includes(b)) throw new Error("更早的消息也应算 B 已读");
  const dm = await post(PA, "/send", { peer: c, text: "私聊已读吗" });
  await until("C 收到私聊", async () => (await msgs(PC, a)).some((e) => e.id === dm.id));
  await post(PC, "/threads/read", { peer: a, at: dm.at, id: dm.id });
  await until("A 看到私聊已读", async () => (await msgs(PA, c)).find((e) => e.id === dm.id)?.readBy?.includes(c));
  log("ok 已读回执");
} catch (err) {
  failed = err;
}

if (failed) {
  console.error("FAIL", failed?.stack ?? failed);
  process.exit(1);
}
log("全部通过");
process.exit(0);
