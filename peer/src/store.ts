import { readJson, statePath, writeJson } from "./config.ts";
import type { ConvId, GroupInfo } from "./model.ts";

/**
 * 会话与群的状态（`state.json`）。
 *
 * 为什么不塞进 JSONL：`seq` / `readSeq` / 草稿 / 置顶是**可变**的当前值，JSONL 只追加，
 * 每改一次追加一行会让文件长得比消息还快。QQ 那边也一样：消息记录读的是
 * `msgSeq`/`unreadCnt` 这些「当前值」，不是回放整条流。
 */
export interface ConvState {
  /** 本会话里出现过的最大 seq：发送时 +1，接收时取 max。 */
  seq: number;
  /** 我已经读到哪个 seq（未读数 = 对方 seq > 它的条数）。 */
  readSeq: number;
  /** 对方读到哪个 seq（我发出的消息 seq <= 它的算已读）。 */
  peerReadSeq: number;
  draft?: { text: string; at: number };
  pinned?: boolean;
  muted?: boolean;
}

export interface StoreFile {
  convs: Record<string, ConvState>;
  groups: Record<string, GroupInfo>;
}

function blank(): ConvState {
  return { seq: 0, readSeq: 0, peerReadSeq: 0 };
}

export class Store {
  private data: StoreFile;

  constructor(private readonly log: (msg: string) => void) {
    const raw = readJson<StoreFile>(statePath("state.json"), { convs: {}, groups: {} });
    this.data = {
      convs: raw.convs && typeof raw.convs === "object" ? raw.convs : {},
      groups: raw.groups && typeof raw.groups === "object" ? raw.groups : {},
    };
  }

  private save(): void {
    try {
      writeJson(statePath("state.json"), this.data);
    } catch (err) {
      this.log(`会话状态落盘失败：${(err as Error).message}`);
    }
  }

  conv(conv: ConvId): ConvState {
    const found = this.data.convs[conv];
    if (!found) return blank();
    return { ...blank(), ...found };
  }

  set(conv: ConvId, patch: Partial<ConvState>): ConvState {
    const next = { ...this.conv(conv), ...patch };
    this.data.convs[conv] = next;
    this.save();
    return next;
  }

  /** 发送前拿一个新的 seq。单调：只增不减。 */
  nextSeq(conv: ConvId): number {
    const seq = this.conv(conv).seq + 1;
    this.set(conv, { seq });
    return seq;
  }

  /** 收到消息后把水位抬到对方的 seq，避免自己下一次发消息用重了。 */
  observeSeq(conv: ConvId, seq: number): void {
    if (seq > this.conv(conv).seq) this.set(conv, { seq });
  }

  markRead(conv: ConvId, seq: number): void {
    if (seq > this.conv(conv).readSeq) this.set(conv, { readSeq: seq });
  }

  peerRead(conv: ConvId, seq: number): void {
    if (seq > this.conv(conv).peerReadSeq) this.set(conv, { peerReadSeq: seq });
  }

  draft(conv: ConvId): { text: string; at: number } | null {
    return this.conv(conv).draft ?? null;
  }

  setDraft(conv: ConvId, text: string): void {
    if (!text) {
      this.data.convs[conv] = { ...this.conv(conv), draft: undefined };
      this.save();
      return;
    }
    this.set(conv, { draft: { text, at: Date.now() } });
  }

  groups(): GroupInfo[] {
    return Object.values(this.data.groups).sort((a, b) => b.createdAt - a.createdAt);
  }

  group(groupId: string): GroupInfo | null {
    return this.data.groups[groupId] ?? null;
  }

  upsertGroup(info: GroupInfo): GroupInfo {
    const prev = this.data.groups[info.groupId];
    const next: GroupInfo = {
      ...info,
      createdAt: prev?.createdAt ?? info.createdAt,
      members: dedupe([...(prev?.members ?? []), ...info.members]),
      name: info.name || prev?.name || info.groupId.slice(0, 8),
    };
    this.data.groups[info.groupId] = next;
    this.save();
    return next;
  }

  removeMember(groupId: string, nodeId: string): void {
    const prev = this.data.groups[groupId];
    if (!prev) return;
    this.data.groups[groupId] = { ...prev, members: prev.members.filter((m: { nodeId: string }) => m.nodeId !== nodeId) };
    this.save();
  }

  dropGroup(groupId: string): void {
    delete this.data.groups[groupId];
    delete this.data.convs[`g:${groupId}`];
    this.save();
  }
}

function dedupe(members: GroupInfo["members"]): GroupInfo["members"] {
  const seen = new Map<string, GroupInfo["members"][number]>();
  for (const member of members) seen.set(member.nodeId, member);
  return [...seen.values()];
}
