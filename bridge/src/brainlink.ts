/**
 * 脑这一侧的控制通道客户端。
 *
 * 有了壳以后，index.js 不再自己 spawn pi、也不再自己写它的 stdin —— 这些请求都发给壳。
 * 对上层（rpc.ts / sessions.ts）保持原来的方法形状：调用方只管要 pid、要写一帧、要杀掉，
 * 不必知道管道握在谁手里。
 */
import { EventEmitter } from "node:events";
import { connectControl, type ControlConn, type ControlMessage } from "./host/control.ts";

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
  /** 换脑前还挂着的问卷 / 审批（原始 extension_ui_request 行）。 */
  pendingUi?: string[];
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

interface AskEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  failType: string;
}

interface Watcher {
  line: (line: string, seq: number) => void;
  stderr: (text: string) => void;
  exit: (reason: string) => void;
}

export class BrainLink extends EventEmitter {
  private readonly conn: ControlConn;
  private readonly watchers = new Map<string, Watcher>();
  private readonly asks = new Map<string, AskEntry>();
  private rid = 0;
  /** 壳的构建指纹（面板用来提示「壳也变了」）。 */
  hostBuildId = "";
  /** 壳自己那份代码已经和磁盘不一样了：面板要在点之前就红字预告「会连会话一起重启」。 */
  hostStale = false;
  publicPort = 0;
  /** 换到了新一代（壳通知 activate 时置位）。 */
  activated = false;
  /** 热部署走到哪一步：页面读这个，不用再去读 worker 的日志文件。 */
  deployState: DeployState = { phase: "idle" };
  /** 壳给的用量底账（换代之后账还在，脑拿它接上）。 */
  usageTotals: Record<string, unknown> = {};
  /** 壳的 snapshot 里列着的会话：换脑后要接管的就是这些（D407）。 */
  private liveIds: string[] = [];
  /** 其中哪些这一轮还在跑 —— 接管时要据此把页面的「思考中」恢复出来。 */
  private turns = new Map<string, boolean>();

  constructor(conn: ControlConn) {
    super();
    this.conn = conn;
    conn.onMessage((msg: ControlMessage) => this.onMessage(msg));
    conn.onClose(() => {
      // 壳没了：脑什么也做不了（管道在壳手里）。先把还挂着的 spawn/attach 立刻结算成
      // 「连接断开」，别让调用方白等 10–15 秒超时（那时报的「超时」还会掩盖真正的原因）。
      this.rejectPending(new Error("壳连接断开"));
      // 退出由上层处理，让壳的看门狗/新壳重来。
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

  /** 壳说这个会话这一轮还在跑吗（snapshot 时刻的）。 */
  turnActive(sessionId: string): boolean {
    return Boolean(this.turns.get(sessionId));
  }

  /** 握手；等壳的 welcome。壳先断开也要立刻失败，而不是等满 10 秒。 */
  hello(info: { buildId: string; internalPort: number }): Promise<{ hostBuildId: string; publicPort: number }> {
    return new Promise<{ hostBuildId: string; publicPort: number }>((resolve, reject) => {
      const finish = (fn: () => void): void => {
        clearTimeout(timer);
        this.off("welcome", onWelcome);
        this.off("reject", onReject);
        this.off("closed", onClosed);
        fn();
      };
      const onWelcome = (w: ControlMessage): void => {
        this.hostBuildId = String(w.hostBuildId ?? "");
        this.publicPort = Number(w.publicPort ?? 0);
        finish(() => resolve({ hostBuildId: this.hostBuildId, publicPort: this.publicPort }));
      };
      const onReject = (reason: string): void => finish(() => reject(new Error(`壳拒绝握手：${reason}`)));
      const onClosed = (): void => finish(() => reject(new Error("壳在握手完成前断开")));
      const timer = setTimeout(() => finish(() => reject(new Error("壳 10s 内没有 welcome"))), 10_000);
      this.once("welcome", onWelcome);
      this.once("reject", onReject);
      this.once("closed", onClosed);
      if (
        !this.send({
          t: "hello",
          proto: 1,
          buildId: info.buildId,
          pid: process.pid,
          internalPort: info.internalPort,
        })
      ) {
        finish(() => reject(new Error("壳连接已断开，hello 没发出去")));
      }
    });
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
    return this.ask<{ pid: number }>(
      { t: "spawn", sessionId: req.sessionId, argv: req.argv, cwd: req.cwd, env: req.env },
      "spawned",
      "spawn-failed",
    );
  }

  attachSession(sessionId: string): Promise<AttachResult> {
    return this.ask<AttachResult>({ t: "attach", sessionId }, "attached", "attach-failed");
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

  private ask<T>(payload: Record<string, unknown>, okType: string, failType: string): Promise<T> {
    const rid = `q${++this.rid}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.asks.delete(rid);
        reject(new Error(`壳 ${okType} 超时`));
      }, 15_000);
      this.asks.set(rid, { resolve: (v) => resolve(v as T), reject, timer, failType });
      if (!this.send({ ...payload, rid })) {
        this.asks.delete(rid);
        clearTimeout(timer);
        reject(new Error("壳连接已断开"));
      }
    });
  }

  /** 壳断开时把还在等应答的请求一次结算掉（定时器也要清）。 */
  private rejectPending(err: Error): void {
    for (const [, entry] of this.asks) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.asks.clear();
  }

  private settle(rid: string, fn: (entry: AskEntry) => void): void {
    const entry = this.asks.get(rid);
    if (!entry) return;
    this.asks.delete(rid);
    clearTimeout(entry.timer);
    fn(entry);
  }

  private onMessage(msg: ControlMessage): void {
    switch (msg.t) {
      case "welcome":
        this.emit("welcome", msg);
        return;
      case "reject":
        this.emit("reject", String(msg.reason ?? ""));
        return;
      case "snapshot": {
        // 壳发的是 [{id, turnActive}]；旧形态是纯 id 数组，两种都认。
        this.hostStale = Boolean(msg.hostStale);
        const list = (msg.sessions ?? []) as Array<string | { id?: string; turnActive?: boolean }>;
        this.liveIds = list
          .map((s) => (typeof s === "string" ? s : String(s?.id ?? "")))
          .filter(Boolean);
        this.turns = new Map(
          list
            .filter((s): s is { id: string; turnActive?: boolean } => typeof s === "object" && s !== null && Boolean(s.id))
            .map((s) => [String(s.id), Boolean(s.turnActive)]),
        );
        this.emit("snapshot", msg);
        return;
      }
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
        this.deployState = msg as unknown as DeployState;
        this.emit("deploy-state", this.deployState);
        return;
      case "host-stale":
        this.hostStale = Boolean(msg.stale);
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
        this.settle(String(msg.rid), (e) => {
          const reason = String(msg.reason ?? "失败");
          // failType 不是装饰：应答类型和调用方等的那一种对不上时要说出来，否则一个发错的
          // 失败帧会被当成正常拒绝，调用方看到的理由是别人的。
          e.reject(new Error(e.failType === msg.t ? reason : `壳回了 ${msg.t}，调用方等的是 ${e.failType}：${reason}`));
        });
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
