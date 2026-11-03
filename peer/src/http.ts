import http from "node:http";
import os from "node:os";
import type { PeerConfig } from "./config.ts";
import { PROTO, VERSION } from "./config.ts";
import type { Discovery } from "./discovery.ts";
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
}

const MAX_BODY = 1024 * 1024;

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
export function createPeerServer(ctx: PeerContext): http.Server {
  const { cfg, nodeId, discovery, history, messages, relations } = ctx;
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
          const result = messages.send(String(body?.peer ?? ""), String(body?.text ?? ""));
          return json(res, 200, result);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
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

      return json(res, 404, { error: "not found" });
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  });
}
