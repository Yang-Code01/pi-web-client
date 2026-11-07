import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";

/**
 * #100：工作区组头那颗 ⋯ 的菜单（改名 / 移到最前 / 删除）。#173 起顺序统一由一份 `order` 管，固定项退役。
 *
 * 外壳复用置顶胶囊的悬停气泡（`.pin-menu` / `.pm-item`，见 `pinmenu.ts`）：同一张圆角卡片、同一套
 * 行高与危险色，用户不用学第二套。挂在 `body` 上、`position: fixed` 贴组头下方 —— 左栏是
 * `overflow-y: auto`，组里弹出的东西会被裁掉。
 *
 * 做不了时不藏这一行：按钮置灰，下面盖一行灰字说明为什么（「还有 3 个会话」/「跟着目录走」/「已经
 * 是第一个」）。藏起来只会让人以为这个组忘了做删除。
 */

export interface WsMenuOpts {
  /** 组头显示的名字（`.name` 为空时由调用方先回落成目录名）。 */
  name: string;
  /** 第二行小字：派生组是目录路径，手建组说明它不绑目录。 */
  sub: string;
  /** `null` = 能「移到最前」；否则是拒绝原因（已经是第一个）。 */
  frontBlocker: string | null;
  /** `null` = 能删；否则是拒绝原因（来自 `dropBlocker()`）。 */
  dropBlocker: string | null;
  onRename(): void;
  onFront(): void;
  onDrop(): void;
}

export interface WsMenuHandle {
  close(): void;
}

const GAP = 4;

export function openWsMenu(anchor: HTMLElement, opts: WsMenuOpts): WsMenuHandle {
  let closed = false;

  const node = el("div", "pin-menu ws-menu");
  node.setAttribute("role", "menu");
  node.setAttribute("aria-label", tr("工作区菜单"));

  const head = el("div", "pm-head");
  head.append(el("div", "pm-name", opts.name), el("div", "pm-cwd", opts.sub));
  node.append(head);

  const item = (act: string, icon: string, text: string, run: () => void, extra = ""): HTMLButtonElement => {
    const btn = el("button", `pm-item${act === "drop" ? " danger" : ""}${extra}`) as HTMLButtonElement;
    btn.type = "button";
    btn.dataset.act = act;
    btn.setAttribute("role", "menuitem");
    btn.append(el("span", "pm-ico", icon), el("span", "pm-text", text));
    btn.onclick = (ev) => {
      ev.stopPropagation();
      if (btn.disabled) return;
      close();
      run();
    };
    return btn;
  };

  const rename = item("rename", "✎", tr("重命名"), () => opts.onRename());
  rename.title = tr("清空名字就恢复成目录名");

  // #177：常驻横条的入口 —— 点一下把这一组排到 `order[0]`，折叠组也走它（＋N 只是临时顶位）。
  const front = item("front", "⇤", tr("移到最前"), () => opts.onFront());
  if (opts.frontBlocker) {
    front.disabled = true;
    front.classList.add("blocked");
    front.setAttribute("aria-disabled", "true");
    front.title = opts.frontBlocker;
  } else {
    front.title = tr("排到第一位，横条与左栏一起跟着变");
  }

  const drop = item("drop", "🗑", tr("删除工作区"), () => opts.onDrop());
  if (opts.dropBlocker) {
    drop.disabled = true;
    drop.classList.add("blocked");
    drop.setAttribute("aria-disabled", "true");
    drop.title = opts.dropBlocker;
  } else {
    drop.title = tr("只删这个空组，组里的东西一概不动");
  }

  node.append(rename, front, drop);
  // 每个做不了的选择都盖一行原因，顺序跟着菜单项（移到最前在前、删除在后）。
  if (opts.frontBlocker) node.append(el("div", "pm-why", opts.frontBlocker));
  if (opts.dropBlocker) node.append(el("div", "pm-why", opts.dropBlocker));

  const onDoc = (ev: Event): void => {
    const t = ev.target as Node | null;
    if (t && (node.contains(t) || anchor === t || anchor.contains(t))) return;
    if (ev instanceof KeyboardEvent && ev.key === "Escape") return;
    close();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    close();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", place);
    node.remove();
  };

  /** 贴组头下方 4px，左右夹在窗口里；左栏窄，别让它戳出屏幕。 */
  function place(): void {
    const r = anchor.getBoundingClientRect();
    const w = node.offsetWidth;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(r.bottom + GAP)}px`;
  }

  document.body.append(node);
  place();
  document.addEventListener("pointerdown", onDoc, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);

  return { close };
}
