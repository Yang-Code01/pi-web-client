import { tr } from "../i18n/index.ts";

/**
 * 图片查看器：点聊天里的图打开。同一会话里的所有图片能左右翻（← / →），
 * 滚轮 / 按钮缩放、拖动平移、双击在「适应窗口」与「原始大小」之间切，Esc 关。
 *
 * 只负责画；挂到哪一层、关的时候清什么都由调用方（`main.ts` 的 `layerEl`）决定。
 */

export interface ViewerItem {
  url: string;
  name: string;
  /** 聊天里那条消息的 id（底栏按钮要用）。 */
  entryId?: string;
}

export interface ViewerOpts {
  items: ViewerItem[];
  index: number;
  /** 底栏额外的按钮（比如「添加到表情」「打开所在位置」）。 */
  actions?: (item: ViewerItem) => { label: string; run: () => void }[];
  onClose: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function btn(text: string, title: string, run: () => void): HTMLButtonElement {
  const b = el("button", "iv-btn", text);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    run();
  });
  return b;
}

/** 返回挂好的根节点与一个 `destroy`（拆掉 document 上的键盘监听）。 */
export function imageViewer(opts: ViewerOpts): { root: HTMLElement; destroy: () => void } {
  let index = Math.max(0, Math.min(opts.index, opts.items.length - 1));
  let scale = 1;
  let fit = 1;
  let tx = 0;
  let ty = 0;

  const root = el("div", "iv");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", tr("看图"));
  const stage = el("div", "iv-stage");
  const img = el("img", "iv-img");
  img.draggable = false;
  stage.append(img);
  const top = el("div", "iv-top");
  const title = el("span", "iv-name");
  const count = el("span", "iv-count");
  top.append(title, count, btn("✕", tr("关掉（Esc）"), () => opts.onClose()));
  const prev = btn("‹", tr("上一张（←）"), () => go(index - 1));
  prev.classList.add("iv-prev");
  const next = btn("›", tr("下一张（→）"), () => go(index + 1));
  next.classList.add("iv-next");
  const bar = el("div", "iv-bar");
  const pct = el("span", "iv-pct");
  const extra = el("span", "iv-extra");
  bar.append(
    btn("−", tr("缩小"), () => zoomTo(scale / 1.25)),
    pct,
    btn("+", tr("放大"), () => zoomTo(scale * 1.25)),
    btn(tr("适应"), tr("适应窗口"), () => reset()),
    btn("1:1", tr("原始大小"), () => zoomTo(1)),
    btn("⟳", tr("旋转 90°"), () => {
      rot = (rot + 90) % 360;
      paint();
    }),
    extra,
  );
  root.append(stage, top, prev, next, bar);
  let rot = 0;

  const paint = (): void => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rot}deg)`;
    pct.textContent = `${Math.round(scale * 100)}%`;
  };
  const reset = (): void => {
    const w = img.naturalWidth || 1;
    const hgt = img.naturalHeight || 1;
    const box = stage.getBoundingClientRect();
    fit = Math.min(1, (box.width - 32) / w, (box.height - 32) / hgt);
    if (!Number.isFinite(fit) || fit <= 0) fit = 1;
    scale = fit;
    tx = 0;
    ty = 0;
    paint();
  };
  const zoomTo = (s: number, cx?: number, cy?: number): void => {
    const next = Math.max(0.05, Math.min(16, s));
    // 以指针为中心缩放：指针下面那一点缩放前后不动。
    if (cx !== undefined && cy !== undefined) {
      const box = stage.getBoundingClientRect();
      const px = cx - box.left - box.width / 2;
      const py = cy - box.top - box.height / 2;
      tx = px - ((px - tx) * next) / scale;
      ty = py - ((py - ty) * next) / scale;
    }
    scale = next;
    paint();
  };
  const go = (i: number): void => {
    if (i < 0 || i >= opts.items.length) return;
    index = i;
    const item = opts.items[index];
    rot = 0;
    img.style.opacity = "0";
    img.onload = () => {
      img.style.opacity = "1";
      reset();
    };
    img.src = item.url;
    img.alt = item.name;
    title.textContent = item.name;
    count.textContent = opts.items.length > 1 ? `${index + 1} / ${opts.items.length}` : "";
    prev.hidden = index <= 0;
    next.hidden = index >= opts.items.length - 1;
    extra.replaceChildren();
    const dl = el("a", "iv-btn", tr("下载"));
    dl.href = item.url;
    dl.download = item.name;
    dl.rel = "noopener";
    extra.append(dl);
    for (const a of opts.actions?.(item) ?? []) extra.append(btn(a.label, a.label, a.run));
  };

  stage.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      zoomTo(scale * (ev.deltaY < 0 ? 1.15 : 1 / 1.15), ev.clientX, ev.clientY);
    },
    { passive: false },
  );
  let drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
  stage.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, tx, ty, moved: false };
    stage.setPointerCapture(ev.pointerId);
  });
  stage.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    tx = drag.tx + dx;
    ty = drag.ty + dy;
    paint();
  });
  stage.addEventListener("pointerup", (ev) => {
    const d = drag;
    drag = null;
    // 点在图外面的空白处（没拖动）= 关掉，和大多数看图器一样。
    if (d && !d.moved && ev.target === stage) opts.onClose();
  });
  stage.addEventListener("dblclick", (ev) => {
    if (Math.abs(scale - fit) < 0.01) zoomTo(1, ev.clientX, ev.clientY);
    else reset();
  });
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      ev.preventDefault();
      opts.onClose();
    } else if (ev.key === "ArrowLeft") go(index - 1);
    else if (ev.key === "ArrowRight") go(index + 1);
    else if (ev.key === "+" || ev.key === "=") zoomTo(scale * 1.25);
    else if (ev.key === "-") zoomTo(scale / 1.25);
    else if (ev.key === "0") reset();
    else return;
    ev.preventDefault();
  };
  document.addEventListener("keydown", onKey, true);
  const onResize = (): void => reset();
  window.addEventListener("resize", onResize);
  go(index);
  return {
    root,
    destroy: () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    },
  };
}
