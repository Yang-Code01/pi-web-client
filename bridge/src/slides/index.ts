/**
 * 幻灯片的站内翻页（D209）：把 pptx/ppt 家族导出成 PDF，前端用 iframe 一页一页翻。
 *
 * 和表格的页面视图共用 `docpdf/service.ts`（排队 + 缓存 + 两阶段 + 失败记录），这里只提供
 * driver（PowerPoint COM）、页数粗筛和对外导出面。缓存目录与表格的分开（`slides-pdf`），
 * 并且**会清理**（保 50 份 / 7 天）——表格那份的历史缓存一直没人清，别再复制这个坑。
 */
import { createPdfService, PdfConvertError, type PdfStatus } from "../docpdf/service.ts";
import { countSlides } from "./pages.ts";
import { convertWithPowerpoint, killPowerpoint, MAX_PAGES, probePowerpoint } from "./powerpoint.ts";

export type SlidesPdfStatus = PdfStatus;

export class SlidesPdfError extends PdfConvertError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "SlidesPdfError";
  }
}

const MAX_BYTES = 50 * 1024 * 1024;

const service = createPdfService({
  dir: "slides-pdf",
  prefix: "slides_pdf",
  engine: {
    label: "PowerPoint",
    available: () => probePowerpoint().available,
    missingMessage: () =>
      process.platform === "win32"
        ? "这台机器没装 PowerPoint（或 COM 没注册），打不开站内翻页"
        : "站内翻页需要 Windows 上的 PowerPoint",
    convert: convertWithPowerpoint,
    kill: killPowerpoint,
  },
  timeoutMs: 180_000,
  maxBytes: MAX_BYTES,
  // 页数上限先数包（几毫秒），别为了一个 500 页的稿子把 PowerPoint 转十分钟再拒。
  precheck: async (abs) => {
    const pages = await countSlides(abs);
    if (pages !== null && pages > MAX_PAGES) {
      return { code: "slides_pdf_pages", message: `这份演示文稿有 ${pages} 页，超过 ${MAX_PAGES} 页上限` };
    }
    return null;
  },
  retain: { count: 50, days: 7 },
});

export function slidesPdfKey(abs: string, mtimeMs: number): string {
  return service.keyOf(abs, mtimeMs);
}

export function slidesPdfStatus(abs: string, mtimeMs: number, retry = false): Promise<SlidesPdfStatus> {
  return service.status(abs, mtimeMs, retry);
}

export function slidesPdfFile(id: string): Promise<{ file: string } | null> {
  return service.file(id);
}

/** 本机能不能站内翻页：没装 PowerPoint 就提前说，别让人卡在「正在生成」。 */
export function slidesAvailable(): boolean {
  return service.available();
}

/** 启动时探一次，把这个结果打进日志（排错时第一眼看的就是它）。 */
export function slidesProbe(): { available: boolean; exe: string | null } {
  return probePowerpoint(true);
}

export { countSlides, MAX_PAGES };
