import fs from "node:fs";
import path from "node:path";
import { statePath } from "./config.ts";
import type { ConvId, Elem, Msg, PeerIdentity, SendStatus } from "./model.ts";
import { RECALL_MS, abstractOf, convFromFileName, convOfGroup, convOfNode, isGroupConv, isMine, safeConvName, textOf } from "./model.ts";
import type { Store } from "./store.ts";

/**
 * 历史 = 每个会话一个 append-only 的 JSONL 文件（D97），但 v2 的行带 `op`：
 *
 *   {"op":"msg","msg":{…}}                       新消息
 *   {"op":"patch","id":"…","patch":{"sendStatus":"read"}}   状态推进 / 撤回
 *
 * 读的时候按顺序 fold 出当前值 —— QQ 那边 `msgList` 也是一份「当前值」，
 * 不是让 UI 自己回放事件流。为什么状态用 patch 而不是改原行：JSONL 只追加，
 * 改行要重写整份文件，2 GB 的对话会在每次「已读」时卡死。
 *
 * v1 的行（没有 `op`）照样能读：折成一条 `seq:0` 的消息；v1 那行伪回执直接丢掉。
 */
export type EntryKind = "text" | "receipt" | "file";

/** v1 的历史行（`files.ts` 还在写它，走 `append()` 兼容入口）。 */
export interface Entry {
  id: string;
  at: number;
  from: PeerIdentity;
  to: { kind: "node" | "group"; id: string };
  kind: EntryKind;
  text?: string;
  ack?: { id: string; status: "delivered" | "failed"; error?: string };
  file?: { name: string; size: number; mime: string; sha256?: string };
  via?: "pi";
}

export type { PeerIdentity } from "./model.ts";

export type StoredLine =
  | { op: "msg"; msg: Msg }
  | { op: "patch"; conv: ConvId; id: string; at: number; patch: { sendStatus?: SendStatus; recall?: { at: number; by: string } } };

export interface ThreadView {
  conv: ConvId;
  kind: "c2c" | "group";
  nodeId?: string;
  groupId?: string;
  nickname: string;
  hostname: string;
  port: number;
  online: boolean;
  last: Msg | null;
  lastAt: number;
  count: number;
  unread: number;
  draft: string;
  pinned: boolean;
  muted: boolean;
  typing: boolean;
  members: number;
}

const TAIL_BYTES = 4 * 1024 * 1024;

function empty(): { size: number; msgs: Msg[]; byId: Map<string, Msg> } {
  return { size: -1, msgs: [], byId: new Map() };
}

export class History {
  private cache = new Map<ConvId, { size: number; msgs: Msg[]; byId: Map<string, Msg> }>();

  constructor(
    private readonly log: (msg: string) => void,
    private readonly me = "",
  ) {
    try {
      fs.mkdirSync(statePath("history"), { recursive: true });
    } catch (err) {
      this.log(`history 目录建不出来：${(err as Error).message}`);
    }
  }

  private file(conv: ConvId): string {
    return path.join(statePath("history"), `${safeConvName(conv)}.jsonl`);
  }

  /** 一行一次 `appendFileSync`：崩溃最多丢最后半行，前面的都还在（append-only 的便宜版本）。 */
  private appendLine(conv: ConvId, line: StoredLine | Entry): void {
    try {
      fs.appendFileSync(this.file(conv), `${JSON.stringify(line)}\n`);
      this.cache.delete(conv);
    } catch (err) {
      this.log(`写历史失败（${conv}）：${(err as Error).message}`);
    }
  }

  appendMsg(msg: Msg): void {
    this.appendLine(msg.conv, { op: "msg", msg });
  }

  appendPatch(conv: ConvId, id: string, patch: { sendStatus?: SendStatus; recall?: { at: number; by: string } }): void {
    this.appendLine(conv, { op: "patch", conv, id, at: Date.now(), patch });
  }

  /** v1 入口：`files.ts` 还在用它。回执行丢掉，其余转成 v2 消息。 */
  append(nodeId: string, entry: Entry): void {
    if (entry.kind === "receipt") return;
    const conv = entry.to.kind === "group" ? convOfGroup(entry.to.id) : convOfNode(nodeId);
    const elements: Elem[] = [];
    if (entry.text) elements.push({ type: "text", text: entry.text });
    if (entry.file) elements.push({ type: "file", ...entry.file });
    if (!elements.length) elements.push({ type: "gray", tip: "（空消息）" });
    const mine = entry.from.nodeId === this.me;
    this.appendMsg({
      v: 2,
      id: entry.id,
      seq: 0,
      conv,
      from: entry.from,
      at: entry.at,
      saveAt: entry.at,
      sendType: mine ? "self" : "recv",
      sendStatus: "success",
      elements,
      via: entry.via,
    });
  }

  private readLines(conv: ConvId): { size: number; lines: (StoredLine | Entry)[] } {
    const file = this.file(conv);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return { size: 0, lines: [] };
    }
    const start = Math.max(0, size - TAIL_BYTES);
    let text = "";
    try {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
      try {
        fs.readSync(fd, buf, 0, buf.length, start);
      } finally {
        fs.closeSync(fd);
      }
      text = buf.toString("utf8");
      // 从中间切进来的第一行可能是半行，丢掉。
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } catch {
      return { size: 0, lines: [] };
    }
    const lines: (StoredLine | Entry)[] = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try {
        lines.push(JSON.parse(raw) as StoredLine | Entry);
      } catch {
        /* 半行（上一轮崩在写入中间）直接跳过 */
      }
    }
    return { size, lines };
  }

  /** fold 出当前值；按文件大小缓存，同一次轮询里 threads + messages 不会重复解析。 */
  private fold(conv: ConvId): { size: number; msgs: Msg[]; byId: Map<string, Msg> } {
    let size = 0;
    try {
      size = fs.statSync(this.file(conv)).size;
    } catch {
      size = 0;
    }
    const hit = this.cache.get(conv);
    if (hit && hit.size === size) return hit;
    if (!size) {
      const blank = empty();
      blank.size = 0;
      this.cache.set(conv, blank);
      return blank;
    }
    const { lines } = this.readLines(conv);
    const byId = new Map<string, Msg>();
    const msgs: Msg[] = [];
    // 旧行（v1 的 append，文件卡片还在走这条路）没有 seq：给它一个「和上一条真实消息同号」的 seq，
    // 这样它在 sorted() 里按 at 落在上一条之后，而不是因为 seq 0 永远排在对话最上面。
    let lastSeq = 0;
    for (const line of lines) {
      if ("op" in line) {
        if (line.op === "msg") {
          byId.set(line.msg.id, line.msg);
          msgs.push(line.msg);
          if (line.msg.seq > lastSeq) lastSeq = line.msg.seq;
        } else if (line.op === "patch") {
          const target = byId.get(line.id);
          if (target) Object.assign(target, line.patch);
        }
        continue;
      }
      // v1 行
      if (line.kind === "receipt") continue;
      const elements: Elem[] = [];
      if (line.text) elements.push({ type: "text", text: line.text });
      if (line.file) elements.push({ type: "file", ...line.file });
      if (!elements.length) elements.push({ type: "gray", tip: "（空消息）" });
      const mine = line.from.nodeId === this.me;
      const msg: Msg = {
        v: 2,
        id: line.id,
        seq: lastSeq,
        conv,
        from: line.from,
        at: line.at,
        saveAt: line.at,
        sendType: mine ? "self" : "recv",
        sendStatus: "success",
        elements,
        via: line.via,
      };
      byId.set(msg.id, msg);
      msgs.push(msg);
    }
    const entry = { size, msgs, byId };
    this.cache.set(conv, entry);
    return entry;
  }

  private sorted(conv: ConvId): Msg[] {
    const { msgs } = this.fold(conv);
    return [...msgs].sort((a, b) => a.seq - b.seq || a.at - b.at || a.id.localeCompare(b.id));
  }

  /** 会话里最近的 `limit` 条（旧→新）。 */
  read(conv: ConvId, limit = 200): Msg[] {
    return this.sorted(conv).slice(-limit);
  }

  all(conv: ConvId): Msg[] {
    return this.sorted(conv);
  }

  byId(conv: ConvId, id: string): Msg | null {
    return this.fold(conv).byId.get(id) ?? null;
  }

  ids(conv: ConvId): Set<string> {
    return new Set(this.fold(conv).byId.keys());
  }

  count(conv: ConvId): number {
    return this.fold(conv).msgs.length;
  }

  /** 补投前查重：最近 2000 条就够了，不需要单独的状态文件（决定 3）。 */
  recentIds(conv: ConvId, count = 2000): Set<string> {
    return new Set(this.read(conv, count).map((msg) => msg.id));
  }

  maxSeq(conv: ConvId): number {
    const { msgs } = this.fold(conv);
    let max = 0;
    for (const msg of msgs) if (msg.seq > max) max = msg.seq;
    return max;
  }

  /** 未读：对方发来、seq 超过我读到位置的条数。撤回的不算（QQ 也是从 unreadCnt 里扣）。 */
  unread(conv: ConvId, readSeq: number): number {
    const { msgs } = this.fold(conv);
    let n = 0;
    for (const msg of msgs) {
      if (isMine(msg, this.me) || msg.recall) continue;
      if (msg.seq > readSeq) n += 1;
    }
    return n;
  }

  /** 对方读到我哪条：把我发出的、seq 够小的消息推成 `read`。 */
  markMineRead(conv: ConvId, seq: number): number {
    let n = 0;
    for (const msg of this.fold(conv).msgs) {
      if (!isMine(msg, this.me)) continue;
      if (msg.seq > seq || msg.seq <= 0) continue;
      if (msg.sendStatus === "read") continue;
      this.appendPatch(conv, msg.id, { sendStatus: "read" });
      n += 1;
    }
    if (n) this.log(`${conv} 有 ${n} 条被对方读到了`);
    return n;
  }

  /** 撤回：只允许原发送者、且在窗口内（接收端复核一遍，不信对端自报的 at）。 */
  recall(conv: ConvId, id: string, by: string, at = Date.now()): { ok: boolean; error?: string; msg?: Msg } {
    const msg = this.byId(conv, id);
    if (!msg) return { ok: false, error: "没有这条消息" };
    if (msg.from.nodeId !== by) return { ok: false, error: "只能撤回自己发的消息" };
    if (msg.recall) return { ok: true, msg };
    if (at - msg.at > RECALL_MS) return { ok: false, error: "超过 2 分钟，撤回不了" };
    this.appendPatch(conv, id, { recall: { at, by } });
    return { ok: true, msg: this.byId(conv, id) ?? msg };
  }

  /** 会话列表：文件里的会话 + 已建但还没说话的群。 */
  threads(
    online: { nodeId: string; nickname: string; hostname: string; port: number }[],
    contacts: { nodeId: string; nickname: string; hostname: string; port: number }[] = [],
    store?: Store,
    typing: Set<ConvId> = new Set(),
  ): ThreadView[] {
    const byId = new Map(online.map((peer) => [peer.nodeId, peer]));
    const byContact = new Map(contacts.map((contact) => [contact.nodeId, contact]));
    let names: string[] = [];
    try {
      names = fs.readdirSync(statePath("history")).filter((name) => name.endsWith(".jsonl"));
    } catch {
      names = [];
    }
    const convs = new Set<ConvId>();
    for (const name of names) {
      const conv = convFromFileName(name);
      if (conv) convs.add(conv);
    }
    for (const group of store?.groups() ?? []) convs.add(convOfGroup(group.groupId));

    const out: ThreadView[] = [];
    for (const conv of convs) {
      const target = conv.slice(2);
      const group = isGroupConv(conv) ? store?.group(target) ?? null : null;
      const msgs = this.sorted(conv);
      const last = msgs.at(-1) ?? null;
      const state = store?.conv(conv);
      const known = isGroupConv(conv) ? null : byId.get(target) ?? byContact.get(target) ?? (last?.from.nodeId === target ? last.from : null);
      const nickname = group?.name || known?.nickname || (last?.from.nodeId === target ? last.from.nickname : "") || target.slice(0, 8);
      out.push({
        conv,
        kind: isGroupConv(conv) ? "group" : "c2c",
        nodeId: isGroupConv(conv) ? undefined : target,
        groupId: group?.groupId,
        nickname,
        hostname: known?.hostname ?? "",
        port: known?.port ?? 0,
        // 群：有成员在线才算「有成员在线」，否则头栏会一直骗人说在线。
        online: isGroupConv(conv) ? (group?.members ?? []).some((m) => byId.has(m.nodeId)) : byId.has(target),
        last,
        lastAt: last?.at ?? 0,
        count: msgs.length,
        unread: this.unread(conv, state?.readSeq ?? 0),
        draft: state?.draft?.text ?? "",
        pinned: state?.pinned === true,
        muted: state?.muted === true,
        typing: typing.has(conv),
        members: group ? group.members.length : 0,
      });
    }
    return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastAt - a.lastAt);
  }

  /** 全文搜索：会话内或全库，扫的是 fold 后的正文（上限兜住大历史）。 */
  search(q: string, conv?: ConvId, limit = 50): { conv: ConvId; msg: Msg }[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const targets = conv ? [conv] : this.searchable();
    const hits: { conv: ConvId; msg: Msg }[] = [];
    for (const id of targets) {
      for (const msg of this.read(id, 2000)) {
        if (msg.recall) continue;
        if (!textOf(msg).toLowerCase().includes(needle)) continue;
        hits.push({ conv: id, msg });
      }
    }
    return hits.sort((a, b) => b.msg.at - a.msg.at).slice(0, limit);
  }

  searchable(): ConvId[] {
    try {
      return fs
        .readdirSync(statePath("history"))
        .map(convFromFileName)
        .filter((conv): conv is ConvId => Boolean(conv));
    } catch {
      return [];
    }
  }

  /** 会话摘要（给 pi 的 `peer_history` 之类的只读消费者用）。 */
  snippets(conv: ConvId, limit = 20): { id: string; at: number; from: string; text: string }[] {
    return this.read(conv, limit).map((msg) => ({ id: msg.id, at: msg.at, from: msg.from.nickname || msg.from.nodeId, text: msg.recall ? "（已撤回）" : abstractOf(msg, 200) }));
  }
}
