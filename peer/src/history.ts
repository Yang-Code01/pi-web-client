import fs from "node:fs";
import path from "node:path";
import { statePath } from "./config.ts";
import type { ThreadMeta } from "./threads.ts";

/**
 * 一条消息 / 一条回执 / 一条撤回，就是 JSONL 里的一行（D97）。
 *
 * 为什么不复用 pi 的会话格式：`bridge/src/sessionfile.ts` 解析的是 pi 自己的
 * `SessionHeader`/`SessionEntry`，字段含义都不一样；硬套只会在对方升级时炸在自己这边。
 * 这里的 schema 只有六个字段，v1.1 加群聊时 `to.kind` 和 `kind` 已经留好位置。
 *
 * D299 之后这是**加性**扩展：新字段全部可选，旧版本读新文件只是看不见它们。
 */
export type EntryKind = "text" | "receipt" | "file" | "recall" | "note";

export interface PeerIdentity {
  nodeId: string;
  nickname?: string;
  hostname?: string;
  port?: number;
}

/** 记录包的截图清单：截图本体逐张走文件通道，卡片只带 sha 对齐（#507）。 */
export interface NoteShot {
  name: string;
  size: number;
  sha256: string;
}

/** 记录包正文：标题 / 净化 HTML / 分类 / 发送时状态 / 截图清单（#507 / #508）。 */
export interface NotePayload {
  title: string;
  body: string;
  kind: "bug" | "change" | "idea" | "chore";
  status: "pending" | "done" | "dropped";
  shots: NoteShot[];
  noteCreatedAt?: number;
  noteUpdatedAt?: number;
}

/** 引用：`excerpt` 截过，不把整段原文塞进信封（D299）。 */
export interface ReplyRef {
  id: string;
  from: string;
  excerpt: string;
}

export interface Entry {
  id: string;
  at: number;
  from: PeerIdentity;
  to: { kind: "node" | "group"; id: string };
  kind: EntryKind;
  text?: string;
  ack?: { id: string; status: "delivered" | "failed"; error?: string };
  /**
   * `kind:"file"` 的元数据。文件本体不在历史里，只留一份能被 UI 画成卡片的描述（D106）。
   * `w`/`h` 只对图片有：页面先用它们把位置占住，缩略图下来时不会把整列消息顶得乱跳
   * —— 照 QQ 的 `PicMsgElem` 自带宽高（D305）。
   */
  file?: { name: string; size: number; mime: string; sha256?: string; w?: number; h?: number };
  /** 谁写的这条消息：`"pi"` = 由 pi（agent）代发，界面挂 🤖 徽章（决定 33）。 */
  via?: "pi";
  /** 会话内单调递增的序号，发送方分配；接收方只拿它当同毫秒的排序第二键（D299）。 */
  seq?: number;
  /** 引用回复。 */
  replyTo?: ReplyRef;
  /** `kind:"recall"` 时指向被撤回的那条消息的 id。 */
  ref?: string;
  /** `kind:"note"` 的记录包（#507）。 */
  note?: NotePayload;
}

/**
 * 折叠后的消息：页面只画这一种。
 *
 * `recalled` / `state` 都是**视图字段**，从来不落盘 —— 它们由「后面那条 receipt / recall」
 * 与「outbox 里还在排队的 id」现算出来（D299：状态派生、不落盘）。
 */
export interface ViewEntry extends Entry {
  recalled?: boolean;
  state?: "sending" | "delivered" | "failed";
}

export interface ThreadSummary {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  last: Entry | null;
  count: number;
  online: boolean;
  /** 对端报的状态：online / away / busy（旧对端没有这个字段，按 online 算）。 */
  status: string;
  lastSeen: number;
  unread: number;
  pinned: boolean;
  muted: boolean;
  draft: string;
  /** 最后一条消息是不是我发的：页面据此加「你:」前缀。 */
  lastMine: boolean;
  /** 我这条还没送到（outbox 里排队）：会话行据此画一个「发送中」。 */
  sending: boolean;
  /** 对方正在输入（3 秒内的 typing 心跳，不落盘）。 */
  typing: boolean;
}

const TAIL_BYTES = 512 * 1024;

function safeName(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 视图里要显示的三种「一条消息」：回执不占位，撤回也不单独占位（它把原气泡换掉）。 */
function isMessage(entry: Entry): boolean {
  return entry.kind === "text" || entry.kind === "file" || entry.kind === "note";
}

/**
 * 把 receipt / recall 折叠进它们指向的消息（D299 / P2）。
 *
 * - receipt → 给原消息挂 `ack`（同一条消息被重投多次时**最后一条回执说了算**）；
 * - recall → 把原消息标成 `recalled`，页面画成灰条；撤回记录本身不进消息流；
 * - `pending` 里的 id → `state:"sending"`，其余已送达的标 `delivered`。
 *
 * 不落盘、不改历史文件：同一份 JSONL 在旧版本里读出来还是它原来的样子。
 */
export function foldEntries(entries: Entry[], me: string, pending: Set<string>): ViewEntry[] {
  const byId = new Map<string, ViewEntry>();
  const out: ViewEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "text" || entry.kind === "file" || entry.kind === "note") {
      const view: ViewEntry = { ...entry };
      byId.set(entry.id, view);
      out.push(view);
      continue;
    }
    if (entry.kind === "receipt" && entry.ack) {
      const target = byId.get(entry.ack.id);
      if (target) {
        target.ack = { id: entry.ack.id, status: entry.ack.status, ...(entry.ack.error ? { error: entry.ack.error } : {}) };
      }
    }
    if (entry.kind === "recall" && entry.ref) {
      const target = byId.get(entry.ref);
      if (target) target.recalled = true;
    }
  }
  for (const view of out) {
    if (view.from.nodeId !== me) continue;
    if (pending.has(view.id)) view.state = "sending";
    else if (view.ack?.status === "failed") view.state = "failed";
    else if (view.ack?.status === "delivered") view.state = "delivered";
  }
  return out;
}

export class History {
  constructor(private readonly log: (msg: string) => void) {
    try {
      fs.mkdirSync(statePath("history"), { recursive: true });
    } catch (err) {
      this.log(`history 目录建不出来：${(err as Error).message}`);
    }
  }

  private file(nodeId: string): string {
    return path.join(statePath("history"), `${safeName(nodeId)}.jsonl`);
  }

  /** 一行一次 `appendFileSync`：崩溃最多丢最后半行，前面的都还在（append-only 的便宜版本）。 */
  append(nodeId: string, entry: Entry): void {
    try {
      fs.appendFileSync(this.file(nodeId), `${JSON.stringify(entry)}\n`);
    } catch (err) {
      this.log(`写历史失败（${nodeId}）：${(err as Error).message}`);
    }
  }

  /** 只读尾巴：2 GB 的对话文件也不该整份读进内存。 */
  read(nodeId: string, limit = 200): Entry[] {
    const file = this.file(nodeId);
    let text = "";
    try {
      const size = fs.statSync(file).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } catch {
      return [];
    }
    const out: Entry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Entry);
      } catch {
        /* 半行（上一轮崩在写入中间）直接跳过 */
      }
    }
    return out.slice(-limit);
  }

  /** 按 id 找一条消息：撤回 / 重投都要把原 entry 原样捞回来。 */
  find(nodeId: string, id: string): Entry | null {
    if (!id) return null;
    const tail = this.read(nodeId, 2000);
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      if (tail[i].id === id) return tail[i];
    }
    return null;
  }

  /** 会话内下一个序号：只看尾巴，够用（消息只在会话里单调，不需要全局）。 */
  nextSeq(nodeId: string): number {
    const tail = this.read(nodeId, 200);
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      const seq = tail[i].seq;
      if (typeof seq === "number" && Number.isFinite(seq)) return seq + 1;
      if (isMessage(tail[i])) return 1;
    }
    return 1;
  }

  /** 补投前查重：最近 2000 条就够了，不需要单独的状态文件（决定 3）。 */
  recentIds(nodeId: string, count = 2000): Set<string> {
    return new Set(this.read(nodeId, count).map((entry) => entry.id));
  }

  /** 会话列表。名字优先用查得到的人：在线表 → 通讯录 → 最后一条的 from。 */
  threads(input: {
    online: { nodeId: string; nickname: string; hostname: string; port: number; status?: string; lastSeen: number }[];
    contacts: { nodeId: string; nickname: string; hostname: string; port: number }[];
    me: string;
    meta: (nodeId: string) => ThreadMeta;
    typing: (nodeId: string) => boolean;
    pending: (nodeId: string) => boolean;
  }): ThreadSummary[] {
    const byId = new Map(input.online.map((peer) => [peer.nodeId, peer]));
    const byContact = new Map(input.contacts.map((contact) => [contact.nodeId, contact]));
    let files: string[] = [];
    try {
      files = fs.readdirSync(statePath("history")).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const out: ThreadSummary[] = [];
    for (const name of files) {
      const nodeId = name.slice(0, -".jsonl".length);
      const tail = this.read(nodeId, 2000);
      let last: Entry | null = null;
      for (let i = tail.length - 1; i >= 0; i -= 1) {
        if (isMessage(tail[i])) {
          last = tail[i];
          break;
        }
      }
      if (!last) continue;
      // 最后一条是我发的（回执 / 回信）时 `last.from` 是我，`from` 为 null：
      // 这时候只有通讯录还记着他的名字，不回退就会把 uuid 前 8 位当昵称显示。
      const known =
        byId.get(nodeId) ??
        byContact.get(nodeId) ??
        byId.get(last.from.nodeId) ??
        byContact.get(last.from.nodeId);
      const from = last.from.nodeId === nodeId ? last.from : null;
      const meta = input.meta(nodeId);
      // 未读 = 对方发来的**消息**：文本与文件都算（D300 之后文件谁都能发，再不计数就会
      // 出现「文件悄悄落在会话里、列表上一点动静都没有」）。回执与撤回记录不算。
      let unread = 0;
      for (const entry of tail) {
        if (!isMessage(entry)) continue;
        if (entry.from.nodeId === input.me) continue;
        if (meta.readAt !== undefined && !afterWatermark(entry, meta.readAt, meta.readId ?? "")) continue;
        unread += 1;
      }
      const texts = tail.filter((entry) => entry.kind === "text").length;
      out.push({
        nodeId,
        nickname: known?.nickname || from?.nickname || nodeId.slice(0, 8),
        hostname: known?.hostname || from?.hostname || "",
        port: known?.port ?? from?.port ?? 0,
        last,
        count: texts,
        online: byId.has(nodeId),
        status: byId.get(nodeId)?.status ?? (byId.has(nodeId) ? "online" : "offline"),
        lastSeen: byId.get(nodeId)?.lastSeen ?? 0,
        unread,
        pinned: meta.pinned === true,
        muted: meta.muted === true,
        draft: meta.draft ?? "",
        lastMine: last.from.nodeId === input.me,
        sending: input.pending(nodeId),
        typing: input.typing(nodeId),
      });
    }
    return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.last?.at ?? 0) - (a.last?.at ?? 0));
  }
}

/**
 * 一条消息在不在水位之后。
 *
 * 同毫秒没法靠时间区分（uuidv7 的随机位不保证顺序），用 id 字典序兜底：它只在本机一致，
 * 而水位本来也只在本机用 —— 不拿它跟对端对表。
 */
export function afterWatermark(entry: Entry, readAt: number, readId: string): boolean {
  if (entry.at !== readAt) return entry.at > readAt;
  return readId ? entry.id > readId : true;
}
