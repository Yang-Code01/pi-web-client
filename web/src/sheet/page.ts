/**
 * 页面视图（#112）：iframe 里放 LibreOffice 排出来的 PDF 纸面。
 *
 * 两阶段契约：先 POST 问状态（ready / pending / failed），pending 时按节奏轮询；
 * ready 后 iframe 指向 GET 字节端点。转换在桥端后台跑，不占住这条请求。
 */
import { tr, errText } from "../i18n/index.ts";
import { api } from "../api.ts";

const POLL_MS = 1500;
const POLL_DEADLINE_MS = 190_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SheetPage {
  readonly root: HTMLElement;
  private readonly token: string;
  private state: "idle" | "loading" | "ready" | "error" = "idle";
  private loadTimer = 0;

  constructor(token: string) {
    this.token = token;
    this.root = document.createElement("div");
    this.root.className = "sd-pg";
    this.renderIdle();
  }

  /** 文件里有图表：打开就把转换跑起来，不等用户切过来。 */
  auto(): void {
    void this.request();
  }

  /** 切到「页面视图」标签时调用：失败过的重试一次；没图表的等用户点「生成页面视图」。 */
  reveal(): void {
    if (this.state === "error") void this.request();
  }

  destroy(): void {
    window.clearTimeout(this.loadTimer);
    this.root.remove();
  }

  private renderIdle(): void {
    this.state = "idle";
    const box = document.createElement("div");
    box.className = "sd-pg-idle";
    box.append(
      dim(tr("这个文件没有图表")),
      dim(tr("页面视图是 LibreOffice 排出来的打印版式，表格、图表都在纸上。")),
    );
    const go = document.createElement("button");
    go.type = "button";
    go.className = "sd-act";
    go.textContent = tr("生成页面视图");
    go.onclick = () => void this.request();
    box.append(go);
    this.root.replaceChildren(box);
  }

  private renderLoading(): void {
    this.state = "loading";
    const box = document.createElement("div");
    box.className = "sd-pg-msg";
    box.append(dim(tr("正在生成页面视图")), dim(tr("第一次要等 LibreOffice 排一次版，之后会记住。")));
    this.root.replaceChildren(box);
  }

  private renderError(err: unknown): void {
    this.state = "error";
    const box = document.createElement("div");
    box.className = "sd-pg-error";
    box.append(dim(tr("页面视图没生成出来：{p1}", { p1: errText(err) })));
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "sd-act";
    retry.textContent = tr("重试");
    retry.onclick = () => void this.request(true);
    box.append(retry);
    this.root.replaceChildren(box);
  }

  private async request(retry = false): Promise<void> {
    if (this.state === "loading") return;
    this.renderLoading();
    try {
      const first = await api.sheetPdf(this.token, retry);
      if (first.status === "failed") throw pdfError(first);
      if (first.status === "ready") {
        this.renderFrame(api.sheetPdfUrl(first.id, this.token));
        return;
      }
      // pending：转换在后台跑，按节奏轮询直到 ready / failed / 超时。
      const deadline = Date.now() + POLL_DEADLINE_MS;
      for (;;) {
        await sleep(POLL_MS);
        const again = await api.sheetPdf(this.token, false);
        if (again.status === "failed") throw pdfError(again);
        if (again.status === "ready") {
          this.renderFrame(api.sheetPdfUrl(again.id, this.token));
          return;
        }
        if (Date.now() > deadline) throw { message: tr("页面视图转换超时") };
      }
    } catch (err) {
      this.renderError(err);
    }
  }

  private renderFrame(src: string): void {
    const frame = document.createElement("iframe");
    frame.className = "sd-pg-frame";
    frame.title = tr("页面视图");
    frame.src = src;
    const note = document.createElement("div");
    note.className = "sd-pg-msg sd-pg-wait";
    note.append(dim(tr("正在打开页面视图…")));
    frame.addEventListener(
      "load",
      () => {
        this.state = "ready";
        window.clearTimeout(this.loadTimer);
        note.remove();
      },
      { once: true },
    );
    this.root.replaceChildren(frame, note);
    // 有的 PDF 查看器不派 load：别让提示条永远盖着纸面。
    this.loadTimer = window.setTimeout(() => {
      this.state = "ready";
      note.remove();
    }, 4000);
  }
}

function pdfError(s: { status?: string; error?: string; code?: string }): { code: string; message: string } {
  return { code: s.code ?? "sheet_pdf_failed", message: s.error ?? tr("页面视图转换失败") };
}

function dim(text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "sd-pg-line";
  node.textContent = text;
  return node;
}
