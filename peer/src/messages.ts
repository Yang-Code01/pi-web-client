import { randomBytes } from "node:crypto";
import os from "node:os";
import { normAddr } from "./addr.ts";
import type { PeerConfig } from "./config.ts";
import { PROTO, VERSION } from "./config.ts";
import type { Discovery } from "./discovery.ts";
import { foldEntries, type Entry, type History, type NotePayload, type PeerIdentity, type SysInfo, type ViewEntry } from "./history.ts";
import { GROUP_PREFIX, MAX_GROUP_MEMBERS, canWriteGroup, isGroupId, normalizeGroup, optOutIds, setOptOut, snapshot, type Group, type Groups } from "./groups.ts";
import { normalizeAnnounce, type AnnouncePayload } from "./announce.ts";
import { normalizeNote } from "./note.ts";
import type { Outbox, Queued, Verdict } from "./outbox.ts";
import type { Relations } from "./peers.ts";
import { afterWatermark } from "./history.ts";
import { covered, type Reads } from "./reads.ts";

/** 单条文本上限（决定 25）：再长就让用户改发文件，协议这边硬拒 32 KB。 */
export const MAX_TEXT_BYTES = 32 * 1024;
/** 补发公告的默认条数与单次上限：默认值与钳制只在这里定义，http 与调用方共用。 */
export const REPLAY_DEFAULT = 3;
export const REPLAY_MAX = 10;

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

export interface InboxResult {
  status: number;
  body: unknown;
}

/** 回应用的表情：一小段字（一个 emoji 可能由好几个码点拼成），不许空、不许长。 */
function normEmoji(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > 16 || /[\s<>]/.test(s)) return "";
  return s;
}

export type ControlKind = "friend-request" | "friend-accept" | "friend-quick" | "recall";

/**
 * 1:1 文字的收发（第 2 片）+ 控制面（第 3 片：撤回 / 输入中）。
 *
 * 两个方向的入口都在这里：
 * - `send()` 由本机页面 / 第 5 片的 pi 工具调用（回环）；
 * - `accept()` 由局域网里的对端 POST `/peer/inbox` 调用。
 */
/** 消息的「重要 / 紧急」标记（Teams 的传递选项）；别的值一律当普通。 */
export function normPriority(raw: unknown): "important" | "urgent" | undefined {
  return raw === "important" || raw === "urgent" ? raw : undefined;
}

/** 话题（群里「回复这条话题」）：值是话题第一条消息的 id。 */
export function normTopic(raw: unknown): string | undefined {
  return typeof raw === "string" && /^[\w-]{8,80}$/.test(raw) ? raw : undefined;
}

export class Messages {
  /** 对方正在输入：只放内存，进程重启就清空（一条心跳本来也只活 3 秒）。 */
  private readonly typingUntil = new Map<string, number>();
  private readonly typingSentAt = new Map<string, number>();
  /** 补发过的公告 id：outbox 投递成功后就删了，光靠它挡不住第二次补发（评审 #11）。 */
  private readonly replayed = new Map<string, Set<string>>();

  constructor(
    private readonly ctx: {
      cfg: PeerConfig;
      nodeId: string;
      discovery: Discovery;
      history: History;
      outbox: Outbox | null;
      relations: Relations;
      groups: Groups;
      reads: Reads;
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
    return { id, at, from, to: { kind: isGroupId(to) ? "group" : "node", id: to }, kind, ...extra };
  }

  /**
   * 这个会话要投给谁：1:1 = 对方（`needOnline` 时必须在线）；群 = 除我以外的成员，
   * 离线的也排队（地址留空，上线后 outbox 的 `locate` 会把地址补上）。
   */
  private targets(threadId: string, needOnline = true): { peerId: string; addr: string; port: number }[] {
    if (isGroupId(threadId)) {
      const group = this.ctx.groups.get(threadId);
      if (!group) throw new Error("没有这个群");
      if (group.left) throw new Error("你已经不在这个群里了");
      return this.memberTargets(group.members);
    }
    const peer = this.ctx.discovery.byId(threadId);
    if (!peer) {
      if (needOnline) throw new Error("这个人已经不在线了：刷新在线列表再试");
      return [];
    }
    return [{ peerId: threadId, addr: peer.addr, port: peer.port }];
  }

  private memberTargets(members: PeerIdentity[]): { peerId: string; addr: string; port: number }[] {
    return members
      .filter((m) => m.nodeId !== this.ctx.nodeId)
      .map((m) => {
        const live = this.ctx.discovery.byId(m.nodeId);
        return { peerId: m.nodeId, addr: live?.addr ?? "", port: live?.port ?? (Number(m.port) || 0) };
      });
  }

  /** 入队：1:1 一条；群按成员拆成多条（id = `<原 id>@<成员>`），各自补投。 */
  private enqueue(threadId: string, id: string, kind: Queued["kind"], payload: unknown, at: number, targets: { peerId: string; addr: string; port: number }[]): void {
    const outbox = this.ctx.outbox;
    if (!outbox) throw new Error("outbox 还没准备好");
    const group = isGroupId(threadId);
    for (const t of targets) {
      outbox.add({
        id: group ? `${id}@${t.peerId}` : id,
        peerId: t.peerId,
        addr: t.addr,
        port: t.port,
        kind,
        payload,
        at,
        tries: 0,
        nextAt: 0,
        ...(group ? { thread: threadId, msgId: id } : {}),
      });
    }
  }

  /** 本机发出：先落历史（bubble 立刻出现），再进 outbox 补投。`retryable` 的失败不在这里发生。 */
  /** 发一条记录包：正文 + 截图清单走 inbox，截图本体随后逐张走文件通道（#507）。 */
  sendNote(peerId: string, raw: unknown): { ok: true; id: string; at: number; seq: number } {
    const note = normalizeNote(raw);
    if (isGroupId(peerId)) throw new Error("群里暂不支持发记录");
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

  send(
    peerId: string,
    text: string,
    via?: "pi",
    replyTo?: Entry["replyTo"],
    opts: { priority?: unknown; topic?: unknown; announce?: unknown } = {},
  ): { ok: true; id: string; at: number; seq: number } {
    const trimmed = text.replace(/\s+$/, "");
    if (!trimmed.trim()) throw new Error("空消息");
    const bytes = Buffer.byteLength(trimmed, "utf8");
    if (bytes > MAX_TEXT_BYTES) {
      throw new Error(`太长（${Math.round(bytes / 1024)} KB，上限 32 KB）：改用文件发`);
    }
    // 先判只读（成员得到的应该是「只有发布者能发」，而不是 announce 校验的报错），
    // 公告也只允许出现在更新组里 —— 普通会话不该冒出更新卡片（评审 #13）。
    this.assertWritable(peerId);
    const announce = opts.announce ? normalizeAnnounce(opts.announce) : null;
    // 调用方明确要发公告却传了非法形状：不能静默退化成普通文本，否则发布者以为推了（评审 #9）。
    if (opts.announce && !announce) throw new Error("公告格式不对，没发出去");
    if (announce && this.ctx.groups.get(peerId)?.announceOnly !== true) throw new Error("只有更新组能发公告");
    const targets = this.targets(peerId);
    const at = Date.now();
    const id = uuidv7(at);
    const seq = this.ctx.history.nextSeq(peerId);
    const priority = normPriority(opts.priority);
    const topic = normTopic(opts.topic);
    if (topic && !this.ctx.history.find(peerId, topic)) throw new Error("找不到这个话题");
    const entry = this.entry(id, at, this.me(), peerId, "text", {
      text: trimmed,
      seq,
      ...(via ? { via } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(priority ? { priority } : {}),
      ...(topic ? { topic } : {}),
      ...(announce ? { announce } : {}),
    });
    this.ctx.history.append(peerId, entry);
    this.enqueue(peerId, id, "text", entry, at, targets);
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
    const outbox = this.ctx.outbox;
    if (!outbox) throw new Error("outbox 还没准备好");
    // 还在排队的那条（页面上的「立即重试」）：只把下一次尝试提前。
    // 不能再 `add()` 一次 —— 它按 id 去重，什么也不会发生，用户点完会以为按钮坏了。
    if (outbox.nudge(entry.id)) return { ok: true };
    const targets = isGroupId(peerId) ? this.targets(peerId) : this.targets(peerId, false);
    if (!targets.length) throw new Error("这个人已经不在线了：等他上线再重发");
    const kind = entry.kind === "note" ? "note" : "text";
    this.enqueue(peerId, entry.id, kind, entry, Date.now(), targets);
    return { ok: true };
  }

  /**
   * 撤回（D299 / P3）：本机先落一条 `kind:"recall"` 的记录（原消息不删），再通知对端。
   *
   * 对端离线时只在本机生效 —— 不做「等他上线再告诉他撤回」：那条消息他可能早就看过了。
   */
  recall(peerId: string, id: string): { ok: true; at: number } {
    // 先判能不能写，再判这条消息在不在：只读群里成员连「找不到」都不该问得出来。
    this.assertWritable(peerId);
    const entry = this.ctx.history.find(peerId, id);
    if (!entry) throw new Error("找不到这条消息");
    if (entry.from.nodeId !== this.ctx.nodeId) throw new Error("只能撤回自己发的");
    if (entry.kind !== "text" && entry.kind !== "file") throw new Error("这条撤不回");
    if (this.isRecalled(peerId, id)) throw new Error("已经撤回过了");
    const at = Date.now();
    if (at - entry.at > RECALL_MS) throw new Error("超过撤回时间，不能被撤回");
    this.ctx.history.append(peerId, this.entry(uuidv7(at), at, this.me(), peerId, "recall", { ref: id }));
    const targets = this.targets(peerId, false);
    if (targets.length) {
      const control = { id: uuidv7(at), at, from: this.me(), target: id, ...this.groupField(peerId) };
      this.enqueue(peerId, control.id, "recall", control, at, targets);
    }
    this.ctx.log(`撤回 ${id.slice(0, 8)}${targets.length ? "" : "（对方不在线：只在本机生效）"}`);
    return { ok: true, at };
  }

  /** 群会话的控制消息要带上群 id：对方得知道这条撤回 / 回应 / 固定落在哪个会话里。 */
  private groupField(threadId: string): { group?: string } {
    return isGroupId(threadId) ? { group: threadId } : {};
  }

  /**
   * 表情回应：本机先落一条 `kind:"react"`（指向原消息、带 emoji 与 on），再通知对端。
   * 对端在线时走 outbox（失败会补投）；离线时只在本机生效。
   */
  react(peerId: string, id: string, emoji: string, on: boolean): { ok: true; at: number } {
    const e = normEmoji(emoji);
    if (!e) throw new Error("表情不对");
    this.assertWritable(peerId);
    const entry = this.ctx.history.find(peerId, id);
    if (!entry) throw new Error("找不到这条消息");
    if (entry.kind !== "text" && entry.kind !== "file" && entry.kind !== "note") throw new Error("这条不能回应");
    const at = Date.now();
    this.ctx.history.append(peerId, this.entry(uuidv7(at), at, this.me(), peerId, "react", { ref: id, emoji: e, on }));
    // 对方不在线时只在本机生效（和撤回一样）：outbox 需要地址，离线的人没有。群里照样排队。
    const targets = this.targets(peerId, false);
    if (targets.length) {
      const control = { id: uuidv7(at), at, from: this.me(), target: id, emoji: e, on, ...this.groupField(peerId) };
      this.enqueue(peerId, control.id, "react", control, at, targets);
    }
    return { ok: true, at };
  }

  /**
   * 固定消息（像 Teams 的「固定」）：本机先落一条 `kind:"pin"`，再通知对端 / 群成员，
   * 大家会话顶上都多一条。同一条消息最后一次 pin / unpin 说了算。
   */
  pin(peerId: string, id: string, on: boolean): { ok: true; at: number } {
    this.assertWritable(peerId);
    const entry = this.ctx.history.find(peerId, id);
    if (!entry) throw new Error("找不到这条消息");
    if (entry.kind !== "text" && entry.kind !== "file" && entry.kind !== "note") throw new Error("这条不能固定");
    if (on && this.isRecalled(peerId, id)) throw new Error("撤回了的消息不能固定");
    const at = Date.now();
    this.ctx.history.append(peerId, this.entry(uuidv7(at), at, this.me(), peerId, "pin", { ref: id, on }));
    const targets = this.targets(peerId, false);
    if (targets.length) {
      const control = { id: uuidv7(at), at, from: this.me(), target: id, on, ...this.groupField(peerId) };
      this.enqueue(peerId, control.id, "pin", control, at, targets);
    }
    return { ok: true, at };
  }

  isRecalled(peerId: string, id: string): boolean {
    return this.ctx.history.read(peerId, 2000).some((entry) => entry.kind === "recall" && entry.ref === id);
  }

  /** 输入中：直接 POST，不落盘、不进 outbox —— 一条心跳丢了就丢了。 */
  async sendTyping(peerId: string): Promise<void> {
    if (isGroupId(peerId)) return;
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
    return (this.ctx.outbox?.pendingFor(peerId) ?? []).some((item) => item.kind === "text" || item.kind === "note");
  }

  /** outbox 的投递器：一次 HTTP POST，4xx 里带 `retryable` 决定「等 24 小时」还是「立刻红」。 */
  async deliver(item: Queued): Promise<Verdict> {
    // 群里离线的成员：入队时没有地址，等他上线（`locate` 补上地址）再投。
    if (!item.addr || !item.port) return { ok: false, retryable: true, error: "对方不在线" };
    try {
      const group = item.thread ? this.ctx.groups.get(item.thread) : null;
      const extra = group ? { group: snapshot(group) } : {};
      const body =
        item.kind === "text"
          ? { proto: PROTO, kind: "text", message: item.payload, ...extra }
          : { proto: PROTO, kind: item.kind, control: item.payload, ...extra };
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
    if (kind === "text") return this.acceptText(fromAddr, body.message, body.group);
    if (kind === "receipt") return this.acceptReceipt(body.receipt);
    if (kind === "friend-request") return this.acceptFriendRequest(fromAddr, body.control);
    if (kind === "friend-accept") return this.acceptFriendAccept(fromAddr, body.control);
    // 老版本不认识这个 kind，回 400 + retryable:false：新版照写本机 quick，旧版只丢这一条。
    if (kind === "friend-quick") return this.acceptFriendQuick(fromAddr, body.control);
    // 第 3 片：撤回 / 输入中。同样是加性的 kind，旧对端回 `unknown kind` 直接丢掉。
    if (kind === "recall") return this.acceptRecall(fromAddr, body.control, body.group);
    if (kind === "note") return this.acceptNote(fromAddr, body.control);
    if (kind === "react") return this.acceptReact(fromAddr, body.control, body.group);
    if (kind === "pin") return this.acceptPin(fromAddr, body.control, body.group);
    if (kind === "read") return this.acceptRead(fromAddr, body.control, body.group);
    if (kind === "group") return this.acceptGroup(fromAddr, body.control);
    if (kind === "typing") return this.acceptTyping(fromAddr, body.control);
    return { status: 400, body: { error: "unknown kind", retryable: false } };
  }

  // ---------------------------------------------------------------- 群

  /** 一个人的对外身份：用他自报的昵称（我给他起的备注只在本机，D303），不在线就用通讯录里那份。 */
  private identity(nodeId: string): PeerIdentity {
    if (nodeId === this.ctx.nodeId) return this.me();
    const live = this.ctx.discovery.byId(nodeId);
    const known = this.ctx.relations.get(nodeId);
    return {
      nodeId,
      nickname: live?.nickname || known?.nickname || nodeId.slice(0, 8),
      hostname: live?.hostname || known?.hostname || "",
      port: live?.port || known?.port || 0,
    };
  }

  private appendSys(threadId: string, actor: PeerIdentity, sys: SysInfo, at = Date.now()): void {
    this.ctx.history.append(threadId, this.entry(uuidv7(at), at, actor, threadId, "sys", { sys }));
  }

  /** 把新的名单告诉大家：按成员逐人排队，离线的人上线后补到。`extra` = 不在新名单里但也要通知的人。 */
  private broadcastGroup(group: Group, extra: PeerIdentity[] = []): void {
    const at = Date.now();
    const control = { id: uuidv7(at), at, from: this.me(), group: snapshot(group) };
    const seen = new Set<string>();
    const all = [...group.members, ...extra].filter((m) => !seen.has(m.nodeId) && Boolean(seen.add(m.nodeId)));
    this.enqueue(group.id, control.id, "group", control, at, this.memberTargets(all));
  }

  private nameOf(m: PeerIdentity): string {
    return m.nickname || m.nodeId.slice(0, 8);
  }

  createGroup(name: string, memberIds: string[], opts: { id?: string; announceOnly?: boolean; publisher?: string } = {}): Group {
    const others = [...new Set(memberIds)].filter((id) => id && id !== this.ctx.nodeId && !isGroupId(id));
    // 更新组（D451）：发布者可能第一个上线，还没人可拉 —— announceOnly 允许只有自己。
    if (!others.length && !opts.announceOnly) throw new Error("至少拉一个人");
    if (others.length + 1 > MAX_GROUP_MEMBERS) throw new Error(`一个群最多 ${MAX_GROUP_MEMBERS} 人`);
    const at = Date.now();
    const members = [this.me(), ...others.map((id) => this.identity(id))];
    // publisher 必须真的在名册里：否则这个只读群建出来没人能发（评审 #10/#19）。
    if (opts.publisher && !members.some((m) => m.nodeId === opts.publisher)) throw new Error("发布者必须是群成员");
    // publisher 只对只读群有意义：普通群带上它会把一个早已被遗忘的 nodeId 写进每个成员的
    // groups.json，日后有人把组改成只读，写权限就落到它头上而不是 owner（评审 #8）。
    if (opts.publisher && !opts.announceOnly) throw new Error("publisher 只对只读群（announceOnly）有意义");
    // 形状不对不能静默丢掉：只读群的 publisher 会退到 owner，建群的脚本却以为远端是发布者（评审 #7）。
    if (opts.publisher && !/^[\w-]{1,64}$/.test(opts.publisher)) throw new Error("发布者 nodeId 不合法");
    const title = name.trim().slice(0, 64) || members.map((m) => this.nameOf(m)).slice(0, 3).join("、");
    const wanted = typeof opts.id === "string" ? opts.id.trim() : "";
    if (wanted && (!isGroupId(wanted) || wanted.length > 80 || !/^[a-zA-Z0-9_-]+$/.test(wanted))) {
      throw new Error("群 id 只能是字母、数字、下划线与短横线");
    }
    const id = wanted || `${GROUP_PREFIX}${uuidv7(at)}`;
    const existing = this.ctx.groups.get(id);
    if (existing) throw new Error("这个群已经存在了");
    const group: Group = {
      id,
      name: title,
      members,
      owner: this.ctx.nodeId,
      createdAt: at,
      v: 1,
      at,
      ...(opts.announceOnly ? { announceOnly: true } : {}),
      // publisher 会进快照、对端 normalizeGroup 会截到 64：本机也先按同一形状收口，别让两边值不同（评审 #15）。
    ...(opts.publisher ? { publisher: opts.publisher } : {}),
    };
    this.ctx.groups.put(group);
    this.appendSys(group.id, this.me(), { op: "create", actor: this.nameOf(this.me()), name: title, names: members.slice(1).map((m) => this.nameOf(m)) }, at);
    this.broadcastGroup(group);
    this.ctx.log(`建群「${title}」（${members.length} 人）`);
    return group;
  }

  private mine(groupId: string): Group {
    const group = this.ctx.groups.get(groupId);
    if (!group) throw new Error("没有这个群");
    if (group.left) throw new Error("你已经不在这个群里了");
    return group;
  }

  renameGroup(groupId: string, name: string): Group {
    const group = this.mine(groupId);
    const title = name.trim().slice(0, 64);
    if (!title) throw new Error("群名不能空");
    if (title === group.name) return group;
    const next: Group = { ...group, name: title, v: group.v + 1, at: Date.now() };
    this.ctx.groups.put(next);
    this.appendSys(groupId, this.me(), { op: "rename", actor: this.nameOf(this.me()), name: title });
    this.broadcastGroup(next);
    return next;
  }

  inviteGroup(groupId: string, memberIds: string[]): Group {
    const group = this.mine(groupId);
    const have = new Set(group.members.map((m) => m.nodeId));
    const fresh = [...new Set(memberIds)].filter((id) => id && !have.has(id) && !isGroupId(id));
    if (!fresh.length) throw new Error("这些人已经在群里了");
    if (group.members.length + fresh.length > MAX_GROUP_MEMBERS) throw new Error(`一个群最多 ${MAX_GROUP_MEMBERS} 人`);
    const added = fresh.map((id) => this.identity(id));
    const next: Group = { ...group, members: [...group.members, ...added], v: group.v + 1, at: Date.now() };
    this.ctx.groups.put(next);
    this.appendSys(groupId, this.me(), { op: "invite", actor: this.nameOf(this.me()), names: added.map((m) => this.nameOf(m)) });
    this.broadcastGroup(next);
    return next;
  }

  /** 退群：名单里去掉自己、版本 +1，通知剩下的人；本机会话留着（能看历史），不能再发。 */
  leaveGroup(groupId: string): Group {
    const group = this.mine(groupId);
    // 先写 opt-out：写不进去（磁盘满 / 权限）就抛错，本机还留在组里，不会出现「退了但没记住」（评审 #11）。
    if (group.announceOnly) setOptOut(groupId, true);
    const members = group.members.filter((m) => m.nodeId !== this.ctx.nodeId);
    const next: Group = { ...group, members, v: group.v + 1, at: Date.now() };
    this.broadcastGroup(next);
    const left: Group = { ...next, left: true };
    this.ctx.groups.put(left);
    this.appendSys(groupId, this.me(), { op: "leave", actor: this.nameOf(this.me()) });
    return left;
  }

  /** 重新加入更新组（D451）：清掉 opt-out，等发布者下一轮邀请把新快照送过来。 */
  rejoinGroup(groupId: string): { ok: true; pending?: boolean } {
    if (!isGroupId(groupId)) throw new Error("不是合法的群 id");
    const group = this.ctx.groups.get(groupId);
    // 只允许本机确实认识、而且确实是只读更新组的群；否则任意 id 都会写进 opt-out 文件（评审 #4）。
    if (!group) throw new Error("这个更新组还没同步到本机");
    if (group.announceOnly !== true) throw new Error("这不是只读的更新组");
    setOptOut(groupId, false);
    // 只有在名册里才清 left：被发布者移出的人不能靠这个 API 假装自己还在组里（评审 #22）。
    if (group.members.some((m) => m.nodeId === this.ctx.nodeId)) {
      this.ctx.groups.put({ ...group, left: false });
      return { ok: true };
    }
    return { ok: true, pending: true };
  }

  /**
   * 换机器（D451）：新发布者接管这个更新组。
   *
   * 新机器要先被拉进组（拿到旧成员那份名册），再走这里 v+1 广播；旧成员按版本接受。
   * `Groups.merge` 的 takeover 只给「publisher 还空着、owner 认领」这一种恢复路径用（见那里），
   * 普通成员换发布者不靠它 —— 只靠 v 更大。
   */
  claimPublisher(groupId: string): Group {
    const group = this.mine(groupId);
    if (!group.announceOnly) throw new Error("这不是只读的更新组");
    if (group.publisher === this.ctx.nodeId) return group;
    // 发布者必须在名册里：不在就补进来。满员时先保住**旧发布者**，再腾最后一席，
    // 否则被挤掉的旧发布者收不到新快照、也不会知道自己已经不在名册里（评审 #3）。
    let members = group.members;
    if (!members.some((m) => m.nodeId === this.ctx.nodeId)) {
      // publisher 为空时写权限回退 owner：满员先保 owner，否则他会被自己挤出去（评审 #14）。
      const keepId = group.publisher || group.owner;
      const kept = members.filter((m) => m.nodeId === keepId);
      const others = members.filter((m) => m.nodeId !== keepId).slice(0, MAX_GROUP_MEMBERS - kept.length - 1);
      members = [...kept, ...others, this.me()].slice(0, MAX_GROUP_MEMBERS);
    }
    // publisher 空着时写权限回退 owner：owner 若不在名册里，回退会让一个非成员继续能写（评审 #23）。
    // owner 是空串 / 形状不对（收到过坏快照）时不能往名册里补一个 nodeId:"" 的幽灵：
    // 那种成员投不出去、也过不了 admitGroup 的成员检查（评审 #9）。
    if (!group.publisher && group.owner && !members.some((m) => m.nodeId === group.owner)) {
      // 满员时截断不能把刚补进来的自己挤掉（评审 #8）：owner 放最前、自己放最后。
      const rest = members.filter((m) => m.nodeId !== this.ctx.nodeId).slice(0, MAX_GROUP_MEMBERS - 2);
      members = [this.identity(group.owner), ...rest, this.me()].slice(0, MAX_GROUP_MEMBERS);
    }
    const next: Group = { ...group, members, publisher: this.ctx.nodeId, v: group.v + 1, at: Date.now() };
    this.ctx.groups.put(next);
    this.appendSys(groupId, this.me(), { op: "publisher", actor: this.nameOf(this.me()), name: this.nameOf(this.me()) });
    this.broadcastGroup(next);
    return next;
  }

  /** 收到新的名单：新于本机才收，差异写成灰条。 */
  private mergeGroup(raw: unknown, actor: PeerIdentity): void {
    const changed = this.ctx.groups.merge(raw, this.ctx.nodeId, actor.nodeId);
    if (!changed) return;
    const { before, after } = changed;
    const who = this.nameOf(actor);
    if (!before) {
      const others = after.members.filter((m) => m.nodeId !== after.owner).map((m) => this.nameOf(m));
      if (after.v === 1) this.appendSys(after.id, actor, { op: "create", actor: who, name: after.name, names: others });
      else this.appendSys(after.id, actor, { op: "invite", actor: who, names: [this.nameOf(this.me())] });
      return;
    }
    if (before.name !== after.name) this.appendSys(after.id, actor, { op: "rename", actor: who, name: after.name });
    // 发布者换了机器（D451）：接受，但要让组里的人看见，不能悄悄换掉。
    if (before.publisher !== after.publisher && after.publisher) {
      this.appendSys(after.id, actor, { op: "publisher", actor: who, name: this.nameOf(this.identity(after.publisher)) });
    }
    const had = new Set(before.members.map((m) => m.nodeId));
    const has = new Set(after.members.map((m) => m.nodeId));
    const added = after.members.filter((m) => !had.has(m.nodeId)).map((m) => this.nameOf(m));
    if (added.length) this.appendSys(after.id, actor, { op: "invite", actor: who, names: added });
    for (const m of before.members) {
      if (!has.has(m.nodeId)) this.appendSys(after.id, m, { op: "leave", actor: this.nameOf(m) });
    }
  }

  /**
   * 群消息进门：先收信封里的名单快照（发送方必须在快照里），再看他是不是成员。
   * `null` = 放行；我已经退了的群回 200 ignored（对方别再重试）。
   */
  private admitGroup(groupId: string, claimed: PeerIdentity, snap: unknown): InboxResult | null {
    if (!isGroupId(groupId)) return { status: 400, body: { error: "bad group", retryable: false } };
    const s = snap ? normalizeGroup(snap) : null;
    if (s && s.id === groupId && s.members.some((m) => m.nodeId === claimed.nodeId)) this.mergeGroup(s, claimed);
    const group = this.ctx.groups.get(groupId);
    if (!group) return { status: 404, body: { error: "不认识这个群", retryable: false } };
    // D451：退更新组 = 本机 opt-out。发布者那边会跳过（announce 里带着 optOut），这里再拦一道：
    // 已经退掉的人不该因为别人还按旧名册发消息而继续收到。
    if (optOutIds().has(groupId)) return { status: 200, body: { ok: true, ignored: true } };
    if (group.left) return { status: 200, body: { ok: true, ignored: true } };
    if (!group.members.some((m) => m.nodeId === claimed.nodeId)) return { status: 403, body: { error: "不是群成员", retryable: false } };
    return null;
  }

  /**
   * 只读群的写门（D451）：除了发布者，文字 / 回应 / 固定 / 撤回都不收。
   * 已读回执（`read`）与名单快照不受影响 —— 成员还是要能标记已读、接收邀请。
   */
  private writeGate(thread: string, claimed: PeerIdentity): InboxResult | null {
    if (!isGroupId(thread)) return null;
    const group = this.ctx.groups.get(thread);
    if (!group?.announceOnly) return null;
    if (canWriteGroup(group, claimed.nodeId)) return null;
    return { status: 403, body: { error: "只读群：只有发布者能发消息", retryable: false } };
  }

  /** 本机自己的写入口也要拦：只读群里成员点到的每个动作都在本地先被拒，不靠对端回 403。 */
  private assertWritable(threadId: string): void {
    if (!isGroupId(threadId)) return;
    const group = this.ctx.groups.get(threadId);
    if (!group?.announceOnly) return;
    // 不在名册里就没有写权限，哪怕 owner 回退也不行（评审 #23）。
    if (!group.members.some((m) => m.nodeId === this.ctx.nodeId)) throw new Error("你不在这个群的名册里");
    if (canWriteGroup(group, this.ctx.nodeId)) return;
    throw new Error("这是只读的更新组：只有发布者能发消息");
  }

  /**
   * 给刚进组的人补最近几条公告（D451）：原 id / 原时间单播。
   * 对方 `recentIds` 会把重复的丢掉，所以已经收到过的人不会多出气泡。
   */
  replayAnnouncements(groupId: string, peerNodeId: string, limit = REPLAY_DEFAULT): { ok: true; sent: number } {
    const group = this.ctx.groups.get(groupId);
    if (!group?.announceOnly) throw new Error("不是更新组");
    // 补发是发布者动作，目标必须是组员：回环 API 也不能拿它往任意节点塞历史（评审 #11）。
    this.assertWritable(groupId);
    if (!group.members.some((m) => m.nodeId === peerNodeId)) throw new Error("这个人不是更新组成员");
    const want = Math.max(0, Math.floor(limit));
    if (!want) return { ok: true, sent: 0 };
    const peer = this.ctx.discovery.byId(peerNodeId);
    if (!peer) throw new Error("这个人不在线");
    // 500 条只够热闹的群；公告稀疏时最近 3 条可能落在更早的位置（评审 #8）。
    // 注意 `history.read()` 读的是会话文件最后 512 KB：5000 只在这个尾巴里数，
    // 比 512 KB 更早公告补不到（没有服务器、没有完整历史），这里也不会报错（评审 #9）。
    const entries = this.ctx.history
      .read(groupId, 5000)
      .filter((entry) => entry.kind === "text" && entry.announce)
      .slice(-want);
    const replayKey = `${groupId}@${peerNodeId}`;
    const sentBefore = this.replayed.get(replayKey) ?? new Set<string>();
    let sent = 0;
    for (const entry of entries) {
      if (sentBefore.has(entry.id)) continue;
      // outbox 按 id 去重：已经在重试队列里的那条不会再排一次，sent 也只数真正排进去的（评审 #5）。
      if (this.ctx.outbox?.has(`${entry.id}@${peerNodeId}`)) continue;
      // 入队时间必须用「现在」：outbox 按 item.at 判 24 小时过期，拿原公告时间会被立刻丢掉（评审 #3）。
      // 气泡时间仍取 payload 里的 entry.at，新成员看到的是原公告的日期。
      this.enqueue(groupId, entry.id, "text", entry, Date.now(), [{ peerId: peerNodeId, addr: peer.addr, port: peer.port }]);
      sentBefore.add(entry.id);
      sent++;
    }
    this.replayed.set(replayKey, sentBefore);
    // 只留还在名册里的人：成员来来回回会让这个 Map 只增不减（评审 #8）。
    // 删的是同一 groupId 下已不在名册里的 key，别的集群一条不动。
    const live = new Set(group.members.map((m) => `${groupId}@${m.nodeId}`));
    for (const key of this.replayed.keys()) if (key.startsWith(`${groupId}@`) && !live.has(key)) this.replayed.delete(key);
    return { ok: true, sent };
  }

  /** 收到名单变化（建群 / 改名 / 拉人 / 退群）。退群的人不在新名单里，所以看「旧名单里有没有他」。 */
  private async acceptGroup(fromAddr: string, control: any): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    const next = normalizeGroup(control?.group);
    if (!claimed?.nodeId || !next) return { status: 400, body: { error: "bad group", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    const before = this.ctx.groups.get(next.id);
    const inNew = next.members.some((m) => m.nodeId === claimed.nodeId);
    const inOld = before?.members.some((m) => m.nodeId === claimed.nodeId) ?? false;
    if (!inNew && !inOld) return { status: 403, body: { error: "不是群成员", retryable: false } };
    this.mergeGroup(next, claimed);
    return { status: 200, body: { ok: true } };
  }

  /** 控制消息落在哪个会话：带群 id 的进群（先过门），否则就是和发送方的 1:1。 */
  private controlThread(control: any, claimed: PeerIdentity, snap: unknown): { thread: string } | InboxResult {
    const groupId = typeof control?.group === "string" ? control.group : "";
    if (!groupId) return { thread: claimed.nodeId };
    const gate = this.admitGroup(groupId, claimed, snap);
    return gate ?? { thread: groupId };
  }

  /**
   * 我把这个会话读到了 `next`（上一次是 `prev`）：给这段里发过消息的人各回一条「已读」。
   * 只告诉作者本人 —— 别人的消息谁读了和我无关；离线的作者照样排队，上线后补到。
   */
  sendRead(threadId: string, prev: { at?: number; id?: string }, next: { at: number; id: string }): number {
    const group = isGroupId(threadId) ? this.ctx.groups.get(threadId) : null;
    if (group?.left) return 0;
    const authors = new Map<string, PeerIdentity>();
    for (const entry of this.ctx.history.read(threadId, 200)) {
      if (entry.kind !== "text" && entry.kind !== "file" && entry.kind !== "note") continue;
      if (entry.from.nodeId === this.ctx.nodeId) continue;
      if (prev.at !== undefined && !afterWatermark(entry, prev.at, prev.id ?? "")) continue;
      if (!covered(entry, next)) continue;
      authors.set(entry.from.nodeId, entry.from);
    }
    if (group) for (const id of [...authors.keys()]) if (!group.members.some((m) => m.nodeId === id)) authors.delete(id);
    if (!authors.size || !this.ctx.outbox) return 0;
    const at = Date.now();
    const id = uuidv7(at);
    const control = { id, at, from: this.me(), upTo: { at: next.at, id: next.id }, ...this.groupField(threadId) };
    const targets = this.memberTargets([...authors.values()]);
    if (group) this.enqueue(threadId, id, "read", control, at, targets);
    else for (const t of targets) this.ctx.outbox.add({ id, peerId: t.peerId, addr: t.addr, port: t.port, kind: "read", payload: control, at, tries: 0, nextAt: 0 });
    return authors.size;
  }

  /** 收到已读回执：只往前推水位，重投 / 乱序都无害。 */
  private async acceptRead(fromAddr: string, control: any, snap: unknown): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    const at = Number(control?.upTo?.at);
    const upId = String(control?.upTo?.id ?? "");
    if (!claimed?.nodeId || !Number.isFinite(at) || !upId) return { status: 400, body: { error: "bad read", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    const where = this.controlThread(control, claimed, snap);
    if (!("thread" in where)) return where;
    this.ctx.reads.mark(where.thread, claimed.nodeId, { at, id: upId });
    return { status: 200, body: { ok: true } };
  }

  /** 收到固定 / 取消固定：同一个 control id 只记一次。 */
  private async acceptPin(fromAddr: string, control: any, snap: unknown): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    const id = String(control?.id ?? "");
    const target = String(control?.target ?? "");
    if (!claimed?.nodeId || !id || !target) return { status: 400, body: { error: "bad pin", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    const where = this.controlThread(control, claimed, snap);
    if (!("thread" in where)) return where;
    const blocked = this.writeGate(where.thread, claimed);
    if (blocked) return blocked;
    if (this.ctx.history.recentIds(where.thread, 2000).has(id)) return { status: 200, body: { ok: true, dup: true } };
    const at = Number(control?.at) || Date.now();
    const to = isGroupId(where.thread) ? where.thread : this.ctx.nodeId;
    this.ctx.history.append(where.thread, this.entry(id, at, claimed, to, "pin", { ref: target, on: control?.on !== false }));
    return { status: 200, body: { ok: true } };
  }

  private async acceptText(fromAddr: string, message: any, snap?: unknown): Promise<InboxResult> {
    const id = String(message?.id ?? "");
    const text = typeof message?.text === "string" ? message.text : "";
    const claimed = message?.from as PeerIdentity | undefined;
    if (!id || !claimed?.nodeId || !text) return { status: 400, body: { error: "bad message", retryable: false } };
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) return { status: 413, body: { error: "太长", retryable: false } };

    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;

    // 群消息落到群会话；1:1 落到和发送方的会话。
    const groupId = message?.to?.kind === "group" ? String(message.to.id ?? "") : "";
    if (groupId) {
      const gate = this.admitGroup(groupId, claimed, snap);
      if (gate) return gate;
    }
    const thread = groupId || claimed.nodeId;
    const blocked = this.writeGate(thread, claimed);
    if (blocked) return blocked;

    const seen = this.ctx.history.recentIds(thread, 2000);
    if (seen.has(id)) return { status: 200, body: { ok: true, dup: true } };

    const at = Number(message?.at) || Date.now();
    const seq = Number(message?.seq);
    const replyTo = message?.replyTo && typeof message.replyTo === "object" ? message.replyTo : undefined;
    const announce: AnnouncePayload | null = message?.announce ? normalizeAnnounce(message.announce) : null;
    // 对端说这是公告但形状不对：降级成普通文本是兼容老/坏客户端，但别一声不吭（评审 #12）。
    if (message?.announce && !announce) this.ctx.log("收到的公告格式不对，已按普通文本落库");
    // `via` 跟着消息走：对端也要能看见「这条是 agent 代发的」，不能只在自己这边挂徽章。
    this.ctx.history.append(
      thread,
      this.entry(id, at, claimed, groupId || this.ctx.nodeId, "text", {
        text,
        ...(message?.via === "pi" ? { via: "pi" as const } : {}),
        ...(Number.isFinite(seq) ? { seq } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(normPriority(message?.priority) ? { priority: normPriority(message?.priority) } : {}),
        ...(normTopic(message?.topic) ? { topic: normTopic(message?.topic) } : {}),
        ...(announce ? { announce } : {}),
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
  private async acceptRecall(fromAddr: string, control: any, snap?: unknown): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    const target = String(control?.target ?? "");
    if (!claimed?.nodeId || !target) return { status: 400, body: { error: "bad recall", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    const where = this.controlThread(control, claimed, snap);
    if (!("thread" in where)) return where;
    const blocked = this.writeGate(where.thread, claimed);
    if (blocked) return blocked;
    if (this.isRecalled(where.thread, target)) return { status: 200, body: { ok: true, dup: true } };
    // 群里只认发送者本人撤回自己的消息。
    const original = this.ctx.history.find(where.thread, target);
    if (original && original.from.nodeId !== claimed.nodeId) return { status: 403, body: { error: "只能撤回自己发的", retryable: false } };
    const at = Number(control?.at) || Date.now();
    const to = isGroupId(where.thread) ? where.thread : this.ctx.nodeId;
    this.ctx.history.append(where.thread, this.entry(uuidv7(at), at, claimed, to, "recall", { ref: target }));
    this.ctx.log(`${claimed.nickname || claimed.nodeId.slice(0, 8)} 撤回了一条消息`);
    return { status: 200, body: { ok: true } };
  }

  /** 收到表情回应：同一个 control id 只记一次（outbox 补投会重发）。 */
  private async acceptReact(fromAddr: string, control: any, snap?: unknown): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    const id = String(control?.id ?? "");
    const target = String(control?.target ?? "");
    const emoji = normEmoji(control?.emoji);
    if (!claimed?.nodeId || !id || !target || !emoji) return { status: 400, body: { error: "bad react", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    const where = this.controlThread(control, claimed, snap);
    if (!("thread" in where)) return where;
    const blocked = this.writeGate(where.thread, claimed);
    if (blocked) return blocked;
    if (this.ctx.history.recentIds(where.thread, 2000).has(id)) return { status: 200, body: { ok: true, dup: true } };
    const at = Number(control?.at) || Date.now();
    const to = isGroupId(where.thread) ? where.thread : this.ctx.nodeId;
    this.ctx.history.append(where.thread, this.entry(id, at, claimed, to, "react", { ref: target, emoji, on: control?.on !== false }));
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
    const pending = new Set(queued.map((item) => item.msgId ?? item.id));
    const why = new Map(queued.map((item) => [item.msgId ?? item.id, { tries: item.tries, error: item.lastError }]));
    // 固定的消息可能很早：多折叠一段，把窗口外被固定的也带上（页面顶上那条要用）。
    const folded = foldEntries(this.ctx.history.read(peerId, Math.max(limit, 2000)), this.ctx.nodeId, pending, why);
    if (isGroupId(peerId)) {
      // 群：有一个人收到就算送到了（离线的人还在排队，但不该让气泡一直转圈）。
      for (const view of folded) {
        if (view.state === "sending" && view.ack?.status === "delivered") {
          view.state = "delivered";
          delete view.tries;
          delete view.sendError;
        }
      }
    }
    // 已读：我发的消息上挂「谁读到了」（别人通过 `read` 回执告诉我的水位）。
    const marks = Object.entries(this.ctx.reads.of(peerId));
    if (marks.length) {
      for (const view of folded) {
        if (view.from.nodeId !== this.ctx.nodeId || view.recalled) continue;
        if (view.kind !== "text" && view.kind !== "file" && view.kind !== "note") continue;
        const who = marks.filter(([, mark]) => covered(view, mark)).map(([nodeId]) => nodeId);
        if (who.length) view.readBy = who;
      }
    }
    const tail = folded.slice(-limit);
    const shown = new Set(tail.map((view) => view.id));
    const pinnedEarlier = folded.filter((view) => view.pinned && !shown.has(view.id)).map((view) => ({ ...view, outside: true }));
    return [...pinnedEarlier, ...tail];
  }

  version(): string {
    return VERSION;
  }
}
