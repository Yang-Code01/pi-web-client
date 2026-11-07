import { api } from "./api.ts";
import { createEl as el, fileIcon } from "./chat.ts";
import { tr } from "./i18n/index.ts";

/**
 * One directory browser, three call sites: the new-session sheet's 📁 浏览, the attachment picker,
 * and the viewer's 浏览 pane of the file explorer. Listings come from `/api/dirs`; the file
 * manager's jump box first asks `/api/stat` what a typed path actually is.
 */

const IMAGE_FILES = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
/** 只敲盘符（`C:`）—— 那颗盘的根，不是相对路径。 */
const BARE_DRIVE = /^[A-Za-z]:$/;

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

/** Explorer 的「复制为路径」会带上一对引号；手输时也常把整条路径括起来。 */
export function cleanPath(raw: string): string {
  let s = raw.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) s = s.slice(1, -1).trim();
  return s;
}

/** 盘符、UNC、POSIX 根都算绝对路径；Windows 的「无盘符根路径」另算，见 resolveTyped。 */
export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p) || p.startsWith("/");
}

export function joinPath(base: string, name: string): string {
  if (!base) return name;
  const sep = base.includes("/") && !base.includes("\\") ? "/" : "\\";
  return `${base.replace(/[\\/]+$/, "")}${sep}${name}`;
}

export function fileNameOf(p: string): string {
  return p.split(/[\\/]+/).filter(Boolean).pop() ?? p;
}

/**
 * 桥端会把相对路径解析到**它自己的 cwd**，那不是正在浏览的目录，所以相对路径先在这里拼好。
 * `\Users\me`（有根无盘符）落在当前盘上。
 */
/**
 * D163: `text` 是否已经作为**一整个 token** 出现在 `hay` 里（左右只认空白、引号或字符串边缘）。
 * 边界别放宽到 `.` `,` `;` —— 输入框里写着 `F:\a.txt` 时，引用目录 `F:\a` 会被误判成「已在输入框」而
 * 插不进去，而插进去的那份带空格，本来就是空白隔开的。
 */
export function hasPathToken(hay: string, text: string): boolean {
  if (!hay || !text) return false;
  const edge = (c: string): boolean => c === "" || /[\s"'`]/.test(c);
  for (let at = hay.indexOf(text); at !== -1; at = hay.indexOf(text, at + 1)) {
    const before = at > 0 ? hay[at - 1] : "";
    const after = at + text.length < hay.length ? hay[at + text.length] : "";
    if (edge(before) && edge(after)) return true;
  }
  return false;
}

export function resolveTyped(raw: string, base: string): string {
  const typed = cleanPath(raw);
  // `C:` 自己也常被敲（在盘符页跳盘）：没有 `\` 的盘符不是绝对路径，但意图就是那颗盘。先归一，
  // 免得盘符页（base 为空）在下面的早返回里把它原样交给桥端，按 bridge 自己的 cwd 解析。
  if (BARE_DRIVE.test(typed)) return `${typed}\\`;
  if (!typed || !base) return typed;
  if (/^[\\/]/.test(typed) && !/^[\\/]{2}/.test(typed) && /^[A-Za-z]:/.test(base)) return `${base.slice(0, 2)}${typed}`;
  if (isAbsolutePath(typed)) return typed;
  // `./a.txt` 拼出来是 `base/./a.txt`：桥端能 resolve，但报错里很难看。
  const rel = typed.replace(/^(\.[\\/])+/, "");
  return rel ? joinPath(base, rel) : base;
}

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
  /**
   * The jump box: type or paste a path and press Enter — a folder opens, a file jumps to its parent
   * directory and marks that row. The file manager (D50's 浏览 pane) and the 文件 attachment picker
   * turn this on; the new-session sheet doesn't (there the first focus belongs on 工作目录).
   */
  pathBox?: boolean;
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
  /**
   * D167: 把某一行（文件夹或文件）标成 `.hit` 并滚到可见处 —— 新建成功后「看得见结果」就是这一下。
   * 调用方已经先 `go()` 刷新过列表，这里只在画好的节点上补标记（不换装、不重发）。
   */
  reveal(name: string): void;
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
      const drive = part.endsWith(":");
      if (acc === "") acc = drive ? part : `${sep}${part}`;
      else acc = `${acc}${sep}${part}`;
      // D163: 盘符那一段的目标得带上分隔符。`F:` 是**盘符相对路径**，桥端按它自己的 cwd 解析
      // （盘符正好是 cwd 那个盘时，点一下就落回仓库目录 —— 看着像没反应）。显示仍然只写 `F:`。
      where.append(el("span", "crumb-sep", sep), crumb(part, drive ? `${acc}${sep}` : acc, drive));
    }
  };
  const dirHead = el("div", "dir-head");
  dirHead.append(where, ...(opts.head ?? []));
  const listFiles = opts.files === true;
  const showFilter = opts.filter ?? listFiles;
  const filter = el("input", "ns-input dir-filter") as HTMLInputElement;
  filter.placeholder = tr("筛选当前目录…");
  const list = el("div", "model-list dir-list");
  /** 输入路径就跳（pathBox）：文件夹进去、文件跳到父目录并高亮那一行。 */
  const jump = opts.pathBox === true ? el("div", "dir-jump") : null;
  const jumpInput = el("input", "dir-jump-input") as HTMLInputElement;
  const jumpErr = el("div", "dir-jump-err");
  if (jump) {
    jumpInput.type = "text";
    jumpInput.spellcheck = false;
    jumpInput.placeholder = tr("输入路径，回车定位到文件夹或文件");
    jumpInput.title = tr("粘贴绝对路径跳过去（相对路径按当前目录算）：文件夹直接进入，文件跳到它所在的文件夹并标出那一行");
    jumpInput.setAttribute("aria-label", tr("跳到路径"));
    jumpErr.setAttribute("role", "status");
    jump.append(jumpInput, jumpErr);
  }
  root.append(dirHead, ...(jump ? [jump] : []));
  if (showFilter) root.append(filter);
  root.append(...(opts.beforeList ?? []), list);
  host.append(root);

  let current = "";
  let res: Awaited<ReturnType<typeof api.dirs>> | null = null;
  /** 待标出来的那一行（保留原大小写）。paint 用掉就清 —— 它是「这一次」的，不是持久状态。 */
  let pendingReveal = "";
  /** D62: file sizes land in a second request; keyed by name so a repaint (筛选) keeps them. */
  let stats = new Map<string, FileStat>();
  /** Guards against a slow answer for the folder we already left. */
  let statToken = 0;
  const fileRows = new Map<string, { size: HTMLElement; time: HTMLElement }>();
  /** Drive letters have no drive to letter, so join with the separator the path already uses. */
  const join = (name: string): string => joinPath(current, name);

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
    // 上一跳要标的那个名字：先按原样找（Linux 上 A.md 与 a.md 是两行），找不到再忽略大小写。
    // 文件夹与文件共用一套判定 —— 新建出来的可能是任一种（D167）。
    const markedName = (names: string[]): string => {
      if (pendingReveal === "") return "";
      if (names.includes(pendingReveal)) return pendingReveal;
      return names.find((n) => n.toLowerCase() === pendingReveal.toLowerCase()) ?? "";
    };
    const markedDir = markedName(dirs);
    const markedFile = markedName(files);
    for (const name of dirs) {
      const vol = current === "" ? volumes.get(name) : undefined;
      if (vol) {
        list.append(volumeRow(vol, name.replace(/[\\/]+$/, "")));
        continue;
      }
      const row = el("button", "model-row dir-row", `📁 ${name}`);
      if (name === markedDir) row.classList.add("hit");
      row.onclick = () => void go(join(name));
      list.append(row);
    }
    for (const name of files) {
      const row = el("button", "model-row dir-row file-row");
      if (name === markedFile) row.classList.add("hit");
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
    // 标过了就算用掉：之后再画（在筛选框里打字）不该又亮一遍 —— 高亮只说明「刚跳/刚建的是这一行」。
    pendingReveal = "";
  };

  /**
   * List a directory. `revealName` is the file the jump box wants highlighted; `allowFallback` is off
   * for the jump box, because a typo has already been answered as 「没有这个路径」and an unreadable
   * folder should say why in place rather than silently bouncing to 此电脑.
   */
  const navigate = async (rawTarget: string, revealName = "", allowFallback = true): Promise<{ ok: true } | { ok: false; error: string }> => {
    // D163: 兜底一次，任何调用方传裸 `D:` 都当成那颗盘的根，而不是桥端 cwd 上的「D 盘相对路径」。
    const target = BARE_DRIVE.test(rawTarget.trim()) ? `${rawTarget.trim()}\\` : rawTarget;
    list.replaceChildren(el("div", "empty", tr("读取中…")));
    // Leaving the folder: drop its sizes and any answer still in flight for it.
    stats = new Map();
    statToken += 1;
    let next: Awaited<ReturnType<typeof api.dirs>>;
    try {
      next = await api.dirs(target, listFiles);
    } catch (ex: any) {
      // 请求根本没到：上一跳的高亮属于别的目录，别留着。
      pendingReveal = "";
      const said = tr("读取失败：{p1}", { p1: ex?.message ?? ex });
      if (root.isConnected) list.replaceChildren(el("div", "empty", said));
      return { ok: false, error: said };
    }
    if (!root.isConnected) return { ok: false, error: "" };
    // A path that does not exist (typed, or remembered from another machine): show drives instead.
    if (next.error && target && opts.fallback && allowFallback) return navigate("", "", allowFallback);
    res = next;
    current = next.path;
    // 高亮跟着列表一起换：列表没换成，旧的「行 ↔ 高亮」配对就原样留着。
    pendingReveal = next.error ? "" : revealName;
    paintCrumbs();
    if (showFilter) filter.value = "";
    opts.onState?.({ path: current, parent: next.parent, error: next.error ?? "", dirs: next.dirs, files: next.files ?? [] });
    paint();
    list.scrollTop = 0;
    fillStats(current);
    // 换到哪儿是哪儿了：上一跳留下的错路径红字不能再指着这个新目录。
    showJump("");
    // 这一屏是错的（读不了 / 不存在）时把话带回去，调用方别再补一句自己的判断。
    return next.error ? { ok: false, error: next.error } : { ok: true };
  };
  const go = (target: string): Promise<void> => navigate(target).then(() => undefined);

  /** 摘掉跳转高亮而不重画列表：重画会换掉节点，滚动位置和焦点都会丢。 */
  const clearReveal = (): void => {
    pendingReveal = "";
    // 文件行也带 .dir-row（它多一个 file-row），一句选择器就盖住两种。
    for (const row of list.querySelectorAll(".dir-row.hit")) row.classList.remove("hit");
  };

  /** 输入框里的路径：文件夹直接进；文件进父目录，列表出来后高亮那一行。 */
  const showJump = (text: string): void => {
    jumpErr.textContent = text;
    jumpInput.classList.toggle("bad", text !== "");
    if (text) jumpInput.setAttribute("aria-invalid", "true");
    else jumpInput.removeAttribute("aria-invalid");
  };
  let locating = false;
  const locate = async (): Promise<void> => {
    if (locating) return;
    const typed = cleanPath(jumpInput.value);
    showJump("");
    if (!typed) return;
    // 盘符页没有「当前目录」可拼，相对路径交给桥端会落到 bridge 自己的 cwd —— 那不是用户看的地方。
    if (!current && !isAbsolutePath(typed) && !BARE_DRIVE.test(typed)) {
      showJump(tr("在盘符列表里要写完整路径，例如 D:\\work"));
      return;
    }
    locating = true;
    jumpInput.readOnly = true;
    root.classList.add("locating");
    try {
      const info = await api.statPath(resolveTyped(typed, current));
      if (!root.isConnected) return;
      if (info.kind === "denied") {
        // 存在但进不去，和「没有这个路径」是两回事。
        showJump(tr("读不了这个路径：{p1}", { p1: info.path || typed }));
        return;
      }
      if (info.kind === "missing") {
        // 上一次跳转留下的高亮跟这次的错路径没有关系，留着会像是它选中了那一行。
        clearReveal();
        showJump(tr("没有这个路径：{p1}", { p1: info.path || typed }));
        return;
      }
      if (info.kind === "dir") {
        const went = await navigate(info.path, "", false);
        if (went.ok) jumpInput.value = "";
        else showJump(went.error);
        return;
      }
      const name = fileNameOf(info.path);
      // 父目录打不开就把它自己的错误留在列表里（allowFallback 关着），不要莫名其妙跳去盘符页；
      // 输入框下面也补同一句，不然 stat 说「是文件夹」、readdir 却说不行时，界面上没有解释。
      const went = await navigate(info.parent ?? "", name, false);
      if (!went.ok) {
        if (went.error) showJump(went.error);
        return;
      }
      const row = list.querySelector<HTMLButtonElement>(".file-row.hit");
      if (!row) {
        // 列表本身就被过滤与截断过（1000 目录 / 2000 文件），别断言「不存在」。
        showJump(tr("列表里没有 {p1}（目录过大时只列出一部分）", { p1: name }));
        return;
      }
      jumpInput.value = "";
      row.scrollIntoView({ block: "center" });
      row.focus({ preventScroll: true });
    } catch (ex: any) {
      if (root.isConnected) showJump(tr("定位失败：{p1}", { p1: ex?.message ?? ex }));
    } finally {
      locating = false;
      jumpInput.readOnly = false;
      root.classList.remove("locating");
    }
  };

  if (jump) {
    jumpInput.oninput = () => showJump("");
    jumpInput.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        if (ev.isComposing) return;
        ev.preventDefault();
        void locate();
      } else if (ev.key === "Escape") {
        // 输入法里的 Esc 只取消组合，不该连带关掉整个浏览面板。
        if (ev.isComposing) {
          ev.stopPropagation();
          return;
        }
        // 有字就只清这一格，别让 Esc 关掉面板；空着再按一次就把 Esc 交给面板（root 上那个监听
        // 关面板，和第二下 blur 后再也关不掉相比，这样才收得住）。
        if (jumpInput.value) {
          ev.preventDefault();
          ev.stopPropagation();
          jumpInput.value = "";
          showJump("");
        }
      }
    };
  }

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
    reveal: (name) => {
      pendingReveal = name;
      paint();
      list.querySelector<HTMLElement>(".dir-row.hit, .file-row.hit")?.scrollIntoView({ block: "nearest" });
    },
  };
}

export const ATTACHABLE_IMAGE = IMAGE_FILES;
