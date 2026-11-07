/**
 * A dedicated browser window that the bridge drives over CDP (D167).
 *
 * Why a browser at all: the teams.microsoft.com web client is the only Teams surface we may use —
 * no Azure AD app, no admin consent. Its session lives in cookies, so the cheapest honest way to
 * reach it is to let the *real* web client log in and then ask the page to `fetch` on our behalf.
 * Cookies stay in the browser profile; the bearer tokens we mint never leave memory and never
 * touch the state dir or the log.
 *
 * The profile is ours (`<state>/teams-profile`), never the user's default one: Chromium ≥ 136
 * refuses `--remote-debugging-port` on the default profile, and pointing it at somebody's daily
 * browser would be rude anyway.
 *
 * The window is spawned detached and outlives a bridge restart; the port and pid are written to
 * `<state>/teams-cdp.json` so a restarted bridge can adopt the same window instead of opening a
 * second one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import WebSocket from "ws";
import { ensureStateDirs, readJson, statePath, writeJson } from "../paths.ts";

export type BrowserKind = "edge" | "chrome";

export interface BrowserRecord {
  port: number;
  pid: number;
  kind: BrowserKind;
  /** When this window was started — only used to explain a stale record in the log. */
  startedAt: number;
}

const TEAMS_URL = "https://teams.microsoft.com/v2/";

// ---------------------------------------------------------------- discovery

interface Candidate {
  kind: BrowserKind;
  exe: string;
}

/**
 * Installed browsers, best first: the order in `settings.browser` wins, then Edge, then Chrome.
 * Windows paths cover both Program Files flavours plus a per-user Chrome install; mac/linux are
 * best-effort because the bridge normally runs on Windows.
 */
function candidates(): Candidate[] {
  const win = process.platform === "win32";
  const mac = process.platform === "darwin";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  const out: Candidate[] = [];
  const add = (kind: BrowserKind, ...paths: string[]) => {
    for (const exe of paths) if (exe && fs.existsSync(exe)) out.push({ kind, exe });
  };
  if (win) {
    add("edge", path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
    add("chrome", path.join(pf, "Google", "Chrome", "Application", "chrome.exe"), path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"), path.join(local, "Google", "Chrome", "Application", "chrome.exe"));
  } else if (mac) {
    add("edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    add("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    add("edge", ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"].find((p) => fs.existsSync(p)) || "");
    add("chrome", ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => fs.existsSync(p)) || "");
  }
  return out;
}

/** Which browsers this machine actually has — the settings page offers exactly these. */
export function installedBrowsers(): BrowserKind[] {
  const seen = new Set<BrowserKind>();
  for (const c of candidates()) seen.add(c.kind);
  return [...seen];
}

function resolveBrowser(prefer: BrowserKind): Candidate | null {
  const all = candidates();
  return all.find((c) => c.kind === prefer) ?? all[0] ?? null;
}

// ---------------------------------------------------------------- CDP

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * One websocket to one page target. `Runtime.evaluate` is all we need; we do not use
 * `Network.*` because the page's own `fetch` is the point (it carries the cookies).
 */
class Cdp {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly url: string) {}

  async connect(timeoutMs = 10_000): Promise<void> {
    const ws = new WebSocket(this.url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connect timeout")), timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", () => this.onClose());
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
    else p.resolve(msg.result);
  }

  private onClose(): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP closed"));
    }
    this.pending.clear();
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws;
    if (!ws || this.closed) return Promise.reject(new Error("CDP closed"));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Run an expression in the page and return its value (promises are awaited). */
  async evaluate<T>(expression: string, timeoutMs = 60_000): Promise<T> {
    const r = await this.send<{
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs);
    if (r.exceptionDetails) {
      const detail = r.exceptionDetails.exception?.description || r.exceptionDetails.text || "page script failed";
      throw new Error(detail.slice(0, 400));
    }
    return r.result?.value as T;
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.closed = true;
  }
}

// ---------------------------------------------------------------- the window

export type BrowserState = "off" | "starting" | "needs-login" | "ready" | "error";

/**
 * The bridge's own Teams window. One instance per bridge: `ensure()` is idempotent and serialised,
 * so the settings page polling `status()` and a tool call arriving at the same time start one
 * browser, not two.
 */
export class TeamsBrowser {
  private child: ChildProcess | null = null;
  private cdp: Cdp | null = null;
  private cdpUrl: string | null = null;
  private starting: Promise<void> | null = null;
  private preferred: BrowserKind = "edge";
  /** Last observed state, plus why — the settings page shows the reason verbatim. */
  state: BrowserState = "off";
  error: string | null = null;

  constructor(private readonly log: (line: string) => void) {}

  setPreferred(kind: BrowserKind): void {
    this.preferred = kind;
  }

  get profileDir(): string {
    return statePath("teams-profile");
  }

  private recordFile(): string {
    return statePath("teams-cdp.json");
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Make sure a window exists and speaks CDP. Adopts a window left behind by a previous bridge
   * (the record on disk still answers `/json/version`), otherwise spawns one.
   */
  async ensure(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.ensureInner().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async ensureInner(): Promise<void> {
    const adopted = await this.adopt();
    if (adopted) {
      this.state = "ready";
      return;
    }
    await this.spawnWindow();
  }

  /** Reuse a window from an earlier bridge run — the login session lives in that profile. */
  private async adopt(): Promise<boolean> {
    const rec = readJson<BrowserRecord | null>(this.recordFile(), null);
    if (!rec || !rec.port) return false;
    if (!(await alive(rec.port))) return false;
    this.log(`teams: adopting browser on :${rec.port} (pid ${rec.pid})`);
    this.preferred = rec.kind ?? this.preferred;
    return true;
  }

  private async spawnWindow(): Promise<void> {
    if (this.child) return;
    const pick = resolveBrowser(this.preferred);
    if (!pick) {
      this.state = "error";
      this.error = "没有找到 Edge 或 Chrome";
      throw new Error(this.error);
    }
    ensureStateDirs();
    fs.mkdirSync(this.profileDir, { recursive: true });
    const port = await freePort();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-allow-origins=*",
      "--disable-features=Translate,MediaRouter",
      TEAMS_URL,
    ];
    this.state = "starting";
    this.log(`teams: starting ${pick.kind} on :${port} (profile ${this.profileDir})`);
    const child = spawn(pick.exe, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    this.child = child;
    child.once("exit", () => {
      this.child = null;
      this.dropCdp();
      if (this.state !== "off") {
        this.state = "off";
        this.log("teams: browser window closed");
      }
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await alive(port)) {
        writeJson(this.recordFile(), { port, pid: child.pid ?? 0, kind: pick.kind, startedAt: Date.now() } satisfies BrowserRecord);
        return;
      }
      await sleep(250);
    }
    this.state = "error";
    this.error = "浏览器没有在 30 秒内打开调试端口";
    throw new Error(this.error);
  }

  /** Close the window we own. A window adopted from a previous bridge is left alone if `force` is false. */
  async stop(force = false): Promise<void> {
    this.dropCdp();
    const rec = readJson<BrowserRecord | null>(this.recordFile(), null);
    const pid = this.child?.pid ?? rec?.pid ?? 0;
    if (pid && (force || this.child)) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    this.child = null;
    this.state = "off";
    this.error = null;
    try {
      fs.rmSync(this.recordFile(), { force: true });
    } catch {
      /* a leftover record only costs an adopt attempt next boot */
    }
  }

  /** Bring the window to the front on the login page. Used by the settings button. */
  async openForLogin(): Promise<void> {
    await this.ensure();
    await this.navigate(TEAMS_URL);
    this.state = "needs-login";
  }

  /**
   * Navigate the Teams tab and wait until it has actually settled on that origin. A timeout is not
   * an error: logging in is a multi-page redirect dance and the caller re-checks the session
   * separately, so the worst case here is a slow page, not a broken flow.
   */
  async navigate(url: string, timeoutMs = 25_000): Promise<void> {
    const page = await this.page();
    await page.cdp.send("Page.navigate", { url });
    this.cdpUrl = url;
    const origin = originOf(url);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const probe = await page.cdp.evaluate<string>("JSON.stringify([location.origin, document.readyState])").catch(() => "");
      try {
        const [at, ready] = JSON.parse(probe) as [string, string];
        if (at === origin && ready === "complete") return;
      } catch {
        /* page is mid-navigation and the context is gone; retry */
      }
      await sleep(400);
    }
  }

  // ------------------------------------------------------------ pages

  private dropCdp(): void {
    this.cdp?.close();
    this.cdp = null;
    this.cdpUrl = null;
  }

  /**
   * The Teams tab we evaluate in. Reuses the current page if it is still reachable, otherwise
   * picks (or creates) a teams.microsoft.com tab. A fresh tab is created rather than hijacking
   * whatever the user has open in that window.
   */
  private async page(): Promise<{ cdp: Cdp; url: string }> {
    if (this.cdp && this.cdpUrl) return { cdp: this.cdp, url: this.cdpUrl };
    const rec = readJson<BrowserRecord | null>(this.recordFile(), null);
    const port = rec?.port;
    if (!port || !(await alive(port))) {
      this.dropCdp();
      await this.ensure();
      return this.page();
    }
    const targets = await listTargets(port);
    let target = targets.find((t) => t.type === "page" && /teams\.microsoft\.com|login\.microsoftonline\.com|teams\.live\.com/.test(t.url));
    if (!target) {
      target = (await listTargets(port)).find((t) => t.type === "page" && t.url === "about:blank");
    }
    if (!target) target = await newTarget(port, TEAMS_URL);
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    this.cdp = cdp;
    this.cdpUrl = target.url;
    return { cdp, url: target.url };
  }

  /** Run `expression` in the Teams tab. Reconnects once: a closed tab is the common failure. */
  async evaluate<T>(expression: string, timeoutMs = 60_000): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const page = await this.page();
      try {
        return await page.cdp.evaluate<T>(expression, timeoutMs);
      } catch (err) {
        this.dropCdp();
        if (attempt >= 1) throw err;
        await sleep(300);
      }
    }
  }

  /** Is any Teams window up right now (without starting one)? */
  async reachable(): Promise<boolean> {
    const rec = readJson<BrowserRecord | null>(this.recordFile(), null);
    return Boolean(rec?.port && (await alive(rec.port)));
  }
}

// ---------------------------------------------------------------- helpers

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function alive(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

interface TargetInfo {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function listTargets(port: number): Promise<TargetInfo[]> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return [];
    return (await r.json()) as TargetInfo[];
  } catch {
    return [];
  }
}

/**
 * `PUT /json/new` is the modern form; Chromium used to accept `GET`. Try PUT, fall back to GET —
 * whichever works, the browser is ours and the URL is constant.
 */
async function newTarget(port: number, url: string): Promise<TargetInfo> {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  for (const method of ["PUT", "GET"]) {
    try {
      const r = await fetch(endpoint, { method, signal: AbortSignal.timeout(5000) });
      if (r.ok) return (await r.json()) as TargetInfo;
    } catch {
      /* try the other verb */
    }
  }
  throw new Error("打不开 Teams 标签页");
}
