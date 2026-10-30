import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface TunnelState {
  status: "off" | "starting" | "up" | "error";
  url: string | null;
  error: string | null;
  updatedAt: number;
}

const URL_RE = /\|\s{1,}(https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com)\s*\|/i;
const URL_FALLBACK_RE = /(https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com)/i;

export class Tunnel extends EventEmitter {
  state: TunnelState = { status: "off", url: null, error: null, updatedAt: Date.now() };
  private child: ChildProcess | null = null;
  private wants = false;
  private attempts = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private retire: (() => void) | null = null;

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
    if (this.child) return;
    this.setState({ status: "starting", url: null, error: null });
    this.spawnOnce();
  }

  private spawnOnce(): void {
    const args = ["tunnel", "--url", `http://127.0.0.1:${this.port}`, "--no-autoupdate"];
    const env = { ...process.env };
    const proxy = process.env.BILLION_CONTEXT_PROXY || process.env.HTTPS_PROXY;
    if (proxy && !env.HTTPS_PROXY) env.HTTPS_PROXY = proxy;

    let child: ChildProcess;
    try {
      child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
    } catch (err: any) {
      this.setState({ status: "error", error: `启动 cloudflared 失败：${err.message}` });
      return;
    }
    this.child = child;
    let found = "";

    const watch = (chunk: Buffer | string) => {
      if (found) return;
      const line = chunk.toString();
      const m = URL_RE.exec(line) || URL_FALLBACK_RE.exec(line);
      if (m) {
        found = m[1];
        this.attempts = 0;
        this.setState({ status: "starting", url: found });
        void this.waitReady(found);
      }
    };

    child.stderr?.on("data", watch);
    child.stdout?.on("data", watch);

    child.on("error", (err) => {
      this.setState({ status: "error", error: `cloudflared 错误：${err.message}` });
    });

    child.on("exit", (code) => {
      this.child = null;
      if (this.retire) {
        this.retire();
        this.retire = null;
      }
      this.setState({ status: this.wants ? "error" : "off", url: null, error: this.wants ? `cloudflared 退出（code=${code}）` : null });
      if (this.wants) this.retry();
    });

    // Give cloudflared a deadline: if no URL after 40s, restart it.
    const deadline = setTimeout(() => {
      if (!found && this.child === child) {
        this.setState({ status: "error", error: "40 秒没拿到 trycloudflare 地址，重试中" });
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
    this.setState({ status: "error", error: "隧道地址拿到了，但 60 秒内一直连不上" });
  }

  private async probe(url: string): Promise<boolean> {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000), redirect: "manual" });
      if (res.status === 530) return false;
      return res.status > 0;
    } catch {
      return false;
    }
  }

  private startHealth(url: string): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(async () => {
      if (!this.child || this.state.url !== url) return;
      const ok = await this.probe(url);
      if (!ok && this.state.status === "up") {
        this.setState({ status: "error", error: "隧道断了（530），正在换新地址" });
        try {
          this.child?.kill();
        } catch {
          /* ignore */
        }
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
