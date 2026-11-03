import fs from "node:fs";
import { statePath } from "./config.ts";
import type { Entry } from "./history.ts";

/** 一条待投递的消息。落盘是为了「bridge 重启后还能补」——进程是会被父进程重启的。 */
export interface Queued {
  id: string;
  peerId: string;
  addr: string;
  port: number;
  /** 信封类型：`text` 要收据，好友请求/接受不要。 */
  kind: "text" | "friend-request" | "friend-accept";
  /** text 时是整条 Entry，其余是控制消息体。 */
  payload: unknown;
  at: number;
  tries: number;
  nextAt: number;
}

/** 对端明确说「以后也别试了」就扔；只有超时 / 配额 / IP 漂移这类才值得重试（决定 21/22）。 */
export type Verdict = { ok: true } | { ok: false; retryable: boolean; error: string };

const EXPIRE_MS = 24 * 3600_000;
const FLUSH_MS = 5000;

export class Outbox {
  private items: Queued[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(
    private readonly opts: {
      log: (msg: string) => void;
      deliver: (item: Queued) => Promise<Verdict>;
      settled: (item: Queued, verdict: Verdict) => void;
    },
  ) {
    this.load();
  }

  private file(): string {
    return statePath("outbox.json");
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as Array<Queued & { entry?: Entry }>;
      this.items = Array.isArray(raw)
        ? raw
            .filter((item) => item && item.id && (item.payload || item.entry))
            .map((item) => (item.payload ? item : { ...item, kind: "text" as const, payload: item.entry }))
        : [];
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file(), JSON.stringify(this.items));
    } catch (err) {
      this.opts.log(`outbox 落盘失败：${(err as Error).message}`);
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    void this.flush();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  add(item: Queued): void {
    this.items.push(item);
    this.save();
    void this.flush();
  }

  pending(): Queued[] {
    return [...this.items];
  }

  /** 串行投递：局域网里几条消息并发没收益，串行还能保证顺序。 */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const now = Date.now();
      for (const item of [...this.items]) {
        if (now < item.nextAt) continue;
        if (now - item.at > EXPIRE_MS) {
          this.settle(item, { ok: false, retryable: false, error: "超过 24 小时没送到" });
          continue;
        }
        const verdict = await this.opts.deliver(item);
        if (verdict.ok) {
          this.settle(item, verdict);
          continue;
        }
        if (!verdict.retryable) {
          this.settle(item, verdict);
          continue;
        }
        item.tries += 1;
        item.nextAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(item.tries, 6));
        this.opts.log(`再投 ${item.id.slice(0, 8)} → ${item.addr}:${item.port} 第 ${item.tries} 次：${verdict.error}`);
        this.save();
      }
    } finally {
      this.flushing = false;
    }
  }

  private settle(item: Queued, verdict: Verdict): void {
    this.items = this.items.filter((other) => other.id !== item.id);
    this.save();
    this.opts.settled(item, verdict);
  }
}
