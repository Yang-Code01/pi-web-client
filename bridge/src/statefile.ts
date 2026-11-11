import { readJsonChecked, writeJson } from "./paths.ts";

export interface StateFailure {
  /** 状态文件的绝对路径（只出现在日志与本地通知里）。 */
  file: string;
  /** 读失败的原因，原样来自 fs / JSON.parse。 */
  error: string;
}

/**
 * 一个「读-改-写」的 JSON 状态文件。
 *
 * 为什么不是「开机读一次、之后只写内存」：一次瞬时读失败（杀毒软件独占、EBUSY、写了一半的文件）
 * 会让内存里这份从**空状态**长出来，下一次写回去就是拿空的覆盖盘上的真实数据 —— 不可逆。
 *
 * 所以每次改动都先重读一遍盘：读到了就以盘为准，把这段时间排队的改动叠上去再落盘；
 * 读不到就**不落盘**，改动留在队列里，等文件恢复可读的那一刻自己接上（和会话的 tailSig 同一个思路）。
 * 失败只报一次（同一句错不重复刷），由调用方决定怎么让用户看见。
 */
export class StateFile<T> {
  private data: T;
  private error: string | null = null;
  private loaded = false;
  /** 读不到盘时攒下来的改动：恢复后按顺序叠到盘上的内容之上。 */
  private pending: Array<(data: T) => void> = [];

  readonly file: string;
  private readonly fallback: T;
  private readonly normalize: (raw: unknown) => T;
  private readonly onError?: (failure: StateFailure) => void;

  constructor(file: string, fallback: T, normalize: (raw: unknown) => T, onError?: (failure: StateFailure) => void) {
    this.file = file;
    this.fallback = fallback;
    this.normalize = normalize;
    this.onError = onError;
    this.data = fallback;
  }

  /** 当前内容（开机第一次调用时才读盘）。读不到时是从默认值长出来的那份，**不要**直接写回去。 */
  value(): T {
    if (!this.loaded) this.reload();
    return this.data;
  }

  /** 上一次读盘失败的原因；null = 最近一次读到了。 */
  lastError(): string | null {
    return this.error;
  }

  /**
   * 改一次并落盘。`fn` 收到的永远是「盘上的内容」——读到了就是新读的，读不到就是当前缓存，
   * 并把同一个 `fn` 记进队列等恢复后重放。返回是否真的写进了文件。
   */
  update(fn: (data: T) => void): boolean {
    fn(this.data);
    // 先入队：读成功时下面要用它按顺序重放，读失败时它就是「恢复后要补的那一笔」。
    this.pending.push(fn);
    const res = this.read();
    if (!res.ok) {
      this.report(res.error);
      return false;
    }
    this.data = res.value;
    for (const op of this.pending) op(this.data);
    this.pending = [];
    this.loaded = true;
    this.error = null;
    this.write();
    return true;
  }

  private reload(): void {
    const res = this.read();
    if (!res.ok) {
      this.report(res.error);
      return;
    }
    this.data = res.value;
    if (this.pending.length) {
      for (const op of this.pending) op(this.data);
      this.pending = [];
      this.write();
    }
    this.loaded = true;
    this.error = null;
  }

  private read(): { ok: true; value: T } | { ok: false; error: string } {
    const res = readJsonChecked<unknown>(this.file, undefined);
    if (!res.ok) return { ok: false, error: res.error ?? "unknown" };
    return { ok: true, value: this.normalize(res.value) };
  }

  private write(): void {
    try {
      writeJson(this.file, this.data);
    } catch {
      /* 状态目录不可写只影响持久化，跟 names.json 一个待遇；内存里的内容仍然是准的。 */
    }
  }

  private report(error: string): void {
    if (error === this.error) return;
    this.error = error;
    this.onError?.({ file: this.file, error });
  }
}
