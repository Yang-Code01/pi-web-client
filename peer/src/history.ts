import fs from "node:fs";
import path from "node:path";
import { statePath } from "./config.ts";

/**
 * 一条消息 / 一条回执，就是 JSONL 里的一行（D97）。
 *
 * 为什么不复用 pi 的会话格式：`bridge/src/sessionfile.ts` 解析的是 pi 自己的
 * `SessionHeader`/`SessionEntry`，字段含义都不一样；硬套只会在对方升级时炸在自己这边。
 * 这里的 schema 只有六个字段，v1.1 加群聊时 `to.kind` 和 `kind` 已经留好位置。
 */
export type EntryKind = "text" | "receipt" | "file";

export interface PeerIdentity {
  nodeId: string;
  nickname?: string;
  hostname?: string;
  port?: number;
}

export interface Entry {
  id: string;
  at: number;
  from: PeerIdentity;
  to: { kind: "node" | "group"; id: string };
  kind: EntryKind;
  text?: string;
  ack?: { id: string; status: "delivered" | "failed"; error?: string };
  /** `kind:"file"` 的元数据。文件本体不在历史里，只留一份能被 UI 画成卡片的描述（D106）。 */
  file?: { name: string; size: number; mime: string; sha256?: string };
  /** 谁写的这条消息：`"pi"` = 由 pi（agent）代发，界面挂 🤖 徽章（决定 33）。 */
  via?: "pi";
}

export interface ThreadSummary {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  last: Entry | null;
  count: number;
  online: boolean;
}

const TAIL_BYTES = 512 * 1024;

function safeName(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9_-]/g, "_");
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

  /** 补投前查重：最近 2000 条就够了，不需要单独的状态文件（决定 3）。 */
  recentIds(nodeId: string, count = 2000): Set<string> {
    return new Set(this.read(nodeId, count).map((entry) => entry.id));
  }

  /** 会话列表。名字优先用查得到的人：在线表 → 通讯录 → 最后一条的 from。 */
  threads(
    online: { nodeId: string; nickname: string; hostname: string; port: number }[],
    contacts: { nodeId: string; nickname: string; hostname: string; port: number }[] = [],
  ): ThreadSummary[] {
    const byId = new Map(online.map((peer) => [peer.nodeId, peer]));
    const byContact = new Map(contacts.map((contact) => [contact.nodeId, contact]));
    let files: string[] = [];
    try {
      files = fs.readdirSync(statePath("history")).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const out: ThreadSummary[] = [];
    for (const name of files) {
      const nodeId = name.slice(0, -".jsonl".length);
      const tail = this.read(nodeId, 20);
      const last = tail.at(-1) ?? null;
      let lastText = last;
      for (let i = tail.length - 1; i >= 0; i -= 1) {
        if (tail[i].kind === "text") {
          lastText = tail[i];
          break;
        }
      }
      // 最后一条是我发的（回执 / 回信）时 `last.from` 是我，`from` 为 null：
      // 这时候只有通讯录还记着他的名字，不回退就会把 uuid 前 8 位当昵称显示。
      const known =
        byId.get(nodeId) ??
        byContact.get(nodeId) ??
        byId.get(last?.from.nodeId ?? "") ??
        byContact.get(last?.from.nodeId ?? "");
      const from = last?.from.nodeId === nodeId ? last.from : null;
      const all = this.read(nodeId, 2000).filter((entry) => entry.kind === "text");
      out.push({
        nodeId,
        nickname: known?.nickname || from?.nickname || nodeId.slice(0, 8),
        hostname: known?.hostname || from?.hostname || "",
        port: known?.port ?? from?.port ?? 0,
        last: lastText,
        count: all.length,
        online: byId.has(nodeId),
      });
    }
    return out.sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));
  }
}
