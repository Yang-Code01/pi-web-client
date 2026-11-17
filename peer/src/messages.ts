import { randomBytes } from "node:crypto";
import os from "node:os";
import type { PeerConfig } from "./config.ts";
import { PROTO, VERSION } from "./config.ts";
import type { Discovery } from "./discovery.ts";
import type { History } from "./history.ts";
import type { ConvId, Elem, Msg, PeerIdentity, Quote } from "./model.ts";
import { RECALL_MS, TYPING_MS, abstractOf, convOfGroup, convOfNode, convTarget, isGroupConv, isMine, textOf } from "./model.ts";
import type { Outbox, Queued, Verdict } from "./outbox.ts";
import type { Relations } from "./peers.ts";
import type { Store } from "./store.ts";

/** 单条文本上限（决定 25）：再长就让用户改发文件，协议这边硬拒 32 KB。 */
export const MAX_TEXT_BYTES = 32 * 1024;

/** 一个群的成员上限：先兜住扇出成本，真要建大群再改。 */
export const MAX_GROUP_MEMBERS = 32;

/** 好友控件的三个 kind，和文字走同一条 inbox + outbox。 */
export type FriendKind = "friend-request" | "friend-accept" | "friend-quick";

/** 控制消息：已读 / 输入中 / 撤回 / 群。它们不进历史（群邀请例外，会落一条灰提示）。 */
export type ControlKind = "read" | "typing" | "recall" | "group-invite" | "group-sync" | "group-leave";

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

/** `::ffff:192.168.1.7` 与 `192.168.1.7` 是同一台机器，比较前先归一。 */
function normAddr(addr: string): string {
  return addr.replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");
}

export interface InboxResult {
  status: number;
  body: unknown;
}

export interface SendInput {
  /** 本机这一份的 sendType：默认 self，转发出去的是 selfForward。 */
  sendType?: "self" | "selfForward";
  text?: string;
  elements?: Elem[];
  quote?: Quote;
  via?: "pi";
}

export interface Sent {
  ok: true;
  id: string;
  at: number;
  seq: number;
  conv: ConvId;
}

/**
 * 收发（第 2 片 + 群聊）。
 *
 * 两个方向的入口都在这里：
 * - `send()/sendConv()` 由本机页面 / pi 工具调用（回环）；
 * - `accept()` 由局域网里的对端 POST `/peer/inbox` 调用。
 *
 * 状态机（对齐 QQ 的 `onAddSendMsg → onSendStatusChange`）：
 * 先以 `sending` 落历史（气泡立刻出现）→ outbox 投递 → 成功 `success` / 4xx 或重试耗尽 `failed`
 * → 对方发来 `read` 控制消息 → `read`。**不再自己给自己写「已送达」回执**。
 */
export class Messages {
  /** 谁正在输入：conv → 最后一次 typing 的毫秒时间。只在内存里，重启就忘。 */
  private typing = new Map<ConvId, number>();

  constructor(
    private readonly ctx: {
      cfg: PeerConfig;
      nodeId: string;
      discovery: Discovery;
      history: History;
      outbox: Outbox | null;
      relations: Relations;
      store: Store;
      log: (msg: string) => void;
    },
  ) {}

  /** outbox 的 `deliver` 反过来要调本类，所以两边只能先建后接。 */
  attachOutbox(outbox: Outbox): void {
    this.ctx.outbox = outbox;
  }

  /**
   * 单聊的会话 key 是本机视角（`n:<对方>`），所以对方发来的 `n:<我>` 必须换成本机的 `n:<他>`。
   * 群聊的 `g:<groupId>` 两边一致，原样用。
   */
  private localConv(raw: unknown, claimed: PeerIdentity): ConvId {
    const conv = String(raw ?? "");
    return isGroupConv(conv) ? conv : convOfNode(claimed.nodeId);
  }

  private me(): PeerIdentity {
    return { nodeId: this.ctx.nodeId, nickname: this.ctx.cfg.nickname, hostname: os.hostname(), port: this.ctx.cfg.port };
  }

  /** 群成员里除我以外的人。 */
  private membersOf(groupId: string): PeerIdentity[] {
    const group = this.ctx.store.group(groupId);
    if (!group) return [];
    return group.members.filter((member) => member.nodeId !== this.ctx.nodeId);
  }

  /** v1 入口：只要文字。 */
  send(peerId: string, text: string, via?: "pi"): Sent {
    return this.sendConv(convOfNode(peerId), { text, via });
  }

  /**
   * 发一条消息到会话：单聊或群聊。
   *
   * 单聊要求对方在线（不在线就没有 addr:port 可投）；群聊要求至少一个成员在线，
   * 离线的成员这条消息收不到（和 QQ 一样：发出去了，但他下次上线不会补）。
   */
  sendConv(conv: ConvId, input: SendInput): Sent {
    const elements: Elem[] = input.elements?.length
      ? input.elements
      : [{ type: "text", text: String(input.text ?? "").replace(/\s+$/, "") }];
    if (!elements.length) throw new Error("空消息");
    const text = elements
      .map((elem) => (elem.type === "text" ? elem.text : ""))
      .join("")
      .trim();
    const bytes = Buffer.byteLength(elements.map((elem) => (elem.type === "text" ? elem.text : "")).join(""), "utf8");
    if (!text && !elements.some((elem) => elem.type === "file")) throw new Error("空消息");
    if (bytes > MAX_TEXT_BYTES) throw new Error(`太长（${Math.round(bytes / 1024)} KB，上限 32 KB）：改用文件发`);

    const target = convTarget(conv);
    const recipients: { nodeId: string; addr: string; port: number }[] = [];
    if (target.kind === "group") {
      for (const member of this.membersOf(target.id)) {
        const peer = this.ctx.discovery.byId(member.nodeId);
        if (peer) recipients.push({ nodeId: peer.nodeId, addr: peer.addr, port: peer.port });
      }
      if (!recipients.length) throw new Error("群里现在没人在线");
    } else {
      const peer = this.ctx.discovery.byId(target.id);
      if (!peer) throw new Error("这个人已经不在线了：刷新在线列表再试");
      recipients.push({ nodeId: peer.nodeId, addr: peer.addr, port: peer.port });
    }

    const at = Date.now();
    const id = uuidv7(at);
    const seq = this.ctx.store.nextSeq(conv);
    const msg: Msg = {
      v: 2,
      id,
      seq,
      conv,
      from: this.me(),
      at,
      saveAt: at,
      sendType: input.sendType ?? "self",
      sendStatus: "sending",
      elements,
      ...(input.quote ? { quote: input.quote } : {}),
      ...(input.via ? { via: input.via } : {}),
    };
    this.ctx.history.appendMsg(msg);
    // 发出去了草稿就该没了：否则下次进会话又把已发的内容填回输入框。
    this.ctx.store.setDraft(conv, "");
    const outbox = this.ctx.outbox;
    if (!outbox) throw new Error("outbox 还没准备好");
    for (const to of recipients) {
      outbox.add({
        // 同一条消息扇出给多个人：outbox 的 id 必须唯一，用 `消息id:人` 拼。
        id: recipients.length > 1 ? `${id}:${to.nodeId}` : id,
        peerId: to.nodeId,
        addr: to.addr,
        port: to.port,
        kind: "msg",
        payload: { msg, target: to.nodeId },
        at,
        tries: 0,
        nextAt: 0,
      });
    }
    this.ctx.log(`发出 ${isGroupConv(conv) ? "群消息" : "消息"}${recipients.length > 1 ? `（扇出 ${recipients.length} 人）` : ""}`);
    return { ok: true, id, at, seq, conv };
  }

  /** 撤回：本机先复核，再通知对端（对端会再复核一遍，不信我的时间戳）。 */
  recall(conv: ConvId, id: string): { ok: boolean; error?: string } {
    const result = this.ctx.history.recall(conv, id, this.ctx.nodeId);
    if (!result.ok) return result;
    const msg = result.msg;
    if (!msg) return { ok: false, error: "没有这条消息" };
    this.notify(conv, "recall", { id });
    return { ok: true };
  }

  /** 转发：把元素抄进目标会话（不转灰度提示 / @）。 */
  forward(conv: ConvId, id: string, targets: ConvId[]): { ok: true; ids: string[] } {
    const src = this.ctx.history.byId(conv, id);
    if (!src) throw new Error("没有这条消息");
    if (src.recall) throw new Error("这条消息已经撤回了");
    const kept = src.elements.filter((elem) => elem.type !== "gray" && elem.type !== "at");
    if (!kept.length) throw new Error("这条消息没有可转发的内容");
    const ids: string[] = [];
    for (const target of targets) {
      const sent = this.sendConv(target, {
        elements: kept,
        sendType: "selfForward",
        quote: { id: src.id, fromNode: src.from.nodeId, nickname: src.from.nickname, abstract: abstractOf(src, 80) },
      });
      ids.push(sent.id);
    }
    return { ok: true, ids };
  }

  /** 进会话时调用：把水位推到最新，并告诉对方「我读到这里了」。 */
  markRead(conv: ConvId): { ok: true; seq: number; unread: number } {
    const seq = this.ctx.history.maxSeq(conv);
    this.ctx.store.markRead(conv, seq);
    if (isGroupConv(conv)) {
      // 群聊的已读回执先只记本机：扇出「谁读了」要额外一张表，等真需要再做。
      return { ok: true, seq, unread: 0 };
    }
    const target = convTarget(conv);
    const peer = this.ctx.discovery.byId(target.id);
    if (peer && seq > this.ctx.store.conv(conv).peerReadSeq) {
      this.enqueue(peer.nodeId, peer.addr, peer.port, "read", { conv, seq });
    }
    return { ok: true, seq, unread: 0 };
  }

  /** 输入中：节流交给调用方；对端 5 秒内没再收到就当停了。 */
  typingNotify(conv: ConvId): void {
    const target = convTarget(conv);
    if (target.kind === "group") {
      for (const member of this.membersOf(target.id)) {
        const peer = this.ctx.discovery.byId(member.nodeId);
        if (peer) this.enqueue(peer.nodeId, peer.addr, peer.port, "typing", { conv });
      }
      return;
    }
    const peer = this.ctx.discovery.byId(target.id);
    if (peer) this.enqueue(peer.nodeId, peer.addr, peer.port, "typing", { conv });
  }

  /** 谁正在输入（未过期的）。 */
  typingNow(): Set<ConvId> {
    const now = Date.now();
    const live = new Set<ConvId>();
    for (const [conv, at] of this.typing) {
      if (now - at <= TYPING_MS) live.add(conv);
      else this.typing.delete(conv);
    }
    return live;
  }

  /** 建群：本机先落元数据，再给每个成员发邀请。 */
  createGroup(name: string, memberIds: string[]): { ok: true; groupId: string; conv: ConvId } {
    const me = this.me();
    const members: PeerIdentity[] = [me];
    for (const nodeId of memberIds) {
      if (nodeId === this.ctx.nodeId) continue;
      const peer = this.ctx.discovery.byId(nodeId);
      const known = this.ctx.relations.get(nodeId);
      members.push({
        nodeId,
        nickname: known?.nickname ?? peer?.nickname,
        hostname: known?.hostname ?? peer?.hostname,
        port: known?.port ?? peer?.port,
      });
    }
    if (members.length < 2) throw new Error("至少选一个人");
    if (members.length > MAX_GROUP_MEMBERS) throw new Error(`成员上限 ${MAX_GROUP_MEMBERS} 人`);
    const groupId = uuidv7();
    const group = this.ctx.store.upsertGroup({
      groupId,
      name: name.trim() || `${me.nickname ?? "我"}建的群`,
      owner: this.ctx.nodeId,
      members,
      createdAt: Date.now(),
    });
    const conv = convOfGroup(groupId);
    this.ctx.store.nextSeq(conv);
    this.ctx.history.appendMsg({
      v: 2,
      id: uuidv7(),
      seq: this.ctx.store.nextSeq(conv),
      conv,
      from: me,
      at: Date.now(),
      saveAt: Date.now(),
      sendType: "self",
      sendStatus: "success",
      elements: [{ type: "gray", tip: `你创建了群聊「${group.name}」`, tone: "system" }],
    });
    for (const member of members) {
      if (member.nodeId === this.ctx.nodeId) continue;
      const peer = this.ctx.discovery.byId(member.nodeId);
      if (peer) this.enqueue(peer.nodeId, peer.addr, peer.port, "group-invite", { group });
    }
    return { ok: true, groupId, conv };
  }

  /** 拉人进群：本地合并 + 给新成员发一条 group-invite（带上完整成员表）。 */
  invite(groupId: string, memberIds: string[]): { ok: true; group: unknown } {
    const group = this.ctx.store.group(groupId);
    if (!group) throw new Error("没有这个群");
    if (group.owner !== this.ctx.nodeId) throw new Error("只有群主能拉人");
    const added: PeerIdentity[] = [];
    for (const nodeId of memberIds) {
      if (group.members.some((member) => member.nodeId === nodeId)) continue;
      const peer = this.ctx.discovery.byId(nodeId);
      const known = this.ctx.relations.get(nodeId);
      added.push({ nodeId, nickname: known?.nickname ?? peer?.nickname, hostname: known?.hostname ?? peer?.hostname, port: known?.port ?? peer?.port });
    }
    if (!added.length) throw new Error("这几个人已经在群里了");
    const next = this.ctx.store.upsertGroup({ ...group, members: [...group.members, ...added] });
    const note = added.map((member) => member.nickname ?? member.nodeId.slice(0, 8)).join("、");
    this.appendGray(groupId, `${note} 加入了群聊`);
    for (const member of next.members) {
      if (member.nodeId === this.ctx.nodeId) continue;
      const peer = this.ctx.discovery.byId(member.nodeId);
      if (peer) this.enqueue(peer.nodeId, peer.addr, peer.port, "group-sync", { group: next });
    }
    return { ok: true, group: next };
  }

  /** 退群：本机删掉元数据，通知还能连上的人。 */
  leave(groupId: string): { ok: true } {
    const group = this.ctx.store.group(groupId);
    if (!group) return { ok: true };
    for (const member of group.members) {
      if (member.nodeId === this.ctx.nodeId) continue;
      const peer = this.ctx.discovery.byId(member.nodeId);
      if (peer) this.enqueue(peer.nodeId, peer.addr, peer.port, "group-leave", { groupId });
    }
    this.ctx.store.dropGroup(groupId);
    return { ok: true };
  }

  /** outbox 的投递器：一次 HTTP POST，4xx 里带 `retryable` 决定「等 24 小时」还是「立刻红」。 */
  async deliver(item: Queued): Promise<Verdict> {
    try {
      const body =
        item.kind === "msg"
          ? { proto: PROTO, kind: "msg", message: (item.payload as { msg: Msg }).msg }
          : item.kind === "text"
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
      return { ok: false, retryable: true, error: (err as Error).message };
    }
  }

  /** 收到对端的 inbox 请求。返回 HTTP 状态 + body，由 http 层原样吐出去。 */
  async accept(fromAddr: string, body: any): Promise<InboxResult> {
    if (body?.proto !== PROTO) return { status: 400, body: { error: `proto 不匹配（我这边 ${PROTO}）`, retryable: false } };
    const kind = String(body.kind ?? "");
    if (kind === "msg") return this.acceptMsg(fromAddr, body.message);
    if (kind === "text") return this.acceptText(fromAddr, body.message);
    if (kind === "receipt") return { status: 200, body: { ok: true } };
    if (kind === "read") return this.acceptRead(fromAddr, body.control);
    if (kind === "typing") return this.acceptTyping(fromAddr, body.control);
    if (kind === "recall") return this.acceptRecall(fromAddr, body.control);
    if (kind === "group-invite") return this.acceptGroup(fromAddr, body.control, "invite");
    if (kind === "group-sync") return this.acceptGroup(fromAddr, body.control, "sync");
    if (kind === "group-leave") return this.acceptGroup(fromAddr, body.control, "leave");
    if (kind === "friend-request") return this.acceptFriendRequest(fromAddr, body.control);
    if (kind === "friend-accept") return this.acceptFriendAccept(fromAddr, body.control);
    // 老版本不认识这个 kind，回 400 + retryable:false：新版照写本机 quick，旧版只丢这一条。
    if (kind === "friend-quick") return this.acceptFriendQuick(fromAddr, body.control);
    return { status: 400, body: { error: "unknown kind", retryable: false } };
  }

  /** v2 消息入口：单聊与群聊都走这里。 */
  private async acceptMsg(fromAddr: string, message: any): Promise<InboxResult> {
    const msg = message as Msg;
    const claimed = msg?.from;
    if (!msg?.id || !claimed?.nodeId || !Array.isArray(msg.elements) || !msg.elements.length) {
      return { status: 400, body: { error: "bad message", retryable: false } };
    }
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;

    const conv = this.localConv(msg.conv, claimed);
    const groupConv = isGroupConv(conv);
    const bytes = Buffer.byteLength(
      msg.elements.map((elem) => (elem.type === "text" ? elem.text : "")).join(""),
      "utf8",
    );
    if (bytes > MAX_TEXT_BYTES) return { status: 413, body: { error: "太长", retryable: false } };

    if (groupConv) {
      const groupId = conv.slice(2);
      const known = this.ctx.store.group(groupId);
      if (!known) {
        // 没见过这个群：按邀请里最省事的方式补一份（之后 group-sync 会把成员补全）。
        this.ctx.store.upsertGroup({
          groupId,
          name: `${claimed.nickname ?? claimed.nodeId.slice(0, 8)}建的群`,
          owner: claimed.nodeId,
          members: [claimed, this.me()],
          createdAt: Number(msg.at) || Date.now(),
        });
      }
    }

    if (this.ctx.history.ids(conv).has(msg.id)) return { status: 200, body: { ok: true, dup: true } };

    const at = Number(msg.at) || Date.now();
    const seq = Number(msg.seq) || this.ctx.store.nextSeq(conv);
    this.ctx.history.appendMsg({
      v: 2,
      id: msg.id,
      seq,
      conv,
      from: claimed,
      at,
      saveAt: Date.now(),
      sendType: "recv",
      sendStatus: "success",
      elements: msg.elements.filter((elem) => elem.type !== "gray"),
      ...(msg.quote ? { quote: msg.quote } : {}),
      ...(msg.via === "pi" ? { via: "pi" as const } : {}),
    });
    this.ctx.store.observeSeq(conv, seq);
    this.ctx.log(`收到 ${claimed.nickname || claimed.nodeId.slice(0, 8)} 的消息（${bytes} 字节）`);
    return { status: 200, body: { ok: true, id: msg.id, seq } };
  }

  /** v1 兼容入口：对端还是老版本时发来 `kind:"text"`。 */
  private async acceptText(fromAddr: string, message: any): Promise<InboxResult> {
    const id = String(message?.id ?? "");
    const text = typeof message?.text === "string" ? message.text : "";
    const claimed = message?.from as PeerIdentity | undefined;
    if (!id || !claimed?.nodeId || !text) return { status: 400, body: { error: "bad message", retryable: false } };
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) return { status: 413, body: { error: "太长", retryable: false } };
    const conv = convOfNode(claimed.nodeId);
    return this.acceptMsg(fromAddr, {
      v: 2,
      id,
      seq: 0,
      conv,
      from: claimed,
      at: Number(message?.at) || Date.now(),
      elements: [{ type: "text", text }],
      ...(message?.via === "pi" ? { via: "pi" } : {}),
    });
  }

  /** 已读回执：把我发出的 `seq <= seq` 的消息推成 `read`。 */
  private async acceptRead(fromAddr: string, control: any): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    if (!claimed?.nodeId) return { status: 400, body: { error: "bad control", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    const conv = this.localConv(control?.conv, claimed);
    const seq = Number(control?.seq) || 0;
    this.ctx.store.peerRead(conv, seq);
    this.ctx.history.markMineRead(conv, seq);
    return { status: 200, body: { ok: true } };
  }

  private async acceptTyping(fromAddr: string, control: any): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    if (!claimed?.nodeId) return { status: 400, body: { error: "bad control", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    const conv = this.localConv(control?.conv, claimed);
    this.typing.set(conv, Date.now());
    return { status: 200, body: { ok: true } };
  }

  private async acceptRecall(fromAddr: string, control: any): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    const id = String(control?.id ?? "");
    if (!claimed?.nodeId || !id) return { status: 400, body: { error: "bad control", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    const conv = this.localConv(control?.conv, claimed);
    const result = this.ctx.history.recall(conv, id, claimed.nodeId, Number(control?.at) || Date.now());
    if (!result.ok) return { status: 400, body: { error: result.error, retryable: false } };
    this.ctx.log(`对方撤回了一条消息`);
    return { status: 200, body: { ok: true } };
  }

  private async acceptGroup(fromAddr: string, control: any, mode: "invite" | "sync" | "leave"): Promise<InboxResult> {
    const claimed = control?.from as PeerIdentity | undefined;
    if (!claimed?.nodeId) return { status: 400, body: { error: "bad control", retryable: false } };
    const check = await this.verifySource(fromAddr, claimed);
    if (check) return check;
    if (mode === "leave") {
      const groupId = String(control?.groupId ?? "");
      if (groupId) this.ctx.store.removeMember(groupId, claimed.nodeId);
      return { status: 200, body: { ok: true } };
    }
    const group = control?.group as { groupId?: string; name?: string; owner?: string; members?: PeerIdentity[] } | undefined;
    if (!group?.groupId || !Array.isArray(group.members)) return { status: 400, body: { error: "bad group", retryable: false } };
    const members = [...group.members.filter((member) => member?.nodeId), this.me()];
    const info = this.ctx.store.upsertGroup({
      groupId: group.groupId,
      name: group.name || "群聊",
      owner: group.owner || claimed.nodeId,
      members,
      createdAt: Date.now(),
    });
    const conv = convOfGroup(info.groupId);
    this.ctx.store.observeSeq(conv, 0);
    if (mode === "invite") {
      this.appendGray(info.groupId, `${claimed.nickname ?? claimed.nodeId.slice(0, 8)} 邀请你加入了群聊`);
      // 把「我进来了」同步回群主，他才知道名单里有我。
      const owner = this.ctx.discovery.byId(info.owner);
      if (owner && info.owner !== this.ctx.nodeId) this.enqueue(owner.nodeId, owner.addr, owner.port, "group-sync", { group: info });
    }
    return { status: 200, body: { ok: true } };
  }

  private appendGray(groupId: string, tip: string): void {
    const conv = convOfGroup(groupId);
    const at = Date.now();
    this.ctx.history.appendMsg({
      v: 2,
      id: uuidv7(at),
      seq: this.ctx.store.nextSeq(conv),
      conv,
      from: this.me(),
      at,
      saveAt: at,
      sendType: "self",
      sendStatus: "success",
      elements: [{ type: "gray", tip, tone: "system" }],
    });
  }

  /**
   * 好友请求 / 接受 / 一键快捷添加（第 3 片）。和文字走同一条 inbox + outbox：补投、去重、IP 校验都白捡。
   * 只是不产生历史行 —— 通讯录里「他请求我」是个状态，不是一段对话。
   */
  sendControl(peerId: string, kind: FriendKind): { ok: true } {
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
    else this.ctx.relations.accepted(identity);
    this.enqueue(peerId, peer.addr, peer.port, kind, {});
    return { ok: true };
  }

  /** 控制消息进 outbox：和消息同一条补投/退避路径。 */
  private enqueue(nodeId: string, addr: string, port: number, kind: ControlKind | FriendKind, payload: Record<string, unknown>): void {
    const outbox = this.ctx.outbox;
    if (!outbox) throw new Error("outbox 还没准备好");
    const at = Date.now();
    outbox.add({ id: uuidv7(at), peerId: nodeId, addr, port, kind, payload: { at, from: this.me(), ...payload }, at, tries: 0, nextAt: 0 });
  }

  private notify(conv: ConvId, kind: ControlKind, payload: Record<string, unknown>): void {
    const target = convTarget(conv);
    const members: { nodeId: string }[] = target.kind === "group" ? this.membersOf(target.id) : [{ nodeId: target.id }];
    for (const member of members) {
      const peer = this.ctx.discovery.byId(member.nodeId);
      if (peer) this.enqueue(peer.nodeId, peer.addr, peer.port, kind, { conv, ...payload });
    }
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

  /** 会话里最后一条我发的、还没被读到的 seq（给 UI 画「已读 N」。 */
  myLastSeq(conv: ConvId): number {
    let max = 0;
    for (const msg of this.ctx.history.read(conv, 2000)) {
      if (isMine(msg, this.ctx.nodeId) && !msg.recall && msg.seq > max) max = msg.seq;
    }
    return max;
  }

  /** 文本摘要，给 pi 工具 / 通知用。 */
  summary(conv: ConvId): string {
    const last = this.ctx.history.read(conv, 1).at(-1);
    if (!last) return "";
    return last.recall ? "（已撤回）" : textOf(last).slice(0, 120);
  }

  /** 撤回窗口还剩多久（毫秒），UI 用来决定显不显示「撤回」。 */
  recallLeft(msg: Msg): number {
    if (msg.recall) return 0;
    if (!isMine(msg, this.ctx.nodeId)) return 0;
    return Math.max(0, msg.at + RECALL_MS - Date.now());
  }

  version(): string {
    return VERSION;
  }
}
