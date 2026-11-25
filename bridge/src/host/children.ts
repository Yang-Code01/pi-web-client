/**
 * 壳手里的会话进程：pi 的三根管道。
 *
 * 这里只做「把字节搬来搬去」，不认识 pi 的协议 —— 协议归脑解释（`rpc.ts`）。这样换脑
 * 时管道不用动，会话进程的 pid 也就不变；崩掉的脑只是暂时没人解释，进程还在跑（D385）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Broker } from "./broker.ts";

export interface SpawnSpec {
  sessionId: string;
  /** 完整 argv（argv[0] 是入口脚本，解释器是本进程的 node）。 */
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ChildHooks {
  line(sessionId: string, seq: number, line: string): void;
  stderr(sessionId: string, text: string): void;
  exit(sessionId: string, code: number | null, signal: NodeJS.Signals | null): void;
}

export class Children {
  private readonly broker: Broker;
  private readonly hooks: ChildHooks;
  private readonly procs = new Map<string, ChildProcessWithoutNullStreams>();
  /** 每个会话最后一次的退出情况：换脑窗口里死掉的进程，新脑 attach 时得知道。 */
  private readonly exits = new Map<string, { code: number | null; signal: NodeJS.Signals | null; at: number }>();
  /** 脑缺席时收到的 stderr：不存下来的话，换脑后就再也看不到它了。 */
  private readonly errs = new Map<string, { text: string; at: number }>();

  constructor(broker: Broker, hooks: ChildHooks) {
    this.broker = broker;
    this.hooks = hooks;
  }

  spawn(spec: SpawnSpec): number {
    if (this.procs.has(spec.sessionId)) throw new Error(`会话 ${spec.sessionId} 已经有进程在跑`);
    const child = spawn(process.execPath, spec.argv, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // 先接事件再判 pid：spawn 失败只发 'error'，不接就是未捕获异常。
    child.stdout.on("data", (chunk: Buffer) => {
      for (const { seq, line } of this.broker.push(spec.sessionId, chunk)) {
        this.hooks.line(spec.sessionId, seq, line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      // 只留尾巴：接不上脑的时候也能在 attach 里把这几十行带过去。
      const prev = this.errs.get(spec.sessionId)?.text ?? "";
      this.errs.set(spec.sessionId, { text: (prev + text).slice(-4000), at: Date.now() });
      this.hooks.stderr(spec.sessionId, text);
    });
    // 与 rpc.ts 同一条教训：写一个已经死掉的 stdin 会抛 ERR_STREAM_WRITE_AFTER_END，
    // 不接住就把整个壳带走。
    child.stdin.on("error", () => {});
    child.on("error", (err) => this.hooks.stderr(spec.sessionId, `spawn: ${String(err)}\n`));
    child.on("exit", (code, signal) => {
      // spawn 没起来时没有进程，也没有会话；别把一次失败当成会话退出广播出去。
      if (this.procs.get(spec.sessionId) !== child) return;
      this.procs.delete(spec.sessionId);
      this.exits.set(spec.sessionId, { code, signal, at: Date.now() });
      // 还留着未确认的行：进程没了，这些行也回放不出更多东西了，但已经吐出来的不能丢。
      this.hooks.exit(spec.sessionId, code, signal);
    });
    if (!child.pid) {
      // 没有 pid 就没有进程；到这里才写 broker，失败路径不会留下一条空的「已有会话」。
      throw new Error("pi 进程没起来");
    }
    // 这是同一会话的新一代进程：上一次的退出码/旧 stderr 不能跟着新 pid 一起交给 attach，
    // 否则调用方会把正在跑的新会话误判成「已经退出」。
    this.exits.delete(spec.sessionId);
    this.errs.delete(spec.sessionId);
    this.broker.attach(spec.sessionId);
    this.procs.set(spec.sessionId, child);
    return child.pid;
  }

  has(sessionId: string): boolean {
    return this.procs.has(sessionId);
  }

  pid(sessionId: string): number | null {
    return this.procs.get(sessionId)?.pid ?? null;
  }

  /** 这个会话上一次退出是什么时候、什么码（没有就 null）。 */
  lastExit(sessionId: string): { code: number | null; signal: NodeJS.Signals | null; at: number } | null {
    return this.exits.get(sessionId) ?? null;
  }

  /** 这个会话最近的 stderr 尾巴（没脑接的时段也能补给人看）。 */
  lastStderr(sessionId: string): string | null {
    return this.errs.get(sessionId)?.text ?? null;
  }

  pids(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, child] of this.procs) if (child.pid) out[id] = child.pid;
    return out;
  }

  /** 往 pi 的 stdin 写一帧（不含换行，由这里补）。管道断了返回 false，调用方负责报出来。 */
  write(sessionId: string, frame: string): boolean {
    const child = this.procs.get(sessionId);
    if (!child?.stdin.writable) return false;
    try {
      child.stdin.write(frame + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** 优雅收：关 stdin，pi 会自己退出（rpc 模式的正常收尾路径）。 */
  end(sessionId: string): void {
    const child = this.procs.get(sessionId);
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* 已经断了 */
    }
  }

  kill(sessionId: string, now: boolean): void {
    const child = this.procs.get(sessionId);
    if (!child) return;
    try {
      if (now) child.kill();
      else {
        child.stdin.end();
        setTimeout(() => {
          if (!child.killed) child.kill();
        }, 1500).unref();
      }
    } catch {
      /* 已经退了 */
    }
  }

  killAll(): void {
    for (const id of [...this.procs.keys()]) this.kill(id, true);
  }
}
