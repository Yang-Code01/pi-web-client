import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";
import { stickMenu } from "./menuplace.ts";

/**
 * 置顶条每颗会话胶囊的悬停气泡（Q-035）：归档 / 重命名 / 删除。
 *
 * 为什么不像别的小菜单那样挂在胶囊里面：`.pin-strip` 是 `overflow-x: auto`，条里任何超出来的东西
 * （包括向上/向下溢出的气泡）都会被裁掉，而条又贴着窗口顶 —— 所以气泡只能挂在 `body` 上、用 fixed
 * 定位贴到胶囊下方 6px。调用方 handle 开关，这里只管排布、定位和「重命名时钉住自己不关」。
 */

export interface PinMenuOpts {
  name: string;
  cwd: string;
  /** 归档：条尾出一个抽屉，胶囊压扁滑进去。 */
  onArchive(): void;
  /** 重命名：气泡里就地变成输入框，回车/失焦提交，Esc 放弃。 */
  onRename(name: string): void;
  /** 删除：胶囊缩成小块飞进左栏那颗🗑，走既有的「移进垃圾箱」，可还原。 */
  onDelete(): void;
}

export interface PinMenuHandle {
  node: HTMLElement;
  /** 重命名输入框开着时为 true —— 这期间指针离开不能关气泡。 */
  pinned(): boolean;
  close(): void;
}

const GAP = 6;

export function openPinMenu(anchor: HTMLElement, opts: PinMenuOpts): PinMenuHandle {
  let closed = false;
  let editing = false;

  const node = el("div", "pin-menu");
  node.setAttribute("role", "menu");
  node.dataset.pinMenu = opts.name;

  const head = el("div", "pm-head");
  head.append(el("div", "pm-name", opts.name || tr("未命名会话")), el("div", "pm-cwd", opts.cwd || tr("未知目录")));

  const row = (act: string, icon: string, text: string, run: () => void): HTMLButtonElement => {
    const btn = el("button", `pm-item${act === "delete" ? " danger" : ""}`) as HTMLButtonElement;
    btn.type = "button";
    btn.dataset.act = act;
    btn.setAttribute("role", "menuitem");
    btn.append(el("span", "pm-ico", icon), el("span", "pm-text", text));
    btn.onclick = (ev) => {
      ev.stopPropagation();
      run();
    };
    return btn;
  };

  const archive = row("archive", "▤", tr("归档"), () => opts.onArchive());
  const rename = row("rename", "✎", tr("重命名"), () => startEdit());
  const remove = row("delete", "🗑️", tr("删除"), () => opts.onDelete());
  archive.title = tr("收进左栏「已归档」，不删任何东西");
  rename.title = tr("就地改名，回车保存");
  remove.title = tr("移进垃圾箱，可以在会话管理里还原");

  node.append(head, archive, rename, remove);

  const startEdit = (): void => {
    editing = true;
    const input = el("input", "pm-input") as HTMLInputElement;
    input.type = "text";
    input.value = opts.name;
    input.spellcheck = false;
    input.setAttribute("aria-label", tr("会话名"));
    rename.replaceChildren(el("span", "pm-ico", "✎"), input);
    rename.classList.add("editing");
    rename.onclick = null;
    input.focus();
    input.select();
    const done = (commit: boolean): void => {
      if (!editing) return;
      editing = false;
      const next = input.value.trim().replace(/\s+/g, " ");
      rename.classList.remove("editing");
      rename.replaceChildren(el("span", "pm-ico", "✎"), el("span", "pm-text", tr("重命名")));
      rename.onclick = (ev) => {
        ev.stopPropagation();
        startEdit();
      };
      if (commit && next && next !== opts.name) opts.onRename(next);
      else if (commit) close();
    };
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        done(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        done(false);
      }
      ev.stopPropagation();
    };
    input.onblur = () => done(true);
  };

  const onDoc = (ev: Event): void => {
    if (editing) return;
    const t = ev.target as Node | null;
    if (t && (node.contains(t) || anchor === t || anchor.contains(t))) return;
    if (ev instanceof KeyboardEvent && ev.key === "Escape") return;
    close();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape" || editing) return;
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

  /** 贴胶囊下方 6px；下方放不下就翻到上方，窄窗口里自己滚。不挂 scroll：滚动条一动鼠标就离开胶囊，
   * 指针出去的 close 先到一步。 */
  function place(): void {
    stickMenu(node, anchor.getBoundingClientRect(), { gap: GAP });
  }

  document.body.append(node);
  place();
  document.addEventListener("pointerdown", onDoc, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);

  return {
    node,
    pinned: () => editing,
    close,
  };
}

export interface PinListItem {
  id: string;
  name: string;
  /** 右侧那行小字：状态徽标优先，没有就相对时间。 */
  sub: string;
  current: boolean;
}

export interface PinListHandle {
  close(): void;
}

/**
 * D125：置顶条装不下一行时折成一颗「＋N」，这就是点开它的那张「全部置顶会话」列表。
 *
 * 外壳跟 Q-035 的悬停气泡共用（`.pin-menu` / `.pm-item`），挂在 `body` 上的理由也一样：
 * `.pin-strip` 是 `overflow-x: auto` 且贴着窗口顶，条里的弹出层会被裁掉。
 * 与气泡的区别：这是一个**选择器**，点一行就打开那个会话，所以不留编辑态、不接指针停留，
 * 并且永远把当前会话滚进视野 —— 它往往就落在被折起来的那几颗里。
 */
export function openPinList(anchor: HTMLElement, items: PinListItem[], onPick: (id: string) => void, onClosed: () => void): PinListHandle {
  let closed = false;

  const node = el("div", "pin-menu pin-list");
  node.setAttribute("role", "menu");
  node.setAttribute("aria-label", tr("全部置顶会话"));
  node.append(el("div", "pm-head", tr("置顶会话 · {p1} 个", { p1: items.length })));

  for (const it of items) {
    const btn = el("button", `pm-item${it.current ? " cur" : ""}`) as HTMLButtonElement;
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.dataset.sessionId = it.id;
    if (it.current) btn.setAttribute("aria-current", "true");
    btn.append(el("span", "pm-ico", it.current ? "●" : ""), el("span", "pm-text", it.name), el("small", "pm-sub", it.sub));
    btn.title = it.name;
    btn.onclick = (ev) => {
      ev.stopPropagation();
      close();
      onPick(it.id);
    };
    node.append(btn);
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
    onClosed();
  };

  /** 贴胶囊下方 6px（下方放不下就翻上方）；装不下的行自己滚 —— 这颗「＋N」常常就贴在窗口底。 */
  function place(): void {
    stickMenu(node, anchor.getBoundingClientRect(), { gap: GAP });
  }

  /** 置顶条是 `overflow-x: auto`，一滚胶囊就挪位（`scroll` 不冒泡，监听挂捕获）。 */
  const onScroll = (ev: Event): void => {
    // 列表自己的滚动（封顶后可能出现）不算「锚点跑掉了」。
    if (ev.target instanceof Node && node.contains(ev.target)) return;
    const r = anchor.getBoundingClientRect();
    if (r.right < 0 || r.left > window.innerWidth) {
      close();
      return;
    }
    place();
  };

  document.body.append(node);
  place();
  const cur = node.querySelector<HTMLElement>(".pm-item.cur");
  // 当前会话可能排在折叠后的末尾：列表自己滚过去，别让人以为它不在里面。
  if (cur) node.scrollTop = Math.max(0, cur.offsetTop - 8);
  (cur ?? node.querySelector<HTMLElement>(".pm-item"))?.focus();
  document.addEventListener("pointerdown", onDoc, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", place);

  return { close };
}
