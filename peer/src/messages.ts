import { randomBytes } from "node:crypto";
import os from "node:os";
import type { PeerConfig } from "./config.ts";
import { PROTO, VERSION } from "./config.ts";
import type { Discovery } from "./discovery.ts";
import { foldEntries, type Entry, type History, type NotePayload, type PeerIdentity, type ViewEntry } from "./history.ts";
import { normalizeNote } from "./note.ts";
import type { Outbox, Queued, Verdict } from "./outbox.ts";
import type { Relations } from "./peers.ts";

/** 单条文本上限（决定 25）：再长就让用户改发文件，协议这边硬拒 32 KB。 */
export const MAX_TEXT_BYTES = 32 * 1024;

/**
 * 撤回窗口 2 分钟（D299 / P3，与 QQ 单聊一致）。
 *
 * 超过就**在发送侧直接拒**，不进补投：对端离线半小时后收到一条「撤回」，那条消息他
 * 可能早就看过了，撤回已经没有意义，还会把「消息」和「撤回」的时间顺序拧乱。
 */
export const RECALL_MS = 120_000;

/** 输入中：3 秒没再敲就当停了（心跳 2 秒一次，丢一包也不会闪）。 */
export const TYPING_MS = 3000;
const TYPING_SEND_MS = 1500;

/** uuidv7：前 48 位是毫秒时间戳，所以跨毫秒天然有序；同一毫秒内剩余位是随机的，不保证先后。 */
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

/**
 * fetch 失败时要往 `cause` 里看一层：Node 只把 `fetch failed` 摆在最外面，
 * 真正的原因（`connect ECONNREFUSED 127.0.0.1:7865` / `getaddrinfo ENOTFOUND`）在 cause 上。
 * 页面要把这句翻成人话（D325），所以这里就要给出有用的那句，而不是「fetch failed」。
 */
function why(err: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let cur = err as { message?: unknown; code?: unknown; cause?: unknown } | undefined;
  while (cur && typeof cur === "object" && !seen.has(cur) && parts.length < 3) {
    seen.add(cur);
    const msg = typeof cur.message === "string" ? cur.message : "";
    const code = typeof cur.code === "string" ? cur.code : "";
    // 外层那句「fetch failed」没有信息量，有 cause 时丢掉它。
    const noise = !code && /^fetch failed$/i.test(msg) && Boolean(cur.cause);
    if (!noise) parts.push(code && !msg.includes(code) ? `${code}: ${msg}` : msg || code);
    cur = cur.cause as typeof cur;
  }
  return parts.join(" ← ") || "fetch failed";
}

/** `::ffff:192.168.1.7` 与 `192.168.1.7` 是同一台机器，比较前先归一。 */
function normAddr(addr: string): string {
  return addr.replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");
}

export interface InboxResult {
  status: number;
  body: unknown;
}

export type ControlKind = "friend-request" | "friend-accept" | "friend-quick" | "recall";

/**
 * 1:1 文字的收发（第 2 片）+ 控制面（第 3 片：撤回 / 输入中）。
 *
 * 两个方向的入口都在这里：
 * - `send()` 由本机页面 / 第 5 片的 pi 工具调用（回环）；
 * - `accept()` 由局域网里的对端 POST `/peer/inbox` 调用。
 */
export class Messages {
  /** 对方正在输入：只放内存，进程重启就清空（一条心跳本来也只活 3 秒）。 */
  private readonly typingUntil = new Map<string, number>();
  private readonly typingSentAt = new Map<string, number>();

  constructor(
    private readonly ctx: {
      cfg: PeerConfig;
      nodeId: string;
      discovery: Discovery;
      history: History;
      outbox: Outbox | null;
      relations: Relations;
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
  /** 发一条记录包：正文 + 截图清单走 inbox，截图本体随后逐张走文件通道（#507）。 */
  sendNote(peerId: string, raw: unknown): { ok: true; id: string; at: number; seq: number } {
    const note = normalizeNote(raw);
    const peer = this.ctx.discovery.byId(peerId);
    if (!peer) throw new Error("这个人已经不在线了：刷新在线列表再试");
    const at = Date.now();
    const id = uuidv7(at);
    const seq = this.ctx.history.nextSeq(peerId);
    const entry = this.entry(id, at, this.me(), peerId, "note", { note, seq });
    this.ctx.history.append(peerId, entry);
    const outbox = this.ctx.outbox;
    if (!outbox) throw new Error("outbox 还没准备好");
    outbox.add({ id, peerId, addr: peer.addr, port: peer.port, kind: "note", payload: entry, at, tries: 0, nextAt: 0 });
    return { ok: true, id, at, seq };
  }

  send(peerId: string, text: string, via?: "pi", replyTo?: Entry["replyTo"]): { ok: true; id: string; at: number; seq: number } {
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
    const seq = this.ctx.history.nextSeq(peerId);
    const entry = this.entry(id, at, this.me(), peerId, "text", { text: trimmed, seq, ...(via ? { via } : {}), ...(replyTo ? { replyTo } : {}) });
    this.ctx.history.append(peerId, entry);
    const item: Queued = { id, peerId, addr: peer.addr, port: peer.port, kind: "text", payload: entry, at, tries: 0, nextAt: 0 };
    const outbox = this.ctx.outbox;
    if (!outbox) throw new Error("outbox 还没准备好");
    outbox.add(item);
    return { ok: true, id, at, seq };
  }

  /**
   * 重发（D299 / P2）：拿**同一条消息**再入队一次，不造新消息。
   *
   * 旧版是页面再 `POST /send` 一次（`web/src/peer/main.ts` 的 `resend()`），所以失败一次
   * 重发一次，历史里就多一对气泡。现在 id 不变，Outbox 按 id 去重，历史只有一条。
   */
  retry(peerId: string, id: string): { ok: true } {
    const entry = this.ctx.history.find(peerId, id);
    if (!entry) throw new Error("找不到这条消息");
    if (entry.from.nodeId !== this.ctx.nodeId) throw new Error("不是自己发的，重发不了");
    if (entry.kind !== "text" && entry.kind !== "note") throw new Error("文件重发请从磁盘再选一次");
    const peer = this.ctx.discovery.byId(peerId);
    if (!peer) throw new Error("这个人已经不在线了：等他上线再重发");
    const outbox = this.ctx.outbox;
    if (!outbox) throw new Error("outbox 还没准备好");
    // 还在排队的那条（页面上的「立即重试」）：只把下一次尝试提前。
    // 不能再 `add()` 一次 —— 它按 id 去重，什么也不会发生，用户点完会以为按钮坏了。
    if (outbox.nudge(entry.id)) return { ok: true };
    const kind = entry.kind === "note" ? "note" : "text";
    outbox.add({ id: entry.id, peerId, addr: peer.addr, port: peer.port, kind, payload: entry, at: Date.now(), tries: 0, nextAt: 0 });
    return { ok: true };
  }

  /**
   * 撤回（D299 / P3）：本机先落一条 `kind:"recall"` 的记录（原消息不删），再通知对端。
   *
   * 对端离线时只在本机生效 —— 不做「等他上线再告诉他撤回」：那条消息他可能早就看过了。
   */
  recall(peerId: string, id: string): { ok: true; at: number } {
    const entry = this.ctx.history.find(peerId, id);
    if (!entry) throw new Error("找不到这条消息");
    if (entry.from.nodeId !== this.ctx.nodeId) throw new Error("只能撤回自己发的");
    if (entry.kind !== "text" && entry.kind !== "file") throw new Error("这条撤不回");
    if (this.isRecalled(peerId, id)) throw new Error("已经撤回过了");
    const at = Date.now();
    if (at - entry.at > RECALL_MS) throw new Error("超过撤回时间，不能被撤回");
    this.ctx.history.append(peerId, this.entry(uuidv7(at), at, this.me(), peerId, "recall", { ref: id }));
    const peer = this.ctx.discovery.byId(peerId);
    const outbox = this.ctx.outbox;
    if (peer && outbox) {
      const control = { id: uuidv7(at), at, from: this.me(), target: id };
      outbox.add({ id: control.id, peerId, addr: peer.addr, port: peer.port, kind: "recall", payload: control, at, tries: 0, nextAt: 0 });
    }
    this.ctx.log(`撤回 ${id.slice(0, 8)}${peer ? "" : "（对方不在线：只在本机生效）"}`);
    return { ok: true, at };
  }

  isRecalled(peerId: string, id: string): boolean {
    return this.ctx.history.read(peerId, 2000).some((entry) => entry.kind === "recall" && entry.ref === id);
  }

  /** 输入中：直接 POST，不落盘、不进 outbox —— 一条心跳丢了就丢了。 */
  async sendTyping(peerId: string): Promise<void> {
    const peer = this.ctx.discovery.byId(peerId);
    if (!peer) return;
    const now = Date.now();
    if (now - (this.typingSentAt.get(peerId) ?? 0) < TYPING_SEND_MS) return;
    this.typingSentAt.set(peerId, now);
    try {
      await fetch(`http://${peer.addr}:${peer.port}/peer/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proto: PROTO, kind: "typing", control: { at: now, from: this.me() } }),
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      /* 对端关了 / 旧版本 / 网络抖动：都不值得重试，下一次敲键还会发 */
    }
  }

  typing(peerId: string): boolean {
    const until = this.typingUntil.get(peerId) ?? 0;
    return until > Date.now();
  }

  /** 这个会话里还有没送到的消息（页面拿它画「发送中」）。 */
  pending(peerId: string): boolean {
    return (this.ctx.outbox?.pendingFor(peerId).length ?? 0) > 0;
  }

  /** outbox 的投递器：一次 HTTP POST，4xx 里带 `retryable` 决定「等 24 小时」还是「立刻红」。 */
  async deliver(item: Queued): Promise<Verdict> {
    try {
      const body =
        item.kind === "text"
          ? { proto: PROTO, kind: "text", message: item.payload }
          : { proto: PROTO, kind: item.kind, control: item.payload };
      const res = await fetch(`http://${item.addr}:${item.port}/peer/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      });
      const reply = (await res.json().catch(() => ({}))) as { error?: string; retryable?: boolean };
      if (res.ok) return { ok: true };
      return { ok: false, retryable: reply.retryable !== false, error: reply.error ?? `HTTP ${res.status}` };
    } catch (err) {
      // 连不上（对端关了 / 换了 IP）先当可重试：24 小时内他再上线还能补到。
      return { ok: false, retryable: true, error: why(err) };
    }
  }

  /** 收到对端的 inbox 请求。返回 HTTP 状态 + body，由 http 层原样吐出去。 */
  async accept(fromAddr: string, body: any): Promise<InboxResult> {
    if (body?.proto !== PROTO) return { status: 400, body: { error: `proto 不匹配（我这边 ${PROTO}）`, retryable: false } };
    const kind = String(body.kind ?? "");
    if (kind === "text") return this.acceptText(fromAddr, body.message);
    if (kind === "receipt") return this.acceptReceipt(body.receipt);
    if (kind === "friend-request") return this.acceptFriendRequest(fromAddr, body.control);
    if (kind === "friend-accept") return this.acceptFriendAccept(fromAddr, body.control);
    // 老版本不认识这个 kind，回 400 + retryable:false：新版照写本机 quick，旧版只丢这一条。
    if (kind === "friend-quick") return this.acceptFriendQuick(fromAddr, body.control);
    // 第 3 片：撤回 / 输入中。同样是加性的 kind，旧对端回 `unknown kind` 直接丢掉。
    if (kind === "recall") return this.acceptRecall(fromAddr, body.control);
    if (kind === "note") return this.acceptNote(fromAddr, body.control);
    if (kind === "typing") return this.acceptTyping(fromAddr, body.control);
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
    const seq = Number(message?.seq);
    const replyTo = message?.replyTo && typeof message.replyTo === "object" ? message.replyTo : undefined;
    // `via` 跟着消息走：对端也要能看见「这条是 agent 代发的」，不能只在自己这边挂徽章。
    this.ctx.history.append(
      claimed.nodeId,
      this.entry(id, at, claimed, this.ctx.nodeId, "text", {
        text,
        ...(message?.via === "pi" ? { via: "pi" as const } : {}),
        ...(Number.isFinite(seq) ? { seq } : {}),
        ...(replyTo ? { replyTo } : {}),
      }),
    );
    this.ctx.log(`收到 ${claimed.nickname || claimed.nodeId.slice(0, 8)} 的消息（${Buffer.byteLength(text, "utf8")} 字节）`);
    return { status: 200, body: { ok: true, id } };
  }

  /** 收到记录包：只存正文与截图清单，图本体等文件通道一张张到（#507）。 */
  private async acceptNote(fromAddr: string, control: any): Promise<InboxResult> {
    const id = String(control?.id ?? "");
    const claimed = control?.from as PeerIdentity | undefined;
    if (!id || !claimed?.nodeId) return { status: 400, body: { error: "bad note", retryable: false } };
    let note: NotePayload;
    try {
      note = normalizeNote(control?.note);
    } catch (err) {
      return { status: 400, body: { error: (err as Error).message, retryable: false } };
    }
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    if (this.ctx.history.recentIds(claimed.nodeId, 2000).has(id)) return { status: 200, body: { ok: true, dup: true } };
    const at = Number(control?.at) || Date.now();
    const seq = Number(control?.seq);
    this.ctx.history.append(
      claimed.nodeId,
      this.entry(id, at, claimed, this.ctx.nodeId, "note", { note, ...(Number.isFinite(seq) ? { seq } : {}) }),
    );
    this.ctx.log(`收到 ${claimed.nickname || claimed.nodeId.slice(0, 8)} 的一条记录（${note.shots.length} 张图）`);
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
   * 收到撤回：**不删原消息**，追加一条 `kind:"recall"` 指向它（D299）。
   * 页面把原气泡换成灰条「X 撤回了一条消息」，历史文件里原文还在。
   */
  private async acceptRecall(fromAddr: string, control: any): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    const target = String(control?.target ?? "");
    if (!claimed?.nodeId || !target) return { status: 400, body: { error: "bad recall", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    if (this.isRecalled(claimed.nodeId, target)) return { status: 200, body: { ok: true, dup: true } };
    const at = Number(control?.at) || Date.now();
    this.ctx.history.append(claimed.nodeId, this.entry(uuidv7(at), at, claimed, this.ctx.nodeId, "recall", { ref: target }));
    this.ctx.log(`${claimed.nickname || claimed.nodeId.slice(0, 8)} 撤回了一条消息`);
    return { status: 200, body: { ok: true } };
  }

  /** 收到输入中：只放内存，3 秒不续就自动过期。来源不校验到底 —— 它不改任何持久状态。 */
  private acceptTyping(fromAddr: string, control: any): InboxResult {
    const claimed = control?.from as PeerIdentity | undefined;
    if (!claimed?.nodeId) return { status: 400, body: { error: "bad typing", retryable: false } };
    const known = this.ctx.discovery.byId(claimed.nodeId);
    if (!known || !known.ips.includes(normAddr(fromAddr))) return { status: 200, body: { ok: true, ignored: true } };
    this.typingUntil.set(claimed.nodeId, Date.now() + TYPING_MS);
    return { status: 200, body: { ok: true } };
  }

  /**
   * 好友请求 / 接受 / 一键快捷添加（第 3 片）/ 撤回通知。和文字走同一条 inbox + outbox：
   * 补投、去重、IP 校验都白捡。控制消息不产生历史行 —— 关系是个状态，不是一段对话。
   */
  sendControl(peerId: string, kind: ControlKind, extra: { target?: string } = {}): { ok: true } {
    const peer = this.ctx.discovery.byId(peerId);
    if (!peer) throw new Error("这个人已经不在线了：刷新在线列表再试");
    const who = this.ctx.relations.get(peerId);
    const identity: PeerIdentity = {
      nodeId: peerId,
      nickname: who?.nickname ?? peer.nickname,
      hostname: who?.hostname || peer.hostname,
      port: who?.port || peer.port,
    };
    if (kind === "friend-request") this.ctx.relations.request(identity);
    else if (kind === "friend-quick") this.ctx.relations.quickAdd(identity);
    else if (kind !== "recall") this.ctx.relations.accepted(identity);
    const at = Date.now();
    const id = uuidv7(at);
    // 对端只知道「谁在敲」，所以控制消息也带上自己的完整身份。
    const control = { id, at, from: this.me(), ...(extra.target ? { target: extra.target } : {}) };
    const outbox = this.ctx.outbox;
    if (!outbox) throw new Error("outbox 还没准备好");
    outbox.add({ id, peerId, addr: peer.addr, port: peer.port, kind, payload: control, at, tries: 0, nextAt: 0 });
    return { ok: true };
  }

  private async acceptFriendRequest(fromAddr: string, control: any): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    if (!claimed?.nodeId) return { status: 400, body: { error: "bad control", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    this.ctx.relations.incomingRequest(claimed);
    this.ctx.log(`收到好友请求：${claimed.nickname ?? claimed.nodeId.slice(0, 8)}`);
    return { status: 200, body: { ok: true } };
  }

  private async acceptFriendAccept(fromAddr: string, control: any): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    if (!claimed?.nodeId) return { status: 400, body: { error: "bad control", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    this.ctx.relations.accepted(claimed);
    this.ctx.log(`对方接受了你的好友请求：${claimed.nickname ?? claimed.nodeId.slice(0, 8)}`);
    return { status: 200, body: { ok: true } };
  }

  /** 一键快捷添加：只写 quick，不写 incoming，也不回 friend-accept（D234）。 */
  private async acceptFriendQuick(fromAddr: string, control: any): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    if (!claimed?.nodeId) return { status: 400, body: { error: "bad control", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    this.ctx.relations.quickAdd(claimed);
    this.ctx.log(`快捷联系人：${claimed.nickname ?? claimed.nodeId.slice(0, 8)}`);
    return { status: 200, body: { ok: true } };
  }

  /** 文件通道复用同一套来源校验（决定 10）：`null` 表示来源可信。 */
  verify(addr: string, who: PeerIdentity): Promise<InboxResult | null> {
    return this.verifySource(addr, who);
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

  /** 页面要的那一份：receipt / recall 已折叠进消息（P2）。 */
  view(peerId: string, limit: number): ViewEntry[] {
    const queued = this.ctx.outbox?.pendingFor(peerId) ?? [];
    const pending = new Set(queued.map((item) => item.id));
    const why = new Map(queued.map((item) => [item.id, { tries: item.tries, error: item.lastError }]));
    return foldEntries(this.ctx.history.read(peerId, limit), this.ctx.nodeId, pending, why);
  }

  version(): string {
    return VERSION;
  }
}
