/**
 * 幻灯片浮窗（D209）：一份演示文稿一扇窗，里面是 PowerPoint 导出的 PDF，一页一页翻着看。
 *
 * 为什么不进 viewer 面板：viewer 固定 `min(760px, 55vw)`，一页幻灯片在里面只能缩成缩略图。
 * 所以它和表格浮窗一样是「和终端并列的一扇窗」——复用 `.sd` 那套外观，但没有遮罩、不抢焦点，
 * 几何记在 `pi.slidesGeom`。转换在桥端排队（docpdf/service.ts），这里只负责轮询状态、挂 iframe。
 *
 * 打不开的情况必须说清楚：没装 PowerPoint 就明说（别让人盯着「正在生成」），
 * 页数超限 / 转换失败则给原文 + 重试 + 「用本机程序打开」。
 */
import { api } from "../api.ts";
import { clampNum, dragFloat, measureFloat, pinFloat, type FloatBox } from "../floatwin.ts";
import { errText, fmtNum, tr } from "../i18n/index.ts";

const KEY = "pi.slidesGeom";
const MIN_W = 420;
const MIN_H = 300;
/** 和 SheetPage 一致：1.5 秒问一次，最多等 190 秒（桥端转换超时 180 秒 + 一点余量）。 */
const POLL_MS = 1500;
const DEADLINE_MS = 190_000;

export interface SlidesDialogOpts {
  token: string;
  name: string;
  path: string;
  /** 桥数出来的页数（null = 认不出，不影响转换）。 */
  pages: number | null;
  /** 这台机器能不能站内翻页（没 PowerPoint 就只留本机打开）。 */
  engine: boolean;
  scale: () => number;
  onOpen: () => Promise<void>;
  onReveal: () => Promise<void>;
  onReopen: () => void;
  onClose: () => void;
  onRaise: () => void;
}

type State = "idle" | "waiting" | "ready" | "error";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class SlidesDialog {
  readonly root: HTMLElement;
  private readonly opts: SlidesDialogOpts;
  private readonly head: HTMLElement;
  private readonly body: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly note: HTMLElement;
  private readonly msg: HTMLElement;
  private frame: HTMLIFrameElement | null = null;
  private state: State = "idle";
  private timer = 0;
  private deadline = 0;
  private closed = false;

  constructor(opts: SlidesDialogOpts) {
    this.opts = opts;
    this.root = el("section", "sd sld");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", opts.name);

    const grip = el("div", "sd-grip");
    grip.title = tr("拖动改高度（双击复原）");
    const resize = el("div", "sd-resize");
    resize.title = tr("拖动改大小（双击复原）");

    this.head = el("header", "sd-head");
    const who = el("div", "sd-who");
    who.append(el("span", "sd-name", opts.name), el("span", "sd-path", opts.path));
    this.head.append(el("span", "sd-ico", "🎬"), who);

    if (opts.engine) {
      const reload = el("button", "sd-btn", "⟳");
      reload.type = "button";
      reload.title = tr("重新生成页面");
      reload.setAttribute("aria-label", tr("重新生成页面"));
      reload.onclick = () => void this.request(true);
      this.head.append(reload);
    }
    const open = el("button", "sd-btn", "🖥");
    open.type = "button";
    open.title = tr("用本机程序打开");
    open.setAttribute("aria-label", tr("用本机程序打开"));
    open.onclick = () => void opts.onOpen();
    this.head.append(open);

    const close = el("button", "sd-btn sd-close", "✕");
    close.type = "button";
    close.title = tr("关闭");
    close.setAttribute("aria-label", tr("关闭"));
    close.onclick = () => this.close();
    this.head.append(close);

    this.body = el("div", "sd-body");
    this.msg = el("div", "sd-msg");
    this.body.append(this.msg);

    this.note = el("span", "sd-note");
    this.foot = el("footer", "sd-foot");
    const reveal = el("button", "sd-act", tr("📂 在文件夹中显示"));
    reveal.type = "button";
    reveal.onclick = () => void opts.onReveal();
    this.foot.append(this.note, reveal);

    this.root.append(grip, this.head, this.body, this.foot, resize);
    this.wire(grip, resize);
    this.renderIdle();

    // 放映格式（.pps/.ppsx）在站内是翻页，交给本机打开会直接进全屏放映 —— 提前说一句。
    if (/\.(ppsx|pps)$/i.test(opts.name)) {
      this.setNote(tr("这是放映格式：在这里翻页看；用本机程序打开会直接全屏放映"));
    } else if (opts.pages) {
      this.setNote(tr("{p1} 页", { p1: fmtNum(opts.pages) }));
    }
  }

  /** 挂上去之后调用：先摆好位置，再开始（或者直接说为什么不行）。 */
  open(): void {
    this.applyGeom();
    if (!this.opts.engine) {
      this.renderError(
        tr("这台机器没装 PowerPoint，没法在这里翻页。用本机程序打开，或者换一台装了 Office 的机器。"),
        false,
      );
      return;
    }
    void this.request(false);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.destroy();
    this.opts.onClose();
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.frame?.remove();
    this.frame = null;
    this.root.remove();
    window.removeEventListener("resize", this.onResize);
  }

  // ------------------------------------------------------------------ 转换

  private async request(retry: boolean): Promise<void> {
    clearTimeout(this.timer);
    this.renderWaiting();
    try {
      const res = await api.slidesPdf(this.opts.token, retry);
      if (this.closed) return;
      if (res.status === "ready") {
        this.renderFrame(res.id);
        return;
      }
      if (res.status === "failed") {
        this.renderError(res.error || tr("转换没有成功"), true);
        return;
      }
    } catch (err: any) {
      if (this.closed) return;
      // 桥端可能回 502/503（没装 PowerPoint、转换挂了）—— 错误里带着它自己的话。
      this.renderError(errText(err), true);
      return;
    }
    if (!this.deadline) this.deadline = Date.now() + DEADLINE_MS;
    if (Date.now() > this.deadline) {
      this.renderError(tr("页面视图转换超时"), true);
      return;
    }
    this.timer = window.setTimeout(() => void this.request(false), POLL_MS);
  }

  private renderFrame(id: string): void {
    this.state = "ready";
    this.msg.hidden = true;
    this.msg.replaceChildren();
    if (!this.frame) {
      // 不放 sandbox：浏览器内建 PDF 查看器需要它自己的 origin（D166 的同一个理由）。
      this.frame = el("iframe", "sld-frame");
      this.frame.title = this.opts.name;
      this.body.append(this.frame);
    }
    const src = api.slidesPdfUrl(id, this.opts.token);
    if (this.frame.getAttribute("src") !== src) this.frame.setAttribute("src", src);
  }

  private renderWaiting(): void {
    this.state = "waiting";
    this.frame?.remove();
    this.frame = null;
    this.msg.hidden = false;
    this.msg.replaceChildren(
      el("div", "sd-pg-line", tr("正在用 PowerPoint 把这份演示文稿转成页面…")),
      el("div", "sld-hint", tr("第一次打开要等几秒，之后直接读缓存")),
    );
  }

  private renderIdle(): void {
    this.state = "idle";
    this.msg.hidden = false;
    this.msg.replaceChildren(el("div", "sd-pg-line", tr("正在准备页面…")));
  }

  private renderError(text: string, retry: boolean): void {
    this.state = "error";
    clearTimeout(this.timer);
    this.frame?.remove();
    this.frame = null;
    this.msg.hidden = false;
    const box = el("div", "sld-error");
    box.append(el("div", "sd-pg-line", text));
    const acts = el("div", "sld-acts");
    if (retry) {
      const again = el("button", "sd-act", tr("重试"));
      again.type = "button";
      again.onclick = () => {
        this.deadline = 0;
        void this.request(true);
      };
      acts.append(again);
    }
    const open = el("button", "sd-act", tr("用本机程序打开"));
    open.type = "button";
    open.onclick = () => void this.opts.onOpen();
    acts.append(open);
    box.append(acts);
    this.msg.replaceChildren(box);
  }

  private setNote(text: string): void {
    this.note.textContent = text;
    this.note.title = text;
  }

  // ------------------------------------------------------------------ 几何

  private wire(grip: HTMLElement, resize: HTMLElement): void {
    const opts = {
      scale: () => this.opts.scale(),
      inset: () => 0,
      save: () => this.saveGeom(),
    };
    dragFloat(
      this.head,
      this.root,
      "move",
      (box, dx, dy, view) => {
        this.root.style.left = `${clampNum(box.l + dx, 0, Math.max(0, view.vw - box.w))}px`;
        this.root.style.top = `${clampNum(box.t + dy, 0, Math.max(0, view.vh - box.h))}px`;
      },
      opts,
    );
    this.head.ondblclick = (ev) => {
      if ((ev.target as HTMLElement).closest("button")) return;
      this.resetGeom();
    };

    dragFloat(
      resize,
      this.root,
      "size",
      (box, dx, dy, view) => {
        this.root.style.width = `${clampNum(box.w + dx, MIN_W, Math.max(MIN_W, view.vw - box.l))}px`;
        this.root.style.height = `${clampNum(box.h + dy, MIN_H, Math.max(MIN_H, view.vh - box.t))}px`;
      },
      opts,
    );
    resize.ondblclick = () => this.resetGeom();

    dragFloat(
      grip,
      this.root,
      "grip",
      (box, _dx, dy) => {
        const bottom = box.t + box.h;
        const h = clampNum(box.h - dy, MIN_H, bottom);
        this.root.style.top = `${clampNum(bottom - h, 0, bottom)}px`;
        this.root.style.height = `${h}px`;
      },
      opts,
    );
    grip.ondblclick = () => this.resetGeom();

    this.root.addEventListener("pointerdown", () => this.opts.onRaise(), true);
    this.root.addEventListener("focusin", () => this.opts.onRaise());
    window.addEventListener("resize", this.onResize);
  }

  private onResize = (): void => {
    const s = this.opts.scale();
    const vw = window.innerWidth / s;
    const vh = window.innerHeight / s;
    const box = measureFloat(this.root, s);
    const w = Math.min(box.w, vw);
    const h = Math.min(box.h, vh);
    this.root.style.width = `${w}px`;
    this.root.style.height = `${h}px`;
    pinFloat(this.root, { l: box.l, t: box.t, w, h }, s, 0);
  };

  /** 一页纸要够宽：比表格浮窗更大一点，宽了按 16:9 估高，窄了按窗口兜底。 */
  private defaults(): FloatBox {
    const s = this.opts.scale();
    const vw = window.innerWidth / s;
    const vh = window.innerHeight / s;
    const w = Math.max(MIN_W, Math.min(1280, vw - 48));
    const h = Math.max(MIN_H, Math.min(Math.round(w * 0.66) + 84, vh - 48));
    return { l: Math.max(0, (vw - w) / 2), t: Math.max(0, (vh - h) / 2), w, h };
  }

  private readGeom(): Partial<FloatBox> | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const value = JSON.parse(raw) as Partial<FloatBox>;
      if (!value || typeof value !== "object") return null;
      return value;
    } catch {
      return null;
    }
  }

  private applyGeom(): void {
    const s = this.opts.scale();
    const vw = window.innerWidth / s;
    const vh = window.innerHeight / s;
    const def = this.defaults();
    const stored = this.readGeom();
    const w = clampNum(stored?.w ?? def.w, Math.min(MIN_W, vw), vw);
    const h = clampNum(stored?.h ?? def.h, Math.min(MIN_H, vh), vh);
    this.root.style.width = `${w}px`;
    this.root.style.height = `${h}px`;
    pinFloat(this.root, { l: stored?.l ?? def.l, t: stored?.t ?? def.t, w, h }, s, 0);
  }

  private saveGeom(): void {
    const box = measureFloat(this.root, this.opts.scale());
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ l: Math.round(box.l), t: Math.round(box.t), w: Math.round(box.w), h: Math.round(box.h) }),
      );
    } catch {
      /* 存不下也还能用这一次 */
    }
  }

  private resetGeom(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* 忘不掉也还能用这一次 */
    }
    this.root.classList.remove("pinned");
    for (const prop of ["left", "top", "bottom", "transform", "width", "height"]) this.root.style.removeProperty(prop);
    this.applyGeom();
  }
}
