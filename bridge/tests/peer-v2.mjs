/**
 * 内网通 v2：消息状态机、已读未读、撤回、引用、转发、搜索、输入中、置顶/草稿、群聊。
 *
 * 两台 peer（A/B）互见、互加好友，然后按 docs/PEER-V2.md 的行为逐条验。
 * 用法：npm run build:peer && node bridge/tests/peer-v2.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, "..", "..", "peer", "dist", "index.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "peer-v2-"));
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

const api = (port) => async (method, url, body) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(3000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    // 进程还没起来 / 已经退了：交给 until 重试
    return { status: 0, body: {} };
  }
};

async function until(label, pred, ms = 12000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await pred();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`超时：${label}（最后拿到 ${JSON.stringify(last)?.slice(0, 300)}）`);
}

const check = (cond, label, extra = "") => {
  if (!cond) throw new Error(`断言失败：${label}${extra ? `（${extra}）` : ""}`);
  log(`ok ${label}`);
};

const A = 17970;
const B = 17971;
start("a", A, 17972, "A 机");
start("b", B, 17972, "B 机");
const a = api(A);
const b = api(B);

try {
  const sa = await until("A 起来", async () => (await a("GET", "/status")).body?.nodeId);
  const sb = await until("B 起来", async () => (await b("GET", "/status")).body?.nodeId);
  await until("A 看见 B", async () => ((await a("GET", "/status")).body?.online ?? []).some((p) => p.nodeId === sb));
  await until("B 看见 A", async () => ((await b("GET", "/status")).body?.online ?? []).some((p) => p.nodeId === sa));
  log("ok 两台互见");

  // 加好友（文件权限与通知用，文字不要求）
  await a("POST", "/friend", { peer: sb, action: "request" });
  await until("B 收到请求", async () => (await b("GET", "/contacts")).body?.contacts?.find((c) => c.nodeId === sa)?.incoming);
  await b("POST", "/friend", { peer: sa, action: "accept" });
  await until("双方好友", async () => (await a("GET", "/contacts")).body?.contacts?.find((c) => c.nodeId === sb)?.friend);
  log("ok 好友建立");

  // 1) 发送三态：发出去先 sending，投递成功后 success
  const sent = await a("POST", "/send", { peer: sb, text: "第一条 v2 消息" });
  check(sent.status === 200 && sent.body.seq >= 1, "发送返回 seq", JSON.stringify(sent.body));
  const onB = await until("B 收到", async () => {
    const m = await b("GET", `/messages?conv=n:${sa}`);
    return m.body.entries?.find((e) => e.text === "第一条 v2 消息");
  });
  check(onB.sendType === "recv" && onB.sendStatus === "success", "接收方标记为 recv/success");
  check(onB.seq >= 1, "接收方拿到发送方的 seq", String(onB.seq));
  const mine = await until("A 侧变 success", async () => {
    const m = await a("GET", `/messages?conv=n:${sb}`);
    const e = m.body.entries?.find((x) => x.text === "第一条 v2 消息");
    return e?.sendStatus === "success" ? e : null;
  });
  check(mine.sendStatus === "success", "发送方状态推进到 success（不再伪造回执行）");
  const noReceipt = (await a("GET", `/messages?conv=n:${sb}&limit=500`)).body.entries?.filter((e) => e.kind === "receipt") ?? [];
  check(noReceipt.length === 0, "历史里没有伪回执行");

  // 2) 未读 → 已读：B 读完，A 侧消息变 read
  const threadB = await until("B 会话有未读", async () => {
    const t = (await b("GET", "/threads")).body.threads?.find((x) => x.conv === `n:${sa}`);
    return t && t.unread > 0 ? t : null;
  });
  check(threadB.unread >= 1, "会话列表带未读数", String(threadB.unread));
  await b("POST", "/read", { conv: `n:${sa}` });
  await until("B 未读清零", async () => (await b("GET", "/threads")).body.threads?.find((x) => x.conv === `n:${sa}`)?.unread === 0);
  log("ok 已读把未读清零");
  const readByPeer = await until("A 侧变 read", async () => {
    const m = await a("GET", `/messages?conv=n:${sb}`);
    const e = m.body.entries?.find((x) => x.text === "第一条 v2 消息");
    return e?.sendStatus === "read" ? e : null;
  });
  check(readByPeer.sendStatus === "read", "真已读回执（对方读了我才变 read）");

  // 3) 引用
  const quoted = await a("POST", "/send", {
    peer: sb,
    text: "这句是回复",
    quote: { id: mine.id, fromNode: sa, nickname: "A 机", abstract: "第一条 v2 消息" },
  });
  check(quoted.status === 200, "带引用发送成功");
  const quoteOnB = await until("B 收到引用", async () => {
    const m = await b("GET", `/messages?conv=n:${sa}`);
    return m.body.entries?.find((e) => e.text === "这句是回复" && e.quote);
  });
  check(quoteOnB.quote.abstract === "第一条 v2 消息", "引用摘要跟着消息走");

  // 4) 撤回（两侧都要 fold 出 recall）
  await a("POST", "/recall", { conv: `n:${sb}`, id: quoted.body.id });
  const recalledA = await until("A 侧撤回", async () => {
    const m = await a("GET", `/messages?conv=n:${sb}`);
    return m.body.entries?.find((e) => e.id === quoted.body.id)?.recall;
  });
  check(Boolean(recalledA), "本机撤回落 patch");
  await until("B 侧撤回", async () => {
    const m = await b("GET", `/messages?conv=n:${sa}`);
    return m.body.entries?.find((e) => e.id === quoted.body.id)?.recall;
  });
  log("ok 对端也看到撤回");

  // 5) 转发：B 把我发的「第一条 v2 消息」转发回同一个会话
  const fwd = await b("POST", "/forward", { conv: `n:${sa}`, id: (await b("GET", `/messages?conv=n:${sa}`)).body.entries.find((e) => e.text === "第一条 v2 消息").id, to: [`n:${sa}`] });
  check(fwd.status === 200 && fwd.body.ids?.length === 1, "转发生成一条新消息");
  const fwdMine = await until("B 侧标成转发", async () => {
    const m = await b("GET", `/messages?conv=n:${sa}`);
    return m.body.entries?.find((e) => e.sendType === "selfForward");
  });
  check(fwdMine.quote?.id, "转发消息带原消息引用");
  await until("A 收到转发", async () => {
    const m = await a("GET", `/messages?conv=n:${sb}`);
    return m.body.entries?.some((e) => e.sendType === "recv" && e.quote?.id === fwdMine.quote.id);
  });
  log("ok 转发到达");

  // 6) 搜索
  const hits = await a("GET", `/search?q=${encodeURIComponent("v2 消息")}`);
  check((hits.body.hits ?? []).length >= 1, "全文搜索命中", String(hits.body.hits?.length));

  // 7) 输入中
  await a("POST", "/typing", { conv: `n:${sb}` });
  await until("B 看到正在输入", async () => (await b("GET", "/threads")).body.threads?.find((x) => x.conv === `n:${sa}`)?.typing);

  // 8) 置顶 / 免打扰 / 草稿
  await a("POST", "/conv", { conv: `n:${sb}`, pinned: true, muted: true });
  await a("POST", "/draft", { conv: `n:${sb}`, text: "没写完的半句" });
  const ta = await until("会话状态生效", async () => {
    const t = (await a("GET", "/threads")).body.threads?.find((x) => x.conv === `n:${sb}`);
    return t?.pinned === true && t?.muted === true && t?.draft ? t : null;
  });
  check(ta.draft === "没写完的半句", "草稿跟着会话走");

  // 9) 群聊：A 建群拉 B
  const group = await a("POST", "/group/create", { name: "测试群", members: [sb] });
  check(group.status === 200 && group.body.conv?.startsWith("g:"), "建群返回群会话", JSON.stringify(group.body));
  const conv = group.body.conv;
  await until("B 收到群邀请", async () => {
    const t = (await b("GET", "/threads")).body.threads?.find((x) => x.conv === conv);
    return t && t.kind === "group";
  });
  const groupSend = await a("POST", "/send", { conv, text: "群里的第一条" });
  check(groupSend.status === 200, "群消息发送成功");
  const onGroupB = await until("B 收到群消息", async () => {
    const m = await b("GET", `/messages?conv=${conv}`);
    return m.body.entries?.find((e) => e.text === "群里的第一条");
  });
  check(onGroupB.sendType === "recv", "群消息到达成员");
  const reply = await b("POST", "/send", { conv, text: "群里回复一句" });
  check(reply.status === 200, "成员能在群里发言");
  await until("A 收到群回复", async () => {
    const m = await a("GET", `/messages?conv=${conv}`);
    return m.body.entries?.find((e) => e.text === "群里回复一句");
  });
  const groupMeta = (await a("GET", `/messages?conv=${conv}`)).body.group;
  check(groupMeta?.members?.length === 2, "群成员两人", JSON.stringify(groupMeta?.members?.length));

  // 10) 退群：B 退，A 的成员表要少一个人
  await b("POST", "/group/leave", { groupId: conv.slice(2) });
  await until("A 侧成员表更新", async () => {
    const m = await a("GET", `/messages?conv=${conv}`);
    return m.body.group?.members?.length === 1;
  });
  log("ok 退群通知群主");

  log("peer-v2 全过");
} catch (err) {
  console.error(`失败：${(err && err.message) || err}`);
  process.exitCode = 1;
} finally {
  stopAll();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(ROOT, { recursive: true, force: true });
}
