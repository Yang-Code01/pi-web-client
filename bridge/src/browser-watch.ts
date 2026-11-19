/**
 * D328：看「浏览器真的被动了」，不看命令怎么写。
 *
 * 浏览器面板以前只靠猜：工具名、shell 命令、脚本源码。AI 每换一种写法（启动器 import 执行器、
 * cp 一份片段再跑、换个命令行工具）就认不出来。各种写法里不变的只有两件事：浏览器进程被拉起来，
 * 或者有人连上了它的调试端口（CDP）。所以工具在跑的时候，桥每隔一会儿看一眼 pi 子进程底下的
 * 进程树和 TCP 连接：
 *
 * - 树里出现 chrome / msedge / chromium / chrome-headless-shell / firefox … → `launch`；
 * - 树里的进程连上了一个「浏览器在监听的本机端口」→ `cdp`；中间隔一层也算（agent-browser 这类
 *   常驻 daemon：命令行连 daemon，daemon 连浏览器）。
 *
 * 归属：pi 子进程的直接子进程里，工具开始之后才出现的，记到「开始时间在它之前、最晚开始」的那个
 * 在跑工具上 —— pi 的 shell 工具就是从它直接 spawn 的；MCP 服务器、扩展这类常驻子进程早于工具，
 * 不会被算进来。两个工具同时跑、且同时起子进程时可能记错，这是已知的不准。
 *
 * 取样只在有工具在跑时进行；Windows 上用一个常驻的 PowerShell 查 Win32_Process（每次开新的要
 * 将近 2 秒），空闲一会儿就关掉。
 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { statePath } from "./paths.ts";

export interface BrowserEvidence {
  /** `launch`：拉起了浏览器；`cdp`：连上了已经开着的浏览器的调试端口。 */
  kind: "launch" | "cdp";
  /** 浏览器进程名（去掉 .exe）。 */
  browser: string;
  port?: number;
  /** 进程名看得出无头（chrome-headless-shell）时为 true；看不出就不写。 */
  headless?: boolean;
  /** 第一次看到的时刻（ms）。 */
  at: number;
}

export interface ProcRow {
  pid: number;
  ppid: number;
  name: string;
  /** 创建时刻（ms）；拿不到时为 0。 */
  created: number;
}

export interface ConnRow {
  pid: number;
  /** 只收连向本机的连接（127.0.0.1 / ::1 / localhost）。 */
  remotePort: number;
}

export interface Snapshot {
  procs: ProcRow[];
  conns: ConnRow[];
  listens: { pid: number; port: number }[];
}

export type Sampler = () => Promise<Snapshot>;

const BROWSERS = new Set([
  "chrome",
  "chromium",
  "chromium-browser",
  "google chrome",
  "google-chrome",
  "chrome-headless-shell",
  "headless_shell",
  "msedge",
  "microsoft edge",
  "microsoft-edge",
  "firefox",
  "brave",
  "brave browser",
  "vivaldi",
  "opera",
  "minibrowser",
  "pw_run.sh",
]);

export function browserName(name: string): string | null {
  const base = name.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
  return BROWSERS.has(base) ? base : null;
}

interface Watched {
  startedAt: number;
  /** pi 的直接子进程里归给这个工具的。 */
  roots: Set<number>;
  found: boolean;
}

/** 允许的时钟误差：进程创建时间与工具开始时间来自不同的钟（OS vs 桥）。 */
const SLACK_MS = 1500;

/**
 * 从一份快照里找出各个在跑工具的浏览器证据。纯函数，测试直接喂快照。
 * `claimed` 记 pi 直接子进程 → toolCallId，跨快照保留（子进程活得比一次取样长）。
 */
export function evidenceFrom(
  snap: Snapshot,
  rootPid: number,
  watched: Map<string, { startedAt: number; roots: Set<number> }>,
  claimed: Map<number, string>,
  now: number,
): Map<string, BrowserEvidence> {
  const byPid = new Map(snap.procs.map((proc) => [proc.pid, proc]));
  const children = new Map<number, ProcRow[]>();
  for (const proc of snap.procs) {
    if (proc.pid === proc.ppid) continue;
    const parent = byPid.get(proc.ppid);
    // 父进程已死、pid 被重用：孩子比「父亲」还早出生，就不是它的孩子。
    if (parent && parent.created && proc.created && proc.created + 1000 < parent.created) continue;
    const list = children.get(proc.ppid) ?? [];
    list.push(proc);
    children.set(proc.ppid, list);
  }

  // 新出现的直接子进程归给开始时间在它之前、最晚开始的在跑工具。
  const order = [...watched.entries()].sort((a, b) => b[1].startedAt - a[1].startedAt);
  for (const child of children.get(rootPid) ?? []) {
    if (claimed.has(child.pid)) continue;
    const created = child.created || now;
    const owner = order.find(([, w]) => w.startedAt <= created + SLACK_MS);
    // 比所有在跑工具都早：常驻子进程（MCP 服务器、扩展），永远不归任何工具。
    claimed.set(child.pid, owner ? owner[0] : "");
  }
  for (const [pid, id] of claimed) {
    if (!byPid.has(pid)) claimed.delete(pid);
    else if (id && watched.has(id)) watched.get(id)!.roots.add(pid);
  }

  const listenOwner = new Map<number, number>();
  for (const row of snap.listens) listenOwner.set(row.port, row.pid);
  const connsOf = new Map<number, number[]>();
  for (const row of snap.conns) {
    const list = connsOf.get(row.pid) ?? [];
    list.push(row.remotePort);
    connsOf.set(row.pid, list);
  }
  const browserOf = (pid: number | undefined): string | null => {
    const proc = pid === undefined ? undefined : byPid.get(pid);
    return proc ? browserName(proc.name) : null;
  };
  /** 这个进程连上的浏览器端口；隔一层（连到一个自己连着浏览器的进程）也算。 */
  const cdpOf = (pid: number, depth: number): { port: number; browser: string } | null => {
    for (const port of connsOf.get(pid) ?? []) {
      const owner = listenOwner.get(port);
      if (owner === undefined || owner === pid) continue;
      const browser = browserOf(owner);
      if (browser) return { port, browser };
      if (depth > 0) {
        const hop = cdpOf(owner, depth - 1);
        if (hop) return hop;
      }
    }
    return null;
  };

  const out = new Map<string, BrowserEvidence>();
  for (const [id, w] of watched) {
    const tree: ProcRow[] = [];
    const stack = [...w.roots].map((pid) => byPid.get(pid)).filter((proc): proc is ProcRow => Boolean(proc));
    const seen = new Set<number>();
    while (stack.length) {
      const proc = stack.pop()!;
      if (seen.has(proc.pid)) continue;
      seen.add(proc.pid);
      tree.push(proc);
      stack.push(...(children.get(proc.pid) ?? []));
    }
    const launched = tree.find((proc) => browserName(proc.name));
    if (launched) {
      const browser = browserName(launched.name)!;
      out.set(id, { kind: "launch", browser, ...(/headless/.test(browser) ? { headless: true } : {}), at: now });
      continue;
    }
    for (const proc of tree) {
      const hit = cdpOf(proc.pid, 1);
      if (hit) {
        out.set(id, { kind: "cdp", browser: hit.browser, port: hit.port, at: now });
        break;
      }
    }
  }
  return out;
}

export interface BrowserWatchOptions {
  rootPid: () => number | null;
  onEvidence: (toolCallId: string, evidence: BrowserEvidence) => void;
  sampler?: Sampler;
  /** 两次取样之间的间隔（取样本身的耗时另算）。 */
  intervalMs?: number;
  now?: () => number;
}

export class BrowserWatch {
  private readonly watched = new Map<string, Watched>();
  private readonly claimed = new Map<number, string>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly sampler: Sampler;
  private readonly now: () => number;

  private readonly opts: BrowserWatchOptions;

  constructor(opts: BrowserWatchOptions) {
    this.opts = opts;
    this.sampler = opts.sampler ?? defaultSampler;
    this.now = opts.now ?? Date.now;
  }

  start(toolCallId: string): void {
    if (!toolCallId || this.watched.has(toolCallId)) return;
    this.watched.set(toolCallId, { startedAt: this.now(), roots: new Set(), found: false });
    this.schedule(this.opts.intervalMs ?? 800);
  }

  end(toolCallId: string): void {
    this.watched.delete(toolCallId);
    for (const [pid, id] of this.claimed) if (id === toolCallId) this.claimed.set(pid, "");
    if (!this.watched.size && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.watched.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 立刻取一次样（测试用；正常由定时器驱动）。 */
  async tick(): Promise<void> {
    if (this.busy) return;
    const root = this.opts.rootPid();
    if (root === null) {
      // pi 子进程没了：这些工具不会再有 end，别让定时器一直转。
      this.watched.clear();
      return;
    }
    const pending = new Map([...this.watched].filter(([, w]) => !w.found));
    if (!pending.size) return;
    this.busy = true;
    try {
      const snap = await this.sampler();
      const found = evidenceFrom(snap, root, pending, this.claimed, this.now());
      for (const [id, evidence] of found) {
        const w = this.watched.get(id);
        if (!w || w.found) continue; // 取样期间工具已经结束
        w.found = true;
        this.opts.onEvidence(id, evidence);
      }
    } catch {
      // 取样失败（PowerShell 没起来、权限）：这一轮就当没看到，判断退回到猜。
    } finally {
      this.busy = false;
    }
  }

  private schedule(delay: number): void {
    if (this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.tick();
      if ([...this.watched.values()].some((w) => !w.found)) this.schedule(this.opts.intervalMs ?? 800);
    }, delay);
    this.timer.unref?.();
  }
}

// ---------------------------------------------------------------- 落盘

/** 证据只在桥里看得到，会话文件里没有：存一份旁文件，重新打开会话时补回工具卡。 */
export function evidenceFile(sessionId: string): string {
  return statePath("browser-evidence", `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
}

export function readEvidence(sessionId: string): Record<string, BrowserEvidence> {
  try {
    const data = JSON.parse(fs.readFileSync(evidenceFile(sessionId), "utf8"));
    return data && typeof data === "object" ? (data as Record<string, BrowserEvidence>) : {};
  } catch {
    return {};
  }
}

export function saveEvidence(sessionId: string, toolCallId: string, evidence: BrowserEvidence): void {
  try {
    const file = evidenceFile(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...readEvidence(sessionId), [toolCallId]: evidence }));
  } catch {
    // 写不下只影响重开会话后的显示，这一轮里的卡照样有。
  }
}

// ---------------------------------------------------------------- 取样

export function parseNetstat(text: string): { conns: ConnRow[]; listens: { pid: number; port: number }[] } {
  const conns: ConnRow[] = [];
  const listens: { pid: number; port: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "TCP" || cols.length < 5) continue;
    const pid = Number(cols[4]);
    const local = endpoint(cols[1]);
    const remote = endpoint(cols[2]);
    if (!local || !Number.isFinite(pid)) continue;
    if (cols[3] === "LISTENING") listens.push({ pid, port: local.port });
    else if (cols[3] === "ESTABLISHED" && remote && remote.loopback) conns.push({ pid, remotePort: remote.port });
  }
  return { conns, listens };
}

/** lsof -nP -iTCP 的输出：`node 123 me 20u IPv4 … TCP 127.0.0.1:5000->127.0.0.1:9333 (ESTABLISHED)`。 */
export function parseLsof(text: string): { conns: ConnRow[]; listens: { pid: number; port: number }[] } {
  const conns: ConnRow[] = [];
  const listens: { pid: number; port: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\S+\s+(\d+)\s.*\bTCP\s+(\S+?)(?:->(\S+))?\s+\((\w+)\)/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (m[4] === "LISTEN") {
      const local = endpoint(m[2]);
      if (local) listens.push({ pid, port: local.port });
    } else if (m[4] === "ESTABLISHED" && m[3]) {
      const remote = endpoint(m[3]);
      if (remote?.loopback) conns.push({ pid, remotePort: remote.port });
    }
  }
  return { conns, listens };
}

function endpoint(text: string | undefined): { port: number; loopback: boolean } | null {
  if (!text) return null;
  const at = text.lastIndexOf(":");
  if (at < 0) return null;
  const port = Number(text.slice(at + 1));
  if (!Number.isFinite(port)) return null;
  const host = text.slice(0, at).replace(/^\[|\]$/g, "");
  return { port, loopback: host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "0.0.0.0" || host === "*" };
}

/** ps 的 etime：`[[dd-]hh:]mm:ss`。 */
export function etimeMs(text: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return 0;
  return (((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 24, timeout: 10_000 }, (_err, stdout) => resolve(String(stdout ?? "")));
  });
}

const END = "@@pi-web-browser-watch@@";
const PS_QUERY =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | " +
  "ForEach-Object { '{0},{1},{2},{3}' -f $_.ProcessId,$_.ParentProcessId,$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }),$_.Name }; " +
  `'${END}'`;

/** 常驻的 PowerShell：每次新开一个要将近 2 秒，常驻后一次查询一两百毫秒。闲 30 秒就关。 */
class PowerShellProcs {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private waiter: ((text: string) => void) | null = null;
  private idle: NodeJS.Timeout | null = null;

  async query(): Promise<ProcRow[]> {
    const text = await this.ask();
    const rows: ProcRow[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^(\d+),(\d+),(\d+),(.*)$/.exec(line.trim());
      if (!m) continue;
      const fileTime = Number(m[3]);
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: fileTime ? fileTime / 10_000 - 11_644_473_600_000 : 0, name: m[4] });
    }
    return rows;
  }

  private ask(): Promise<string> {
    const child = this.ensure();
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), 30_000);
    this.idle.unref?.();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.waiter = null;
        this.close();
        resolve("");
      }, 15_000);
      this.waiter = (text) => {
        clearTimeout(timeout);
        resolve(text);
      };
      child.stdin.write(`${PS_QUERY}\n`);
    });
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], { windowsHide: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      const at = this.buffer.indexOf(END);
      if (at < 0) return;
      const text = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + END.length);
      const waiter = this.waiter;
      this.waiter = null;
      waiter?.(text);
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      this.waiter?.("");
      this.waiter = null;
    });
    child.on("error", () => undefined);
    child.unref();
    this.child = child;
    return child;
  }

  private close(): void {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    if (child) {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        // 已经退了
      }
    }
  }
}

let ps: PowerShellProcs | null = null;

export const defaultSampler: Sampler = async () => {
  if (process.platform === "win32") {
    ps ??= new PowerShellProcs();
    const [procs, net] = await Promise.all([ps.query(), run("netstat.exe", ["-ano", "-p", "TCP"])]);
    // IPv6 的 [::1] 连接在 -p TCP 里看不到，补一次 TCPv6。
    const v6 = await run("netstat.exe", ["-ano", "-p", "TCPv6"]);
    const a = parseNetstat(net);
    const b = parseNetstat(v6);
    return { procs, conns: [...a.conns, ...b.conns], listens: [...a.listens, ...b.listens] };
  }
  const now = Date.now();
  const [psOut, lsof] = await Promise.all([run("ps", ["-A", "-o", "pid=,ppid=,etime=,comm="]), run("lsof", ["-nP", "-iTCP"])]);
  const procs: ProcRow[] = [];
  for (const line of psOut.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const age = etimeMs(m[3]);
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), created: age ? now - age : 0, name: m[4].trim() });
  }
  return { procs, ...parseLsof(lsof) };
};
