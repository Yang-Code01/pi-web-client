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
export type EntryKind = "text" | "receipt" | "file" | "recall" | "note" | "react" | "pin" | "sys" | "share" | "share-ack";

/** 群里的系统灰条：谁建了群 / 改了名 / 拉了谁 / 退了群。页面按 `op` 翻译，不落中文原句。 */
export interface SysInfo {
  op: "create" | "rename" | "invite" | "leave";
  actor: string;
  names?: string[];
  name?: string;
}

export interface PeerIdentity {
  nodeId: string;
  nickname?: string;
  hostname?: string;
  port?: number;
  /** 头像 id（见 `avatars.ts`）。没设就是空，页面退回首字母。 */
  avatar?: string;
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

/**
 * 共享卡的文件清单：名字 / 大小 / sha256，`role` 说明它是什么（技能压缩包、会话导出的 md
 * 各自标出来）。本体逐份走文件通道，卡片只带清单（D439）。
 */
export interface ShareFile {
  name: string;
  size: number;
  sha256: string;
  role: "file" | "skill" | "session";
}

/** 共享卡载荷（D439）：四类共用一套字段，`body` 只是截断预览，全文由接收端按需取。 */
export interface SharePayload {
  type: "file" | "snippet" | "skill" | "session";
  title: string;
  summary?: string;
  /** 正文预览（≤8 KB）。文件 / 技能类通常是说明文字，内容 / 会话类是开头一段。 */
  body?: string;
  /** 原文总字节数：卡片据此说「还有更多」。 */
  bodyBytes?: number;
  files: ShareFile[];
  /** 源数据的生成时间（文件的 mtime、会话的更新时间）。 */
  sourceAt?: number;
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
  /** 「重要 / 紧急」（Teams 的传递选项），普通消息不带。 */
  priority?: "important" | "urgent";
  /** 话题回复：话题第一条消息的 id（群里「回复这条话题」）。 */
  topic?: string;
  /** `kind:"recall"` 时指向被撤回的那条消息的 id。 */
  ref?: string;
  /** `kind:"note"` 的记录包（#507）。 */
  note?: NotePayload;
  /** `kind:"share"` 的共享卡（D439）。 */
  share?: SharePayload;
  /** `kind:"share-ack"`：哪个人收了 `ref` 那张卡。 */
  ackBy?: string;
  /** `kind:"react"`：对 `ref` 那条消息点的表情；`on:false` 是取消（同一个人同一个表情最后一条说了算）。 */
  emoji?: string;
  on?: boolean;
  /** `kind:"sys"`：群的系统灰条。 */
  sys?: SysInfo;
}

/** 折叠后挂在消息上的表情回应：每个表情一组，`who` 是点了它的 nodeId（按先后）。 */
export interface Reaction {
  emoji: string;
  who: string[];
}

/**
 * 折叠后的消息：页面只画这一种。
 *
 * `recalled` / `state` / `tries` / `sendError` 都是**视图字段**，从来不落盘 —— 它们由
 * 「后面那条 receipt / recall」与「outbox 里还在排队的 id」现算出来（D299：状态派生、不落盘）。
 */
export interface ViewEntry extends Entry {
  recalled?: boolean;
  reactions?: Reaction[];
  state?: "sending" | "delivered" | "failed";
  /** 还在排队时试过几次（送达到了就不带）。 */
  tries?: number;
  /** 上一次没送到的原因，原样是网络错误那串字（`fetch` 的 `The operation was aborted…`）。 */
  sendError?: string;
  /** 被谁固定在会话顶上（`kind:"pin"` 折叠出来的，最后一条说了算）。 */
  pinned?: { by: string; at: number };
  /** 不在这一页里、只因为被固定才带上的早期消息：页面只拿它画顶上的固定条，不进消息流。 */
  outside?: boolean;
  /** 我发的消息：哪些人已读（nodeId）。 */
  readBy?: string[];
  /** 我发的共享卡：谁点了接收（nodeId，按先后；由 `share-ack` 折叠出来）。 */
  acceptedBy?: string[];
}

/** 排队中的那条现在什么情况：重试过几次、上一次说了什么。 */
export interface PendingInfo {
  tries?: number;
  error?: string;
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
  /** 头像 id：在线表里的最新值优先，离线时用通讯录里存下的。 */
  avatar: string;
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
  /** 未读里有标「紧急」的消息：免打扰也照样提醒。 */
  urgent: boolean;
  /** 未读里有人 @ 我（或 @所有人）：免打扰也照样提醒。 */
  mention: boolean;
  /** 群会话才有：成员、群主、我是不是已经退出。 */
  group?: { members: PeerIdentity[]; owner: string; left: boolean };
}

const TAIL_BYTES = 512 * 1024;

/** 这段文字有没有 @ 到我（`@所有人` 也算）。正文可能是富文本 HTML，先剥标签。 */
export function mentioned(text: string, name: string | undefined): boolean {
  const plain = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  if (plain.includes("@所有人")) return true;
  return Boolean(name) && plain.includes(`@${name}`);
}

function safeName(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 视图里要显示的三种「一条消息」：回执不占位，撤回也不单独占位（它把原气泡换掉）。 */
function isMessage(entry: Entry): boolean {
  return entry.kind === "text" || entry.kind === "file" || entry.kind === "note" || entry.kind === "share";
}

/**
 * 把 receipt / recall 折叠进它们指向的消息（D299 / P2）。
 *
 * - receipt → 给原消息挂 `ack`（同一条消息被重投多次时**最后一条回执说了算**）；
 * - recall → 把原消息标成 `recalled`，页面画成灰条；撤回记录本身不进消息流；
 * - `pending` 里的 id → `state:"sending"`，其余已送达的标 `delivered`；
 * - `why` 里的 id 再带上 `tries` / `sendError`：光说「发送中」等于不说，用户看不出是
 *   在等对方上线，还是对方的端口根本连不上（两种都可能是真的）。
 *
 * 不落盘、不改历史文件：同一份 JSONL 在旧版本里读出来还是它原来的样子。
 */
export function foldEntries(entries: Entry[], me: string, pending: Set<string>, why?: Map<string, PendingInfo>): ViewEntry[] {
  const byId = new Map<string, ViewEntry>();
  const out: ViewEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "text" || entry.kind === "file" || entry.kind === "note" || entry.kind === "share" || entry.kind === "sys") {
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
    if (entry.kind === "share-ack" && entry.ref && entry.ackBy) {
      const target = byId.get(entry.ref);
      if (target) {
        const list = target.acceptedBy ?? [];
        if (!list.includes(entry.ackBy)) target.acceptedBy = [...list, entry.ackBy];
      }
    }
    if (entry.kind === "recall" && entry.ref) {
      const target = byId.get(entry.ref);
      if (target) target.recalled = true;
    }
    if (entry.kind === "react" && entry.ref && entry.emoji) {
      const target = byId.get(entry.ref);
      if (target) applyReaction(target, entry.from.nodeId, entry.emoji, entry.on !== false);
    }
    if (entry.kind === "pin" && entry.ref) {
      const target = byId.get(entry.ref);
      if (target) {
        if (entry.on === false) delete target.pinned;
        else target.pinned = { by: entry.from.nodeId, at: entry.at };
      }
    }
  }
  for (const view of out) {
    if (view.pinned && view.recalled) delete view.pinned;
    if (view.from.nodeId !== me || view.kind === "sys") continue;
    if (pending.has(view.id)) {
      view.state = "sending";
      const info = why?.get(view.id);
      if (info?.tries) view.tries = info.tries;
      if (info?.error) view.sendError = info.error;
    } else if (view.ack?.status === "failed") view.state = "failed";
    else if (view.ack?.status === "delivered") view.state = "delivered";
  }
  return out;
}

/** 同一个人对同一个表情：点了就加（不重复），取消就摘；一组空了就整组拿掉。 */
function applyReaction(target: ViewEntry, who: string, emoji: string, on: boolean): void {
  const list = target.reactions ?? [];
  let group = list.find((r) => r.emoji === emoji);
  if (on) {
    if (!group) {
      group = { emoji, who: [] };
      list.push(group);
    }
    if (!group.who.includes(who)) group.who.push(who);
  } else if (group) {
    group.who = group.who.filter((x) => x !== who);
  }
  const kept = list.filter((r) => r.who.length > 0);
  if (kept.length) target.reactions = kept;
  else delete target.reactions;
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
    online: { nodeId: string; nickname: string; hostname: string; port: number; status?: string; lastSeen: number; avatar?: string }[];
    contacts: { nodeId: string; nickname: string; hostname: string; port: number; avatar?: string }[];
    me: string;
    /** 我的昵称：未读里有没有人 @ 我。 */
    meName?: string;
    meta: (nodeId: string) => ThreadMeta;
    typing: (nodeId: string) => boolean;
    pending: (nodeId: string) => boolean;
    group?: (id: string) => { name: string; members: PeerIdentity[]; owner: string; left?: boolean } | null;
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
      const group = nodeId.startsWith("grp-") ? (input.group?.(nodeId) ?? null) : null;
      // 刚建好的群还没人说话：拿最后一条灰条（「X 创建了群」）占住会话行。
      if (!last && group) last = [...tail].reverse().find((entry) => entry.kind === "sys") ?? null;
      if (!last) continue;
      // 最后一条是我发的（回执 / 回信）时 `last.from` 是我，`from` 为 null：
      // 这时候只有通讯录还记着他的名字，不回退就会把 uuid 前 8 位当昵称显示。
      // 名字先看通讯录：那里是我给他起的备注（D303 改名只改本机），在线表里是他自报的昵称。
      const live = byId.get(nodeId);
      const contact = byContact.get(nodeId);
      const known = contact ?? live ?? byId.get(last.from.nodeId) ?? byContact.get(last.from.nodeId);
      const from = last.from.nodeId === nodeId ? last.from : null;
      const meta = input.meta(nodeId);
      // 未读 = 对方发来的**消息**：文本与文件都算（D300 之后文件谁都能发，再不计数就会
      // 出现「文件悄悄落在会话里、列表上一点动静都没有」）。回执与撤回记录不算。
      let unread = 0;
      let urgent = false;
      let mention = false;
      for (const entry of tail) {
        if (!isMessage(entry)) continue;
        if (entry.from.nodeId === input.me) continue;
        if (meta.readAt !== undefined && !afterWatermark(entry, meta.readAt, meta.readId ?? "")) continue;
        unread += 1;
        if (entry.priority === "urgent") urgent = true;
        if (entry.kind === "text" && mentioned(entry.text ?? "", input.meName)) mention = true;
      }
      const texts = tail.filter((entry) => entry.kind === "text").length;
      const anyOnline = group ? group.members.some((m) => m.nodeId !== input.me && byId.has(m.nodeId)) : false;
      // 群没有「对端状态」这回事：有个成员在线就算在线，全都离线就是离线。
      let status: string;
      if (group) status = anyOnline ? "online" : "offline";
      else status = live ? (live.status ?? "online") : "offline";
      out.push({
        nodeId,
        nickname: group ? group.name : known?.nickname || from?.nickname || nodeId.slice(0, 8),
        hostname: group ? "" : live?.hostname || known?.hostname || from?.hostname || "",
        port: group ? 0 : (live?.port ?? known?.port ?? from?.port ?? 0),
        last,
        count: texts,
        online: group ? anyOnline : byId.has(nodeId),
        status,
        // 头像永远拿最新的：在线表里是他刚报的，离线就显通讯录里存下的（上一次说 hello 时的）。
        avatar: group ? "" : live?.avatar || contact?.avatar || "",
        lastSeen: live?.lastSeen ?? 0,
        unread,
        pinned: meta.pinned === true,
        muted: meta.muted === true,
        draft: meta.draft ?? "",
        lastMine: last.from.nodeId === input.me,
        sending: input.pending(nodeId),
        typing: input.typing(nodeId),
        urgent,
        mention,
        ...(group ? { group: { members: group.members, owner: group.owner, left: group.left === true } } : {}),
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
export function afterWatermark(entry: Pick<Entry, "at" | "id">, readAt: number, readId: string): boolean {
  if (entry.at !== readAt) return entry.at > readAt;
  return readId ? entry.id > readId : true;
}
