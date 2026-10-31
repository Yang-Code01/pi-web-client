import { api } from "./api.ts";
import { createEl as el, fileIcon } from "./chat.ts";

/**
 * One directory browser, three call sites: the new-session sheet's 📁 浏览, the attachment picker,
 * and the viewer's 浏览 pane of the file explorer. It only reads `/api/dirs`, which the bridge
 * answers for any path on this machine.
 */

const IMAGE_FILES = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;

export interface DirPickerState {
  path: string;
  parent: string | null;
  error: string;
  dirs: string[];
  files: string[];
}

export interface DirPickerOpts {
  /** Where to start. Empty = the drive list (此电脑). */
  start: string;
  /** List files next to directories (and let `onPick` run on them). */
  files?: boolean;
  /** Show the 筛选 box. Defaults to on when `files` is on. */
  filter?: boolean;
  /** When `start` does not exist, fall back to the drive list instead of a dead end. */
  fallback?: boolean;
  /**
   * Skip the listing that normally runs on mount. Pass false when the picker is mounted inside a
   * hidden container (the new-session sheet): that request would land whenever it liked, and its
   * `onState` would then overwrite whatever the user had typed into the 工作目录 field meanwhile.
   */
  autoStart?: boolean;
  /** Extra buttons on the path row (e.g. 新建文件夹). */
  head?: HTMLElement[];
  /** Extra nodes between the path row and the list (e.g. the mkdir row). */
  beforeList?: HTMLElement[];
  /** Called after every successful listing, and on entering a directory. */
  onState?: (state: DirPickerState) => void;
  /** A file was clicked; the row is handed over so the caller can show a busy state. */
  onPick?: (abs: string, name: string, row: HTMLButtonElement) => void;
  /** A file row that must not be picked (it is attached, not referenced). */
  isAttach?: (name: string) => boolean;
  /** Right-click on a file row (Q-008: 用 PowerShell 运行 / 以管理员运行). */
  onContext?: (abs: string, name: string, ev: MouseEvent) => void;
}

export interface DirPicker {
  root: HTMLElement;
  /** List a directory (empty string = the drive list). */
  go(target: string): Promise<void>;
  /** Where the list is now. */
  path(): string;
  /** Re-list the current directory. */
  refresh(): void;
}

export function mountDirPicker(host: HTMLElement, opts: DirPickerOpts): DirPicker {
  const root = el("div", "dirpicker");
  const where = el("div", "dir-path");
  /** Q-014: the path is a breadcrumb — every segment jumps back to that level. */
  const crumb = (label: string, target: string, root = false): HTMLElement => {
    const button = el("button", root ? "crumb root" : "crumb", label);
    button.title = target ? `跳到 ${target}` : "此电脑";
    button.onclick = () => void go(target);
    return button;
  };
  const paintCrumbs = (): void => {
    where.replaceChildren();
    where.append(crumb("此电脑", "", true));
    if (!current) return;
    const sep = current.includes("\\") ? "\\" : "/";
    const parts = current.split(sep).filter((part) => part !== "");
    let acc = "";
    for (const part of parts) {
      acc = acc === "" ? (part.endsWith(":") ? part : `${sep}${part}`) : `${acc}${sep}${part}`;
      where.append(el("span", "crumb-sep", sep), crumb(part, acc, part.endsWith(":")));
    }
  };
  const dirHead = el("div", "dir-head");
  dirHead.append(where, ...(opts.head ?? []));
  const listFiles = opts.files === true;
  const showFilter = opts.filter ?? listFiles;
  const filter = el("input", "ns-input dir-filter") as HTMLInputElement;
  filter.placeholder = "筛选当前目录…";
  const list = el("div", "model-list dir-list");
  if (showFilter) root.append(dirHead, filter, ...(opts.beforeList ?? []), list);
  else root.append(dirHead, ...(opts.beforeList ?? []), list);
  host.append(root);

  let current = "";
  let res: Awaited<ReturnType<typeof api.dirs>> | null = null;
  /** Drive letters have no drive to letter, so join with the separator the path already uses. */
  const join = (name: string): string => {
    if (!current) return name;
    const sep = current.includes("/") && !current.includes("\\") ? "/" : "\\";
    return `${current.replace(/[\\/]+$/, "")}${sep}${name}`;
  };

  const paint = (): void => {
    if (!res) return;
    const q = showFilter ? filter.value.trim().toLowerCase() : "";
    const hit = (n: string) => !q || n.toLowerCase().includes(q);
    const dirs = res.dirs.filter(hit);
    const files = (res.files ?? []).filter(hit);
    list.replaceChildren();
    if (res.parent !== null) {
      const up = el("button", "model-row dir-row", "↑ 上一级");
      up.onclick = () => void go(res?.parent ?? "");
      list.append(up);
    }
    if (res.error) {
      list.append(el("div", "empty", res.error));
      return;
    }
    for (const name of dirs) {
      const row = el("button", "model-row dir-row", `📁 ${name}`);
      row.onclick = () => void go(join(name));
      list.append(row);
    }
    for (const name of files) {
      const row = el("button", "model-row dir-row file-row");
      row.append(el("span", "ico", fileIcon(name)), el("span", "nm", name));
      row.title = join(name);
      row.onclick = () => opts.onPick?.(join(name), name, row);
      if (opts.onContext) {
        row.oncontextmenu = (ev) => {
          ev.preventDefault();
          opts.onContext?.(join(name), name, ev);
        };
      }
      list.append(row);
    }
    if (!dirs.length && !files.length) {
      list.append(el("div", "empty", res.dirs.length || (res.files ?? []).length ? "没有匹配项" : "空目录"));
    }
  };

  const go = async (target: string): Promise<void> => {
    list.replaceChildren(el("div", "empty", "读取中…"));
    let next: Awaited<ReturnType<typeof api.dirs>>;
    try {
      next = await api.dirs(target, listFiles);
    } catch (ex: any) {
      if (root.isConnected) list.replaceChildren(el("div", "empty", `读取失败：${ex?.message ?? ex}`));
      return;
    }
    if (!root.isConnected) return;
    // A path that does not exist (typed, or remembered from another machine): show drives instead.
    if (next.error && target && opts.fallback) return go("");
    res = next;
    current = next.path;
    paintCrumbs();
    if (showFilter) filter.value = "";
    opts.onState?.({ path: current, parent: next.parent, error: next.error ?? "", dirs: next.dirs, files: next.files ?? [] });
    paint();
    list.scrollTop = 0;
  };

  if (showFilter) filter.oninput = () => paint();
  if (opts.autoStart !== false) void go(opts.start);

  return {
    root,
    go,
    path: () => current,
    refresh: () => void go(current),
  };
}

export const ATTACHABLE_IMAGE = IMAGE_FILES;
