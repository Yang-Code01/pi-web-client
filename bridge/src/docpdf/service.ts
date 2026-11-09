/**
 * 文件 → PDF 的共用设施（D209）：排队、缓存、两阶段状态、失败记录、超时、临时目录、`%PDF-` 校验。
 *
 * 表格的页面视图（LibreOffice，D166/#112）与幻灯片的站内翻页（PowerPoint，D209）是同一套东西，
 * 不同的只有「用哪个程序把文件转成 PDF」，那一点做成 driver（`engine`）。
 *
 * 两阶段契约：`status()` 命中缓存直接 ready；否则把转换丢到后台、立刻回 pending；前端轮询状态，
 * ready 之后再去 GET 字节。转换在后台跑，不占住那条请求。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { statePath } from "../paths.ts";

export class PdfConvertError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PdfConvertError";
    this.code = code;
  }
}

export interface PdfStatus {
  id: string;
  status: "ready" | "pending" | "failed";
  error?: string;
  code?: string;
}

/** 一个「能把文件转成 PDF」的程序。转换失败自己抛 PdfConvertError（带自己的码）。 */
export interface ConvertEngine {
  /** 出现在兜底文案里的名字（"LibreOffice" / "PowerPoint"）。 */
  label: string;
  /** 装没装；返回 false 就不启动转换，直接回 failed。不给 = 总是有。 */
  available?: () => boolean;
  /** 缺程序时的文案；不给就按 `没装 ${label}` 说。 */
  missingMessage?: () => string;
  /** 把 abs 转成 workDir 里的一个 PDF：返回产物路径，或 undefined（取 workDir 里唯一/第一个 .pdf）。 */
  convert: (abs: string, workDir: string) => Promise<string | undefined>;
  /** 超时时收拾残局（杀掉自己起的进程）。默认什么也不做。 */
  kill?: () => void;
}

export interface PdfServiceOptions {
  /** `statePath()` 下的目录名：缓存、临时目录、driver 的私有数据都住这。 */
  dir: string;
  /** 错误码前缀：`${prefix}_failed` / `${prefix}_timeout` / `${prefix}_missing`。 */
  prefix: string;
  engine: ConvertEngine;
  timeoutMs?: number;
  /** 超过就不转（字节）。 */
  maxBytes?: number;
  /** 更细的粗筛（比如 pptx 的页数）：返回错误码与文案就拒，不启动 driver。可以慢，转换开始前只此一次。 */
  precheck?: (
    abs: string,
    size: number,
  ) => { code: string; message: string } | null | Promise<{ code: string; message: string } | null>;
  /** 转完清一次缓存：保最近 count 份、days 天之内。不给就不清理（老行为）。 */
  retain?: { count: number; days: number };
}

export interface PdfService {
  /** path+mtime 的稳定 id：既是缓存文件名，也是状态/字节两个端点之间的握手钥匙。 */
  keyOf: (abs: string, mtimeMs: number) => string;
  status: (abs: string, mtimeMs: number, retry?: boolean) => Promise<PdfStatus>;
  file: (id: string) => Promise<{ file: string } | null>;
  /** driver 装没装（界面据此提前说一句，而不是让人等失败）。 */
  available: () => boolean;
}

const DEFAULT_TIMEOUT_MS = 180_000;

export function createPdfService(opts: PdfServiceOptions): PdfService {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheDir = () => statePath(opts.dir);
  const pdfPath = (key: string) => path.join(cacheDir(), `${key}.pdf`);
  const codes = {
    failed: `${opts.prefix}_failed`,
    timeout: `${opts.prefix}_timeout`,
    missing: `${opts.prefix}_missing`,
  };

  const inflight = new Map<string, Promise<unknown>>();
  /** 转换失败的记录：状态端点据此回 failed，而不是让前端永远 pending。 */
  const failures = new Map<string, { message: string; code: string }>();
  let queue: Promise<unknown> = Promise.resolve();

  const available = (): boolean => (opts.engine.available ? opts.engine.available() : true);

  async function ensureDir(): Promise<void> {
    await fs.promises.mkdir(cacheDir(), { recursive: true });
  }

  async function status(abs: string, mtimeMs: number, retry = false): Promise<PdfStatus> {
    await ensureDir();
    const key = keyOf(abs, mtimeMs);
    if (await isPdf(pdfPath(key))) {
      failures.delete(key);
      return { id: key, status: "ready" };
    }
    const fail = failures.get(key);
    if (fail) {
      if (!retry) return { id: key, status: "failed", error: fail.message, code: fail.code };
      failures.delete(key); // 显式重试：清掉旧失败，重新转。
    }
    start(key, abs);
    return { id: key, status: "pending" };
  }

  async function file(id: string): Promise<{ file: string } | null> {
    await ensureDir();
    const out = pdfPath(id);
    if (await isPdf(out)) return { file: out };
    const job = inflight.get(id);
    if (!job) return null;
    await job; // 等转换结束（成功/失败都 resolve，失败记在 failures）。
    if (await isPdf(out)) return { file: out };
    const fail = failures.get(id);
    if (fail) throw new PdfConvertError(fail.code, fail.message);
    return null;
  }

  /** 幂等地启动转换：同一个 key 只转一次；失败记进 failures，由状态端点回 failed。 */
  function start(key: string, abs: string): void {
    if (inflight.has(key)) return;
    failures.delete(key); // 重新开始，旧失败作废。
    const out = pdfPath(key);
    const job = serialized(() => convert(abs, out))
      .catch((err) => {
        const e =
          err instanceof PdfConvertError
            ? err
            : new PdfConvertError(codes.failed, String((err as Error)?.message ?? err));
        failures.set(key, { message: e.message, code: e.code });
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
  }

  /** 同一个 driver 一次只该跑一个实例（LibreOffice 抢 profile、PowerPoint 抢 COM）：所有转换排队。 */
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function convert(abs: string, out: string): Promise<string> {
    let size = 0;
    try {
      size = (await fs.promises.stat(abs)).size;
    } catch {
      throw new PdfConvertError(codes.failed, `文件不见了：${abs}`);
    }
    if (opts.maxBytes && size > opts.maxBytes) {
      throw new PdfConvertError(codes.failed, `文件超过 ${Math.round(opts.maxBytes / 1024 / 1024)} MB，转不了`);
    }
    const rejected = opts.precheck ? await opts.precheck(abs, size) : null;
    if (rejected) throw new PdfConvertError(rejected.code, rejected.message);
    if (!available()) {
      throw new PdfConvertError(codes.missing, opts.engine.missingMessage?.() ?? `这台机器没装 ${opts.engine.label}`);
    }

    const root = cacheDir();
    const tmp = await fs.promises.mkdtemp(path.join(root, "tmp-"));
    try {
      const produced = await withTimeout(opts.engine.convert(abs, tmp), timeoutMs);
      const file = produced ?? (await onlyPdf(tmp));
      if (!file) throw new PdfConvertError(codes.failed, `${opts.engine.label} 没有生成 PDF`);
      if (!(await isPdf(file))) throw new PdfConvertError(codes.failed, `${opts.engine.label} 生成的文件不是 PDF`);
      await fs.promises.rename(file, out);
      void prune();
      return out;
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function withTimeout<T>(job: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        opts.engine.kill?.();
        reject(new PdfConvertError(codes.timeout, `转换超时（${ms / 1000} 秒）`));
      }, ms);
    });
    // 转换被放弃之后它自己的失败不该变成 unhandledRejection。
    job.catch(() => undefined);
    try {
      return await Promise.race([job, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function onlyPdf(dir: string): Promise<string | null> {
    const names = (await fs.promises.readdir(dir)).filter((n) => n.toLowerCase().endsWith(".pdf"));
    return names.length ? path.join(dir, names[0]) : null;
  }

  /** 缓存不该无限长：按份数与天数各留一手，先到先删。副作用吞掉，转不出来才是大事。 */
  async function prune(): Promise<void> {
    const retain = opts.retain;
    if (!retain) return;
    try {
      const dir = cacheDir();
      const rows: { file: string; at: number }[] = [];
      for (const name of await fs.promises.readdir(dir)) {
        if (!name.endsWith(".pdf")) continue;
        const file = path.join(dir, name);
        const st = await fs.promises.stat(file).catch(() => null);
        if (st) rows.push({ file, at: st.mtimeMs });
      }
      rows.sort((a, b) => b.at - a.at);
      const cutoff = Date.now() - retain.days * 24 * 60 * 60 * 1000;
      for (const [i, row] of rows.entries()) {
        if (i < retain.count && row.at >= cutoff) continue;
        await fs.promises.rm(row.file, { force: true }).catch(() => undefined);
      }
    } catch {
      /* 清理失败不影响这一次转换 */
    }
  }

  function keyOf(abs: string, mtimeMs: number): string {
    return crypto.createHash("sha256").update(`${abs}\0${mtimeMs}`).digest("hex");
  }

  return { keyOf, status, file, available };
}

export async function isPdf(file: string): Promise<boolean> {
  try {
    const fh = await fs.promises.open(file, "r");
    try {
      const head = Buffer.alloc(5);
      await fh.read(head, 0, 5, 0);
      return head.toString("latin1") === "%PDF-";
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** 子进程输出收尾：压成一行，只看最后一段（错误信息别把整份日志端给用户）。 */
export function tail(text: string, max = 300): string {
  return text.replace(/\s+/g, " ").trim().slice(-max);
}
