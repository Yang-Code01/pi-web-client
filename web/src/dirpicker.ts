import { api, type DirEntry, type DirPage, type DirSortKey } from "./api.ts";
import { formatBytes } from "./bytes.ts";
import { createEl as el } from "./chat.ts";
import { icon, fileIcon } from "./icons.ts";
import { DEFAULT_SORT, loadDirSort, loadSubSearch, nextDirSort, saveDirSort, saveSubSearch, type DirSort } from "./dirsort.ts";
import { tr } from "./i18n/index.ts";

/**
 * One directory browser, three call sites: the new-session sheet's 📁 浏览, the attachment picker,
 * and the viewer's 浏览 pane of the file explorer. Listings come from `/api/dirs`; the file
 * manager's jump box first asks `/api/stat` what a typed path actually is.
 */

const IMAGE_FILES = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
/** 只敲盘符（`C:`）—— 那颗盘的根，不是相对路径。 */
const BARE_DRIVE = /^[A-Za-z]:$/;

/** 目录行与「上一级」行共用全站的图标（`./icons.ts`）：以前这里自己画了一份 16×16，
 * 而文件行还是 emoji，一张表里两套图标语言。 */
const folderIcon = (): SVGSVGElement => icon("folder", { size: 14, cls: "dir-ico" });
const upIcon = (): SVGSVGElement => icon("arrowUp", { size: 14, cls: "dir-ico" });

type Volume = { root: string; total: number; free: number };
type FileStat = { name: string; size: number; mtime: number };

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
  /** #499：这个目录一共多少条（不是这一页多少条），控制台的「N 项」要用它。 */
  total?: number;
  /** 已经取到客户端的有多少条。 */
  loaded?: number;
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
  /**
   * 附件控制台（#421）的表格版式：名称 / 大小 / 修改时间 / 操作 四列。
   * 只有控制台用它；文件管理器仍是行列表。
   */
  tableView?: boolean;
  /** 控制台式版式：面包屑与动作条一行，跳转框与筛选框一行。 */
  layout?: "stack" | "console";
  /**
   * 状态栏右侧那格写当前目录（文件管理器的 pane 壳用）。弹层已经在自己页脚写了一份，不传。
   * 给了它，页脚就常显：没有分页时只留这一格路径。
   */
  statusPath?: boolean;
  /**
   * 每行右侧的动作按钮（引用 / 打开）。给了它，文件行就从 `<button>` 换成 `div` ——
   * 按钮里不能再嵌按钮。
   */
  actions?: (abs: string, name: string) => HTMLElement[];
  /** Called after every successful listing, and on entering a directory. */
  onState?: (state: DirPickerState) => void;
  /** A file was clicked; the row is handed over so the caller can show a busy state. */
  onPick?: (abs: string, name: string, row: HTMLElement) => void;
  /** A file row that must not be picked (it is attached, not referenced). */
  isAttach?: (name: string) => boolean;
  /** Right-click on a file row (Q-008: 用 PowerShell 运行 / 以管理员运行). */
  onContext?: (abs: string, name: string, ev: MouseEvent) => void;
  /**
   * #499：一页一页取（服务端筛选 / 排序 / 递归 + 加载更多）。默认开；旧桥没有 `entries`
   * 时自动退回「整目录一次给完 + 本地筛选」，排序控件也不显示。
   */
  paged?: boolean;
  /** 排序控件。表头版（tableView）默认有；列表版要显式打开。 */
  sortable?: boolean;
  /** 排序记在哪个 key 下（默认 shared = 五个入口共用一份）。 */
  sortStore?: string;
  /** 没有任何记忆时的初始排序：文件两个入口传修改时间降序，新会话弹层留名称升序。 */
  defaultSort?: DirSort;
  /** 一页多少条。 */
  pageSize?: number;
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
  /**
   * 面包屑只占一行：长路径（`此电脑 / var / folders / … / 项目`）以前会折成三行，把工具条顶成三层；
   * 现在横向滚到尾巴（当前目录就在眼前），哪一侧还藏着内容就在那一侧渐隐。
   */
  const fitCrumbs = (): void => {
    const hidden = where.scrollWidth - where.clientWidth;
    // 左边藏了字（滚到尾巴后总有）：一层渐隐，别让人以为路径从「42z4…」开始。
    where.classList.toggle("cut", where.scrollLeft > 2);
    // 右边还藏着：同理再补一层（分页 / 长路径时才有）。
    where.classList.toggle("cut-end", hidden - where.scrollLeft > 2);
  };
  where.onscroll = () => fitCrumbs();
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
    // 画完才知道有没有溢出：滚到尾巴，再决定左边要不要渐隐。
    requestAnimationFrame(() => {
      if (!where.isConnected) return;
      where.scrollLeft = where.scrollWidth;
      fitCrumbs();
    });
  };
  const dirHead = el("div", "dir-head");
  dirHead.append(where, ...(opts.head ?? []));
  const listFiles = opts.files === true;
  const table = opts.tableView === true;
  const consoleLayout = opts.layout === "console";
  const showFilter = opts.filter ?? listFiles;
  const sortable = opts.sortable ?? table;
  const store = opts.sortStore ?? "shared";
  const limit = Math.max(20, opts.pageSize ?? 200);

  const filter = el("input", "ns-input dir-filter") as HTMLInputElement;
  filter.placeholder = tr("筛选当前目录…");
  // #499：包含子目录是递归检索，默认关（大树上很贵），开关记一份。
  let subSearch = loadSubSearch();
  const subBox = el("input") as HTMLInputElement;
  subBox.type = "checkbox";
  subBox.checked = subSearch;
  const subWrap = el("label", "dir-sub");
  subWrap.title = tr("连子目录一起找（跳过 node_modules、dist 这类目录）");
  subWrap.append(subBox, el("span", "", tr("包含子目录")));
  // 只挑目录的入口（新会话弹层）里递归没有意义：桥端 sub 只找文件，勾上也不会多出一行。
  subWrap.hidden = !listFiles;

  // 表格版式的滚动容器：表头要跟着列表一起滚出去，所以滚动区包住 <table> 而不是 tbody。
  const list = table ? el("div", "fc-body dir-table-wrap") : el("div", "model-list dir-list");
  const tbody = el("tbody");
  const ths: HTMLTableCellElement[] = [];
  let sort: DirSort = sortable ? loadDirSort(store, opts.defaultSort) : { ...DEFAULT_SORT };
  const makeTh = (key: DirSortKey | null, cls: string, label: string): HTMLTableCellElement => {
    const th = el("th", cls, label) as HTMLTableCellElement;
    if (key) {
      th.dataset.sort = key;
      th.append(el("span", "ar"));
      th.tabIndex = 0;
      th.title = tr("按这一列排序；再点一次换方向");
      th.onclick = () => applySort(key);
      th.onkeydown = (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        applySort(key);
      };
      ths.push(th);
    }
    return th;
  };
  if (table) {
    const tableEl = el("table", "sys-table fc-table");
    const thead = el("thead");
    const headRow = el("tr");
    headRow.append(makeTh("name", "", tr("名称")), makeTh("size", "num fc-col-size", tr("大小")), makeTh("mtime", "num fc-col-time", tr("修改时间")), makeTh(null, "fc-ops", tr("操作")));
    thead.append(headRow);
    tableEl.append(thead, tbody);
    list.append(tableEl);
  }
  const rowsHost: HTMLElement = table ? tbody : list;
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

  // 列表版的排序也是一排「列名」，和表格版的表头同一个手势：点一下按它排，再点一下翻方向。
  // 文件行才有「大小」——只列目录的入口不给一个永远空的排序。
  const sortLabels: [DirSortKey, string][] = [
    ["name", tr("名称")],
    ...(listFiles ? [["size", tr("大小")] as [DirSortKey, string]] : []),
    ["mtime", tr("修改时间")],
  ];
  const sortBtns = new Map<DirSortKey, HTMLButtonElement>();
  const sortRow = el("div", "dir-sort");
  for (const [key, label] of sortLabels) {
    const b = el("button", "dir-sort-key", label) as HTMLButtonElement;
    b.type = "button";
    b.dataset.sort = key;
    b.title = tr("按这一列排序；再点一次换方向");
    b.onclick = () => applySort(key);
    sortBtns.set(key, b);
    sortRow.append(b);
  }

  // 已加载 N / M + 加载更多：只在分页清单里有意义（旧桥一次给完，这行一直隐藏）。
  // 控制台版式把它当状态栏用：右边再加一格当前路径（`statusPath`）。
  const statusPath = opts.statusPath === true;
  const foot = el("div", "dir-pagefoot");
  const count = el("span", "dir-pagecount");
  const pending = el("span", "dir-pending", tr("正在统计大小…"));
  const footPath = el("span", "dir-footpath");
  const more = el("button", "btn ghost dir-more") as HTMLButtonElement;
  more.type = "button";
  more.onclick = () => void loadMore();
  foot.append(count, pending, more, footPath);

  const findRow = el("div", "dir-find");
  if (showFilter) findRow.append(filter, subWrap);
  if (consoleLayout) {
    root.classList.add("console");
    dirHead.classList.add("fc-bar");
    jumpInput.classList.add("fc-input");
    // fc-filter 自带 .fc-input 的尺寸；再把 .dir-filter 摘掉，否则会被 `.dirpicker .dir-filter`
    // 的 8px 外边距和 13px 字号顶得比左边的路径框高半头。
    filter.classList.remove("dir-filter");
    filter.classList.add("fc-input", "fc-filter");
    const find = el("div", "fc-find");
    if (jump) find.append(jump);
    if (showFilter) find.append(filter, subWrap);
    root.append(dirHead, ...(find.childElementCount ? [find] : []), ...(opts.beforeList ?? []), list, foot);
  } else {
    // 筛选与排序挤在同一行：两行各自的上下 padding 叠起来能吃掉近 90px 的列表高度（#499 之后
    // 右栏一屏只剩四个文件夹，大头就在这两行的留白上）。
    const tools = el("div", "dir-tools");
    if (showFilter) tools.append(findRow);
    if (sortable && !table) tools.append(sortRow);
    root.append(dirHead, ...(jump ? [jump] : []), ...(tools.childElementCount ? [tools] : []), ...(opts.beforeList ?? []), list, foot);
  }
  host.append(root);

  let current = "";
  let parent: string | null = null;
  let errorText = "";
  let volumes: Volume[] = [];
  /** 已经拿到的条目（分页时是累加出来的）。 */
  let entries: DirEntry[] = [];
  let total = 0;
  let truncated = false;
  let statsPending = false;
  /** 旧桥没有 `entries`：退回「整目录一次给完 + 本地筛选」。 */
  let paged = opts.paged !== false;
  let query = "";
  /** 慢回应守卫：只认最后一次请求。 */
  let seq = 0;
  let moreBusy = false;
  let filterTimer: number | null = null;
  /** 待标出来的那一行（保留原大小写）。paint 用掉就清 —— 它是「这一次」的，不是持久状态。 */
  let pendingReveal = "";
  /** D62 的老桥兜底：大小/时间是第二个请求，按名字把格子补上。 */
  let stats = new Map<string, FileStat>();
  let statToken = 0;
  const fileRows = new Map<string, { size: HTMLElement; time: HTMLElement }>();
  /** Drive letters have no drive to letter, so join with the separator the path already uses. */
  const join = (name: string): string => joinPath(current, name);

  const clearRows = (): void => {
    rowsHost.replaceChildren();
    fileRows.clear();
  };
  /** 空态 / 读取中：列表版是一行 `.empty`，表格版得是一条跨四列的 `<tr>`。 */
  const message = (text: string): HTMLElement => {
    if (!table) return el("div", "empty", text);
    const row = el("tr");
    const cell = el("td", "fc-empty", text);
    cell.colSpan = 4;
    row.append(cell);
    return row;
  };

  const paintSort = (): void => {
    const arrow = sort.dir === "asc" ? " ↑" : " ↓";
    for (const [key, b] of sortBtns) {
      const on = key === sort.key;
      b.classList.toggle("on", on);
      b.textContent = (sortLabels.find(([k]) => k === key)?.[1] ?? key) + (on ? arrow : "");
    }
    for (const th of ths) {
      const on = th.dataset.sort === sort.key;
      th.classList.toggle("on", on);
      const ar = th.querySelector(".ar");
      if (ar) ar.textContent = on ? arrow : "";
    }
  };

  const paintFoot = (): void => {
    foot.hidden = statusPath ? false : !paged || errorText !== "";
    if (foot.hidden) return;
    const paging = paged && errorText === "";
    count.hidden = !paging && !statusPath;
    pending.hidden = !paging || !statsPending;
    more.hidden = !paging || entries.length >= total;
    more.disabled = moreBusy;
    if (paging) count.textContent = truncated ? tr("超过 5 万条，只展示前 5 万") : tr("已加载 {p1} / {p2}", { p1: String(entries.length), p2: String(total) });
    // 旧桥一次给完（没有分页）时，状态栏就报这一共几条。
    else if (statusPath) count.textContent = tr("{p1} 项", { p1: String(total || entries.length) });
    more.textContent = moreBusy ? tr("读取中…") : tr("加载更多");
    footPath.hidden = !statusPath;
    footPath.textContent = statusPath ? current || tr("此电脑") : "";
    footPath.title = footPath.textContent;
  };

  /** 旧桥：整目录里按名字筛（分页时由桥端筛，这里不再过滤）。 */
  const shown = (): DirEntry[] => {
    if (paged || !query) return entries;
    const needle = query.toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(needle) || (e.rel ?? "").toLowerCase().includes(needle));
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

  /** 旧桥的第二轮：文件大小/时间（新桥的清单里已经带了，不用再问）。 */
  const fillStats = (dir: string): void => {
    if (paged || !listFiles || !dir) return;
    const token = ++statToken;
    void api
      .fileStats(dir)
      .then((payload) => {
        if (!root.isConnected || token !== statToken || dir !== current) return;
        const rows = Array.isArray(payload?.files) ? payload.files : [];
        stats = new Map(rows.filter((f) => f && typeof f.size === "number").map((f) => [f.name, f]));
        for (const [name, cells] of fileRows) {
          const st = stats.get(name);
          if (!st) continue;
          cells.size.textContent = formatBytes(st.size);
          cells.time.textContent = formatTime(st.mtime);
        }
      })
      .catch(() => {
        // 老桥答不了大小就空着，列表照样能用。
      });
  };

  const marked = (entry: DirEntry): boolean => {
    if (pendingReveal === "") return false;
    return entry.name === pendingReveal || entry.name.toLowerCase() === pendingReveal.toLowerCase();
  };

  const addVolume = (vol: Volume, label: string): void => {
    const row = volumeRow(vol, label);
    if (!table) {
      rowsHost.append(row);
      return;
    }
    const tr = el("tr", "vol-tr");
    const cell = el("td", "fc-volcell");
    cell.colSpan = 4;
    cell.append(row);
    tr.append(cell);
    rowsHost.append(tr);
  };

  const addDir = (entry: DirEntry): void => {
    const { name } = entry;
    const face = (): Node => {
      if (!listFiles) return folderIcon();
      const box = el("span", "ico");
      box.append(icon("folder", { size: 14 }));
      return box;
    };
    if (!table) {
      // 图标和名字分两个节点：图标占定宽那一列，名字自己省略号。
      const row = el("button", "model-row dir-row") as HTMLButtonElement;
      row.append(face(), el("span", "nm", name));
      if (marked(entry)) row.classList.add("hit");
      row.title = entry.rel ? `${join(name)} · ${entry.rel}` : join(name);
      row.onclick = () => void go(join(name));
      rowsHost.append(row);
      return;
    }
    const row = el("tr", "dir-row dir");
    if (marked(entry)) row.classList.add("hit");
    const nameCell = el("td", "fc-namecell");
    const wrap = el("div", "fc-name");
    wrap.append(face(), el("span", "nm", name));
    if (entry.rel) wrap.append(el("span", "rel", entry.rel));
    nameCell.append(wrap);
    const timeText = typeof entry.mtime === "number" ? formatTime(entry.mtime) : "–";
    row.append(nameCell, el("td", "num fc-col-size fc-dim", tr("文件夹")), el("td", "num fc-col-time fc-dim", timeText), el("td", "fc-ops"));
    row.title = join(name);
    row.tabIndex = 0;
    row.onclick = () => void go(join(name));
    row.onkeydown = (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      void go(join(name));
    };
    rowsHost.append(row);
  };

  const pickFile = (name: string, row: HTMLElement): void => {
    opts.onPick?.(join(name), name, row);
  };

  const addFile = (entry: DirEntry): void => {
    const { name } = entry;
    const actions = opts.actions?.(join(name), name) ?? [];
    const size = (table ? el("td", "num fc-col-size") : el("span", "size")) as HTMLElement;
    const time = (table ? el("td", "num fc-col-time") : el("span", "mtime")) as HTMLElement;
    // 新桥这一条已经带着大小/时间；老桥先空着，等 fileStats 回来补。
    if (typeof entry.size === "number") size.textContent = formatBytes(entry.size);
    if (typeof entry.mtime === "number") time.textContent = formatTime(entry.mtime);
    fileRows.set(entry.rel ?? name, { size, time });
    // <button> 里不能再放 <button>：带动作按钮的行整个改成 div（role/tabindex 补回键盘语义）。
    let row: HTMLElement;
    if (table) row = el("tr", "file-row");
    else if (actions.length) {
      row = el("div", "model-row dir-row file-row");
      row.tabIndex = 0;
      row.setAttribute("role", "button");
    } else row = el("button", "model-row dir-row file-row");
    if (marked(entry)) row.classList.add("hit");
    if (table) {
      const nameCell = el("td", "fc-namecell");
      const wrap = el("div", "fc-name");
      const pick = el("button", "fc-pick nm", name) as HTMLButtonElement;
      pick.type = "button";
      pick.title = join(name);
      pick.onclick = (ev) => {
        ev.stopPropagation();
        pickFile(name, row);
      };
      const fileIc = el("span", "ico");
      fileIc.append(icon(fileIcon(name), { size: 14 }));
      wrap.append(fileIc, pick);
      if (entry.rel) wrap.append(el("span", "rel", entry.rel));
      nameCell.append(wrap);
      row.append(nameCell, size, time, el("td", "fc-ops"));
    } else {
      const fileIc = el("span", "ico");
      fileIc.append(icon(fileIcon(name), { size: 14 }));
      row.append(fileIc, el("span", "nm", name), size, time);
      if (entry.rel) row.append(el("span", "rel", entry.rel));
    }
    if (actions.length) {
      const acts = el("span", "fc-acts");
      for (const act of actions) {
        act.addEventListener("click", (ev) => ev.stopPropagation());
        acts.append(act);
      }
      if (table) (row.lastElementChild as HTMLElement | null)?.append(acts);
      else row.append(acts);
    }
    row.title = join(name);
    row.onclick = () => pickFile(name, row);
    if (!table && actions.length) {
      row.onkeydown = (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        if ((ev.target as HTMLElement | null)?.closest(".fc-act")) return;
        ev.preventDefault();
        pickFile(name, row);
      };
    }
    if (opts.onContext) {
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        opts.onContext?.(join(name), name, ev);
      };
    }
    rowsHost.append(row);
  };

  const renderEntry = (entry: DirEntry): void => {
    if (current === "" && volumes.length) {
      const vol = volumes.find((v) => v.root === entry.name);
      if (vol) {
        addVolume(vol, entry.name.replace(/[\\/]+$/, ""));
        return;
      }
    }
    if (entry.kind === "dir") addDir(entry);
    else addFile(entry);
  };

  const upRow = (): void => {
    if (table) {
      const up = el("tr", "fc-up");
      const cell = el("td", "fc-dim");
      cell.colSpan = 4;
      cell.append(upIcon(), el("span", "", tr("上一级")));
      up.append(cell);
      up.onclick = () => void go(parent ?? "");
      rowsHost.append(up);
      return;
    }
    const up = el("button", "model-row dir-row") as HTMLButtonElement;
    up.append(upIcon(), el("span", "nm", tr("上一级")));
    up.onclick = () => void go(parent ?? "");
    rowsHost.append(up);
  };

  const paint = (): void => {
    clearRows();
    if (parent !== null) upRow();
    if (errorText) {
      rowsHost.append(message(errorText));
      paintFoot();
      return;
    }
    const rows = shown();
    for (const entry of rows) renderEntry(entry);
    if (!rows.length) rowsHost.append(message(query ? tr("没有匹配项") : tr("空目录")));
    // 标过了就算用掉：之后再画（在筛选框里打字）不该又亮一遍 —— 高亮只说明「刚跳/刚建的是这一行」。
    pendingReveal = "";
    paintFoot();
    paintSort();
  };

  /** 追加下一页：只画新增的那几条（整块重画会把滚动位置弹回顶部）。 */
  const appendRange = (from: number): void => {
    for (let i = from; i < entries.length; i++) renderEntry(entries[i]);
  };

  const showJump = (text: string): void => {
    jumpErr.textContent = text;
    jumpInput.classList.toggle("bad", text !== "");
    if (text) jumpInput.setAttribute("aria-invalid", "true");
    else jumpInput.removeAttribute("aria-invalid");
  };

  let refetchStats: () => Promise<void> = async () => {};

  /**
   * 取一页。`append` 是「加载更多」，`reveal` 是跳转要标的那一行，`allowFallback` 关掉时
   * 打不开的目录在原处报错（跳转框已经先说过一次，别再默默跳去盘符页）。
   */
  const fetchInto = async (target: string, o: { append?: boolean; reveal?: string; allowFallback?: boolean; keepQuery?: boolean; quiet?: boolean } = {}): Promise<{ ok: true } | { ok: false; error: string }> => {
    const mine = ++seq;
    const append = o.append === true;
    let quiet = !append && o.quiet === true;
    // 「读取中…」占位不立刻出：快的请求（本机目录 20~80ms）留着旧的一页就行，
    // 先清空再填回去，视觉上就是列表闪了一下。只有真的慢过 220ms 才让位给占位。
    let waitTimer: ReturnType<typeof setTimeout> | null = null;
    const stopWait = (): void => {
      if (waitTimer === null) return;
      clearTimeout(waitTimer);
      waitTimer = null;
    };
    if (append) {
      moreBusy = true;
      paintFoot();
    } else if (quiet) {
      // 同一个目录里只换了顺序或筛选词：旧的那一页先留着，等新的一页到了整块换上去。
      // 先清空会让列表闪一下「读取中…」再弹回来，看着就是「抖了一下」。
      root.classList.add("busy");
      paintFoot();
    } else {
      waitTimer = setTimeout(() => {
        waitTimer = null;
        if (mine !== seq || !root.isConnected) return;
        clearRows();
        rowsHost.append(message(tr("读取中…")));
        // 状态栏（文件管理器 pane 壳）不跟着藏：它是常显的那条，闪一下等于底栏跳了一下。
        if (!statusPath) foot.hidden = true;
      }, 220);
    }
    let next: DirPage;
    try {
      next = await api.dirsPage(target, { q: query, offset: append ? entries.length : 0, limit, sort: sort.key, dir: sort.dir, sub: subSearch, files: listFiles });
    } catch (ex: any) {
      stopWait();
      if (mine !== seq || !root.isConnected) return { ok: false, error: "" };
      moreBusy = false;
      quiet = false;
      root.classList.remove("busy");
      pendingReveal = "";
      const said = tr("读取失败：{p1}", { p1: ex?.message ?? ex });
      clearRows();
      rowsHost.append(message(said));
      paintFoot();
      return { ok: false, error: said };
    }
    stopWait();
    if (mine !== seq || !root.isConnected) {
      moreBusy = false;
      root.classList.remove("busy");
      return { ok: false, error: "" };
    }
    // A path that does not exist (typed, or remembered from another machine): show drives instead.
    if (next.error && !append && target && opts.fallback && o.allowFallback !== false) return fetchInto("", o);
    paged = next.paged;
    subWrap.hidden = !paged || !listFiles;
    const before = entries.length;
    if (!append) entries = [];
    entries = entries.concat(next.entries);
    current = next.path;
    parent = next.parent;
    errorText = next.error ?? "";
    volumes = next.volumes ?? [];
    total = next.total;
    truncated = next.truncated;
    statsPending = next.statsPending === true;
    // 高亮跟着列表一起换：列表没换成，旧的「行 ↔ 高亮」配对就原样留着。
    pendingReveal = errorText ? "" : (o.reveal ?? "");
    paintCrumbs();
    if (append) appendRange(before);
    else {
      if (showFilter && !o.keepQuery) {
        filter.value = "";
        query = "";
      }
      paint();
      // 换顺序/换筛选词后回到顶部是对的（不然眼睛找不到刚排在最前的那几条），
      // 但只在用户本来就不在顶部时才动，避免「已经在顶部还跳一下」。
      if (list.scrollTop !== 0) list.scrollTop = 0;
    }
    moreBusy = false;
    if (quiet) {
      quiet = false;
      root.classList.remove("busy");
    }
    paintFoot();
    fillStats(current);
    opts.onState?.({
      path: current,
      parent,
      error: errorText,
      dirs: entries.filter((e) => e.kind === "dir").map((e) => e.name),
      files: entries.filter((e) => e.kind === "file").map((e) => e.name),
      total,
      loaded: entries.length,
    });
    // 换到哪儿是哪儿了：上一跳留下的错路径红字不能再指着这个新目录。
    showJump("");
    if (statsPending) setTimeout(() => void refetchStats(), 700);
    return errorText ? { ok: false, error: errorText } : { ok: true };
  };

  const go = async (target: string): Promise<void> => {
    // 换目录 = 换一个筛选上下文：上一个目录的筛选词留着会让新目录看着空空的。
    if (target !== current) {
      query = "";
      if (showFilter) filter.value = "";
    }
    await fetchInto(target);
  };

  const loadMore = async (): Promise<void> => {
    if (moreBusy || !paged || errorText || entries.length >= total) return;
    if (filterTimer !== null) {
      clearTimeout(filterTimer);
      filterTimer = null;
    }
    await fetchInto(current, { append: true });
  };

  /** 统计没回来：隔一会儿再问同一页，把大小/时间补进已经画好的格子（不重画，滚动位置不动）。 */
  refetchStats = async (): Promise<void> => {
    if (!root.isConnected || errorText) return;
    const mine = seq;
    let next: DirPage;
    try {
      next = await api.dirsPage(current, { q: query, offset: 0, limit, sort: sort.key, dir: sort.dir, sub: subSearch, files: listFiles });
    } catch {
      return;
    }
    if (mine !== seq || !root.isConnected || next.path !== current) return;
    statsPending = next.statsPending === true;
    for (const entry of next.entries) {
      const cells = fileRows.get(entry.rel ?? entry.name);
      if (!cells) continue;
      if (typeof entry.size === "number") cells.size.textContent = formatBytes(entry.size);
      if (typeof entry.mtime === "number") cells.time.textContent = formatTime(entry.mtime);
    }
    paintFoot();
  };

  /** 排序：同一列翻方向 / 换列用默认方向；筛选词与滚动位置都留在原地（只换顺序）。 */
  function applySort(key: DirSortKey): void {
    sort = nextDirSort(sort, key);
    saveDirSort(store, sort);
    paintSort();
    void fetchInto(current, { keepQuery: true, quiet: true });
  }

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
    // 筛选框那 150ms 防抖还在排队时跳转：它一落地就会拿（旧）筛选词重取一页，把刚标出来的行冲掉。
    if (filterTimer !== null) {
      clearTimeout(filterTimer);
      filterTimer = null;
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
        pendingReveal = "";
        for (const row of list.querySelectorAll(".dir-row.hit")) row.classList.remove("hit");
        showJump(tr("没有这个路径：{p1}", { p1: info.path || typed }));
        return;
      }
      if (info.kind === "dir") {
        const went = await fetchInto(info.path, { allowFallback: false });
        if (went.ok) jumpInput.value = "";
        else showJump(went.error);
        return;
      }
      const name = fileNameOf(info.path);
      // 父目录打不开就把它自己的错误留在列表里（allowFallback 关着），不要莫名其妙跳去盘符页；
      // 输入框下面也补同一句，不然 stat 说「是文件夹」、readdir 却说不行时，界面上没有解释。
      const went = await fetchInto(info.parent ?? "", { reveal: name, allowFallback: false });
      if (!went.ok) {
        if (went.error) showJump(went.error);
        return;
      }
      let row = list.querySelector<HTMLElement>(".file-row.hit");
      if (!row && paged) {
        // #499：不在这一页里就按名字再问一次桥端 —— 路径框是「我知道它叫什么」，不该被分页卡住。
        // 筛出来的结果就留在列表上，省得「跳是跳到了，列表却还是刚才那一页」。
        query = name;
        filter.value = name;
        await fetchInto(info.parent ?? "", { reveal: name, allowFallback: false, keepQuery: true });
        row = list.querySelector<HTMLElement>(".file-row.hit");
      }
      if (!row) {
        // 这一页里没有它（筛选词、或者它排在后面的页里）：翻过去也找不到，说清楚，别留个「没反应」。
        showJump(tr("这一页里没有 {p1}，试试清空筛选或再点一次「加载更多」", { p1: name }));
        return;
      }
      jumpInput.value = "";
      row.scrollIntoView({ block: "center" });
      (row.querySelector<HTMLElement>(".fc-pick") ?? row).focus({ preventScroll: true });
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

  if (showFilter) {
    filter.oninput = () => {
      if (filterTimer !== null) clearTimeout(filterTimer);
      // 150ms 防抖：每敲一个字都问一次桥，大目录会把连接打满。
      filterTimer = window.setTimeout(() => {
        filterTimer = null;
        if (!root.isConnected) return;
        query = filter.value.trim();
        void fetchInto(current, { keepQuery: true, quiet: true });
      }, 150);
    };
    subBox.onchange = () => {
      subSearch = subBox.checked;
      saveSubSearch(subSearch);
      void fetchInto(current, { keepQuery: true, quiet: true });
    };
  }
  paintSort();

  // 滚到底自动翻页；再往下一屏才点「加载更多」也行（按钮一直在）。
  list.onscroll = () => {
    if (!paged || moreBusy || errorText || entries.length >= total) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 160) void loadMore();
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
