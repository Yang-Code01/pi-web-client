/**
 * 表格的页面视图（D166/#112）：把 xlsx 家族转成 PDF，前端用 iframe 翻页看。
 *
 * 排队、缓存、两阶段状态、超时这些和幻灯片的站内翻页是同一套东西，已经抽到
 * `docpdf/service.ts`（D209）；这里只剩「用 LibreOffice 转」这一个 driver 和旧的导出面
 * （`sheet_pdf_*` 三个错误码与前端文案都是既成约定，别改名）。
 *
 * 这个文件在非 Windows 机器上也是唯一的页面视图来源，所以 soffice 的查找逻辑原样保留。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPdfService, PdfConvertError, type PdfStatus } from "../docpdf/service.ts";

export type SheetPdfStatus = PdfStatus;

export class SheetPdfError extends PdfConvertError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "SheetPdfError";
  }
}

const TIMEOUT_MS = 180_000;
const MAX_BYTES = 50 * 1024 * 1024;

/** 找 LibreOffice：PI_SOFFICE → Windows 两处安装路径 → PATH 里的 soffice。 */
export function sofficeBinary(): string {
  const env = process.env.PI_SOFFICE;
  if (env && fs.existsSync(env)) return env;
  if (process.platform === "win32") {
    const fixed = [
      path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "LibreOffice", "program", "soffice.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "LibreOffice", "program", "soffice.exe"),
    ];
    for (const p of fixed) if (fs.existsSync(p)) return p;
  }
  return "soffice";
}

/** 转换是子进程：超时/失败要把这一个进程收掉，别留下后台 soffice。 */
let child: { kill: () => void } | null = null;

function runSoffice(args: string[]): Promise<void> {
  const exe = sofficeBinary();
  return new Promise((resolve, reject) => {
    const proc = execFile(
      exe,
      args,
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        child = null;
        const said = `${String(stdout ?? "")} ${String(stderr ?? "")}`.trim();
        if (!err) {
          resolve();
          return;
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          reject(new SheetPdfError("sheet_pdf_soffice", `找不到 LibreOffice（${exe}）`));
          return;
        }
        if (code === "ETIMEDOUT" || (err as Error).message.includes("timed out")) {
          reject(new SheetPdfError("sheet_pdf_timeout", `转换超时（${TIMEOUT_MS / 1000} 秒）`));
          return;
        }
        reject(new SheetPdfError("sheet_pdf_failed", `LibreOffice 退出码 ${(err as any).code ?? "?"}：${said.slice(-300)}`));
      },
    );
    child = proc;
  });
}

async function convertWithSoffice(abs: string, workDir: string): Promise<string | undefined> {
  const profile = path.join(workDir, "profile");
  await fs.promises.mkdir(profile, { recursive: true });
  await runSoffice([
    "--headless",
    "--norestore",
    "--nolockcheck",
    "--nodefault",
    "--convert-to",
    "pdf",
    "--outdir",
    workDir,
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    abs,
  ]);
  const names = (await fs.promises.readdir(workDir)).filter((n) => n.toLowerCase().endsWith(".pdf"));
  return names.length ? path.join(workDir, names[0]) : undefined;
}

const service = createPdfService({
  dir: "sheet-pdf",
  prefix: "sheet_pdf",
  engine: {
    label: "LibreOffice",
    convert: convertWithSoffice,
    kill: () => child?.kill(),
  },
  timeoutMs: TIMEOUT_MS,
  maxBytes: MAX_BYTES,
});

export function sheetPdfKey(abs: string, mtimeMs: number): string {
  return service.keyOf(abs, mtimeMs);
}

export function sheetPdfStatus(abs: string, mtimeMs: number, retry = false): Promise<SheetPdfStatus> {
  return service.status(abs, mtimeMs, retry);
}

export function sheetPdfFile(id: string): Promise<{ file: string } | null> {
  return service.file(id);
}
