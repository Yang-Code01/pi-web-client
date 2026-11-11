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

  // #381：C 只是被 A 发现、没有任何关系记录，通讯录仍要把它合并出来，且不写任何关系。
  const merged = await until(
    "在线陌生人合并进通讯录",
    async () => {
      const [contacts, live] = await Promise.all([
        (await fetch("http://127.0.0.1:17965/contacts")).json(),
        status(17965),
      ]);
      const c = contacts.contacts?.find((x) => x.nodeId === sc);
      const p = live?.online?.find((x) => x.nodeId === sc);
      if (!c || !p) return false;
      return [
        c.quick === false,
        c.friend === false,
        c.favorite === false,
        c.incoming === false,
        c.outgoing === false,
        c.ignored === false,
        c.online === true,
        c.nickname === p.nickname,
        c.hostname === p.hostname,
        c.addr === p.addr,
        c.livePort === p.port,
      ].every(Boolean) ? c : false;
    },
    8000,
  );
  void merged;
  log("ok 在线陌生人进通讯录且关系字段全假");

  // ---- #382：一键快捷添加。quick 与好友正交：双方立刻可聊，但不产生待接受申请、不放开文件。 ----
  const quickRes = await fetch("http://127.0.0.1:17965/friend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sc, action: "quick" }),
  });
  if (!quickRes.ok) throw new Error(`快捷添加应 200，实际 ${quickRes.status} ${await quickRes.text()}`);
  const quickBoth = await until(
    "两边都记成 quick（不是好友、也没有待处理）",
    async () => {
      const [a, c] = await Promise.all([
        (await fetch("http://127.0.0.1:17965/contacts")).json(),
        (await fetch("http://127.0.0.1:17968/contacts")).json(),
      ]);
      const onA = a.contacts?.filter((x) => x.nodeId === sc) ?? [];
      const onC = c.contacts?.filter((x) => x.nodeId === sa) ?? [];
      const ok = (row) => row?.quick === true && row.friend === false && row.incoming === false && row.outgoing === false;
      return onA.length === 1 && onC.length === 1 && ok(onA[0]) && ok(onC[0]) ? { onA, onC } : false;
    },
    8000,
  );
  void quickBoth;
  log("ok 快捷添加双方立刻是 quick，且没有待接受申请");

  const quickAgain = await fetch("http://127.0.0.1:17965/friend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sc, action: "quick" }),
  });
  if (!quickAgain.ok) throw new Error(`重复快捷添加应 200，实际 ${quickAgain.status} ${await quickAgain.text()}`);
  await new Promise((r) => setTimeout(r, 900));
  const dedupQuick = await (await fetch("http://127.0.0.1:17965/contacts")).json();
  if ((dedupQuick.contacts ?? []).filter((x) => x.nodeId === sc).length !== 1) throw new Error("重复快捷添加写出了两行关系");
  log("ok 重复快捷添加不产生重复关系");

  const quickText = await fetch("http://127.0.0.1:17965/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sc, text: "快捷联系人也能聊" }),
  });
  if (!quickText.ok) throw new Error(`quick 发文字应成功，实际 ${quickText.status} ${await quickText.text()}`);
  await until(
    "C 收到 quick 文字",
    async () => {
      const body = await (await fetch(`http://127.0.0.1:17968/messages?peer=${sa}`)).json();
      return body.entries?.some((e) => e.kind === "text" && e.text === "快捷联系人也能聊") ? body : false;
    },
    8000,
  );
  await until(
    "A 拿到 quick 文字的 delivered 回执",
    async () => {
      const body = await (await fetch(`http://127.0.0.1:17965/messages?peer=${sc}`)).json();
      return body.entries?.some((e) => e.kind === "receipt" && e.ack?.status === "delivered") ? body : false;
    },
    8000,
  );
  log("ok quick 文字送到对端且有送达回执");

  // 文件三道闸仍然只认 friend：本机发不出去，对端也不会为 quick 的人写盘。
  const quickProbe = path.join(ROOT, "quick-probe.bin");
  fs.writeFileSync(quickProbe, Buffer.from("quick"));
  const quickFile = await fetch("http://127.0.0.1:17965/files/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sc, path: quickProbe }),
  });
  if (quickFile.status !== 403) throw new Error(`quick 发文件应 403，实际 ${quickFile.status} ${await quickFile.text()}`);
  const quickBegin = await fetch("http://127.0.0.1:17968/peer/file/begin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from: { nodeId: sa, nickname: "甲", hostname: os.hostname(), port: 17965 },
      messageId: "00000000-0000-4000-8000-0000000000ff",
      name: "quick.bin",
      size: 5,
      sha256: "0".repeat(64),
    }),
  });
  const quickBeginBody = await quickBegin.json();
  if (quickBegin.status !== 403 || quickBeginBody.retryable !== false) {
    throw new Error(`quick 收件端应 403 且不可重试，实际 ${quickBegin.status} ${JSON.stringify(quickBeginBody)}`);
  }
  log("ok quick 不放开文件：发出去 403，收件端拒写 403");

  const offlineQuick = await fetch("http://127.0.0.1:17965/friend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: "not-online", action: "quick" }),
  });
  const offlineQuickBody = await offlineQuick.json();
  if (offlineQuick.status !== 400 || offlineQuickBody.error !== "对方已离线，等他上线再试") {
    throw new Error(`离线快捷添加应 400 明确拒绝，实际 ${offlineQuick.status} ${JSON.stringify(offlineQuickBody)}`);
  }
  log("ok 离线快捷添加被接口拒绝，不进补投");

  // 混合版本：旧版收到不认识的 kind 回 400 + retryable:false，新版 Outbox 直接丢、不无限补投。
  const oldKind = await fetch("http://127.0.0.1:17968/peer/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proto: 1, kind: "friend-quick-from-old", control: { from: { nodeId: sa, port: 17965 } } }),
  });
  const oldKindBody = await oldKind.json();
  if (oldKind.status !== 400 || oldKindBody.error !== "unknown kind" || oldKindBody.retryable !== false) {
    throw new Error(`未知控制消息应 400 且不可重试，实际 ${oldKind.status} ${JSON.stringify(oldKindBody)}`);
  }
  log("ok 旧版未知控制消息 400 不可重试（只丢不补投）");

  // ---- 隐身（D99）：隐身的 peer 一条 announce 都不许发，也不许透露身份。 ----
  // 嗅探器在 D 起来之后才绑：启动时那一包已经过去了，这里只看 /peer/refresh 触发的那一包
  // （定时器和 /peer/refresh 走的是同一个 announce()）。
  const dgram = await import("node:dgram");
  const dstate = path.join(ROOT, "d");
  fs.mkdirSync(dstate, { recursive: true });
  fs.writeFileSync(path.join(dstate, "config.json"), JSON.stringify({ hidden: true }));
  const D = start("d", 17970, 17967, "丁");
  const sd = await until("D 起来", async () => (await status(17970))?.nodeId);

  const heard = [];
  const sniffer = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sniffer.on("message", (buf) => {
    try {
      const packet = JSON.parse(buf.toString());
      if (packet?.nodeId) heard.push(packet);
    } catch {
      /* 不是我们的包 */
    }
  });
  await new Promise((resolve, reject) => {
    sniffer.once("error", reject);
    sniffer.bind(17967, () => {
      try {
        sniffer.addMembership("239.255.42.99");
      } catch {
        /* 只有一块网卡时也可能报错，单播仍可测 */
      }
      resolve();
    });
  });
  const flush = () => heard.splice(0, heard.length);
  const waitFor = async (pred, ms = 2500) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = heard.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  await new Promise((r) => setTimeout(r, 300));

  // 对照组：可见的 A 必须能被嗅到，否则后面的「0 条」什么都不证明。
  flush();
  await fetch("http://127.0.0.1:17965/peer/refresh", { method: "POST" });
  if (!(await waitFor((p) => p.nodeId === sa))) throw new Error("对照组失败：嗅不到可见 peer 的 announce");

  flush();
  await fetch("http://127.0.0.1:17970/peer/refresh", { method: "POST" });
  await new Promise((r) => setTimeout(r, 1200));
  const leaked = heard.filter((p) => p.nodeId === sd);
  sniffer.close();
  if (leaked.length) throw new Error(`隐身还发了 ${leaked.length} 条 announce：${JSON.stringify(leaked[0]).slice(0, 160)}`);
  log("ok 隐身不发 announce");

  const invisible = await (await fetch("http://127.0.0.1:17970/peer/hello", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proto: 1, nodeId: "probe-invisible", nickname: "探针" }),
  })).json();
  if (invisible.hidden !== true) throw new Error(`隐身不该交身份，实际 ${JSON.stringify(invisible)}`);
  log("ok 隐身不回 hello 身份");

  // 手动地址也不能泄露身份：隐身时 addManual 只记地址，不发 hello（含单播 UDP）。
  // 单播发往对方的 HTTP 端口（UDP 上没有 peer 监听），这里自己绑一个来收。
  const unicast = [];
  const tap = dgram.createSocket({ type: "udp4", reuseAddr: true });
  tap.on("message", (buf) => {
    try {
      const packet = JSON.parse(buf.toString());
      if (packet?.nodeId) unicast.push(packet);
    } catch {
      /* 不是我们的包 */
    }
  });
  await new Promise((resolve, reject) => {
    tap.once("error", reject);
    tap.bind(17968, resolve);
  });
  const added = await fetch("http://127.0.0.1:17970/peer/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addr: "127.0.0.1:17968" }),
  });
  if (!added.ok) throw new Error(`隐身时 /peer/add 回 ${added.status}：${await added.text()}`);
  await new Promise((r) => setTimeout(r, 600));
  tap.close();
  if (unicast.length) throw new Error(`隐身加手动地址还发了 ${unicast.length} 条单播：${JSON.stringify(unicast[0]).slice(0, 160)}`);
  log("ok 隐身加手动地址不发单播");
  D.kill();

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

  // ---- 第 5 片：pi 的三个工具（找 / 看历史 / 代发文字） ----
  const found = await (await fetch("http://127.0.0.1:17965/tools/find?q=" + encodeURIComponent("乙"))).json();
  const hit = (found.peers || []).find((p) => p.nodeId === sb);
  if (!hit) throw new Error(`/tools/find 没找到乙：${JSON.stringify(found)}`);
  if (!hit.friend || !hit.online) throw new Error(`/tools/find 应报在线且已好友：${JSON.stringify(hit)}`);
  log("ok /tools/find 能按昵称找到人（带在线/好友）");

  const viaSend = await fetch("http://127.0.0.1:17965/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sb, text: "这条是 agent 代发的", via: "pi" }),
  });
  if (!viaSend.ok) throw new Error(`/send(via=pi) 回 ${viaSend.status}：${await viaSend.text()}`);
  const viaEntry = await until(
    "B 收到 agent 代发的消息",
    async () => {
      const body = await (await fetch(`http://127.0.0.1:17966/messages?peer=${sa}&limit=20`)).json();
      return (body.entries || []).find((e) => e.text === "这条是 agent 代发的" && e.via === "pi");
    },
    8000,
  );
  void viaEntry;
  log("ok agent 代发的消息带 via=pi（对端徽章）");

  // ---- 第 4 片：文件。先造一个 3 MB 的二进制文件（跨 3 个分块），发过去逐字节比对。 ----
  const { createHash } = await import("node:crypto");
  const payload = Buffer.alloc(3 * 1024 * 1024 + 137);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) % 256;
  const srcFile = path.join(ROOT, "报告 e2e.bin");
  fs.writeFileSync(srcFile, payload);
  const wantHash = createHash("sha256").update(payload).digest("hex");

  // 非好友不能发文件：C 不是 A 的好友，必须 403 且不可重试。
  const notFriend = await fetch("http://127.0.0.1:17965/files/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sc, path: srcFile }),
  });
  if (notFriend.status !== 403) throw new Error(`非好友发文件应 403，实际 ${notFriend.status} ${await notFriend.text()}`);
  log("ok 非好友发文件被拒（403）");

  const sendFile = await fetch("http://127.0.0.1:17965/files/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sb, path: srcFile }),
  });
  if (!sendFile.ok) throw new Error(`发文件失败：${sendFile.status} ${await sendFile.text()}`);

  const gotFile = await until(
    "B 收到文件卡片",
    async () => {
      const body = await (await fetch(`http://127.0.0.1:17966/messages?peer=${sa}`)).json();
      return body.entries?.find((e) => e.kind === "file") ?? false;
    },
    30000,
  );
  if (gotFile.file.size !== payload.length) throw new Error(`大小不对：${gotFile.file.size} vs ${payload.length}`);
  if (gotFile.file.sha256 !== wantHash) throw new Error("文件卡片里的哈希不对");
  log(`ok 文件送到对端（${Math.round(gotFile.file.size / 1024)} KB，哈希一致）`);

  const stored = await (await fetch(`http://127.0.0.1:17966/files?id=${gotFile.id}`)).arrayBuffer();
  const gotHash = createHash("sha256").update(Buffer.from(stored)).digest("hex");
  if (gotHash !== wantHash) throw new Error("落盘内容与源文件不一致");
  log("ok 落盘内容逐字节一致");

  const again2 = await (await fetch(`http://127.0.0.1:17966/messages?peer=${sa}`)).json();
  if (again2.entries.filter((e) => e.kind === "file").length !== 1) throw new Error("文件重发写了多张卡片");
  log("ok 同一文件只留一张卡片");

  // 0 字节文件：空的 .log / .txt 也要能发（以前 begin 用 size <= 0 直接 400）。
  const emptyPath = path.join(ROOT, "空文件.txt");
  fs.writeFileSync(emptyPath, "");
  const sendEmpty = await fetch("http://127.0.0.1:17965/files/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: sb, path: emptyPath }),
  });
  if (!sendEmpty.ok) throw new Error(`发 0 字节文件失败：${sendEmpty.status} ${await sendEmpty.text()}`);
  const emptyCard = await until(
    "B 收到 0 字节文件",
    async () => {
      const body = await (await fetch(`http://127.0.0.1:17966/messages?peer=${sa}`)).json();
      return body.entries?.find((e) => e.kind === "file" && e.file?.name === "空文件.txt") ?? false;
    },
    10000,
  );
  if (emptyCard.file.size !== 0) throw new Error(`0 字节文件大小不对：${emptyCard.file.size}`);
  const emptyBytes = await (await fetch(`http://127.0.0.1:17966/files?id=${emptyCard.id}`)).arrayBuffer();
  if (emptyBytes.byteLength !== 0) throw new Error(`落盘的 0 字节文件不是空的：${emptyBytes.byteLength}`);
  log("ok 0 字节文件也能发（大小与落盘都一致）");

  // token 是发的凭据：随便编一个必须被拒。
  for (const [p, body] of [
    ["/peer/file/chunk?token=made-up&offset=0", Buffer.from("x")],
    ["/peer/file/end?token=made-up", undefined],
  ]) {
    const bad = await fetch(`http://127.0.0.1:17966${p}`, { method: "POST", body });
    if (bad.status !== 410) throw new Error(`${p} 应 410，实际 ${bad.status}`);
  }
  log("ok 没有 token 写不进盘（410）");

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
