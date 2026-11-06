/**
 * 页面视图（#112）：让 LibreOffice 把整个工作簿排成一张 PDF。
 *
 * 一次转换只有一份 PDF（所有 sheet 共用），按 path+mtime 缓存；同一个文件同时来两次只转一次。
 * 独立的 UserInstallation 配置目录：不碰用户自己的 LibreOffice 配置，也不会互相抢锁。
 * 转换失败只让页面视图报错，网格不受影响。
 *
 * 两阶段契约（spec）：POST 状态端点返回「生成中」的 id，转换在后台跑，不占住那条请求；
 * 前端轮询状态，等 ready 再从 GET 字节端点取 PDF。
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { statePath } from "../paths.ts";

export class SheetPdfError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SheetPdfError";
    this.code = code;
  }
}

export interface SheetPdfStatus {
  id: string;
  status: "ready" | "pending" | "failed";
  error?: string;
  code?: string;
}

const TIMEOUT_MS = 180_000;
const inflight = new Map<string, Promise<unknown>>();
/** 转换失败的记录：状态端点据此回 failed，而不是让前端永远 pending。 */
const failures = new Map<string, { message: string; code: string }>();
let queue: Promise<unknown> = Promise.resolve();
let binary: string | null = null;

/** 找 soffice：环境变量优先（测试用坏路径模拟「没装」），Windows 走默认安装目录。 */
export function sofficeBinary(): string {
  if (binary) return binary;
  const env = (process.env.PI_SOFFICE ?? "").trim();
  if (env) return (binary = env);
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\LibreOffice\\program\\soffice.com",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com",
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return (binary = candidate);
    }
  }
  return (binary = "soffice");
}

/** path+mtime 的稳定 id：既是缓存文件名，也是状态/字节两个端点之间的握手钥匙。 */
export function sheetPdfKey(abs: string, mtimeMs: number): string {
  return crypto.createHash("sha256").update(`${abs}\0${mtimeMs}`).digest("hex");
}

function pdfPath(key: string): string {
  return path.join(statePath("sheet-pdf"), `${key}.pdf`);
}

async function ensureDir(): Promise<void> {
  await fs.promises.mkdir(statePath("sheet-pdf"), { recursive: true });
}

/**
 * 问一次状态：命中缓存 → ready；否则启动转换（不阻塞，马上回）→ pending。
 * 前端拿到 pending 就按节奏轮询，直到这里回 ready 再去取字节。
 */
export async function sheetPdfStatus(abs: string, mtimeMs: number, retry = false): Promise<SheetPdfStatus> {
  await ensureDir();
  const key = sheetPdfKey(abs, mtimeMs);
  if (await isPdf(pdfPath(key))) {
    failures.delete(key);
    return { id: key, status: "ready" };
  }
  const fail = failures.get(key);
  if (fail) {
    if (!retry) return { id: key, status: "failed", error: fail.message, code: fail.code };
    failures.delete(key); // 显式重试：清掉旧失败，重新转。
  }
  startPdf(key, abs);
  return { id: key, status: "pending" };
}

/** 取字节：ready → 文件；还在转 → null（前端继续轮询状态）；转失败 → 抛 SheetPdfError。 */
export async function sheetPdfFile(id: string): Promise<{ file: string } | null> {
  await ensureDir();
  const out = pdfPath(id);
  if (await isPdf(out)) return { file: out };
  const job = inflight.get(id);
  if (!job) return null;
  await job; // 等转换结束（成功/失败都 resolve，失败记在 failures）。
  if (await isPdf(out)) return { file: out };
  const fail = failures.get(id);
  if (fail) throw new SheetPdfError(fail.code, fail.message);
  return null;
}

/** 幂等地启动转换：同一个 key 只转一次；失败记进 failures，由状态端点回 failed。 */
function startPdf(key: string, abs: string): void {
  if (inflight.has(key)) return;
  failures.delete(key); // 重新开始，旧失败作废。
  const out = pdfPath(key);
  const job = serialized(() => convert(abs, out))
    .catch((err) => {
      const e = err instanceof SheetPdfError ? err : new SheetPdfError("sheet_pdf_failed", String((err as Error)?.message ?? err));
      failures.set(key, { message: e.message, code: e.code });
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
}

/** LibreOffice 一次只该有一个实例在跑同一个 profile：所有转换排队。 */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function convert(abs: string, out: string): Promise<string> {
  const root = statePath("sheet-pdf");
  const tmp = await fs.promises.mkdtemp(path.join(root, "tmp-"));
  try {
    const profile = path.join(root, "profile");
    await fs.promises.mkdir(profile, { recursive: true });
    await runSoffice([
      "--headless",
      "--norestore",
      "--nolockcheck",
      "--nodefault",
      "--convert-to",
      "pdf",
      "--outdir",
      tmp,
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      abs,
    ]);
    const produced = (await fs.promises.readdir(tmp)).find((name) => name.toLowerCase().endsWith(".pdf"));
    if (!produced) throw new SheetPdfError("sheet_pdf_failed", "LibreOffice 没有生成 PDF");
    const file = path.join(tmp, produced);
    if (!(await isPdf(file))) throw new SheetPdfError("sheet_pdf_failed", "LibreOffice 生成的文件不是 PDF");
    await fs.promises.rename(file, out);
    return out;
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runSoffice(args: string[]): Promise<void> {
  const exe = sofficeBinary();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    timer = setTimeout(() => {
      child.kill();
      done(new SheetPdfError("sheet_pdf_timeout", `转换超时（${TIMEOUT_MS / 1000} 秒）`));
    }, TIMEOUT_MS);
    child.on("error", (err: NodeJS.ErrnoException) => {
      done(
        err.code === "ENOENT"
          ? new SheetPdfError("sheet_pdf_soffice", `找不到 LibreOffice（${exe}）`)
          : new SheetPdfError("sheet_pdf_failed", `启动 LibreOffice 失败：${err.message}`),
      );
    });
    child.on("close", (code) => {
      if (code === 0) done();
      else done(new SheetPdfError("sheet_pdf_failed", `LibreOffice 退出码 ${code}：${tail(stderr || stdout)}`));
    });
  });
}

async function isPdf(file: string): Promise<boolean> {
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

function tail(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(-300);
}
