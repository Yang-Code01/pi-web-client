import { createEl as el } from "./chat.ts";

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
  head.append(el("div", "pm-name", opts.name || "未命名会话"), el("div", "pm-cwd", opts.cwd || "未知目录"));

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

  const archive = row("archive", "▤", "归档", () => opts.onArchive());
  const rename = row("rename", "✎", "重命名", () => startEdit());
  const remove = row("delete", "🗑️", "删除", () => opts.onDelete());
  archive.title = "收进左栏「已归档」，不删任何东西";
  rename.title = "就地改名，回车保存";
  remove.title = "移进垃圾箱，可以在会话管理里还原";

  node.append(head, archive, rename, remove);

  const startEdit = (): void => {
    editing = true;
    const input = el("input", "pm-input") as HTMLInputElement;
    input.type = "text";
    input.value = opts.name;
    input.spellcheck = false;
    input.setAttribute("aria-label", "会话名");
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
      rename.replaceChildren(el("span", "pm-ico", "✎"), el("span", "pm-text", "重命名"));
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

  /** 贴胶囊下方 6px，左右夹在窗口里；窗口太窄就让气泡左对齐窗口 8px。 */
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

  return {
    node,
    pinned: () => editing,
    close,
  };
}
