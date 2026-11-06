import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { saveConfig, statePath } from "./config.ts";
import type { PeerConfig } from "./config.ts";
import { PROTO, VERSION } from "./config.ts";
import type { Discovery } from "./discovery.ts";
import { CHUNK } from "./files.ts";
import type { Files } from "./files.ts";
import { listDir } from "./fsbrowse.ts";
import type { History } from "./history.ts";
import type { Messages } from "./messages.ts";
import type { Relations } from "./peers.ts";

export interface PeerContext {
  cfg: PeerConfig;
  nodeId: string;
  discovery: Discovery;
  history: History;
  messages: Messages;
  relations: Relations;
  files: Files;
}

const MAX_BODY = 1024 * 1024;
/** 分块请求的体上限：一个 CHUNK 再加一点余量。 */
const MAX_CHUNK = CHUNK + 64 * 1024;

function isLoopback(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(addr);
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
  const { cfg, nodeId, discovery, history, messages, relations, files } = ctx;
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
        // 隐身刚变：立刻丢一份 announce / hello，别等下一轮定时（15 秒里对方还看得见）。
        if (cfg.hidden !== wasHidden) discovery.announce();
        return json(res, 200, {
          ok: true,
          config: { hidden: cfg.hidden, pauseFiles: cfg.pauseFiles, dnd: cfg.dnd, inbox: cfg.inbox, manual: cfg.manual },
        });
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
        return json(res, 200, { ok: true, threads: history.threads(discovery.online()) });
      }

      if (url.pathname === "/messages" && req.method === "GET") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const peerId = url.searchParams.get("peer") ?? "";
        if (!peerId) return json(res, 400, { error: "缺 peer" });
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
        return json(res, 200, { ok: true, peer: peerId, entries: history.read(peerId, limit) });
      }

      if (url.pathname === "/send" && req.method === "POST") {
        if (!loopback) return json(res, 403, { error: "只对回环开放" });
        const body = await readBody(req).catch(() => ({}));
        try {
          const via = body?.via === "pi" ? ("pi" as const) : undefined;
          const result = messages.send(String(body?.peer ?? ""), String(body?.text ?? ""), via);
          return json(res, 200, result);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
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
        const online = new Map(discovery.online().map((peer) => [peer.nodeId, peer]));
        const contacts = relations.list().map((contact) => {
          const peer = online.get(contact.nodeId);
          return { ...contact, online: Boolean(peer), addr: peer?.addr ?? "", livePort: peer?.port ?? 0 };
        });
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
          if (action === "accept") {
            const known = relations.get(peerId);
            if (!known?.incoming) return json(res, 400, { error: "没有待接受的请求" });
            if (!who) return json(res, 400, { error: "他不在线，等他在线再接受（否则他不知道）" });
            relations.accept({ nodeId: peerId, nickname: known.nickname, hostname: known.hostname, port: known.port });
            messages.sendControl(peerId, "friend-accept");
            return json(res, 200, { ok: true, contact: relations.get(peerId) });
          }
          if (action === "favorite") {
            const known = relations.get(peerId);
            if (!known) return json(res, 400, { error: "不在通讯录里" });
            relations.favorite({ nodeId: peerId, nickname: known.nickname, hostname: known.hostname, port: known.port }, Boolean(body?.on));
            return json(res, 200, { ok: true, contact: relations.get(peerId) });
          }
          if (action === "remove") {
            relations.remove(peerId);
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
        if (!relations.isFriend(peerId)) return json(res, 403, { error: "先加好友才能发文件" });
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
        if (!relations.isFriend(peerId)) return json(res, 403, { error: "先加好友才能发文件" });
        const data = await readRaw(req, 64 * 1024 * 1024).catch(() => null);
        if (!data) return json(res, 413, { error: "太大了（上限 64 MB）" });
        const tmp = path.join(statePath("out"), `up-${randomUUID()}${path.extname(name)}`);
        fs.writeFileSync(tmp, data);
        return json(res, 200, await files.send(peerId, tmp, name));
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
        const inline = /^image\//.test(type) || type.startsWith("text/") || type === "application/pdf";
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

      return json(res, 404, { error: "not found" });
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  });
}
