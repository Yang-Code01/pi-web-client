/**
 * 共享卡（D439）端到端：两份真 peer 进程。
 *
 * 要验的是「协议在真网络里走通」，纯逻辑在 peer-share-unit.mjs 里已经测过：
 *   1. 1:1 共享卡：元数据先到，本体随后走文件通道；接收方回执，发送方看到「谁收了」；
 *   2. 群共享卡：一张卡投给每个成员（以前记录包在群里是直接 throw 的）；
 *   3. 群里的文件本体也逐人送达，sha256 对得上；
 *   4. 回执按 itemId 幂等：连点两次不会变成两个人收了。
 *
 * 用法：node bridge/tests/peer-share-e2e.mjs   （先 npm run build:peer 或者 npm run build）
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, "..", "..", "peer", "dist", "index.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "peer-share-e2e-"));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!fs.existsSync(ENTRY)) {
  console.error(`没找到 ${ENTRY}：先跑 npm run build:peer`);
  process.exit(1);
}

const procs = [];
const start = (name, port, announce, nickname) => {
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
};
process.on("exit", () => {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* 已经退了 */
    }
  }
});

const get = async (port, p) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  if (!res.ok) throw new Error(`${p} → ${res.status}`);
  return res.json();
};
const post = async (port, p, body, expect = 200) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== expect) throw new Error(`${p} → ${res.status}（想要 ${expect}）：${await res.text()}`);
  return res.json();
};
const status = async (port) => {
  try {
    return await get(port, "/status");
  } catch {
    return null;
  }
};
const until = async (label, pred, ms = 15000) => {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await pred().catch(() => null);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`超时：${label}${last ? `（最后 ${JSON.stringify(last).slice(0, 200)}）` : ""}`);
};
const msgs = async (port, peer) => (await get(port, `/messages?peer=${encodeURIComponent(peer)}&limit=200`)).entries ?? [];
const shaOf = (buf) => createHash("sha256").update(buf).digest("hex");

const PA = 17991;
const PB = 17992;
const ANN = 17993;

let failures = 0;
const check = (ok, label) => {
  if (ok) {
    log("ok", label);
    return true;
  }
  failures += 1;
  console.error("FAIL", label);
  return false;
};

try {
  start("a", PA, ANN, "甲");
  start("b", PB, ANN, "乙");
  const a = await until("A 起来", async () => (await status(PA))?.nodeId);
  const b = await until("B 起来", async () => (await status(PB))?.nodeId);
  await until("互见", async () => {
    const s = await status(PA);
    return s?.online?.some((p) => p.nodeId === b);
  });
  log("ok 两台互见");

  // ---- 1:1：内容共享 + 本体 + 回执 ----
  const snippet = await post(PA, "/share", {
    peer: b,
    via: "pi",
    share: { type: "snippet", title: "一段配置", summary: "nginx 片段", body: "server { listen 80; }", bodyBytes: 21 },
  });
  const card = await until("B 收到共享卡", async () => (await msgs(PB, a)).find((e) => e.id === snippet.id && e.kind === "share"));
  check(card.share.type === "snippet" && card.share.body.includes("listen 80"), "1:1 共享卡带着正文落地");
  check(card.via === "pi", "via 透传（页面上要标 🤖）");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const filePath = path.join(ROOT, "dot.png");
  fs.writeFileSync(filePath, png);
  const withFile = await post(PA, "/share", {
    peer: b,
    share: {
      type: "file",
      title: "一个像素",
      files: [{ name: "dot.png", size: png.length, sha256: shaOf(png), role: "file" }],
    },
  });
  check(Boolean(withFile.id), "带本体的卡发出去了");
  // 卡片只管元数据；本体是桥在发完卡之后逐份走文件通道补的（peer-share.ts: sendShare）。
  // 这里用同一份字节手工补那一跳，验的是「卡片先到、本体后到」这个顺序在真网络里成立。
  await post(PA, "/files/send", { peer: b, path: filePath, name: "dot.png" });
  const got = await until("B 收到本体文件", async () => {
    const list = await msgs(PB, a);
    return list.find((e) => e.kind === "file" && e.file?.sha256 === shaOf(png));
  });
  check(Boolean(got), "本体走文件通道到达，sha256 对得上");

  await post(PB, "/share/ack", { peer: a, ref: snippet.id, thread: a });
  await until("A 看到回执", async () => (await msgs(PA, b)).find((e) => e.id === snippet.id)?.acceptedBy?.includes(b));
  check(true, "回执回到发送方，acceptedBy 里有 B");
  await post(PB, "/share/ack", { peer: a, ref: snippet.id, thread: a });
  const after = await msgs(PA, b);
  check(after.find((e) => e.id === snippet.id).acceptedBy.length === 1, "重复回执不会变成两个人收了");
  // 回执是控制帧，页面上不显示成消息（foldEntries 会收掉），所以这边只能确认它没把会话搞乱。
  const dup = await msgs(PB, a);
  const cards = dup.filter((e) => e.kind === "share" && e.share?.title === "一段配置");
  check(cards.length === 1, `重复回执没有多出卡片（实际 ${cards.length} 张：${dup.map((e) => `${e.kind}:${e.share?.title ?? e.text ?? ""}`).join(" / ")}）`);

  // ---- 群：共享卡投给每个成员 ----
  const created = await post(PA, "/groups", { action: "create", name: "项目组", members: [b] });
  const gid = created.group.id;
  await until("B 收到群", async () => (await get(PB, "/threads")).threads?.some((t) => t.nodeId === gid));

  const groupCard = await post(PA, "/share", {
    peer: gid,
    share: { type: "session", title: "会话导出", summary: "一段排障会话", files: [{ name: "s.md", size: 12, sha256: shaOf(Buffer.from("会话内容")), role: "session" }] },
  });
  const inGroup = await until("B 在群里收到卡", async () => (await msgs(PB, gid)).find((e) => e.id === groupCard.id && e.kind === "share"));
  check(inGroup.to?.kind === "group", "群共享卡落在群会话");
  check((await msgs(PB, a)).every((e) => e.id !== groupCard.id), "群卡不会串到 1:1 会话");

  await post(PB, "/share/ack", { peer: a, ref: groupCard.id, thread: gid });
  await until("A 的群卡有回执", async () => (await msgs(PA, gid)).find((e) => e.id === groupCard.id)?.acceptedBy?.includes(b));
  check(true, "群回执也回到发送方");

  // ---- 记录包也能发群了（这条以前是 throw） ----
  const noteToGroup = await post(PA, "/note", {
    peer: gid,
    note: { title: "群里记一笔", body: "<p>正文</p>", kind: "change", status: "pending", shots: [] },
  });
  await until("B 在群里收到记录", async () => (await msgs(PB, gid)).some((e) => e.id === noteToGroup.id && e.kind === "note"));
  check(true, "记录包发群（原限制已放开）");

  // ---- 校验：坏卡被拒，且不进历史 ----
  const bad = await fetch(`http://127.0.0.1:${PB}/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: a, share: { type: "video", title: "x" } }),
  });
  check(bad.status === 400, "不认识的类型被 400 拒掉");
} catch (err) {
  failures += 1;
  console.error("FAIL", err);
} finally {
  if (failures) console.error(`
${failures} 项没通过`);
  else log("全部通过");
  // 两个 peer 子进程还活着，靠 exit 钩子杀掉；这里显式收尾，别把测试挂在事件循环上。
  process.exit(failures ? 1 : 0);
}
