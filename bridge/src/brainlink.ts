/**
 * 脑这一侧的控制通道客户端。
 *
 * 有了壳以后，index.js 不再自己 spawn pi、也不再自己写它的 stdin —— 这些请求都发给壳。
 * 对上层（rpc.ts / sessions.ts）保持原来的方法形状：调用方只管要 pid、要写一帧、要杀掉，
 * 不必知道管道握在谁手里。
 */
import { EventEmitter } from "node:events";
import { connectControl, type ControlConn } from "./host/control.ts";

export interface SpawnRequest {
  sessionId: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface AttachResult {
  pid: number;
  pending: { fromSeq: number; toSeq: number; lines: { seq: number; line: string }[]; overflowed: boolean };
  lastWritten: number;
  lastExit?: { code: number | null; signal: string | null; at: number } | null;
  lastStderr?: string | null;
}

export type DeployPhase = "idle" | "running" | "observing" | "switched" | "failed" | "needs-group-restart";

export interface DeployState {
  phase: DeployPhase;
  at?: number;
  ok?: boolean;
  reason?: string;
  buildId?: string;
  brainPid?: number;
}

interface Watcher {
  line: (line: string, seq: number) => void;
  stderr: (text: string) => void;
  exit: (reason: string) => void;
}

export class BrainLink extends EventEmitter {
  private readonly conn: ControlConn;
  private readonly watchers = new Map<string, Watcher>();
  private readonly asks = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private rid = 0;
  /** 壳的构建指纹（面板用来提示「壳也变了」）。 */
  hostBuildId = "";
  publicPort = 0;
  /** 换到了新一代（壳通知 activate 时置位）。 */
  activated = false;
  /** 热部署走到哪一步：页面读这个，不用再去读 worker 的日志文件。 */
  deployState: DeployState = { phase: "idle" };
  /** 壳给的用量底账（换代之后账还在，脑拿它接上）。 */
  usageTotals: Record<string, unknown> = {};
  /** 壳的 snapshot 里列着的会话 id：换脑后要接管的就是这些（D385）。 */
  private liveIds: string[] = [];

  constructor(conn: ControlConn) {
    super();
    this.conn = conn;
    conn.onMessage((msg: any) => this.onMessage(msg));
    conn.onClose(() => {
      // 壳没了：脑什么也做不了（管道在壳手里）。退出，让壳的看门狗/新壳重来。
      this.emit("closed");
    });
  }

  static async connect(socketPath: string): Promise<BrainLink> {
    return new BrainLink(await connectControl(socketPath));
  }

  /** 壳里还活着的会话 id（snapshot 时刻的）。页面与新脑不是同一个进程，只能靠这个对齐。 */
  liveSessionIds(): string[] {
    return [...this.liveIds];
  }

  /** 握手；等壳的 welcome。 */
  hello(info: { buildId: string; internalPort: number }): Promise<{ hostBuildId: string; publicPort: number }> {
    const done = new Promise<{ hostBuildId: string; publicPort: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("壳 10s 内没有 welcome")), 10_000);
      this.once("welcome", (w: any) => {
        clearTimeout(timer);
        this.hostBuildId = String(w.hostBuildId ?? "");
        this.publicPort = Number(w.publicPort ?? 0);
        resolve({ hostBuildId: this.hostBuildId, publicPort: this.publicPort });
      });
      this.once("reject", (reason: string) => {
        clearTimeout(timer);
        reject(new Error(`壳拒绝握手：${reason}`));
      });
    });
    this.send({
      t: "hello",
      proto: 1,
      buildId: info.buildId,
      pid: process.pid,
      internalPort: info.internalPort,
    });
    return done;
  }

  send(msg: Record<string, unknown>): boolean {
    if (!this.conn.alive) return false;
    this.conn.send(msg);
    return true;
  }

  get connected(): boolean {
    return this.conn.alive;
  }

  /** 壳说可以服务了（首个脑 / 换脑完成）。 */
  ready(): void {
    this.send({ t: "ready" });
  }

  /** 订阅某个会话的帧。返回退订函数。 */
  watch(sessionId: string, w: Watcher): () => void {
    this.watchers.set(sessionId, w);
    return () => {
      if (this.watchers.get(sessionId) === w) this.watchers.delete(sessionId);
    };
  }

  spawnSession(req: SpawnRequest): Promise<{ pid: number }> {
    return this.ask({ t: "spawn", sessionId: req.sessionId, argv: req.argv, cwd: req.cwd, env: req.env }, "spawned", "spawn-failed");
  }

  attachSession(sessionId: string): Promise<AttachResult> {
    return this.ask({ t: "attach", sessionId }, "attached", "attach-failed");
  }

  /** 写一帧到 pi 的 stdin；壳是唯一的写者（换脑时老脑排队的帧不会跟着它消失）。 */
  stdin(sessionId: string, data: string): boolean {
    if (!this.connected) return false;
    return this.send({ t: "stdin", sessionId, data });
  }

  ack(sessionId: string, seq: number): void {
    this.send({ t: "ack", sessionId, seq });
  }

  kill(sessionId: string, mode: "end" | "now"): void {
    this.send({ t: "kill", sessionId, mode });
  }

  /** 把这一轮的用量交给壳记账：换代后数字还在。 */
  usage(sessionId: string, usage: unknown): void {
    this.send({ t: "usage", sessionId, usage });
  }

  deploy(branch?: string, stash = false): void {
    this.send({ t: "deploy", action: "run", branch, stash });
  }

  requestStop(scope: "all" | "group" = "all"): void {
    this.send({ t: "shutdown", scope });
  }

  private ask(payload: Record<string, unknown>, okType: string, failType: string): Promise<any> {
    const rid = `q${++this.rid}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.asks.delete(rid);
        reject(new Error(`壳 ${okType} 超时`));
      }, 15_000);
      this.asks.set(rid, { resolve, reject, timer });
      this.send({ ...payload, rid });
      // failType 的应答没有专属监听器，统一在 onMessage 里按 rid 结算。
      void failType;
    });
  }

  private settle(rid: string, fn: (entry: { resolve: (v: any) => void; reject: (e: Error) => void }) => void): void {
    const entry = this.asks.get(rid);
    if (!entry) return;
    this.asks.delete(rid);
    clearTimeout(entry.timer);
    fn(entry);
  }

  private onMessage(msg: any): void {
    switch (msg.t) {
      case "welcome":
        this.emit("welcome", msg);
        return;
      case "reject":
        this.emit("reject", String(msg.reason ?? ""));
        return;
      case "snapshot":
        // 壳发的是会话 id 数组（`broker.sessions()`）；旧形态是 `{id}` 对象，两种都认。
        this.liveIds = ((msg.sessions ?? []) as Array<string | { id?: string }>)
          .map((s) => (typeof s === "string" ? s : String(s?.id ?? "")))
          .filter(Boolean);
        this.emit("snapshot", msg);
        return;
      case "activate":
        this.activated = true;
        this.emit("activate", msg);
        return;
      case "retire":
        this.emit("retire");
        return;
      case "usage-snapshot":
        this.usageTotals = (msg.sessions ?? {}) as Record<string, unknown>;
        this.emit("usage-snapshot", this.usageTotals);
        return;
      case "deploy-state":
        this.deployState = msg as DeployState;
        this.emit("deploy-state", msg as DeployState);
        return;
      case "line": {
        const w = this.watchers.get(String(msg.sessionId));
        w?.line(String(msg.line), Number(msg.seq) || 0);
        return;
      }
      case "stderr": {
        const w = this.watchers.get(String(msg.sessionId));
        w?.stderr(String(msg.text ?? ""));
        return;
      }
      case "child-exit": {
        const w = this.watchers.get(String(msg.sessionId));
        w?.exit(`pi 退出（${msg.code ?? msg.signal ?? "?"}）`);
        return;
      }
      case "spawned":
      case "attached":
        this.settle(String(msg.rid), (e) => e.resolve(msg));
        return;
      case "spawn-failed":
      case "attach-failed":
        this.settle(String(msg.rid), (e) => e.reject(new Error(String(msg.reason ?? "失败"))));
        return;
      case "stale-owner":
        this.emit("stale-owner", String(msg.sessionId));
        return;
      case "shutdown":
        this.emit("shutdown", msg);
        return;
      default:
        this.emit("message", msg);
    }
  }
}

/**
 * 进程级的那一条连接。sessions.ts 在起会话时直接 `brainLink()`：
 * 有壳就交给壳代持管道，没壳（`npm start` 直连、测试）就回 null，走原来的 spawn。
 */
let active: BrainLink | null = null;

export function setBrainLink(link: BrainLink | null): void {
  active = link;
}

export function brainLink(): BrainLink | null {
  return active;
}
