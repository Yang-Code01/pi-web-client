import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";
import { stickMenu } from "./menuplace.ts";

/**
 * #100：工作区组头那颗 ⋯ 的菜单（改名 / 移到最前 / 删除）。#173 起顺序统一由一份 `order` 管，固定项退役。
 *
 * 外壳复用置顶胶囊的悬停气泡（`.pin-menu` / `.pm-item`，见 `pinmenu.ts`）：同一张圆角卡片、同一套
 * 行高与危险色，用户不用学第二套。挂在 `body` 上、`position: fixed` 贴组头下方 —— 左栏是
 * `overflow-y: auto`，组里弹出的东西会被裁掉。
 *
 * 落位见 `menuplace.ts`：组头可能就贴着窗口底（左栏能滚十几组），下方放不下就翻到组头上方，
 * 再放不下就自己滚 —— 别让「删除工作区」只剩半行在窗口外面。左栏一滚组头就跑，所以滚动时重摆
 * （`scroll` 不冒泡，得用捕获），组头彻底滚出窗口就把菜单关掉，别让它在边上飘一块。
 *
 * 做不了时不藏这一行：按钮置灰，下面盖一行灰字说明原因；删除会影响组内会话时也在菜单里说明效果。
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
  /** #276：新桥才有；旧桥整个字段不传，菜单里连这一行都不出现。 */
  row?: { checked: boolean; onToggle(): void };
  /** 有组内会话时的删除效果说明（见 `dropHint()`）；空组可不传。 */
  dropHint?: string;
  onRename(): void;
  onFront(): void;
  onDrop(): void;
}

export interface WsMenuHandle {
  close(): void;
}

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

  // #276：旧桥没有成员字段 → 这一行整个不画（不是置灰）；新桥用 aria-checked 表示在不在横条里。
  let row: HTMLButtonElement | null = null;
  if (opts.row) {
    row = item("row", opts.row.checked ? "✓" : "○", tr("在横条中"), () => opts.row?.onToggle());
    row.setAttribute("role", "menuitemcheckbox");
    row.setAttribute("aria-checked", String(opts.row.checked));
    row.classList.toggle("on", opts.row.checked);
    row.title = opts.row.checked ? tr("点一下移出横条") : tr("点一下放回横条");
  }

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
    drop.title = opts.dropHint ?? "";
  }

  node.append(rename, ...(row ? [row] : []), front, drop);
  // 不可执行的选择显示原因；可执行的删除若有会话，则显示删除效果说明。
  if (opts.frontBlocker) {
    const why = el("div", "pm-why", opts.frontBlocker);
    why.dataset.for = "front";
    node.append(why);
  }
  const dropInfo = opts.dropBlocker ?? opts.dropHint;
  if (dropInfo) {
    const why = el("div", "pm-why", dropInfo);
    why.dataset.for = "drop";
    node.append(why);
  }

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
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", place);
    node.remove();
  };

  /** 贴组头下方 4px；下方放不下就翻到上方，上下左右都夹进窗口（组头可能滚到窗口最底下）。 */
  function place(): void {
    stickMenu(node, anchor.getBoundingClientRect());
  }

  /** 左栏一滚组头就挪位置（`scroll` 不冒泡，所以监听挂了捕获）；组头彻底滚出窗口就把菜单收掉。 */
  const onScroll = (ev: Event): void => {
    // 菜单自己肚子里滚（封顶后就有滚动条）不该触发重排。
    if (ev.target instanceof Node && node.contains(ev.target)) return;
    const r = anchor.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      close();
      return;
    }
    place();
  };

  document.body.append(node);
  place();
  document.addEventListener("pointerdown", onDoc, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", place);

  return { close };
}
