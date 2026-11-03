import { api } from "./api.ts";
import { createEl as el, fileIcon } from "./chat.ts";
import { tr } from "./i18n/index.ts";

/**
 * One directory browser, three call sites: the new-session sheet's 📁 浏览, the attachment picker,
 * and the viewer's 浏览 pane of the file explorer. It only reads `/api/dirs`, which the bridge
 * answers for any path on this machine.
 */

const IMAGE_FILES = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;

type Volume = { root: string; total: number; free: number };
type FileStat = { name: string; size: number; mtime: number };

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Sizes sit in a column, so they get one decimal at most and never a trailing ".0". */
export function formatBytes(n: number): string {
  let value = Number.isFinite(n) && n > 0 ? n : 0;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${UNITS[unit]}`;
}

/** Today → 18:37, this year → 11-01, older → 2025-12-31 (same idea as the composer's activity peek). */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Below this the picker is a popover (the attachment sheet), not a pane: the percentage goes. */
const NARROW_PX = 460;

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
    button.title = target ? tr("跳到 {p1}", { p1: target }) : tr("此电脑");
    button.onclick = () => void go(target);
    return button;
  };
  const paintCrumbs = (): void => {
    where.replaceChildren();
    where.append(crumb(tr("此电脑"), "", true));
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
  filter.placeholder = tr("筛选当前目录…");
  const list = el("div", "model-list dir-list");
  if (showFilter) root.append(dirHead, filter, ...(opts.beforeList ?? []), list);
  else root.append(dirHead, ...(opts.beforeList ?? []), list);
  host.append(root);

  let current = "";
  let res: Awaited<ReturnType<typeof api.dirs>> | null = null;
  /** D62: file sizes land in a second request; keyed by name so a repaint (筛选) keeps them. */
  let stats = new Map<string, FileStat>();
  /** Guards against a slow answer for the folder we already left. */
  let statToken = 0;
  const fileRows = new Map<string, { size: HTMLElement; time: HTMLElement }>();
  /** Drive letters have no drive to letter, so join with the separator the path already uses. */
  const join = (name: string): string => {
    if (!current) return name;
    const sep = current.includes("/") && !current.includes("\\") ? "/" : "\\";
    return `${current.replace(/[\\/]+$/, "")}${sep}${name}`;
  };

  /** D62: a drive row carries its own fill bar, since a bare `C:\` says nothing about "够不够用". */
  const volumeRow = (vol: Volume, label: string): HTMLElement => {
    const used = Math.max(0, vol.total - vol.free);
    const pct = vol.total > 0 ? Math.min(100, Math.round((used / vol.total) * 100)) : 0;
    const row = el("button", "model-row vol-row");
    if (pct >= 95) row.classList.add("full");
    else if (pct >= 85) row.classList.add("tight");
    const bar = el("span", "vol-bar");
    const fill = el("i");
    fill.style.width = `${pct}%`;
    bar.append(fill);
    row.append(el("span", "vol-letter", label), bar, el("span", "vol-pct", `${pct}%`), el("span", "vol-free", tr("{p1} 可用", { p1: formatBytes(vol.free) })));
    row.title = tr("{p1}\\ 共 {p2} · 已用 {p3} · 剩 {p4}", { p1: label, p2: formatBytes(vol.total), p3: formatBytes(used), p4: formatBytes(vol.free) });
    row.onclick = () => void go(vol.root);
    return row;
  };

  /** D62: sizes are a second round trip, so a sleeping network folder never holds up the names. */
  const fillStats = (dir: string): void => {
    if (!listFiles || !dir) return;
    const token = ++statToken;
    void api
      .fileStats(dir)
      .then((payload) => {
        if (!root.isConnected || token !== statToken || dir !== current) return;
        // Tolerate an older bridge that answers the listing instead of `{ files: [...] }`.
        const rows = Array.isArray(payload?.files) ? payload.files : [];
        stats = new Map(rows.filter((f) => f && typeof f.size === "number").map((f) => [f.name, f]));
        for (const [name, cells] of fileRows) {
          const st = stats.get(name);
          if (!st) continue;
          cells.size.textContent = formatBytes(st.size);
          cells.time.textContent = formatTime(st.mtime);
        }
      })
      .catch(() => {});
  };

  const paint = (): void => {
    if (!res) return;
    const q = showFilter ? filter.value.trim().toLowerCase() : "";
    const hit = (n: string) => !q || n.toLowerCase().includes(q);
    const dirs = res.dirs.filter(hit);
    const files = (res.files ?? []).filter(hit);
    const volumes = new Map((res.volumes ?? []).map((v) => [v.root, v]));
    list.replaceChildren();
    fileRows.clear();
    if (res.parent !== null) {
      const up = el("button", "model-row dir-row", tr("↑ 上一级"));
      up.onclick = () => void go(res?.parent ?? "");
      list.append(up);
    }
    if (res.error) {
      list.append(el("div", "empty", res.error));
      return;
    }
    for (const name of dirs) {
      const vol = current === "" ? volumes.get(name) : undefined;
      if (vol) {
        list.append(volumeRow(vol, name.replace(/[\\/]+$/, "")));
        continue;
      }
      const row = el("button", "model-row dir-row", `📁 ${name}`);
      row.onclick = () => void go(join(name));
      list.append(row);
    }
    for (const name of files) {
      const row = el("button", "model-row dir-row file-row");
      const size = el("span", "size");
      const time = el("span", "mtime");
      const st = stats.get(name);
      if (st) {
        size.textContent = formatBytes(st.size);
        time.textContent = formatTime(st.mtime);
      }
      fileRows.set(name, { size, time });
      row.append(el("span", "ico", fileIcon(name)), el("span", "nm", name), size, time);
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
      list.append(el("div", "empty", res.dirs.length || (res.files ?? []).length ? tr("没有匹配项") : tr("空目录")));
    }
  };

  const go = async (target: string): Promise<void> => {
    list.replaceChildren(el("div", "empty", tr("读取中…")));
    // Leaving the folder: drop its sizes and any answer still in flight for it.
    stats = new Map();
    statToken += 1;
    let next: Awaited<ReturnType<typeof api.dirs>>;
    try {
      next = await api.dirs(target, listFiles);
    } catch (ex: any) {
      if (root.isConnected) list.replaceChildren(el("div", "empty", tr("读取失败：{p1}", { p1: ex?.message ?? ex })));
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
    fillStats(current);
  };

  // A narrow container (the attachment sheet) spares no room for a percentage: path and 剩余 stay.
  const narrow = new ResizeObserver(() => {
    if (!root.isConnected) {
      narrow.disconnect();
      return;
    }
    const width = root.getBoundingClientRect().width;
    root.classList.toggle("narrow", width > 0 && width < NARROW_PX);
  });
  narrow.observe(root);

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
