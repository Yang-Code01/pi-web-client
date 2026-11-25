import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { BrainLink } from "./brainlink.ts";
import { ensureDir, piChildEnv } from "./paths.ts";

/** 认领落地前最多攒这么多帧；超过就结算整条链路，别让一个挂着的 attach 把内存拖爆。 */
const LINK_PENDING_MAX_FRAMES = 4096;
const LINK_PENDING_MAX_BYTES = 8 * 1024 * 1024;

export interface RpcSpawnOptions {
  cli: string;
  args: string[];
  cwd: string;
  logPath: string;
  env?: Record<string, string | undefined>;
  /** 会话 id：有壳时用它认领管道（`spawn` / `attach` / `stdin` 都要带）。 */
  sessionId?: string;
  /** 有壳时非空：进程由壳 spawn、管道由壳持有，这里只说话。 */
  link?: BrainLink | null;
  /**
   * 只接管壳里现成的子进程，**不许新开**（换脑后接管在跑的会话）。壳里没有就算失败：
   * 不能像发消息那样顺手拉起一个新的 pi —— 那会让同一条会话多出两个写者。
   */
  adoptOnly?: boolean;
}

export interface RpcResponse {
  type: "response";
  command: string;
  success: boolean;
  id?: string;
  data?: any;
  error?: string;
}

/**
 * Minimal pi RPC client.
 *
 * pi's own RpcClient can't be used here: its private send() does
 * `{...command, id: 'req_N'}`, which overwrites the id we must echo back for
 * `extension_ui_response` (approval answers). Framing rules per docs/rpc.md:
 * split on \n, strip a trailing \r, never use readline (it splits on U+2028/2029).
 */
export class RpcChild extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private log: fs.WriteStream | null = null;
  private _alive = false;
  private stderrBuf = "";
  /** 有壳时：pid 来自壳的 spawn/attach，进程不是这里生的。 */
  private viaPid: number | null = null;
  private detachLink: (() => void) | null = null;
  /** 有壳时：attach/spawn 还没落地前收到的帧先排这里，认领之后按顺序交给壳。 */
  private linkClaimed = false;
  private linkPending: string[] = [];
  private linkPendingBytes = 0;
  /** 认领的最终结果：adopt() 要等它落地才敢说「接管了」。成功/失败都 resolve，避免没人接的 rejection。 */
  private linkResult: Promise<{ pid: number } | { error: Error }> | null = null;
  private settleLink: ((v: { pid: number } | { error: Error }) => void) | null = null;
  private readonly sessionId: string;

  private opts: RpcSpawnOptions;

  constructor(opts: RpcSpawnOptions) {
    super();
    this.opts = opts;
    this.sessionId = opts.sessionId ?? "";
  }

  get alive(): boolean {
    return this._alive;
  }

  /**
   * 等壳里的进程真正认领完（adopt 用）。成功给 pid，失败给原因；不 reject，
   * 因为 startLive() 那条路没人等它，未处理的 rejection 会变成进程级告警。
   */
  whenLinked(): Promise<{ pid: number } | { error: Error }> {
    return this.linkResult ?? Promise.resolve({ error: new Error("这个进程没有走壳") });
  }

  /**
   * The child's own pid, while it is alive. The runtime panel samples memory with these and only
   * these numbers (D120 §2) — matching a parent process or a process name guesses at who we mean.
   */
  get pid(): number | null {
    return this._alive ? (this.child?.pid ?? this.viaPid) : null;
  }

  start(): void {
    ensureDir(path.dirname(this.opts.logPath));
    this.log = fs.createWriteStream(this.opts.logPath, { flags: "a" });
    this.log.write(`\n===== ${new Date().toISOString()} spawn =====\n`);

    if (this.opts.link && this.sessionId) {
      this.startLinked(this.opts.link, this.sessionId);
      return;
    }

    const child = spawn(process.execPath, [this.opts.cli, ...this.opts.args], {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...piChildEnv(), ...this.opts.env },
      windowsHide: true,
    });
    this.child = child;
    this._alive = true;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuf = (this.stderrBuf + chunk).slice(-4000);
      this.log?.write(chunk);
      this.emit("stderr", chunk);
    });

    // A pi that is mid-exit can still hand us a queued ui_request while its stdin pipe is
    // already closed. Writing into that pipe emits 'error' (ERR_STREAM_WRITE_AFTER_END) on the
    // socket; with no listener here it becomes an uncaught exception and takes the whole bridge
    // down — which is exactly how the 7864 server died. Swallow it and retire the child.
    child.stdin.on("error", (err: Error) => {
      this.emit("log", `stdin: ${err.message}`);
      this.finish(`stdin: ${err.message}`);
    });

    child.on("error", (err) => {
      this.failAll(new Error(`pi process error: ${err.message}`));
      this.finish(`error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      const tail = this.stderrBuf.trim().split("\n").slice(-6).join("\n");
      this.finish(`exit code=${code} signal=${signal}${tail ? `\n${tail}` : ""}`);
    });
  }

  /**
   * 有壳时的启动：进程由壳 spawn（或早就活着、只是换了个脑来认领），管道也在壳手里。
   * 这里只做三件事：认领、把壳留着的未确认行喂进来、之后每行处理完回 ack。
   */
  private startLinked(link: BrainLink, sessionId: string): void {
    this._alive = true;
    this.linkClaimed = false;
    this.linkResult = new Promise((resolve) => {
      this.settleLink = resolve;
    });
    this.detachLink = link.watch(sessionId, {
      line: (line, seq) => {
        this.handleLine(line);
        // 处理完才 ack：壳据此判断哪一帧可以不用再交给下一个脑。
        if (seq > 0) link.ack(sessionId, seq);
      },
      stderr: (text) => {
        this.stderrBuf = (this.stderrBuf + text).slice(-4000);
        this.log?.write(text);
        this.emit("stderr", text);
      },
      exit: (reason) => this.finish(reason),
    });
    void this.claimChild(link, sessionId);
  }

  private async claimChild(link: BrainLink, sessionId: string): Promise<void> {
    try {
      let pid: number;
      try {
        const got = await link.attachSession(sessionId);
        pid = got.pid;
        // 先喂旧行再算命：新脑看到的是「上一个人没承认过的那一段」，不多不少。
        for (const { line, seq } of got.pending.lines) {
          this.handleLine(line);
          if (seq > 0) link.ack(sessionId, seq);
        }
        if (got.pending.overflowed) {
          this.emit("log", "换脑时未确认的行超过 8 MB，这一段交给上层从会话文件补齐");
        }
        // 换脑窗口里进程若已退出 / 吐过错误，新脑得看到，不能装作一切正常。
        if (got.lastExit) {
          this.emit("log", `attach: 这个会话的进程已经退出（${got.lastExit.code ?? got.lastExit.signal}）`);
        }
        if (got.lastStderr) this.emit("log", `attach: 最近的 stderr：\n${got.lastStderr.slice(-800)}`);
        // 换脑前还挂着的问卷 / 审批：当它刚发过来一样重放 —— 页面那张表单接着能答（D385）。
        // 不重放的话，用户眼前是一张永远交不出去的问卷，pi 那边还在等这个 id 的回答。
        for (const line of got.pendingUi ?? []) this.handleLine(line);
      } catch (err) {
        // 只有「壳那边没有这个会话的子进程」才该新开；其余（超时、壳拒绝）保持原样失败。
        if ((err as Error).message !== "no-child") throw err;
        // 接管（换脑后的 adopt）不许顺手新开：壳里没有就是没有，拉起第二个 pi 会让同一条会话
        // 多出一个写者（DECISIONS 里那条「一个会话文件同一时刻只有一个写者」）。
        if (this.opts.adoptOnly) throw err;
        const got = await link.spawnSession({
          sessionId,
          argv: [this.opts.cli, ...this.opts.args],
          cwd: this.opts.cwd,
          env: { ...piChildEnv(), ...this.opts.env } as Record<string, string>,
        });
        pid = got.pid;
      }
      this.viaPid = pid;
      // 认领完成前写的是「attach 变 no-child、spawn 还没发出」这段窗口：直接发会被壳回
      // stale-owner，BrainLink 没人为它重试，get_state / prompt 就这样静默丢了。现在按序补发。
      this.linkClaimed = true;
      // 不要 splice 了再发：stdin 半路失败时，剩下的帧会被移出队列却没送出去，而 _alive 还是
      // true，上层的请求只能干等超时。逐帧出队，发不出去就让 finish() 结算所有等待者。
      while (this.linkPending.length) {
        if (!this._alive) return;
        const frame = this.linkPending[0];
        if (!link.stdin(sessionId, frame)) {
          this.finish("link: 认领后补发失败");
          return;
        }
        this.linkPending.shift();
        this.linkPendingBytes -= Buffer.byteLength(frame);
      }
      this.settleLink?.({ pid });
      this.settleLink = null;
    } catch (err) {
      this.finish(`link: ${(err as Error).message}`);
    }
  }

  private finish(reason: string): void {
    if (!this._alive) return;
    this._alive = false;
    this.linkClaimed = false;
    this.linkPending = [];
    this.linkPendingBytes = 0;
    this.settleLink?.({ error: new Error(reason) });
    this.settleLink = null;
    this.detachLink?.();
    this.detachLink = null;
    this.failAll(new Error(`pi process ended (${reason})`));
    this.log?.write(`\n===== ended: ${reason} =====\n`);
    this.log?.end();
    this.emit("exit", reason);
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("log", `non-JSON stdout line: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.type === "response") {
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.success) p.resolve(msg.data);
        else p.reject(new Error(msg.error || `command failed: ${msg.command}`));
      } else {
        this.emit("response", msg);
      }
    } else if (msg.type === "extension_ui_request") {
      this.emit("ui_request", msg);
    } else {
      this.emit("event", msg);
    }
  }

  /**
   * Write one JSON line to the child. Returns false instead of throwing when the child is gone
   * or its stdin already ended — a dying pi can still deliver a ui_request, and answering it must
   * never be able to kill the process that serves every other session.
   */
  private write(obj: unknown): boolean {
    if (this.opts.link && this.sessionId) {
      if (!this._alive) return false;
      const frame = JSON.stringify(obj) + "\n";
      // 认领之前先攒着：壳还没把这个会话的管道交给本脑，此时直接发只会收到 stale-owner。
      if (!this.linkClaimed) {
        const bytes = Buffer.byteLength(frame);
        if (
          this.linkPending.length >= LINK_PENDING_MAX_FRAMES ||
          this.linkPendingBytes + bytes > LINK_PENDING_MAX_BYTES
        ) {
          // attach 有 15s 超时，本来不会永久挂；但积压本身没有上限。超限时立刻结算，
          // 让 abort / 表单响应这类帧的等待者拿到明确错误，而不是在队列里无限排队。
          this.finish("link: 认领前积压的帧太多");
          return false;
        }
        this.linkPending.push(frame);
        this.linkPendingBytes += bytes;
        return true;
      }
      return this.opts.link.stdin(this.sessionId, frame);
    }
    const stdin = this.child?.stdin;
    if (!stdin || !this._alive) return false;
    if (stdin.destroyed || stdin.writableEnded || !stdin.writable) return false;
    try {
      stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch (err) {
      this.emit("log", `stdin write failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Send a command and wait for its response. */
  request<T = any>(command: string, payload: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: any) => void, reject, timer });
      try {
        if (!this.write({ ...payload, type: command, id })) throw new Error("pi process is not running");
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  /** Send a command without waiting (used for abort, which can stall behind a dialog). */
  fire(command: string, payload: Record<string, unknown> = {}): boolean {
    return this.write({ ...payload, type: command, id: `r${++this.seq}` });
  }

  /** Answer an extension_ui_request, echoing the server-generated id. Never throws. */
  uiRespond(resp: { id: string; confirmed?: boolean; value?: string; cancelled?: boolean }): boolean {
    return this.write({ type: "extension_ui_response", ...resp });
  }

  kill(): void {
    if (this.opts.link && this.sessionId) {
      if (this._alive) this.opts.link.kill(this.sessionId, "end");
      return;
    }
    const child = this.child;
    if (!child || !this._alive) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 1500);
    t.unref?.();
    child.once("exit", () => clearTimeout(t));
  }

  killNow(): void {
    if (this.opts.link && this.sessionId) {
      this.opts.link.kill(this.sessionId, "now");
      return;
    }
    try {
      this.child?.kill();
    } catch {
      /* ignore */
    }
  }
}
