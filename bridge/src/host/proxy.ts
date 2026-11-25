/**
 * 公网口 → 脑 的转发。壳自己只留两个口：`/healthz` 与 `/api/host/*`，其余原样转给脑。
 *
 * 转发是流式的（上传、`/raw/` 大文件、SSE 都一样过），不缓存整包 —— 壳变胖会变成
 * 「更常需要整组重启」的反噬，这一点在 PLAN 里就定了。
 *
 * 安全：转发时**先删掉**客户端自带的 `x-pi-peer` / `x-forwarded-*`，再按真实的
 * `remoteAddress` 写一份。脑里所有「只有本机才能调」的路由改读这个头，否则壳一转发，
 * 每个请求看起来都来自 127.0.0.1，守卫会整体失效。
 */
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

export function isLoopbackAddress(addr: string | undefined): boolean {
  return /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(addr ?? "");
}

export type Peer = "loopback" | "remote";

export interface ProxyOptions {
  /** 脑此刻的内部端口；null = 还没有脑（新脑没 ready，或正在换）。 */
  targetPort: () => number | null;
  log: (line: string) => void;
  /** 脑缺席时最多挂起多少个请求。 */
  maxQueued?: number;
  /** 挂起多久还没脑就放弃（毫秒）。 */
  queueTimeoutMs?: number;
}

interface Queued {
  run: () => void;
  timer: NodeJS.Timeout;
}

/** 转发时要重写的请求头。`x-pi-peer` 由壳说了算，客户端写什么都不算。 */
/**
 * 这一帧到底算谁发的。
 *
 * 回环来源不一定就能信：隧道（cloudflared）从本机连进来，`remoteAddress` 也是
 * `127.0.0.1`，但它带的是公网访客的请求。这两种信号都只在「不是从壳自己的页面来」时出现。
 */
function peerFor(headers: http.IncomingHttpHeaders, remote: string | undefined): Peer {
  for (const key of Object.keys(headers)) {
    const k = key.toLowerCase();
    if (k.startsWith("cf-") || k === "x-forwarded-for" || k === "x-real-ip") return "remote";
  }
  return isLoopbackAddress(remote) ? "loopback" : "remote";
}

function forwardHeaders(req: http.IncomingMessage, peer: Peer): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (key === "x-pi-peer") continue;
    if (key.startsWith("x-forwarded-")) continue;
    headers[key] = v;
  }
  headers["x-pi-peer"] = peer;
  return headers;
}

export class BrainProxy {
  private readonly opts: Required<ProxyOptions>;
  private queue: Queued[] = [];

  constructor(opts: ProxyOptions) {
    this.opts = { maxQueued: 64, queueTimeoutMs: 30_000, ...opts };
  }

  /** 新脑 ready：把挂着的请求按顺序放出去。 */
  release(): void {
    const queued = this.queue.splice(0);
    for (const q of queued) {
      clearTimeout(q.timer);
      q.run();
    }
  }

  get queued(): number {
    return this.queue.length;
  }

  private whenReady(run: () => void, onGiveUp: (reason: "timeout" | "overflow") => void): void {
    if (this.opts.targetPort() !== null) {
      run();
      return;
    }
    if (this.queue.length >= this.opts.maxQueued) {
      onGiveUp("overflow");
      return;
    }
    const timer = setTimeout(() => {
      this.queue = this.queue.filter((q) => q.timer !== timer);
      onGiveUp("timeout");
    }, this.opts.queueTimeoutMs);
    timer.unref();
    this.queue.push({ run, timer });
  }

  handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const peer: Peer = peerFor(req.headers, req.socket.remoteAddress);
    this.whenReady(
      () => this.forward(req, res, peer),
      (why) => {
        if (res.headersSent) return void res.end();
        res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, code: "brain-unavailable", reason: why }));
      },
    );
  }

  private forward(req: http.IncomingMessage, res: http.ServerResponse, peer: Peer): void {
    const port = this.opts.targetPort();
    if (port === null) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, code: "brain-unavailable" }));
      return;
    }
    const up = http.request({
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, peer),
    });
    up.on("response", (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", (err) => {
      this.opts.log(`proxy: ${req.method} ${req.url} → ${String((err as Error).message)}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, code: "brain-unreachable" }));
    });
    req.pipe(up);
  }

  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const socketPeer: Peer = peerFor(req.headers, (socket as net.Socket).remoteAddress);
    socket.on("error", () => socket.destroy());
    this.whenReady(
      () => this.upgrade(req, socket, head, socketPeer),
      () => socket.destroy(),
    );
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, peer: Peer): void {
    const port = this.opts.targetPort();
    if (port === null) return void socket.destroy();
    const up = http.request({
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, peer),
      agent: false,
    });
    up.on("upgrade", (res, upSocket: Duplex, upHead: Buffer) => {
      const status = res.statusCode ?? 101;
      const raw = [`HTTP/1.1 ${status} ${res.statusMessage ?? "Switching Protocols"}`];
      for (let i = 0; i < res.rawHeaders.length; i += 2) raw.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      socket.write(raw.join("\r\n") + "\r\n\r\n");
      if (upHead?.length) socket.write(upHead);
      this.pipeBoth(socket, upSocket);
    });
    // 对端回的是普通 HTTP（比如 401/404）而不是 101：把整包回给浏览器，别让 socket 干挂着。
    up.on("response", (res) => {
      const raw = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
      for (let i = 0; i < res.rawHeaders.length; i += 2) raw.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      socket.write(raw.join("\r\n") + "\r\n\r\n");
      res.pipe(socket);
    });
    up.on("error", () => socket.destroy());
    // 浏览器和 upgrade 一起送来的首帧（head）必须先写：end() 之后再 write 会
    // ERR_STREAM_WRITE_AFTER_END，'error' 处理器随即销毁 socket，连带丢掉这一帧。
    if (head?.length) up.write(head);
    up.end();
  }

  private pipeBoth(a: Duplex, b: Duplex): void {
    a.on("error", () => b.destroy());
    b.on("error", () => a.destroy());
    a.pipe(b);
    b.pipe(a);
    a.on("close", () => b.destroy());
    b.on("close", () => a.destroy());
  }
}
