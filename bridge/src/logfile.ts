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

/** 一个窗口就是一秒。 */
const STORM_WINDOW_MS = 1000;
/** 一秒内超过这么多行就当风暴。正常一份桥一天几百行，这个阀值是「差了三个数量级」的位置。 */
export const DEFAULT_MAX_LINES_PER_SECOND = 500;

/** 样本行截多长：够认出是哪一条在刷就行。 */
const SAMPLE_CHARS = 200;

/**
 * 日志风暴罩子：把「事件循环里顺手写一行」和「同一个循环失控地写一万行」分开。
 *
 * 为什么需要它（除了轮转已经管住的盘）：`log()` 写盘是 `appendFileSync`，**同步**的。
 * 实测有一份桥日志 50 分钟长到 17 GB，折下来 1500 行/秒 —— 那不是占多少盘的问题，
 * 是每个事件循环里多了一次同步系统调用，桥自己先卡死。轮转只能把磁盘封在 16 MB，
 * 但 1500 次/秒的同步写还在。所以这里在「写」之前先算频率：
 *
 * - 一秒内超过 `maxPerSecond` 行 → 写**一条**`⚠️ 日志风暴`摘要（带样本行的前 200 字符），
 *   之后的每一行只计数、不碰盘、不碰 stdout。
 * - 某个窗口降回到阀值一半以下 → 写一条`⚠️ 日志风暴结束`，带上吞掉多少行、持续多久、
 *   最后一条是什么，然后恢复正常逐行写。
 *
 * 被吞掉的行不丢诊断价值：下一次再出这事，文件里留着「什么形状的行、什么速率、持续多久」，
 * 正是要查的东西；而逐条留下 4 百万行副本本来也没人看。`maxPerSecond = 0` 关掉整个罩子。
 */
export class LogStorm {
  private readonly sink: (line: string) => void;
  private readonly maxPerSecond: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private started = false;
  private windowStart = 0;
  /** 当前窗口里已经过去的行数（含被吞的）。 */
  private count = 0;
  private storming = false;
  private stormStart = 0;
  private suppressed = 0;
  private firstSample = "";
  private lastSample = "";
  /** 风暴期间按窗口重排的定时器：不打这个，刷了一阵之后彻底安静下来的桥就永远写不出结尾那一行。 */
  private timer: unknown = null;

  constructor(
    sink: (line: string) => void,
    maxPerSecond: number = DEFAULT_MAX_LINES_PER_SECOND,
    opts: { now?: () => number; schedule?: (fn: () => void, ms: number) => unknown; cancel?: (handle: unknown) => void } = {},
  ) {
    this.sink = sink;
    this.maxPerSecond = maxPerSecond;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    });
    this.cancel = opts.cancel ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** 外面写日志只有这一个入口；风暴自己产生的摘要行不进这里，直接落 sink。 */
  write(line: string): void {
    if (this.maxPerSecond <= 0) {
      this.sink(line);
      return;
    }
    const t = this.now();
    this.advance(t);
    if (this.storming) {
      // 风暴里的行不进 sink，但**计数不能停**：不然下一个窗口永远是 0 行，
      // 罩子会以为「已经安静了」马上关门，而实际上还在刷。
      this.suppressed += 1;
      this.count += 1;
      this.lastSample = clip(line);
      return;
    }
    this.count += 1;
    if (this.count > this.maxPerSecond) {
      this.storming = true;
      this.stormStart = t;
      this.suppressed = 1;
      this.firstSample = clip(line);
      this.lastSample = this.firstSample;
      this.sink(`⚠️ 日志风暴：一秒内超过 ${this.maxPerSecond} 行，接下来只计数不逐条写（样本：${this.firstSample}）`);
      this.arm();
      return;
    }
    this.sink(line);
  }

  /** 推进窗口；一个窗口过去就看看上一轮是不是已经安静了。 */
  private advance(t: number): void {
    if (!this.started) {
      this.started = true;
      this.windowStart = t;
      return;
    }
    if (t - this.windowStart < STORM_WINDOW_MS) return;
    const previous = this.count;
    this.windowStart = t;
    this.count = 0;
    // 风暴里：只有窗口真的降下来才收工。阀值一半给的是「抖一下别结束」的余量。
    if (this.storming && previous <= Math.floor(this.maxPerSecond / 2)) this.endStorm(t);
  }

  private arm(): void {
    if (this.timer !== null) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.advance(this.now());
      if (this.storming) this.arm();
    }, STORM_WINDOW_MS);
  }

  private endStorm(t: number): void {
    const seconds = Math.max(0.1, (t - this.stormStart) / 1000);
    const sunk = this.suppressed;
    this.storming = false;
    this.suppressed = 0;
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.sink(`⚠️ 日志风暴结束：${seconds.toFixed(1)} 秒里吞掉 ${sunk} 行（最后一条：${this.lastSample || this.firstSample}）`);
  }
}

function clip(line: string): string {
  return line.length > SAMPLE_CHARS ? `${line.slice(0, SAMPLE_CHARS)}…` : line;
}

/** `PI_WEB_LOG_MAX_LINES_PER_S`：正整数改阀值，`0` 关掉风暴罩子；读不懂就用默认值。 */
export function logMaxLinesPerSecond(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.PI_WEB_LOG_MAX_LINES_PER_S ?? "").trim();
  if (!raw) return DEFAULT_MAX_LINES_PER_SECOND;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : DEFAULT_MAX_LINES_PER_SECOND;
}
