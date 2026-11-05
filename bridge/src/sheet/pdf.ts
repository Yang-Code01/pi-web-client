/**
 * 页面视图（#112）：让 LibreOffice 把整个工作簿排成一张 PDF。
 *
 * 一次转换只有一份 PDF（所有 sheet 共用），按 path+mtime 缓存；同一个文件同时来两次只转一次。
 * 独立的 UserInstallation 配置目录：不碰用户自己的 LibreOffice 配置，也不会互相抢锁。
 * 转换失败只让页面视图报错，网格不受影响。
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

export interface SheetPdfFile {
  file: string;
  /** 这次请求是命中缓存（没有真的跑 LibreOffice）。 */
  cached: boolean;
}

const TIMEOUT_MS = 180_000;
const inflight = new Map<string, Promise<string>>();
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

export async function sheetPdf(abs: string, mtimeMs: number): Promise<SheetPdfFile> {
  const dir = statePath("sheet-pdf");
  await fs.promises.mkdir(dir, { recursive: true });
  const key = crypto.createHash("sha256").update(`${abs}\0${mtimeMs}`).digest("hex");
  const out = path.join(dir, `${key}.pdf`);
  if (await isPdf(out)) return { file: out, cached: true };

  const pending = inflight.get(key);
  if (pending) return { file: await pending, cached: true };

  const job = serialized(() => convert(abs, out)).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return { file: await job, cached: false };
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
      done(new SheetPdfError("sheet_pdf_failed", `转换超时（${TIMEOUT_MS / 1000} 秒）`));
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
