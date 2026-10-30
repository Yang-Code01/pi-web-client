import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./paths.ts";

export interface RpcSpawnOptions {
  cli: string;
  args: string[];
  cwd: string;
  logPath: string;
  env?: Record<string, string | undefined>;
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

  constructor(private opts: RpcSpawnOptions) {
    super();
  }

  get alive(): boolean {
    return this._alive;
  }

  start(): void {
    ensureDir(path.dirname(this.opts.logPath));
    this.log = fs.createWriteStream(this.opts.logPath, { flags: "a" });
    this.log.write(`\n===== ${new Date().toISOString()} spawn =====\n`);

    const child = spawn(process.execPath, [this.opts.cli, ...this.opts.args], {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.opts.env },
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

  private finish(reason: string): void {
    if (!this._alive) return;
    this._alive = false;
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
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("log", `non-JSON stdout line: ${line.slice(0, 200)}`);
        continue;
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
  }

  /**
   * Write one JSON line to the child. Returns false instead of throwing when the child is gone
   * or its stdin already ended — a dying pi can still deliver a ui_request, and answering it must
   * never be able to kill the process that serves every other session.
   */
  private write(obj: unknown): boolean {
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
    try {
      this.child?.kill();
    } catch {
      /* ignore */
    }
  }
}
