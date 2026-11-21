import fs from "node:fs";
import path from "node:path";

/** 一个会话最后一次上报的用量；字段跟着 provider 走，壳不解释，只记账。 */
export interface SessionUsage {
  input?: number;
  output?: number;
  total?: number;
  cost?: number;
  updatedAt: string;
}

/**
 * 用量账本：只追加、不修改，跨换代与整组重启都在。
 *
 * 为什么放在壳里：脑每换一代，它内存里那点累计值就没了；而「这个会话到今天用掉多少」
 * 是用户看得到的数字，不能因为一次热部署就归零。壳是这里唯一长期活着的进程。
 *
 * 记的是「某个会话最后一次上报的值」而不是增量：脑上报的本来就是累计值，
 * 重放时后写的覆盖先写的即可，不需要做加法，也就不会因为重发一次而多算。
 */
export class UsageLedger {
  private file: string;
  private map = new Map<string, SessionUsage>();
  private bytes = 0;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  get size(): number {
    return this.map.size;
  }

  get(sessionId: string): SessionUsage | undefined {
    return this.map.get(sessionId);
  }

  snapshot(): Record<string, SessionUsage> {
    return Object.fromEntries(this.map);
  }

  /** 记一笔。写不进去只记日志，不影响会话本身。 */
  record(sessionId: string, usage: SessionUsage, log: (message: string) => void = () => {}): void {
    this.map.set(sessionId, usage);
    const line = `${JSON.stringify({ s: sessionId, u: usage })}\n`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, line);
      this.bytes += Buffer.byteLength(line);
    } catch (err) {
      log(`账本写不进去：${String((err as Error).message ?? err)}`);
    }
  }

  /** 超过阈值就压一遍：只留每个会话的最后一条。 */
  compactIfBig(maxBytes = 1024 * 1024): boolean {
    if (this.bytes <= maxBytes) return false;
    return this.compact();
  }

  compact(): boolean {
    const lines = [...this.map].map(([s, u]) => `${JSON.stringify({ s, u })}\n`);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, lines.join(""));
      this.bytes = Buffer.byteLength(lines.join(""));
      return true;
    } catch {
      return false;
    }
  }

  private load(): void {
    let text = "";
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    this.bytes = Buffer.byteLength(text);
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as { s?: string; u?: SessionUsage };
        if (row.s && row.u) this.map.set(row.s, row.u);
      } catch {
        /* 半截行（上次没写完）跳过就好 */
      }
    }
  }
}
