import { randomBytes } from "node:crypto";
import os from "node:os";
import type { PeerConfig } from "./config.ts";
import { PROTO, VERSION } from "./config.ts";
import type { Discovery } from "./discovery.ts";
import type { Entry, History, PeerIdentity } from "./history.ts";
import type { Outbox, Queued, Verdict } from "./outbox.ts";

/** 单条文本上限（决定 25）：再长就让用户改发文件，协议这边硬拒 32 KB。 */
export const MAX_TEXT_BYTES = 32 * 1024;

/** uuidv7：前 48 位是毫秒时间戳，所以同一毫秒内的多条也能保持发送顺序。 */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `::ffff:192.168.1.7` 与 `192.168.1.7` 是同一台机器，比较前先归一。 */
function normAddr(addr: string): string {
  return addr.replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");
}

export interface InboxResult {
  status: number;
  body: unknown;
}

/**
 * 1:1 文字的收发（第 2 片）。
 *
 * 两个方向的入口都在这里：
 * - `send()` 由本机页面 / 第 5 片的 pi 工具调用（回环）；
 * - `accept()` 由局域网里的对端 POST `/peer/inbox` 调用。
 */
export class Messages {
  constructor(
    private readonly ctx: {
      cfg: PeerConfig;
      nodeId: string;
      discovery: Discovery;
      history: History;
      outbox: Outbox | null;
      log: (msg: string) => void;
    },
  ) {}

  /** outbox 的 `deliver` 反过来要调本类，所以两边只能先建后接。 */
  attachOutbox(outbox: Outbox): void {
    this.ctx.outbox = outbox;
  }

  private me(): PeerIdentity {
    return { nodeId: this.ctx.nodeId, nickname: this.ctx.cfg.nickname, hostname: os.hostname(), port: this.ctx.cfg.port };
  }

  private entry(id: string, at: number, from: PeerIdentity, to: string, kind: Entry["kind"], extra: Partial<Entry> = {}): Entry {
    return { id, at, from, to: { kind: "node", id: to }, kind, ...extra };
  }

  /** 本机发出：先落历史（bubble 立刻出现），再进 outbox 补投。`retryable` 的失败不在这里发生。 */
  send(peerId: string, text: string): { ok: true; id: string; at: number } {
    const trimmed = text.replace(/\s+$/, "");
    if (!trimmed.trim()) throw new Error("空消息");
    const bytes = Buffer.byteLength(trimmed, "utf8");
    if (bytes > MAX_TEXT_BYTES) {
      throw new Error(`太长（${Math.round(bytes / 1024)} KB，上限 32 KB）：改用文件发`);
    }
    const peer = this.ctx.discovery.byId(peerId);
    if (!peer) throw new Error("这个人已经不在线了：刷新在线列表再试");
    const at = Date.now();
    const id = uuidv7(at);
    const entry = this.entry(id, at, this.me(), peerId, "text", { text: trimmed });
    this.ctx.history.append(peerId, entry);
    const item: Queued = { id, peerId, addr: peer.addr, port: peer.port, entry, at, tries: 0, nextAt: 0 };
    const outbox = this.ctx.outbox;
    if (!outbox) throw new Error("outbox 还没准备好");
    outbox.add(item);
    return { ok: true, id, at };
  }

  /** outbox 的投递器：一次 HTTP POST，4xx 里带 `retryable` 决定「等 24 小时」还是「立刻红」。 */
  async deliver(item: Queued): Promise<Verdict> {
    try {
      const res = await fetch(`http://${item.addr}:${item.port}/peer/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proto: PROTO, kind: "text", message: item.entry }),
        signal: AbortSignal.timeout(4000),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; retryable?: boolean };
      if (res.ok) return { ok: true };
      return { ok: false, retryable: body.retryable !== false, error: body.error ?? `HTTP ${res.status}` };
    } catch (err) {
      // 连不上（对端关了 / 换了 IP）先当可重试：24 小时内他再上线还能补到。
      return { ok: false, retryable: true, error: (err as Error).message };
    }
  }

  /** 收到对端的 inbox 请求。返回 HTTP 状态 + body，由 http 层原样吐出去。 */
  async accept(fromAddr: string, body: any): Promise<InboxResult> {
    if (body?.proto !== PROTO) return { status: 400, body: { error: `proto 不匹配（我这边 ${PROTO}）`, retryable: false } };
    const kind = String(body.kind ?? "");
    if (kind === "text") return this.acceptText(fromAddr, body.message);
    if (kind === "receipt") return this.acceptReceipt(body.receipt);
    return { status: 400, body: { error: "unknown kind", retryable: false } };
  }

  private async acceptText(fromAddr: string, message: any): Promise<InboxResult> {
    const id = String(message?.id ?? "");
    const text = typeof message?.text === "string" ? message.text : "";
    const claimed = message?.from as PeerIdentity | undefined;
    if (!id || !claimed?.nodeId || !text) return { status: 400, body: { error: "bad message", retryable: false } };
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) return { status: 413, body: { error: "太长", retryable: false } };

    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;

    const seen = this.ctx.history.recentIds(claimed.nodeId, 2000);
    if (seen.has(id)) return { status: 200, body: { ok: true, dup: true } };

    const at = Number(message?.at) || Date.now();
    this.ctx.history.append(claimed.nodeId, this.entry(id, at, claimed, this.ctx.nodeId, "text", { text }));
    this.ctx.log(`收到 ${claimed.nickname || claimed.nodeId.slice(0, 8)} 的消息（${Buffer.byteLength(text, "utf8")} 字节）`);
    return { status: 200, body: { ok: true, id } };
  }

  private acceptReceipt(receipt: any): InboxResult {
    const id = String(receipt?.id ?? "");
    const ackId = String(receipt?.ack?.id ?? "");
    if (!id || !ackId) return { status: 400, body: { error: "bad receipt", retryable: false } };
    const status = receipt.ack.status === "failed" ? "failed" : "delivered";
    this.ctx.log(`回执 ${ackId.slice(0, 8)} → ${status}`);
    return { status: 200, body: { ok: true } };
  }

  /**
   * 决定 7/10：不看 `from` 里自报什么，看来源 IP 在不在这个 nodeId 的 IP 集合里。
   * 不匹配时不直接判「伪造」——先敲一次 hello 让对方把当前 IP 报上来，还是不对才 409 可重试。
   */
  private async verifySource(fromAddr: string, claimed: PeerIdentity): Promise<InboxResult | null> {
    const addr = normAddr(fromAddr);
    const known = this.ctx.discovery.byId(claimed.nodeId);
    if (!known) {
      // 组播被挡住时，对端可能还没学到我们；敲一次 hello 让他回填我们的地址。
      void this.ctx.discovery.sendHello(addr, Number(claimed.port) || this.ctx.cfg.port);
      return { status: 409, body: { error: "还没学到你（先握个手）", retryable: true } };
    }
    if (known.ips.includes(addr)) return null;
    await this.ctx.discovery.sendHello(addr, Number(claimed.port) || this.ctx.cfg.port);
    const again = this.ctx.discovery.byId(claimed.nodeId);
    if (again?.ips.includes(addr)) return null;
    this.ctx.log(`来源 IP 漂移：${claimed.nickname ?? claimed.nodeId.slice(0, 8)} 说自己是 ${addr}，但记着 ${known.ips.join(",")}`);
    return { status: 409, body: { error: "来源 IP 对不上，重试看看", retryable: true } };
  }

  version(): string {
    return VERSION;
  }
}
