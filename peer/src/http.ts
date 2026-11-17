import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, saveConfig, statePath, writeJson } from "./config.ts";
import type { PeerConfig } from "./config.ts";
import { PROTO, VERSION } from "./config.ts";
import type { Discovery } from "./discovery.ts";
import { CHUNK } from "./files.ts";
import type { Files } from "./files.ts";
import { listDir } from "./fsbrowse.ts";
import type { History } from "./history.ts";
import type { Messages } from "./messages.ts";
import { convOfNode, isGroupConv, textOf } from "./model.ts";
import type { Msg } from "./model.ts";
import type { Quote } from "./model.ts";
import type { Relations } from "./peers.ts";
import type { Store } from "./store.ts";
import { MAX_MARKET_FRAME, ingest, manifestResponse, parseFrame, touchBlob } from "./market.ts";

export interface PeerContext {
  cfg: PeerConfig;
  nodeId: string;
  discovery: Discovery;
  history: History;
  messages: Messages;
  relations: Relations;
  files: Files;
  ignored: Ignored;
  store: Store;
}

const MAX_BODY = 1024 * 1024;
/** 分块请求的体上限：一个 CHUNK 再加一点余量。 */
const MAX_CHUNK = CHUNK + 64 * 1024;

/**
 * 被移除的在线 nodeId。独立落盘，不进关系记录，也不进状态 / 找人接口：
 * 只用来挡住「下一次轮询又把在线的人合并回通讯录」（#383）。
 */
export class Ignored {
  private set = new Set<string>();

  constructor(private readonly log: (msg: string) => void) {
    const raw = readJson<{ nodeIds?: unknown }>(statePath("ignored.json"), {});
    this.set = new Set(Array.isArray(raw.nodeIds) ? raw.nodeIds.filter((id): id is string => typeof id === "string") : []);
  }

  private save(): void {
    try {
      writeJson(statePath("ignored.json"), { nodeIds: [...this.set] });
    } catch (err) {
      this.log(`忽略名单落盘失败：${(err as Error).message}`);
    }
  }

  has(nodeId: string): boolean {
    return this.set.has(nodeId);
  }

  add(nodeId: string): void {
    if (!nodeId || this.set.has(nodeId)) return;
    this.set.add(nodeId);
    this.save();
  }

  clear(): void {
    if (!this.set.size) return;
    this.set.clear();
    this.save();
  }

  size(): number {
    return this.set.size;
  }

  list(): string[] {
    return [...this.set];
  }
}

function isLoopback(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(addr);
}

/**
 * 线上投影：v2 字段原样带出去，同时补回 v1 的 `kind` / `text` / `file`。
 * 老的 pi 工具和旧页面按这三个字段读，没必要为了协议升级让它们全挂。
 */
function wire(msg: Msg): Record<string, unknown> {
  const file = msg.elements.find((elem) => elem.type === "file");
  const out: Record<string, unknown> = { ...msg, kind: file ? "file" : "text", text: textOf(msg) };
  if (file && file.type === "file") {
    out.file = { name: file.name, size: file.size, mime: file.mime, ...(file.sha256 ? { sha256: file.sha256 } : {}) };
  }
  return out;
}

/** 页面和 pi 工具既可以按 `conv` 也可以按 `peer` 传；`conv` 先认（群聊只有一个 key）。 */
function convOfQuery(conv: unknown, peer: unknown): string {
  const raw = String(conv ?? "");
  if (raw.startsWith("n:") || raw.startsWith("g:")) return raw;
  const id = String(peer ?? "");
  return id ? convOfNode(id) : "";
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (err) {
        reject(err as Error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * peer 的 HTTP 面。三条规矩：
 * - `/status`、`/peer/add`、`/peer/refresh` 只认回环（本机 bridge 用），局域网访问一律 403；
 * - `/peer/hello` 与将来的 `/peer/inbox` 对局域网开放（这就是协议本体），靠 `proto` 挡旧版本；
 * - 对端是谁不看它自报的字段，看 `req.socket.remoteAddress`（决定 7/10）。
 */
/** 读原始字节（文件分块用），不做 JSON 解析。 */
function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createPeerServer(ctx: PeerContext): http.Server {
  const { cfg, nodeId, discovery, history, messages, relations, files, ignored, store } = ctx;
  const identity = () => ({ nodeId, nickname: cfg.nickname, hostname: os.hostname(), port: cfg.port, version: VERSION });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://peer");
    const loopback = isLoopback(req);
    const from = req.socket.remoteAddress ?? "";
    try {
      if (url.pathname === "/status" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        return json(res, 200, {
          ok: true,
          proto: PROTO,
          version: VERSION,
          nodeId,
          nickname: cfg.nickname,
          hostname: os.hostname(),
          port: cfg.port,
          online: discovery.online(),
          config: { hidden: cfg.hidden, pauseFiles: cfg.pauseFiles, dnd: cfg.dnd, inbox: cfg.inbox, manual: cfg.manual },
        });
      }

      if (url.pathname === "/config" && req.method === "POST") {
        // 页面上的三个开关（隐身 / 免打扰 / 暂停收文件）走这里：改的是同一个 cfg 对象，
        // discovery / files 下一次检查就生效，再落盘让重启后保持。
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = (await readBody(req).catch(() => null)) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return json(res, 400, { error: "bad body" });
        const wasHidden = cfg.hidden;
        for (const key of ["hidden", "dnd", "pauseFiles"] as const) {
          if (typeof body[key] === "boolean") cfg[key] = body[key] as boolean;
        }
        saveConfig(cfg);
        // 隐身→可见：立刻丢一份 announce，别等下一轮定时（10 秒里对方还看不见）。
        // 可见→隐身不发：`announce()` 自己就查 hidden（D99），这里再额外补一刀只会绕开那个守卫。
        if (wasHidden && !cfg.hidden) discovery.announce();
        return json(res, 200, {
          ok: true,
          config: { hidden: cfg.hidden, pauseFiles: cfg.pauseFiles, dnd: cfg.dnd, inbox: cfg.inbox, manual: cfg.manual },
        });
      }

      // 忽略名单是通讯录自己的读口：状态 / 找人接口不看它，页面只用它挡住在线表兜底合并。
      if (url.pathname === "/ignored" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        return json(res, 200, { ok: true, nodeIds: ignored.list() });
      }

      // 设置页整体清空忽略名单：只动这份名单，不动关系记录，也不碰状态 / 找人接口。
      if (url.pathname === "/ignored/clear" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const cleared = ignored.size();
        ignored.clear();
        return json(res, 200, { ok: true, cleared });
      }

      if (url.pathname === "/peer/hello" && req.method === "POST") {
        const body = await readBody(req).catch(() => null);
        if (!body || body.proto !== PROTO || typeof body.nodeId !== "string") return json(res, 400, { error: "bad hello" });
        if (body.nodeId !== nodeId) discovery.recordHello(body, from);
        if (cfg.hidden) return json(res, 200, { proto: PROTO, hidden: true });
        return json(res, 200, identity());
      }

      if (url.pathname === "/peer/refresh" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        discovery.announce();
        return json(res, 200, { ok: true, online: discovery.online() });
      }

      if (url.pathname === "/peer/add" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        try {
          discovery.addManual(String(body?.addr ?? ""));
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
        return json(res, 200, { ok: true, manual: cfg.manual });
      }

      if (url.pathname === "/peer/inbox" && req.method === "POST") {
        const body = await readBody(req).catch(() => null);
        if (!body) return json(res, 400, { error: "bad body", retryable: false });
        const result = await messages.accept(from, body);
        return json(res, result.status, result.body);
      }

      // 第 4 片：文件。三条都在局域网面上，但都没法绕过 begin（决定 13/24）：
      // token 只在收方 begin 成功后才存在，伪造 from 的人拿不到 token，写不进盘。
      if (url.pathname === "/peer/file/begin" && req.method === "POST") {
        const body = await readBody(req).catch(() => null);
        if (!body) return json(res, 400, { error: "bad begin", retryable: false });
        const result = await files.begin(from, body, (addr, who) => messages.verify(addr, who));
        return json(res, result.status, result.body);
      }

      if (url.pathname === "/peer/file/chunk" && req.method === "POST") {
        const token = url.searchParams.get("token") ?? "";
        const offset = Number(url.searchParams.get("offset"));
        const data = await readRaw(req, MAX_CHUNK).catch(() => null);
        if (!data) return json(res, 413, { error: "分块太大", retryable: false });
        const result = files.chunk(token, Number.isFinite(offset) ? offset : -1, data);
        return json(res, result.status, result.body);
      }

      if (url.pathname === "/peer/file/end" && req.method === "POST") {
        const result = files.end(url.searchParams.get("token") ?? "");
        return json(res, result.status, result.body);
      }

      // 以下三条只给本机页面 / pi 工具用。历史只在回环上可读（决定 4；隧道里那条 403 是设计好的）。
      if (url.pathname === "/threads" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        return json(res, 200, {
          ok: true,
          // 会话列表里的 last 也按 v1 形状投影一次：前端摘要读的是 kind/text/file。
          threads: history
            .threads(discovery.online(), relations.list(), store, messages.typingNow())
            .map((t) => ({ ...t, last: t.last ? wire(t.last) : null })),
          groups: store.groups(),
        });
      }

      if (url.pathname === "/messages" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const conv = convOfQuery(url.searchParams.get("conv"), url.searchParams.get("peer"));
        if (!conv) return json(res, 400, { error: "缺 conv" });
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
        const state = store.conv(conv);
        const group = isGroupConv(conv) ? store.group(conv.slice(2)) : null;
        return json(res, 200, {
          ok: true,
          conv,
          entries: history.read(conv, limit).map(wire),
          state,
          group,
          typing: messages.typingNow().has(conv),
        });
      }

      // 进会话 / 窗口重新可见：把水位推到最新，并告诉对方「我读到这儿了」。
      if (url.pathname === "/read" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        const conv = convOfQuery(body?.conv, body?.peer);
        if (!conv) return json(res, 400, { error: "缺 conv" });
        return json(res, 200, messages.markRead(conv));
      }

      if (url.pathname === "/typing" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        const conv = convOfQuery(body?.conv, body?.peer);
        if (!conv) return json(res, 400, { error: "缺 conv" });
        messages.typingNotify(conv);
        return json(res, 200, { ok: true });
      }

      if (url.pathname === "/send" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        try {
          const conv = convOfQuery(body?.conv, body?.peer);
          if (!conv) return json(res, 400, { error: "缺 conv 或 peer" });
          const via = body?.via === "pi" ? ("pi" as const) : undefined;
          const quote = body?.quote && typeof body.quote === "object" ? (body.quote as Quote) : undefined;
          const result = messages.sendConv(conv, { text: String(body?.text ?? ""), ...(quote ? { quote } : {}), ...(via ? { via } : {}) });
          return json(res, 200, result);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }

      // 撤回 2 分钟内自己发的消息；对端收到后走同一条复核再落 patch。
      if (url.pathname === "/recall" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        const conv = convOfQuery(body?.conv, body?.peer);
        const id = String(body?.id ?? "");
        if (!conv || !id) return json(res, 400, { error: "缺 conv 或 id" });
        const result = messages.recall(conv, id);
        return json(res, result.ok ? 200 : 400, result);
      }

      // 转发：把一条消息抄进一个或多个会话（QQ 的 forwardMsg）。
      if (url.pathname === "/forward" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        const conv = convOfQuery(body?.conv, body?.peer);
        const id = String(body?.id ?? "");
        const targets = Array.isArray(body?.to) ? body.to.map((item: unknown) => convOfQuery(item, null)).filter(Boolean) : [];
        if (!conv || !id || !targets.length) return json(res, 400, { error: "缺 conv / id / to" });
        try {
          return json(res, 200, messages.forward(conv, id, targets));
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }

      if (url.pathname === "/search" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const q = url.searchParams.get("q") ?? "";
        const conv = convOfQuery(url.searchParams.get("conv"), null);
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        const hits = history.search(q, conv || undefined, limit).map((hit) => ({ conv: hit.conv, msg: wire(hit.msg) }));
        return json(res, 200, { ok: true, hits });
      }

      // 置顶 / 免打扰：会话级的两个开关，写进 state.json。
      if (url.pathname === "/conv" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        const conv = convOfQuery(body?.conv, body?.peer);
        if (!conv) return json(res, 400, { error: "缺 conv" });
        const patch: { pinned?: boolean; muted?: boolean } = {};
        if (typeof body?.pinned === "boolean") patch.pinned = body.pinned;
        if (typeof body?.muted === "boolean") patch.muted = body.muted;
        return json(res, 200, { ok: true, state: store.set(conv, patch) });
      }

      // 草稿：停止输入时写一次，进别的会话再回来就能续上。
      if (url.pathname === "/draft" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        const conv = convOfQuery(body?.conv, body?.peer);
        if (!conv) return json(res, 400, { error: "缺 conv" });
        store.setDraft(conv, String(body?.text ?? ""));
        return json(res, 200, { ok: true });
      }

      if (url.pathname === "/groups" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        return json(res, 200, { ok: true, groups: store.groups() });
      }

      if (url.pathname === "/group/create" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        const name = String(body?.name ?? "");
        const members = Array.isArray(body?.members) ? body.members.map((id: unknown) => String(id)) : [];
        try {
          return json(res, 200, messages.createGroup(name, members));
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }

      if (url.pathname === "/group/invite" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        const groupId = String(body?.groupId ?? "");
        const members = Array.isArray(body?.members) ? body.members.map((id: unknown) => String(id)) : [];
        try {
          return json(res, 200, messages.invite(groupId, members));
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }

      if (url.pathname === "/group/leave" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        return json(res, 200, messages.leave(String(body?.groupId ?? "")));
      }

      // pi 的三个工具里「找人」这一步（第 5 片，决定 33）：昵称可以重名，
      // 所以必须把 nodeId 一起给模型，让它下次直接用 id。
      if (url.pathname === "/tools/find" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        const online = new Map(discovery.online().map((peer) => [peer.nodeId, peer]));
        const seen = new Set<string>();
        const rows: Record<string, unknown>[] = [];
        const push = (nodeId: string, nickname: string, hostname: string, port: number): void => {
          if (seen.has(nodeId)) return;
          seen.add(nodeId);
          rows.push({ nodeId, nickname, hostname, port, online: online.has(nodeId), friend: relations.isFriend(nodeId) });
        };
        for (const contact of relations.list()) push(contact.nodeId, contact.nickname, contact.hostname, contact.port);
        for (const peer of online.values()) push(peer.nodeId, peer.nickname, peer.hostname, peer.port);
        const hit = q ? rows.filter((row) => `${row.nickname} ${row.hostname} ${row.nodeId}`.toLowerCase().includes(q)) : rows;
        return json(res, 200, { ok: true, peers: hit.slice(0, 20) });
      }

      // 第 3 片：通讯录。收藏 / 删除 / 接受都在这里改，对方只收到一条控制消息。
      if (url.pathname === "/contacts" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const onlinePeers = discovery.online();
        const online = new Map(onlinePeers.map((peer) => [peer.nodeId, peer]));
        const known = new Set<string>();
        const contacts = relations.list().map((contact) => {
          known.add(contact.nodeId);
          const peer = online.get(contact.nodeId);
          return { ...contact, quick: contact.quick ?? false, ignored: ignored.has(contact.nodeId), online: Boolean(peer), addr: peer?.addr ?? "", livePort: peer?.port ?? 0 };
        });
        for (const peer of onlinePeers) {
          // 忽略名单只过滤由在线表合并出来的无关系行：已有关系的人照样列出来。
          if (peer.nodeId === nodeId || known.has(peer.nodeId) || ignored.has(peer.nodeId)) continue;
          contacts.push({
            nodeId: peer.nodeId,
            nickname: peer.nickname,
            hostname: peer.hostname,
            port: peer.port,
            quick: false,
            friend: false,
            favorite: false,
            incoming: false,
            outgoing: false,
            ignored: false,
            at: peer.lastSeen,
            online: true,
            addr: peer.addr,
            livePort: peer.port,
          });
        }
        return json(res, 200, { ok: true, contacts });
      }

      if (url.pathname === "/friend" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        const peerId = String(body?.peer ?? "");
        const action = String(body?.action ?? "");
        const who = discovery.byId(peerId);
        if (!peerId) return json(res, 400, { error: "缺 peer" });
        try {
          if (action === "request") {
            if (!who) return json(res, 400, { error: "这个人已经不在线了" });
            messages.sendControl(peerId, "friend-request");
            return json(res, 200, { ok: true, contact: relations.get(peerId) });
          }
          // 快捷添加只认 30 秒在线窗口（不是 5 分钟 IP 宽松窗口），离线直接拒、不进补投。
          if (action === "quick") {
            if (!discovery.online().some((peer) => peer.nodeId === peerId)) {
              return json(res, 400, { error: "对方已离线，等他上线再试" });
            }
            messages.sendControl(peerId, "friend-quick");
            return json(res, 200, { ok: true, contact: relations.get(peerId) });
          }
          if (action === "accept") {
            const known = relations.get(peerId);
            if (!known?.incoming) return json(res, 400, { error: "没有待接受的请求" });
            if (!who) return json(res, 400, { error: "他不在线，等他在线再接受（否则他不知道）" });
            relations.accept({ nodeId: peerId, nickname: known.nickname, hostname: known.hostname, port: known.port });
            messages.sendControl(peerId, "friend-accept");
            return json(res, 200, { ok: true, contact: relations.get(peerId) });
          }
          if (action === "favorite") {
            // 由在线表合并出来的「附近的人」还没有关系记录：收藏时当场建一行本机备注。
            const known = relations.get(peerId) ?? who;
            if (!known) return json(res, 400, { error: "不在通讯录里" });
            relations.favorite({ nodeId: peerId, nickname: known.nickname, hostname: known.hostname, port: known.port }, Boolean(body?.on));
            return json(res, 200, { ok: true, contact: relations.get(peerId) });
          }
          if (action === "remove") {
            // 移除有关系的人：先清关系，再写忽略，否则下一轮在线表会把他合并回来。
            relations.remove(peerId);
            ignored.add(peerId);
            return json(res, 200, { ok: true });
          }
          return json(res, 400, { error: "未知动作" });
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }

      // 第 4 片：本机侧。发文件走「传路径」而不是「传字节」——页面、peer 在同一台机器上，
      // 让 peer 直接读盘比浏览器先把 2 GB 塞进 base64 再吐出来快得多；剪贴板里的图走 upload 兜底。
      if (url.pathname === "/files/send" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        const peerId = String(body?.peer ?? "");
        const file = String(body?.path ?? "");
        if (!peerId || !file) return json(res, 400, { error: "缺 peer 或 path" });
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile()) return json(res, 400, { error: "这不是一个文件" });
          const name = String(body?.name ?? "") || path.basename(file);
          return json(res, 200, await files.send(peerId, file, name));
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }

      if (url.pathname === "/files/upload" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const peerId = url.searchParams.get("peer") ?? "";
        const name = url.searchParams.get("name") ?? "粘贴的图片.png";
        if (!peerId) return json(res, 400, { error: "缺 peer" });
        const data = await readRaw(req, 64 * 1024 * 1024).catch(() => null);
        if (!data) return json(res, 413, { error: "太大了（上限 64 MB）" });
        const tmp = path.join(statePath("out"), `up-${randomUUID()}${path.extname(name)}`);
        fs.writeFileSync(tmp, data);
        return json(res, 200, await files.send(peerId, tmp, name));
      }

      // D209：收件目录里那份文件的绝对路径。站内翻页 / 「用本机程序打开」都要它，
      // 只回环——和 /files 同一道门（能拿字节能拿路径）。
      if (url.pathname === "/files/meta" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const stored = files.storedPath(url.searchParams.get("id") ?? "");
        if (!stored) return json(res, 404, { error: "没有这个文件" });
        return json(res, 200, { ok: true, path: stored.path, name: stored.name, size: stored.size, mime: stored.mime });
      }

      if (url.pathname === "/files" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const stored = files.storedPath(url.searchParams.get("id") ?? "");
        if (!stored) return json(res, 404, { error: "没有这个文件" });
        let stat: fs.Stats;
        try {
          stat = fs.statSync(stored.path);
        } catch {
          return json(res, 404, { error: "文件已经被挪走或删掉了" });
        }
        const type = stored.mime || "application/octet-stream";
        // 「预览」走 inline（浏览器自己认得图片/文本/PDF），「下载」带 dl=1 强制落盘。
        const dl = url.searchParams.get("dl") === "1";
        const inline = !dl && (/^image\//.test(type) || type.startsWith("text/") || type === "application/pdf");
        res.writeHead(200, {
          "content-type": type,
          "content-length": stat.size,
          "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(stored.name)}`,
          "cache-control": "private, max-age=60",
        });
        return void fs.createReadStream(stored.path).pipe(res);
      }

      if (url.pathname === "/fs" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        try {
          return json(res, 200, { ok: true, ...listDir(url.searchParams.get("path") ?? "") });
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }

      if (url.pathname === "/transfers" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        return json(res, 200, { ok: true, transfers: files.transfers_(), free: files.free() });
      }

      // 局域网市场：清单与字节对 LAN 开放，发布/镜像/删除只认本机 bridge（D248）。
      if (url.pathname === "/market/manifest" && req.method === "GET") {
        return json(res, 200, manifestResponse(nodeId, cfg.nickname, os.hostname()));
      }

      if (url.pathname === "/market/blob" && req.method === "GET") {
        const sha = (url.searchParams.get("sha256") ?? "").toLowerCase();
        const file = touchBlob(sha);
        if (!file) return json(res, 404, { error: "本机没有这个包字节" });
        const stat = fs.statSync(file);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": stat.size,
          "cache-control": "no-store",
        });
        return void fs.createReadStream(file).pipe(res);
      }

      if (url.pathname === "/market/publish" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        let frame: Buffer;
        try {
          frame = await readRaw(req, MAX_MARKET_FRAME);
        } catch {
          return json(res, 413, { error: "太大了（上限 64 MB）" });
        }
        try {
          const parsed = parseFrame(frame);
          const out = ingest(parsed.manifest, parsed.zip, nodeId);
          if (!out.ok) return json(res, 400, { error: out.error });
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  });
}
