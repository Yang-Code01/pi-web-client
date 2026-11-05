/**
 * 页面视图（#112）：iframe 里放 LibreOffice 排出来的 PDF 纸面。
 *
 * 端点 `/api/sheet/pdf` 是专用的（不带 CSP sandbox，`/raw` 带，PDF 在 sandbox 里会白屏）。
 * 第一次要等 LibreOffice 转换，先把「正在生成页面视图」显示出来；转换中再点不会重复发请求。
 */
import { tr, errText } from "../i18n/index.ts";

export class SheetPage {
  readonly root: HTMLElement;
  private readonly url: string;
  private state: "idle" | "loading" | "ready" | "error" = "idle";
  private loadTimer = 0;

  constructor(url: string) {
    // 只认桥自己的页面视图端点：这个地址永远由 api.sheetPdf() 用 token 拼出来。
    const target = new URL(url, location.origin);
    if (target.origin !== location.origin || !target.pathname.startsWith("/api/sheet/pdf")) {
      throw new Error("bad sheet page url");
    }
    this.url = target.href;
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
    retry.onclick = () => void this.request();
    box.append(retry);
    this.root.replaceChildren(box);
  }

  private async request(): Promise<void> {
    if (this.state === "loading") return;
    this.renderLoading();
    try {
      // 先确认转换成功再让 iframe 去取字节：失败时端点是 JSON，iframe 里只会显示一团原文。
      const res = await fetch(this.url, { credentials: "same-origin" });
      if (!res.ok) {
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          /* 不是 JSON 就按 HTTP 状态说 */
        }
        const data = (body ?? {}) as { error?: string; code?: string; params?: Record<string, string | number> };
        throw { ...data, message: data.error ?? `HTTP ${res.status}` };
      }
      // 只要头：转换已经完成，真正的字节让 iframe 去取（同一个缓存）。
      await res.body?.cancel().catch(() => undefined);
      this.renderFrame();
    } catch (err) {
      this.renderError(err);
    }
  }

  private renderFrame(): void {
    const frame = document.createElement("iframe");
    frame.className = "sd-pg-frame";
    frame.title = tr("页面视图");
    frame.src = this.url;
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

function dim(text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "sd-pg-line";
  node.textContent = text;
  return node;
}
