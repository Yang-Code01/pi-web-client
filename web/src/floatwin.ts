/**
 * 浮窗拖拽的共用骨架（终端与表格浮窗共用）：按住 → 捕获指针 → 按指针位移算几何 → 松手存盘。
 *
 * 坐标全是「布局 px」：`#app` 上的 zoom 会同时缩放指针位移和 rect，所以统一除以 scale。
 */

export interface FloatBox {
  l: number;
  t: number;
  w: number;
  h: number;
}

export interface FloatView {
  vw: number;
  vh: number;
}

export interface FloatDragOpts {
  scale: () => number;
  /** 可用高度要扣掉的东西（终端下方那条 tab）；表格浮窗传 0。 */
  inset: () => number;
  save: (dock: HTMLElement) => void;
}

export function clampNum(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

export function measureFloat(dock: HTMLElement, scale: number): FloatBox {
  const r = dock.getBoundingClientRect();
  return { l: r.left / scale, t: r.top / scale, w: r.width / scale, h: r.height / scale };
}

/** 把「CSS 居中」改成 left/top 钉住，并 clamp 在可视区内。 */
export function pinFloat(dock: HTMLElement, box: FloatBox, scale: number, inset: number): FloatBox {
  const vw = window.innerWidth / scale;
  const vh = window.innerHeight / scale - inset;
  const l = clampNum(box.l, 0, Math.max(0, vw - box.w));
  const t = clampNum(box.t, 0, Math.max(0, vh - box.h));
  dock.classList.add("pinned");
  dock.style.left = `${l}px`;
  dock.style.top = `${t}px`;
  dock.style.bottom = "auto";
  dock.style.transform = "none";
  return { l, t, w: box.w, h: box.h };
}

export function dragFloat(
  handle: HTMLElement,
  dock: HTMLElement,
  kind: "move" | "size" | "grip",
  step: (box: FloatBox, dx: number, dy: number, view: FloatView) => void,
  opts: FloatDragOpts,
): void {
  handle.onpointerdown = (ev) => {
    if (ev.button !== 0) return;
    // 标题栏里的按钮要能点，只有空白处才是「拖走」。
    if (kind === "move" && (ev.target as HTMLElement).closest("button")) return;
    ev.preventDefault();
    const s = opts.scale();
    const box = pinFloat(dock, measureFloat(dock, s), s, opts.inset());
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    const view = { vw: window.innerWidth / s, vh: window.innerHeight / s - opts.inset() };
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add("dragging");
    const cls = kind === "move" ? "win-dragging" : "win-resizing";
    document.body.classList.add(cls);
    const move = (e: PointerEvent) => step(box, (e.clientX - x0) / s, (e.clientY - y0) / s, view);
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      handle.classList.remove("dragging");
      document.body.classList.remove(cls);
      opts.save(dock);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  };
}
