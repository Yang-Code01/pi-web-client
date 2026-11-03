import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PeerView {
  nodeId: string;
  nickname: string;
  hostname: string;
  addr: string;
  port: number;
  lastSeen: number;
  ips: string[];
}

export interface PeerStatus {
  ok: boolean;
  proto: number;
  version: string;
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  online: PeerView[];
  config: { hidden: boolean; pauseFiles: boolean; dnd: boolean; inbox: string; manual: string[] };
}

/**
 * peer 子进程的托管：fork + 退避重启 + 5 秒轮询 `/status`。
 *
 * 为什么是 fork 而不是把 peer 编进 bridge：peer 要绑 7865、要被局域网访问，而 bridge 默认只
 * 绑回环；两者生命周期也不同（peer 崩了 bridge 必须活着，好把「peer 没起来」显示出来）。
 */
export class PeerHost {
  private child: ChildProcess | null = null;
  private restarts = 0;
  private stopped = false;
  private status: PeerStatus | null = null;
  private reason = "";
  private timer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: { port: number; entry: string | null; log: (msg: string) => void },
  ) {
    if (!opts.entry) this.reason = "peer 还没构建：在仓库根目录跑 npm run build:peer";
  }

  start(): void {
    if (!this.opts.entry) return;
    this.spawn();
    this.timer = setInterval(() => void this.poll(), 5000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.child?.kill();
    this.child = null;
  }

  private spawn(): void {
    const entry = this.opts.entry;
    if (!entry) return;
    const child = fork(entry, [], {
      env: { ...process.env, PI_PEER_PORT: String(this.opts.port) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    const relay = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) if (line.trim()) this.opts.log(`[peer] ${line.trim()}`);
    };
    child.stdout?.on("data", relay);
    child.stderr?.on("data", relay);
    child.on("exit", (code, signal) => {
      this.child = null;
      this.status = null;
      if (this.stopped) return;
      // 退出码 2 = peer 自己说的「端口被占」。这时候重启只会反复失败，所以只报不试。
      if (code === 2) {
        this.reason = `peer 端口 ${this.opts.port} 被占用：另一份 peer 在跑（或者别的程序占了）`;
        return;
      }
      this.restarts += 1;
      if (this.restarts > 3) {
        this.reason = `peer 连续退出 ${this.restarts} 次（最后一次 ${signal ?? code}），不再重启`;
        return;
      }
      this.reason = `peer 退出了（${signal ?? code}），${2 ** (this.restarts - 1)} 秒后重启`;
      this.restartTimer = setTimeout(() => this.spawn(), 1000 * 2 ** (this.restarts - 1));
    });
  }

  private async poll(): Promise<void> {
    const next = await this.fetchStatus();
    if (next) this.reason = "";
    this.status = next;
  }

  private fetchStatus(): Promise<PeerStatus | null> {
    return new Promise((resolve) => {
      const req = http.get(
        { host: "127.0.0.1", port: this.opts.port, path: "/status", timeout: 1500 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as PeerStatus);
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
    });
  }

  /** 页面要的一句话：能不能用、为什么不能用、在线几台。 */
  view(): { enabled: boolean; running: boolean; reason: string; status: PeerStatus | null } {
    return {
      enabled: Boolean(this.opts.entry),
      running: this.status !== null,
      reason: this.status ? "" : this.reason || "peer 正在启动",
      status: this.status,
    };
  }

  private async request(method: "GET" | "POST", pathname: string, body?: unknown): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${this.opts.port}${pathname}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(4000),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
    if (!res.ok) throw new Error(parsed?.error ?? `peer 回 ${res.status}`);
    if (method === "POST") await this.poll();
    return parsed;
  }

  private call(pathname: string, body?: unknown): Promise<any> {
    return this.request("POST", pathname, body);
  }

  threads(): Promise<{ threads: unknown[] }> {
    return this.request("GET", "/threads");
  }

  history(peer: string, limit = 200): Promise<{ entries: unknown[] }> {
    return this.request("GET", `/messages?peer=${encodeURIComponent(peer)}&limit=${limit}`);
  }

  sendText(peer: string, text: string): Promise<{ ok: boolean; id: string; at: number }> {
    return this.request("POST", "/send", { peer, text });
  }

  contacts(): Promise<{ contacts: unknown[] }> {
    return this.request("GET", "/contacts");
  }

  friend(peer: string, action: "request" | "accept" | "favorite" | "remove", on?: boolean): Promise<unknown> {
    return this.request("POST", "/friend", { peer, action, on });
  }

  addManual(addr: string): Promise<any> {
    return this.call("/peer/add", { addr });
  }

  refresh(): Promise<any> {
    return this.call("/peer/refresh");
  }
}

/** `peer/dist/index.js`，从 bridge 的 dist 与 src 都指得对。 */
export function peerEntry(): string | null {
  const found: string[] = [];
  try {
    found.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "peer", "dist", "index.js"));
  } catch {
    /* exotic loader */
  }
  found.push(path.resolve(process.cwd(), "peer", "dist", "index.js"));
  return found.find((p) => fs.existsSync(p)) ?? null;
}
