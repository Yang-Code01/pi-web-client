#!/usr/bin/env node
/**
 * 内网通 MCP 服务（D439）：让任意 pi 会话在 chat 框里就能查联系人、读记录、发消息、共享东西。
 *
 * 设计上的几条硬约束：
 * - **零依赖**：只用 node 内置模块。这个文件由 pi 直接 `node …/peer-mcp.mjs` 拉起，装不进
 *   node_modules 也不该装 —— peer 包本身就没有运行时依赖。
 * - **只调本机桥**：`/api/peer/*` 对回环免 cookie（bridge/src/index.ts 那段注释），所以这里
 *   不碰 `~/.pi-peer`，也不直连 7865。桥知道端口、知道 cookie、知道重连，服务端逻辑都在桥上。
 * - **工具有限**：六个粗粒度工具，名字都以 `peer_` 开头。pi 的 `deferred` 曝光下它们不会
 *   常驻上下文，模型用 tool_search 搜到才出现。
 *
 * 协议：MCP stdio —— 一行一个 JSON-RPC 2.0 消息，stdout 只写协议，日志一律 stderr。
 */
import { createInterface } from "node:readline";

const VERSION = "1.0.0";
/** 我们认的协议版本（新的在前）；客户端给的不在表里就回第一个。 */
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
/** 桥的端口：桥启动时会把自己的 `PI_WEB_PORT` 补进环境变量，缺了按默认 7864。 */
const BASE = `http://127.0.0.1:${process.env.PI_WEB_PORT || 7864}`;
const TIMEOUT_MS = 20_000;

function log(...args) {
  process.stderr.write(`[peer-mcp] ${args.map(String).join(" ")}\n`);
}

async function api(pathname, init) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) throw new Error(data?.error || `桥回了 ${res.status}`);
  return data;
}

const get = (pathname) => api(pathname);
const post = (pathname, body) => api(pathname, { method: "POST", body: JSON.stringify(body ?? {}) });

/**
 * 我是谁：`/api/peer/messages` 的响应里没有 status 字段，拿不到自己的 nodeId。
 * 单独取一次 `/api/peer` 并缓存 —— 一个会话里 nodeId 不会变。
 */
let myNodeId = "";
async function me() {
  if (myNodeId) return myNodeId;
  const data = await get("/api/peer");
  myNodeId = String(data?.status?.nodeId ?? "");
  return myNodeId;
}

/** 一屏之内说完：长正文折成一行，别把 8KB 预览整段塞进工具结果。 */
function oneLine(text, max = 120) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function clock(at) {
  const d = new Date(Number(at) || Date.now());
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 我把对方的 nodeId 当 `to`，但群里 `to.id` 是群 id。发消息 / 共享都支持两种，
 * 所以这里只提示一句，不做转换 —— 让模型自己从 peer_contacts / peer_inbox 里挑。
 */
function who(from) {
  return from?.nickname || from?.hostname || String(from?.nodeId ?? "?").slice(0, 8);
}

const TOOLS = [
  {
    name: "peer_contacts",
    description: "列出内网通里的好友、群、在线状态和最近一次联系。要发消息或共享东西前先用它拿 nodeId（群用群 id）。query 可按昵称 / 主机名过滤。",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "按昵称或主机名过滤，可留空" } },
      additionalProperties: false,
    },
  },
  {
    name: "peer_history",
    description: "读和某个人（或某个群）的内网通聊天记录，最新的在最后。limit 最多 200 条。记录卡与共享卡会显示成一行摘要。",
    inputSchema: {
      type: "object",
      properties: {
        peer: { type: "string", description: "对方 nodeId 或群 id（来自 peer_contacts）" },
        limit: { type: "number", description: "最多几条，默认 30，上限 200" },
      },
      required: ["peer"],
      additionalProperties: false,
    },
  },
  {
    name: "peer_send_text",
    description: "给内网通里的某个人或某个群发一条纯文字消息（不是邮件、不是通知）。消息上会标「🤖 agent 代发」。只能发文字，文件 / 技能 / 会话请用 peer_share。",
    inputSchema: {
      type: "object",
      properties: {
        peer: { type: "string", description: "对方 nodeId 或群 id" },
        text: { type: "string", description: "要发的话，最长 32 KB" },
        replyTo: { type: "string", description: "可选：引用某条消息的 id" },
      },
      required: ["peer", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "peer_share",
    description:
      "把东西以卡片形式共享给好友或群：type=file（本机文件，paths）、snippet（一段内容，text）、skill（技能目录，skillName + scope）、session（当前或其他 pi 会话，sessionFile）。对方看到卡片能预览、点接收；文件本体走内网通的文件通道。",
    inputSchema: {
      type: "object",
      properties: {
        peer: { type: "string", description: "对方 nodeId 或群 id" },
        type: { type: "string", enum: ["file", "snippet", "skill", "session"], description: "共享什么" },
        title: { type: "string", description: "卡片标题，可留空（会从内容里取）" },
        summary: { type: "string", description: "一句话说明，可留空" },
        text: { type: "string", description: "type=snippet 的正文；其它类型可以当附言（只带前 8 KB）" },
        paths: { type: "array", items: { type: "string" }, description: "type=file 的文件路径（绝对路径，或相对会话工作目录）；一次最多 10 份" },
        skillName: { type: "string", description: "type=skill 的技能目录名" },
        scope: { type: "string", enum: ["global", "project"], description: "type=skill 从哪儿装：global（~/.pi/agent/skills）或 project（<cwd>/.pi/skills）" },
        sessionFile: { type: "string", description: "type=session 的会话 jsonl 路径" },
        cwd: { type: "string", description: "相对路径的基准目录，默认本会话工作目录" },
      },
      required: ["peer", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "peer_inbox",
    description: "看一眼内网通收件情况：哪些会话有未读、各自最后一条是什么、有没有别人共享过来的卡片等着接收。",
    inputSchema: {
      type: "object",
      properties: { unreadOnly: { type: "boolean", description: "只看有未读的，默认 true" } },
      additionalProperties: false,
    },
  },
  {
    name: "peer_status",
    description: "内网通自己的状态：本机 nodeId、昵称、主机名、端口、在线与否、收件箱目录、MCP 服务是否已注册。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** 工具结果的统一形状：一段可读文本，加上给程序看的结构化细节可省。 */
const ok = (text, extra) => ({ content: [{ type: "text", text }], ...(extra ? { structuredContent: extra } : {}) });
const bad = (text) => ({ content: [{ type: "text", text: `内网通：${text}` }], isError: true });

async function contacts(args) {
  const q = String(args.query ?? "").trim().toLowerCase();
  const [view, list, threads] = await Promise.all([get("/api/peer"), get("/api/peer/contacts"), get("/api/peer/threads")]);
  const status = view?.status ?? {};
  const me = status.nodeId;
  const contacts = (list.contacts ?? []).filter((c) => c.nodeId !== me);
  const rows = contacts
    .filter((c) => !q || `${c.nickname ?? ""} ${c.hostname ?? ""}`.toLowerCase().includes(q))
    .map((c) => ({
      nodeId: c.nodeId,
      name: who(c),
      hostname: c.hostname,
      online: Boolean(c.online),
      friend: Boolean(c.friend),
      last: (threads.threads ?? []).find((t) => t.nodeId === c.nodeId)?.last?.at ?? null,
    }))
    .sort((a, b) => Number(b.online) - Number(a.online) || (b.last ?? 0) - (a.last ?? 0));
  const groups = (status.groups ?? [])
    .filter((g) => !q || String(g.name ?? "").toLowerCase().includes(q))
    .map((g) => `- 群「${g.name}」 \`${g.id}\` · ${(g.members ?? []).length} 人`);
  const lines = [`我是 ${status.nickname || ""}（${String(me ?? "").slice(0, 8)}）· ${rows.filter((r) => r.online).length} 人在线`, ""];
  if (rows.length) {
    lines.push("好友 / 联系人：");
    for (const r of rows) {
      lines.push(`- ${r.name} \`${r.nodeId}\` · ${r.online ? "在线" : "离线"}${r.friend ? " · 好友" : ""}`);
    }
  } else lines.push("没有匹配的联系人。");
  if (groups.length) lines.push("", "群：", ...groups);
  return ok(lines.join("\n"), { contacts: rows, groups: status.groups ?? [] });
}

async function history(args) {
  const peer = String(args.peer ?? "").trim();
  const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
  if (!peer) throw new Error("要 peer（nodeId 或群 id）");
  const data = await get(`/api/peer/messages?peer=${encodeURIComponent(peer)}&limit=${limit}`);
  const entries = (data.entries ?? []).filter((e) => e.kind !== "sys");
  if (!entries.length) return ok("这段会话还没有消息。");
  const mine = await me();
  const lines = entries.map((e) => {
    const at = clock(e.at);
    const from = mine && e.from?.nodeId === mine ? "我" : who(e.from);
    if (e.recalled) return `[${at}] ${from}：（撤回了一条消息）`;
    if (e.kind === "note") return `[${at}] ${from}：【记录】${e.note?.title ?? ""} — ${oneLine(e.note?.body ?? "", 80)}`;
    if (e.kind === "share") {
      const files = (e.share?.files ?? []).map((f) => f.name).join("、");
      return `[${at}] ${from}：【共享·${e.share?.type}】${e.share?.title ?? ""}${files ? `（${files}）` : ""} — ${oneLine(e.share?.summary ?? e.share?.body ?? "", 60)}`;
    }
    if (e.kind === "file") return `[${at}] ${from}：【文件】${e.file?.name ?? ""} · ${humanSize(e.file?.size)}`;
    if (e.kind === "react") return `[${at}] ${from}：${e.emoji ?? ""} 回应`;
    return `[${at}] ${from}：${oneLine(e.text ?? "", 300)}`;
  });
  return ok(lines.join("\n"), { count: entries.length });
}

/**
 * 桥的 replyTo 只接受 `{ id, from, excerpt }` 对象，给字符串会被静默忽略（引用就悄悄没了）。
 * 这里拿 id 去历史里把引用补全；找不到就不引用，并把这件事说清楚。
 */
async function replyRef(peer, id) {
  const data = await get(`/api/peer/messages?peer=${encodeURIComponent(peer)}&limit=200`);
  const hit = (data.entries ?? []).find((e) => e.id === id);
  if (!hit) return null;
  const excerpt = oneLine(hit.text ?? hit.note?.title ?? hit.share?.title ?? hit.file?.name ?? "", 60);
  return { id, from: String(hit.from?.nodeId ?? ""), excerpt };
}

async function sendText(args) {
  const peer = String(args.peer ?? "").trim();
  const text = String(args.text ?? "");
  if (!peer) throw new Error("要 peer（nodeId 或群 id）");
  if (!text.trim()) throw new Error("text 不能为空");
  let replyTo;
  let note = "";
  if (args.replyTo) {
    replyTo = (await replyRef(peer, String(args.replyTo))) ?? undefined;
    if (!replyTo) note = "（要找的那条消息没在这段会话的最后 200 条里，这条没有带引用）";
  }
  const res = await post("/api/peer/send", { peer, text, via: "pi", ...(replyTo ? { replyTo } : {}) });
  return ok(`已交给内网通投递（消息 id \`${res.id ?? "?"}\`，${res.seq !== undefined ? `seq ${res.seq}` : "排队中"}）。${note}`);
}

async function share(args) {
  const peer = String(args.peer ?? "").trim();
  const type = String(args.type ?? "").trim();
  if (!peer) throw new Error("要 peer（nodeId 或群 id）");
  if (!["file", "snippet", "skill", "session"].includes(type)) throw new Error("type 只能是 file / snippet / skill / session");
  const res = await post("/api/peer/share", {
    peer,
    type,
    via: "pi",
    ...(args.title ? { title: String(args.title) } : {}),
    ...(args.summary ? { summary: String(args.summary) } : {}),
    ...(args.text !== undefined ? { text: String(args.text) } : {}),
    ...(Array.isArray(args.paths) ? { paths: args.paths.map(String) } : {}),
    ...(args.skillName ? { skillName: String(args.skillName) } : {}),
    ...(args.scope ? { scope: String(args.scope) } : {}),
    ...(args.sessionFile ? { sessionFile: String(args.sessionFile) } : {}),
    cwd: String(args.cwd ?? process.cwd()),
  });
  const sent = (res.files ?? []).filter(Boolean).length;
  return ok(`共享卡已发出（${type}，id \`${res.id ?? "?"}\`${sent ? `，${sent} 份文件已传` : ""}）。`);
}

async function inbox(args) {
  const unreadOnly = args.unreadOnly !== false;
  const [threads, view] = await Promise.all([get("/api/peer/threads"), get("/api/peer")]);
  const me = view?.status?.nodeId;
  const list = (threads.threads ?? []).filter((t) => (unreadOnly ? (t.unread ?? 0) > 0 : Boolean(t.last)));
  if (!list.length) return ok(unreadOnly ? "没有未读。" : "还没有任何会话。");
  const lines = list.map((t) => {
    const last = t.last ?? {};
    const from = last.from?.nodeId === me ? "我" : who(last.from);
    const body =
      last.kind === "note"
        ? `【记录】${last.note?.title ?? ""}`
        : last.kind === "share"
          ? `【共享·${last.share?.type}】${last.share?.title ?? ""}`
          : last.kind === "file"
            ? `【文件】${last.file?.name ?? ""}`
            : oneLine(last.text ?? "", 80);
    return `- ${t.group ? `群「${t.nickname}」` : t.nickname || t.hostname} \`${t.nodeId}\` · 未读 ${t.unread ?? 0} · 最近 ${clock(last.at)} ${from}：${body}${last.kind === "share" && last.from?.nodeId !== me ? "（可以在内网通页面点「接收」）" : ""}`;
  });
  return ok(lines.join("\n"), { threads: list.map((t) => ({ nodeId: t.nodeId, unread: t.unread ?? 0 })) });
}

async function status() {
  const view = await get("/api/peer");
  const st = view.status ?? {};
  const lines = [
    `启用：${view.enabled ? "是" : "否"}${view.running ? "" : "（没在跑）"}${view.reason ? ` · ${view.reason}` : ""}`,
    `我：${st.nickname || "(未设置)"} · nodeId \`${st.nodeId ?? "?"}\` · ${st.hostname ?? ""} · 端口 ${st.port ?? "?"}`,
    `收件箱：${st.config?.inbox ?? "(未知)"}`,
    `MCP 服务：${view.mcp?.present ? `已注册（${view.mcp.file}）` : "未注册"}${view.mcp && view.mcp.enabled === false ? " · 用户关掉了" : ""}`,
  ];
  return ok(lines.join("\n"), { status: st });
}

const HANDLERS = { peer_contacts: contacts, peer_history: history, peer_send_text: sendText, peer_share: share, peer_inbox: inbox, peer_status: status };

async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) return bad(`没有这个工具：${name}`);
  try {
    return await handler(args ?? {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 桥没起来是最常见的失败，单独说清楚怎么办。
    if (/fetch failed|ECONNREFUSED/i.test(message)) return bad(`连不上本机的 pi 网页桥（${BASE}）。先确认 bridge 在跑，再重试。`);
    return bad(message);
  }
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (method === "initialize") {
    const wanted = String(params?.protocolVersion ?? "");
    const protocolVersion = PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0];
    if (isRequest) {
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "peer", version: VERSION },
        instructions:
          "内网通（局域网聊天）。发消息前先用 peer_contacts 拿 nodeId；共享文件 / 内容 / 技能 / 会话用 peer_share。工具是按需加载的：搜到之后才出现在上下文里。",
      });
    }
    return;
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
  if (method === "ping") {
    if (isRequest) reply(id, {});
    return;
  }
  if (method === "tools/list") {
    if (isRequest) reply(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const result = await callTool(String(params?.name ?? ""), params?.arguments ?? {});
    if (isRequest) reply(id, result);
    return;
  }
  if (isRequest) fail(id, -32601, `不支持的方法：${method}`);
}

async function main() {
  // 给自己留一个可核对的身份：桥那边看进程也能对上。
  log(`starting v${VERSION} → ${BASE} (pid ${process.pid})`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      log("ignoring non-JSON line");
      continue;
    }
    try {
      await handle(msg);
    } catch (err) {
      log("handler failed:", err?.message ?? err);
      if (msg?.id !== undefined && msg?.id !== null) fail(msg.id, -32603, err instanceof Error ? err.message : String(err));
    }
  }
  log("stdin closed, exiting");
}

main().catch((err) => {
  log("fatal:", err?.stack ?? err);
  process.exit(1);
});
