import fs from "node:fs";
import { statePath, writeJson } from "./config.ts";

/**
 * 已读回执（Teams 的「已读」）：别人告诉我「我读到了你的哪一条」，按会话 × 成员记一个水位。
 *
 * 不写进 `history/*.jsonl`：读一次就会来一条，往对话里追加只会把历史撑大；而且这里只有
 * 「最新的水位」有意义，和 `threads.json` 一样是一份会被反复改写的小 json。
 * 水位只往前走 —— outbox 补投的旧回执晚到也盖不回去。
 */
export interface ReadMark {
  at: number;
  id: string;
}

export class Reads {
  private map: Record<string, Record<string, ReadMark>> = {};

  constructor(private readonly log: (msg: string) => void) {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath("reads.json"), "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) this.map = raw as Record<string, Record<string, ReadMark>>;
    } catch {
      this.map = {};
    }
  }

  /** 这个会话里谁读到了哪儿（nodeId → 水位）。 */
  of(threadId: string): Record<string, ReadMark> {
    return this.map[threadId] ?? {};
  }

  /** 记下 `who` 读到了 `mark`；比已有的旧就丢掉。返回有没有往前走。 */
  mark(threadId: string, who: string, mark: ReadMark): boolean {
    if (!threadId || !who || !Number.isFinite(mark.at) || !mark.id) return false;
    const prev = this.map[threadId]?.[who];
    if (prev && (prev.at > mark.at || (prev.at === mark.at && prev.id >= mark.id))) return false;
    (this.map[threadId] ??= {})[who] = { at: mark.at, id: mark.id };
    try {
      writeJson(statePath("reads.json"), this.map);
    } catch (err) {
      this.log(`已读回执落盘失败：${(err as Error).message}`);
    }
    return true;
  }
}

/** `entry` 在水位之内（含）：读到了。 */
export function covered(entry: { at: number; id: string }, mark: ReadMark | undefined): boolean {
  if (!mark) return false;
  return entry.at < mark.at || (entry.at === mark.at && entry.id <= mark.id);
}
