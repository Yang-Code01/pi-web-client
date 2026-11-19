import fs from "node:fs";
import { statePath } from "./config.ts";
import type { Entry } from "./history.ts";

/** 一条待投递的消息。落盘是为了「bridge 重启后还能补」——进程是会被父进程重启的。 */
export interface Queued {
  id: string;
  peerId: string;
  addr: string;
  port: number;
  /** 信封类型：`text` 要收据，好友/快捷/撤回这些控制消息不要。 */
  kind: "text" | "note" | "friend-request" | "friend-accept" | "friend-quick" | "recall";
  /** text 时是整条 Entry，其余是控制消息体。 */
  payload: unknown;
  at: number;
  tries: number;
  nextAt: number;
  /** 上一次没送到的原因（原样留着，页面拿来解释「为什么还在这条上打转」）。 */
  lastError?: string;
}

/** 对端明确说「以后也别试了」就扔；只有超时 / 配额 / IP 漂移这类才值得重试（决定 21/22）。 */
export type Verdict = { ok: true } | { ok: false; retryable: boolean; error: string };

const EXPIRE_MS = 24 * 3600_000;
const FLUSH_MS = 5000;

export class Outbox {
  private items: Queued[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  /** flush 跑着的时候又有人要 flush（新消息 / 立即重试）：跑完这轮立刻再来一轮，不等 5 秒定时器。 */
  private again = false;

  constructor(
    private readonly opts: {
      log: (msg: string) => void;
      deliver: (item: Queued) => Promise<Verdict>;
      settled: (item: Queued, verdict: Verdict) => void;
      /**
       * 投递前按 nodeId 现查对端地址。入队时记下的 `addr`/`port` 只是当时的快照：
       * 对端离线期间换了 IP（DHCP / Wi-Fi 与网线切换）或换了端口，不现查就会对着旧地址
       * 重试整整 24 小时。查不到（已经从在线表里掉出去）就沿用快照。
       */
      locate?: (peerId: string) => { addr: string; port: number } | null;
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

  /** 按 id 去重：重发（P2）拿的是同一条消息的同一个 id，重复入队只会投两遍。 */
  add(item: Queued): void {
    if (this.items.some((other) => other.id === item.id)) return;
    // 同一个人前面还有在退避的：新消息要排在它们后面（保序），所以顺手让队头现在就试，
    // 否则新消息得陪着等最多 60 秒。
    for (const other of this.items) if (other.peerId === item.peerId) other.nextAt = 0;
    this.items.push(item);
    this.save();
    void this.flush();
  }

  has(id: string): boolean {
    return this.items.some((item) => item.id === id);
  }

  /**
   * 某个会话里还没送到的消息：页面据此把气泡画成「发送中」。
   *
   * 不只是一个 id 集合 —— `tries` / `lastError` 一起交出去，否则「发送中」永远说不出
   * 自己卡在哪（真事：对端防火墙挡了 7865，气泡能显示一整天「发送中…」）。
   */
  pendingFor(peerId: string): Queued[] {
    return this.items.filter((item) => item.peerId === peerId);
  }

  /**
   * 「立即重试」：把下一次尝试提前到现在。
   *
   * 已经在排队的那条不能再 `add()` 一次（按 id 去重，什么都不会发生 —— 用户点了会觉得
   * 按钮坏了），所以由这里直接改 `nextAt` 并踢一脚 flush。返回 false = 它已经不在队列里。
   */
  nudge(id: string): boolean {
    const item = this.items.find((other) => other.id === id);
    if (!item) return false;
    // 同一个人的队列是串行的：只提前这一条，队头还在退避就等于没点。
    for (const other of this.items) if (other.peerId === item.peerId) other.nextAt = 0;
    this.save();
    void this.flush();
    return true;
  }

  pending(): Queued[] {
    return [...this.items];
  }

  /**
   * 投递：**同一个人串行、不同的人并行**。
   *
   * - 同一个人的队列里，前一条没送到（可重试的失败 / 还在退避）就停在这儿，后面的不越过它：
   *   以前是「跳过它接着投下一条」，第一次联系时第 1 条吃一个 409、第 2 条却送到了，
   *   对方看到的顺序就颠倒了（接收方按到达顺序追加）。
   * - 不同的人互不等：一个连不上的人每条都要白等 4 秒超时，以前全局串行时会把发给在线的人的
   *   消息一起拖住。
   */
  async flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.again = false;
        const queues = new Map<string, Queued[]>();
        for (const item of this.items) {
          const queue = queues.get(item.peerId);
          if (queue) queue.push(item);
          else queues.set(item.peerId, [item]);
        }
        await Promise.all([...queues.values()].map((queue) => this.flushPeer(queue)));
      } while (this.again);
    } finally {
      this.flushing = false;
    }
  }

  private async flushPeer(queue: Queued[]): Promise<void> {
    for (const item of queue) {
      const now = Date.now();
      if (now - item.at > EXPIRE_MS) {
        this.settle(item, { ok: false, retryable: false, error: "超过 24 小时没送到" });
        continue;
      }
      // 队头还在退避：后面的陪它等（保序）。
      if (now < item.nextAt) return;
      const live = this.opts.locate?.(item.peerId);
      if (live && (live.addr !== item.addr || live.port !== item.port)) {
        this.opts.log(`改投 ${item.id.slice(0, 8)}：${item.addr}:${item.port} → ${live.addr}:${live.port}`);
        item.addr = live.addr;
        item.port = live.port;
        this.save();
      }
      const verdict = await this.opts.deliver(item);
      if (verdict.ok || !verdict.retryable) {
        this.settle(item, verdict);
        continue;
      }
      item.tries += 1;
      item.lastError = verdict.error;
      item.nextAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(item.tries, 6));
      this.opts.log(`再投 ${item.id.slice(0, 8)} → ${item.addr}:${item.port} 第 ${item.tries} 次：${verdict.error}`);
      this.save();
      return;
    }
  }

  private settle(item: Queued, verdict: Verdict): void {
    this.items = this.items.filter((other) => other.id !== item.id);
    this.save();
    this.opts.settled(item, verdict);
  }
}
