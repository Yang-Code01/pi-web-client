import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/** D110: `errCode` + `errParams` 让前端把这句话翻成当前语言（`error` 仍是中文兜底）。 */
export interface TunnelState {
  status: "off" | "starting" | "up" | "error";
  url: string | null;
  error: string | null;
  errCode?: string;
  errParams?: Record<string, string | number>;
  updatedAt: number;
}

const URL_RE = /\|\s{1,}(https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com)\s*\|/i;

/**
 * D29：只认框线里那行。cloudflared 创建失败时会打 `api.trycloudflare.com`，宽松正则会把 API
 * 主机当成隧道地址（曾因此对外报出一个永远 1033 的 URL）。
 */
export function parseTunnelUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  return m ? m[1] : null;
}

/** D184：本机 UDP/QUIC 到 Cloudflare 边缘被限速，默认走 http2；要试自动/QUIC 就设这个 env。 */
export const TUNNEL_PROTOCOLS = ["auto", "quic", "http2"] as const;
export type TunnelProtocol = (typeof TUNNEL_PROTOCOLS)[number];

export function tunnelProtocol(env: NodeJS.ProcessEnv = process.env): TunnelProtocol {
  const raw = (env.PI_WEB_TUNNEL_PROTOCOL ?? "").trim().toLowerCase();
  return (TUNNEL_PROTOCOLS as readonly string[]).includes(raw) ? (raw as TunnelProtocol) : "http2";
}

export function tunnelArgs(port: number, protocol: TunnelProtocol = tunnelProtocol()): string[] {
  return ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate", "--protocol", protocol];
}

export class Tunnel extends EventEmitter {
  state: TunnelState = { status: "off", url: null, error: null, updatedAt: Date.now() };
  private child: ChildProcess | null = null;
  private wants = false;
  private attempts = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private retire: (() => void) | null = null;
  /** D184：连续几次探不通才算死 —— 单次 530 常常是边缘抖动，换地址只会让已经发出去的链接立刻失效。 */
  private healthFails = 0;

  constructor(
    private port: number,
    private bin: string,
  ) {
    super();
  }

  private setState(patch: Partial<TunnelState>): void {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() };
    this.emit("state", this.state);
  }

  start(): void {
    this.wants = true;
    if (this.child) {
      // 「开」也得有反应：进程还活着、但状态停在 error（waitReady 60 秒超时会留下活进程）时，
      // 旧逻辑直接 return，按钮就像死了一样。换一条新进程重来一次。
      if (this.state.status !== "error") return;
      const old = this.child;
      this.child = null;
      try {
        old.kill();
      } catch {
        /* ignore */
      }
      this.setState({ status: "starting", url: null, error: null });
      this.spawnOnce();
      return;
    }
    this.setState({ status: "starting", url: null, error: null });
    this.spawnOnce();
  }

  private spawnOnce(): void {
    const args = tunnelArgs(this.port);
    const env = { ...process.env };
    const proxy = process.env.BILLION_CONTEXT_PROXY || process.env.HTTPS_PROXY;
    if (proxy && !env.HTTPS_PROXY) env.HTTPS_PROXY = proxy;

    let child: ChildProcess;
    try {
      child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
    } catch (err: any) {
      this.setState({ status: "error", error: `启动 cloudflared 失败：${err.message}`, errCode: "cloudflared_spawn", errParams: { p1: err.message } });
      return;
    }
    this.child = child;
    let found = "";
    let buf = "";
    let errTail = "";

    const watch = (chunk: Buffer | string) => {
      const line = chunk.toString();
      // 框线可能被管道拆成两块，留一小段尾巴再匹配。
      buf = (buf + line).slice(-4096);
      if (/\sERR\s/.test(line)) errTail = line.replace(/\r?\n/g, " ").trim().slice(-200);
      if (found) return;
      const url = parseTunnelUrl(buf);
      if (url) {
        found = url;
        this.attempts = 0;
        this.setState({ status: "starting", url: found });
        void this.waitReady(found);
      }
    };

    child.stderr?.on("data", watch);
    child.stdout?.on("data", watch);

    child.on("error", (err) => {
      this.setState({ status: "error", error: `cloudflared 错误：${err.message}`, errCode: "cloudflared_error", errParams: { p1: err.message } });
    });

    child.on("exit", (code) => {
      // 已经被换掉（start 重来 / stop）的旧进程：它的退出不代表现在的隧道状态，别覆盖新进程的设置。
      if (this.child !== child) return;
      this.child = null;
      if (this.retire) {
        this.retire();
        this.retire = null;
      }
      // 原因就在 stderr 最后那条 ERR 里（QUIC 被限速时是 `context deadline exceeded`），别吞掉。
      const why = errTail ? `：${errTail}` : "";
      this.setState({ status: this.wants ? "error" : "off", url: null, error: this.wants ? `cloudflared 退出（code=${code}）${why}` : null });
      if (this.wants) this.retry();
    });

    // Give cloudflared a deadline: if no URL after 40s, restart it.
    const deadline = setTimeout(() => {
      if (!found && this.child === child) {
        this.setState({ status: "error", error: "40 秒没拿到 trycloudflare 地址，重试中", errCode: "tunnel_no_url" });
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    }, 40_000);
    child.once("exit", () => clearTimeout(deadline));
  }

  private retry(): void {
    this.attempts += 1;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.attempts, 5));
    const t = setTimeout(() => {
      if (this.wants && !this.child) this.spawnOnce();
    }, delay);
    t.unref?.();
  }

  /** cloudflared prints the URL ~6s before the edge can serve it (probe finding). */
  private async waitReady(url: string): Promise<void> {
    for (let i = 0; i < 40; i += 1) {
      if (this.state.url !== url) return;
      const ok = await this.probe(url);
      if (ok) {
        this.setState({ status: "up", url, error: null });
        this.startHealth(url);
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    this.setState({ status: "error", error: "隧道地址拿到了，但 60 秒内一直连不上", errCode: "tunnel_unreachable" });
    // 边缘可能只是慢（cloudflared 自己会重连）：留着巡检，迟到就绪也能翻回 up，而不是永远停在 error。
    this.startHealth(url);
  }

  /** D29：就绪 = `/healthz` 200。530 是隧道没连上，502/404 等也不是「能用」。 */
  private async probe(url: string): Promise<boolean> {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000), redirect: "manual" });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  private startHealth(url: string): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthFails = 0;
    this.healthTimer = setInterval(async () => {
      if (!this.child || this.state.url !== url) return;
      const ok = await this.probe(url);
      if (ok) {
        this.healthFails = 0;
        if (this.state.status !== "up") this.setState({ status: "up", url, error: null });
        return;
      }
      if (this.state.status !== "up") return;
      // 两次连续探不通才判死（D184）：一次 530 多半是边缘抖动。
      this.healthFails += 1;
      if (this.healthFails < 2) return;
      this.setState({ status: "error", error: "隧道断了（连续两次探不通），正在换新地址", errCode: "tunnel_lost" });
      try {
        this.child?.kill();
      } catch {
        /* ignore */
      }
    }, 60_000);
    this.healthTimer.unref?.();
  }

  stop(): void {
    this.wants = false;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    const child = this.child;
    this.child = null;
    if (child && child.pid) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    this.setState({ status: "off", url: null, error: null });
  }

  get running(): boolean {
    return this.wants;
  }
}

/** 在 PATH 里找一个可执行文件（Windows 试 .exe，POSIX 试原名）。 */
function findOnPath(name: string): string | null {
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const file of names) {
      const full = path.join(dir, file);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* 不在这个目录 */
      }
    }
  }
  return null;
}

/** Locates the cloudflared binary: env → PATH → 常见安装位置（winget / brew / apt）。 */
export function findCloudflared(): string | null {
  const candidates = [
    process.env.CLOUDFLARED_BIN,
    findOnPath("cloudflared"),
    "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
    "C:\\Program Files\\cloudflared\\cloudflared.exe",
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}
