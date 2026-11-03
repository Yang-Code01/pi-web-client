import http from "node:http";
import os from "node:os";
import type { PeerConfig } from "./config.ts";
import { PROTO, VERSION } from "./config.ts";
import type { Discovery } from "./discovery.ts";

export interface PeerContext {
  cfg: PeerConfig;
  nodeId: string;
  discovery: Discovery;
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
  const { cfg, nodeId, discovery } = ctx;
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

      if (url.pathname === "/peer/inbox") {
        // 第 2 片接文字与回执，第 3 片接好友请求。现在只回「协议在、kind 不认识」，
        // 免得对端把 501 当成「这台机器不是 peer」。
        return json(res, 400, { error: "unknown kind", proto: PROTO });
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  });
}
