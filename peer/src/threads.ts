import { quarantineStateFile, readJsonChecked, statePath, writeJson } from "./config.ts";

/**
 * 会话元数据（D299 / P1）：置顶、静音、草稿、已读水位。
 *
 * 为什么不塞进 `history/<nodeId>.jsonl`：那些行是**消息**，append-only；这四样是
 * **我对这个人的看法**，会被反复改写。写进 append-only 的文件只能靠「后一条盖前一条」，
 * 读一次要扫全量才能知道现在的值。单独一份小 json，改一次写一次，读的时候是一次 stat。
 *
 * 水位是 `{readAt, readId}` 而不是一个时间戳：`uuidv7` 同一毫秒内剩余位是随机的
 * （`peer/src/messages.ts` 的注释已经写了），单键会让同一毫秒里后到的那条永远算未读。
 */
export interface ThreadMeta {
  readAt?: number;
  readId?: string;
  pinned?: boolean;
  muted?: boolean;
  draft?: string;
}

/** 草稿上限与一条消息同（32 KB）：存得下的才发得出去。 */
export const MAX_DRAFT_BYTES = 32 * 1024;

function safeName(nodeId: string): boolean {
  return typeof nodeId === "string" && nodeId.length > 0 && nodeId.length < 200;
}

export class Threads {
  private map: Record<string, ThreadMeta> = {};
  /** 旧文件读不出来且没能留档时，拒绝落盘 —— 不能拿空表覆盖它。 */
  private blocked = false;

  constructor(private readonly log: (msg: string) => void) {
    this.load();
  }

  private file(): string {
    return statePath("threads.json");
  }

  private load(): void {
    const res = readJsonChecked<unknown>(this.file(), {});
    if (!res.ok) {
      const bak = quarantineStateFile(this.file());
      this.blocked = !bak;
      this.map = {};
      this.log(`会话元数据读失败（${res.error ?? "?"}）${bak ? `，已备份到 ${bak}` : "，备份失败，暂停落盘"}`);
      return;
    }
    const raw = res.value;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      const bak = quarantineStateFile(this.file());
      this.blocked = !bak;
      this.map = {};
      this.log(`会话元数据内容不是对象${bak ? `，已备份到 ${bak}` : "，备份失败，暂停落盘"}`);
      return;
    }
    this.map = raw as Record<string, ThreadMeta>;
  }

  private save(): void {
    if (this.blocked) return;
    try {
      writeJson(this.file(), this.map);
    } catch (err) {
      this.log(`会话元数据落盘失败：${(err as Error).message}`);
    }
  }

  get(nodeId: string): ThreadMeta {
    return this.map[nodeId] ?? {};
  }

  all(): Record<string, ThreadMeta> {
    return this.map;
  }

  /** 只写点名的字段；`undefined` 表示「不改」，`null` 表示「删掉这个字段」。 */
  patch(nodeId: string, patch: Partial<Record<keyof ThreadMeta, unknown>>): ThreadMeta {
    if (!safeName(nodeId)) return {};
    const prev = this.map[nodeId] ?? {};
    const next: ThreadMeta = { ...prev };
    for (const key of ["readAt", "readId", "pinned", "muted", "draft"] as const) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value === null || value === undefined) delete next[key];
      else (next as Record<string, unknown>)[key] = value;
    }
    if (Object.keys(next).length === 0) delete this.map[nodeId];
    else this.map[nodeId] = next;
    this.save();
    return this.get(nodeId);
  }

  setRead(nodeId: string, read: { at: number; id: string }): ThreadMeta {
    return this.patch(nodeId, { readAt: read.at, readId: read.id });
  }

  setDraft(nodeId: string, text: string): ThreadMeta {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_DRAFT_BYTES) throw new Error("草稿太长");
    return this.patch(nodeId, { draft: text || null });
  }

  remove(nodeId: string): void {
    if (!this.map[nodeId]) return;
    delete this.map[nodeId];
    this.save();
  }
}
