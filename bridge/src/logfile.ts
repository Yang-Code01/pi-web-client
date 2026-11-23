import fs from "node:fs";

/**
 * append-only 的日志文件，带一个上限：越过上限就把这一代搬成 `<file>.1`（只留一代），
 * 所以一份日志最多占 `2 × maxBytes`。
 *
 * 为什么需要它：`logs/bridge.log` 原来是无脑 `appendFileSync`，没有任何上限。一份连着跑了几小时
 * 的桥（探针 / 测试组尤其容易）能写到 GB 级 —— 实测见过单个 17 GB 的文件，一台 228 GB 的机器上
 * 光这类日志就占了 29 GB。日志是给「刚才发生了什么」用的，超过几十 MB 就既读不了也没人读。
 *
 * 两条规则，看起来不对称，各自对应各自的现场：
 * - **运行中越限**：这一代搬成 `.1`。刚写满的那几十 MB 就是最近的现场，值得留。
 * - **开写时发现已经越限**：直接截断，不搬。那说明这个文件是上一版（没上限的时代）留下的怪物，
 *   或者上一次进程没来得及轮转就被杀了；把它搬成 `.1` 只是把怪物换个名字继续占着盘。
 */
export class RotatingLog {
  private readonly file: string;
  /** `0` / 负数表示不轮转（老行为），环境变量 `PI_WEB_LOG_MAX_BYTES=0` 就是这个意思。 */
  private readonly maxBytes: number;
  private readonly backup: string;
  /** 当前这一代已经写进去多少字节；`null` = 还没读过盘。 */
  private size: number | null = null;

  constructor(file: string, maxBytes: number = DEFAULT_LOG_MAX_BYTES) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.backup = `${file}.1`;
  }

  /** 追加一行（换行由这里补）。写盘失败照旧抛出去，调用方自己决定要不要忽略。 */
  write(line: string): void {
    const text = `${line}\n`;
    if (this.maxBytes <= 0) {
      fs.appendFileSync(this.file, text);
      return;
    }
    const bytes = Buffer.byteLength(text);
    const size = this.measure();
    if (size + bytes > this.maxBytes) {
      if (size > 0) this.rotate();
      this.size = 0;
    }
    fs.appendFileSync(this.file, text);
    this.size = (this.size ?? 0) + bytes;
  }

  /** 第一次写的时候读一次盘（顺带处理「一开门就已经是个怪物」那种）。 */
  private measure(): number {
    if (this.size !== null) return this.size;
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      // 还没有这个文件：就是 0。
    }
    if (size > this.maxBytes) {
      try {
        fs.truncateSync(this.file, 0);
        size = 0;
      } catch {
        // 截断不了（别人占着 / 没权限）：那就当它是满的，下一行先轮转再说。
      }
    }
    this.size = size;
    return size;
  }

  private rotate(): void {
    try {
      fs.renameSync(this.file, this.backup);
    } catch {
      // 改不了名（Windows 上被别的进程打开着就是这样）：退一步，原地截断。
      try {
        fs.truncateSync(this.file, 0);
      } catch {
        // 都不行就算了，日志写不进去不该拖垮桥。
      }
    }
    this.size = 0;
  }
}

/** 一份桥日志的上限。8 MB ≈ 一天忙碌会话的量，翻两页也看得完。 */
export const DEFAULT_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** `PI_WEB_LOG_MAX_BYTES`：正整数改上限，`0` 关掉轮转；读不懂就用默认值。 */
export function logMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.PI_WEB_LOG_MAX_BYTES ?? "").trim();
  if (!raw) return DEFAULT_LOG_MAX_BYTES;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : DEFAULT_LOG_MAX_BYTES;
}
