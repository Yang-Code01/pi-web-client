/**
 * 表格浮窗（D127）：不是 viewer 面板、没有遮罩、不抢焦点，层级与终端并列。
 *
 * 几何按界面缩放归一（布局 px）后记在 localStorage 的 `pi.sheetGeom`；
 * 拖标题栏移动、拖右下角改宽高、拖顶边只改高、双击复原、打开时 clamp 回可视区。
 */
import { tr, errText } from "../i18n/index.ts";
import type { SheetMeta, SheetWindow } from "../types.ts";
import { clampNum, dragFloat, measureFloat, pinFloat, type FloatBox } from "../floatwin.ts";
import { SheetGrid } from "./grid.ts";

const KEY = "pi.sheetGeom";
const MIN_W = 420;
const MIN_H = 260;

export interface SheetDialogOpts {
  token: string;
  name: string;
  path: string;
  /** 原文件的裸地址（`/raw/<token>/<rel>`）：下载不经过任何接口。 */
  raw: string;
  scale: () => number;
  loadMeta: () => Promise<SheetMeta>;
  fetchWindow: (sheet: string, r0: number, r1: number, c0: number, c1: number) => Promise<SheetWindow>;
  /** #106 出口：交给这台电脑上的 Excel 打开原文件。 */
  onOpen: () => Promise<void>;
  onReveal: () => Promise<void>;
  /** 文件被改过之后重新开一趟（要新的凭据，所以由 app 重走 /api/preview）。 */
  onReopen: () => void;
  onClose: () => void;
  onRaise: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class SheetDialog {
  readonly root: HTMLElement;
  private readonly opts: SheetDialogOpts;
  private readonly head: HTMLElement;
  private readonly body: HTMLElement;
  private grid: SheetGrid | null = null;
  private closed = false;

  constructor(opts: SheetDialogOpts) {
    this.opts = opts;
    this.root = el("section", "sd");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", opts.name);

    const grip = el("div", "sd-grip");
    grip.title = tr("拖动改高度（双击复原）");

    this.head = el("header", "sd-head");
    const who = el("div", "sd-who");
    who.append(el("span", "sd-name", opts.name), el("span", "sd-path", opts.path));
    this.head.append(el("span", "sd-ico", "📊"), who);

    const close = el("button", "sd-btn sd-close", "✕");
    close.type = "button";
    close.title = tr("关闭");
    close.setAttribute("aria-label", tr("关闭"));
    close.onclick = () => this.close();
    this.head.append(close);

    this.body = el("div", "sd-body");
    const resize = el("div", "sd-resize");
    resize.title = tr("拖动改大小（双击复原）");

    this.root.append(grip, this.head, this.body, this.foot(opts), resize);
    this.wire(grip, resize);
  }

  /** 看完之后能回到真文件：Excel / 文件夹 / 下载。都是本地动作，公网那边由桥端拒（#106）。 */
  private foot(opts: SheetDialogOpts): HTMLElement {
    const bar = el("footer", "sd-foot");
    const open = el("button", "sd-act", tr("用 Excel 打开"));
    open.type = "button";
    open.title = tr("交给这台电脑上的 Excel 打开原文件");
    open.onclick = () => {
      open.disabled = true;
      void opts.onOpen().finally(() => {
        open.disabled = false;
      });
    };
    const reveal = el("button", "sd-act", tr("📂 在文件夹中显示"));
    reveal.type = "button";
    reveal.title = tr("在文件管理器里定位这个文件");
    reveal.onclick = () => void opts.onReveal();
    // 下载不靠桥：跟预览同一份原字节，浏览器直接存。
    const dl = el("a", "sd-act sd-dl", tr("下载"));
    dl.href = opts.raw;
    dl.download = opts.name;
    dl.title = tr("把原文件下载下来");
    bar.append(open, reveal, dl);
    return bar;
  }

  /** 挂上去之后调用：先按记忆摆好，再取元数据。 */
  open(): void {
    this.applyGeom();
    void this.load();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.destroy();
    this.opts.onClose();
  }

  destroy(): void {
    this.grid?.destroy();
    this.grid = null;
    window.removeEventListener("resize", this.onResize);
    this.root.remove();
  }

  private async load(): Promise<void> {
    this.showMessage(tr("正在读取…"));
    try {
      const meta = await this.opts.loadMeta();
      if (this.closed) return;
      this.grid = new SheetGrid({
        meta,
        sheet: meta.name,
        fetchWindow: this.opts.fetchWindow,
        // 文件在预览之后被改过：停下，说清楚，别拿旧数据装作没事（#106）。
        onStale: () => this.stale(),
      });
      this.body.replaceChildren(this.grid.root);
      await this.grid.start();
    } catch (err) {
      if (this.closed) return;
      const code = (err as { code?: string } | null)?.code;
      if (code === "sheet_stale") {
        this.stale();
        return;
      }
      if (code === "sheet_unsupported") {
        this.blocked(tr("这个格式这里不支持，用 Excel 打开"), [{ label: tr("用 Excel 打开"), run: () => void this.opts.onOpen() }]);
        return;
      }
      this.showMessage(tr("读不了这张表：{p1}", { p1: errText(err) }));
    }
  }

  /** 文件在这扇窗打开之后被改过：旧凭据已失效，只剩「重新打开」这一条路。 */
  private stale(): void {
    if (this.closed) return;
    this.blocked(tr("文件已改变，重新打开"), [{ label: tr("重新打开"), run: () => this.opts.onReopen() }]);
  }

  /** 盖住网格：说清楚发生了什么，外加能继续走下去的按钮。 */
  private blocked(text: string, actions: { label: string; run: () => void }[]): void {
    this.grid?.destroy();
    this.grid = null;
    const box = el("div", "sd-block");
    box.append(el("div", "sd-block-text", text));
    if (actions.length) {
      const row = el("div", "sd-block-acts");
      for (const action of actions) {
        const b = el("button", "sd-act", action.label);
        b.type = "button";
        b.onclick = () => action.run();
        row.append(b);
      }
      box.append(row);
    }
    this.body.replaceChildren(box);
  }

  private showMessage(text: string): void {
    this.body.replaceChildren(el("div", "sd-msg", text));
  }

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
        this.resized();
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
        this.resized();
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
    const box = this.currentBox();
    const w = Math.min(box.w, vw);
    const h = Math.min(box.h, vh);
    this.root.style.width = `${w}px`;
    this.root.style.height = `${h}px`;
    pinFloat(this.root, { l: box.l, t: box.t, w, h }, s, 0);
    this.resized();
  };

  private resized(): void {
    // 宽高刚变：可视行数变了，重新算一遍窗口。
    requestAnimationFrame(() => this.grid?.refresh());
  }

  private defaults(): FloatBox {
    const s = this.opts.scale();
    const vw = window.innerWidth / s;
    const vh = window.innerHeight / s;
    const w = Math.max(MIN_W, Math.min(1180, vw - 48));
    const h = Math.max(MIN_H, Math.min(780, vh - 48));
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

  private currentBox(): FloatBox {
    return measureFloat(this.root, this.opts.scale());
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
    const box = this.currentBox();
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
    this.resized();
  }
}
