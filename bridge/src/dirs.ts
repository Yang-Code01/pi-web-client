import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { listFilesUnder } from "./filesearch.ts";

export type Volume = { root: string; total: number; free: number };
export type FileStat = { name: string; size: number; mtime: number };

/** D110: `errCode` 让前端把 `error` 那句中文换成本地语言（见 web/src/i18n 的 errText）。 */
type Listing = { path: string; parent: string | null; dirs: string[]; files?: string[]; volumes?: Volume[]; error?: string; errCode?: string };

/** Used/total for one drive root; null when the volume refuses to answer (a sleeping network drive). */
function volumeOf(root: string): Volume | null {
  try {
    const st = fs.statfsSync(root);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    return total > 0 ? { root, total, free } : null;
  } catch {
    return null;
  }
}

/**
 * A typed path as an absolute one, plus its parent. Shared by the listing and the jump box's kind
 * check so the two can never disagree about where a path points or what its 「上一级」 is.
 * An empty path means the drive list, which has neither.
 */
function resolveTarget(raw: string): { target: string; abs: string; parent: string | null } {
  const target = raw.trim();
  const abs = target ? path.resolve(target) : "";
  const up = abs ? path.dirname(abs) : "";
  // At a drive root the next step up is the drive list itself.
  const parent = !abs ? null : up !== abs ? up : process.platform === "win32" ? "" : null;
  return { target, abs, parent };
}

/** One level of folders (and files when asked); an empty path lists the roots (drive letters on Windows). */
export function listDirs(raw: string, withFiles = false): Listing {
  const { target, abs, parent } = resolveTarget(raw);
  if (!target) {
    if (process.platform !== "win32") return listDirs("/", withFiles);
    const drives: string[] = [];
    const volumes: Volume[] = [];
    for (let c = 65; c <= 90; c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      if (!fs.existsSync(root)) continue;
      drives.push(root);
      // D62: one statfs per drive (0ms), so a drive row can show 占用/剩余 instead of a bare letter.
      const vol = volumeOf(root);
      if (vol) volumes.push(vol);
    }
    return { path: "", parent: null, dirs: drives, volumes, ...(withFiles ? { files: [] } : {}) };
  }
  const order = (a: string, b: string) => Number(a.startsWith(".")) - Number(b.startsWith(".")) || a.localeCompare(b, "zh-CN");
  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => !/^(\$|System Volume Information$)/i.test(d.name));
    const dirs = entries
      .filter((d) => d.isDirectory() || (d.isSymbolicLink() && isDir(path.join(abs, d.name))))
      .map((d) => d.name)
      .sort(order)
      .slice(0, 1000);
    if (!withFiles) return { path: abs, parent, dirs };
    const dirSet = new Set(dirs);
    const files = entries
      .filter((d) => (d.isFile() || d.isSymbolicLink()) && !dirSet.has(d.name))
      .map((d) => d.name)
      .sort(order)
      .slice(0, 2000);
    return { path: abs, parent, dirs, files };
  } catch (err: any) {
    return { path: abs, parent, dirs: [], ...(withFiles ? { files: [] } : {}), error: err?.code === "ENOENT" ? "目录不存在" : `读不了这个目录：${err?.code ?? err}`, errCode: err?.code === "ENOENT" ? "dirs_missing" : "dirs_unreadable" };
  }
}

/* ── 大目录：按页取、按名字筛、按大小/时间排（issue #499） ────────────────────
 *
 * 老接口的硬截断（1000 个文件夹 / 2000 个文件）让人在小目录里也会碰上「明明有，却看不见」
 * 的文件夹，也没法排序。这里换成一份分页清单：排序、过滤、切页都在桥端做，前端只负责把这一页
 * 画出来、往下翻时再要一页。`limit` 只影响这一页多少条，`total` 永远是过滤后的总数。
 */

export type DirSort = "name" | "size" | "mtime";
export type DirEntryKind = "dir" | "file";
export type DirEntry = {
  name: string;
  kind: DirEntryKind;
  /** 文件才有；目录的大小是「里面有多少」而不是字节数。 */
  size?: number;
  mtime?: number;
  /** 递归检索时相对当前目录的路径（`docs/a.md`）；当前目录里的条目没有它。 */
  rel?: string;
};

export type DirPageQuery = {
  /** 名字子串，大小写不敏感；递归时也匹配相对路径。 */
  q?: string;
  offset?: number;
  limit?: number;
  sort?: DirSort;
  dir?: "asc" | "desc";
  /** 连子目录一起找（复用 @ 搜索的 git ls-files / walk）。 */
  sub?: boolean;
  /** 兼容老前端：false 时响应里不带 `files` 名字数组。 */
  files?: boolean;
};

export type DirPage = {
  path: string;
  parent: string | null;
  /** 过滤之后一共有多少条（不是这一页）。 */
  total: number;
  /** 条目本身超了 5 万上限，只保留了前 5 万。 */
  truncated: boolean;
  entries: DirEntry[];
  /** 老前端的字段：这一页里的名字，和 `entries` 同序。 */
  dirs: string[];
  files?: string[];
  volumes?: Volume[];
  error?: string;
  errCode?: string;
  /** 还有条目没量到大小/时间（大目录的 stat 超过预算）：先按名字显示，稍后再问一次。 */
  statsPending?: boolean;
};

const PAGE_LIMIT = 200;
/** 一页最多给多少（前端要翻到底也就几百条，再大就没有意义）。 */
const PAGE_LIMIT_MAX = 1000;
/** 一个目录最多认多少条，超出只保留按名字排的前 5 万。 */
const ENTRY_CAP = 50_000;
/** 一次最多量多少条的大小/时间。 */
const STAT_MAX = 20_000;
const STAT_TTL_MS = 60_000;
/** 量大小的时间预算：超了就先答名字，别让一次点「按大小」等好几秒。 */
const STAT_BUDGET_MS = 2_500;

/** 名字排序：点文件排在后面（和资源管理器一致），中文按拼音。 */
function byName(a: DirEntry, b: DirEntry): number {
  return Number(a.name.startsWith(".")) - Number(b.name.startsWith(".")) || a.name.localeCompare(b.name, "zh-CN");
}

/** 纯函数：名字（递归时也看相对路径）子串匹配，大小写不敏感。 */
export function filterEntries(entries: DirEntry[], q: string): DirEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(needle) || (e.rel ? e.rel.toLowerCase().includes(needle) : false));
}

/**
 * 纯函数：排好序的一份副本。文件夹恒在前；同组里按 `sort` 比。
 *
 * 「文件夹恒在前」不是排序键的一部分 —— 早先把它乘进方向里，按时间降序时文件夹整组被翻到末尾。
 * 按大小时文件夹之间没有大小可比，退回名字；按时间时文件夹之间照常用它自己的 mtime。
 */
export function orderEntries(entries: DirEntry[], sort: DirSort, dir: "asc" | "desc"): DirEntry[] {
  const mul = dir === "desc" ? -1 : 1;
  const cmp = (a: DirEntry, b: DirEntry): number => {
    if (sort === "name") return byName(a, b) * mul;
    if (a.kind === "dir" || b.kind === "dir") return byName(a, b);
    const key = sort === "size" ? ((a.size ?? -1) - (b.size ?? -1)) : ((a.mtime ?? 0) - (b.mtime ?? 0));
    return key * mul || byName(a, b) * mul;
  };
  return entries.slice().sort((a, b) => (a.kind === b.kind ? cmp(a, b) : a.kind === "dir" ? -1 : 1));
}

/** 纯函数：切一页出来，越界的 offset 给空数组。 */
export function pageEntries(entries: DirEntry[], offset: number, limit: number): DirEntry[] {
  const from = Math.max(0, Math.floor(offset));
  return entries.slice(from, from + Math.max(1, Math.floor(limit)));
}

/** 目录 → 名字/相对路径 → 大小·时间。60s 内不重复 stat（换排序、翻页、改筛选都用它）。 */
const statCache = new Map<string, { at: number; stats: Map<string, { size: number; mtime: number }> }>();
const cacheKey = (abs: string): string => (process.platform === "win32" ? abs.toLowerCase() : abs);

type Measured = { size: number; mtime: number };

async function measure(abs: string, entries: DirEntry[], into: Map<string, Measured>, deadline: number): Promise<boolean> {
  let at = 0;
  let done = true;
  const keyOf = (e: DirEntry): string => e.rel ?? e.name;
  const worker = async (): Promise<void> => {
    while (at < entries.length) {
      if (Date.now() > deadline) {
        done = false;
        return;
      }
      const entry = entries[at++];
      try {
        const st = await fs.promises.stat(path.join(abs, entry.rel ?? entry.name));
        into.set(keyOf(entry), { size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
      } catch {
        // 半路被删、或者是个断掉的链接：这一行没有大小/时间，别把整页拖垮。
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, entries.length) }, worker));
  return done;
}

/** 把目录里能认的条目都量一遍；返回是否全部量完（false = 超预算，调用方置 `statsPending`）。 */
async function fillStats(abs: string, entries: DirEntry[], deadline: number): Promise<boolean> {
  const key = cacheKey(abs);
  let hit = statCache.get(key);
  if (!hit || Date.now() - hit.at > STAT_TTL_MS) {
    hit = { at: Date.now(), stats: new Map() };
    statCache.set(key, hit);
    // 缓存本身不清理会跟着浏览过的目录一直长；40 个目录足够回退用。
    if (statCache.size > 40) statCache.delete(statCache.keys().next().value as string);
  }
  const todo = entries.filter((e) => !hit.stats.has(e.rel ?? e.name)).slice(0, STAT_MAX);
  const done = todo.length ? await measure(abs, todo, hit.stats, deadline) : true;
  hit.at = Date.now();
  for (const entry of entries) {
    const st = hit.stats.get(entry.rel ?? entry.name);
    if (!st) continue;
    if (entry.kind === "file") entry.size = st.size;
    entry.mtime = st.mtime;
  }
  return done && entries.length <= STAT_MAX;
}

function errorOf(err: any): { error: string; errCode: string } {
  return err?.code === "ENOENT"
    ? { error: "目录不存在", errCode: "dirs_missing" }
    : { error: `读不了这个目录：${err?.code ?? err}`, errCode: "dirs_unreadable" };
}

/** 一页目录清单：过滤 → 排序 → 切页，都在桥端做完。盘符页不分页（最多 26 行）。 */
export async function listDirPage(raw: string, opts: DirPageQuery = {}): Promise<DirPage> {
  const limit = Math.min(PAGE_LIMIT_MAX, Math.max(1, Math.floor(opts.limit ?? PAGE_LIMIT)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const sort: DirSort = opts.sort === "size" || opts.sort === "mtime" ? opts.sort : "name";
  const dirOrder = opts.dir === "desc" ? "desc" : "asc";
  const withFiles = opts.files !== false;
  const { target, abs, parent } = resolveTarget(raw);
  if (!target && process.platform !== "win32") return listDirPage("/", { ...opts, limit, offset });
  if (!target) {
    const drives: string[] = [];
    const volumes: Volume[] = [];
    for (let c = 65; c <= 90; c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      if (!fs.existsSync(root)) continue;
      drives.push(root);
      const vol = volumeOf(root);
      if (vol) volumes.push(vol);
    }
    const entries: DirEntry[] = drives.map((name) => ({ name, kind: "dir" }));
    const page = pageEntries(orderEntries(entries, "name", "asc"), offset, limit);
    return { path: "", parent: null, total: entries.length, truncated: false, entries: page, dirs: page.map((e) => e.name), volumes, ...(withFiles ? { files: [] } : {}) };
  }

  let entries: DirEntry[];
  try {
    const dirents = (await fs.promises.readdir(abs, { withFileTypes: true })).filter((d) => !/^(\$|System Volume Information$)/i.test(d.name));
    entries = [];
    for (const d of dirents) {
      if (d.isDirectory()) entries.push({ name: d.name, kind: "dir" });
      // #499：`files=0` 的入口（新会话弹层只挑工作目录）连总数都不该把文件算进去。
      else if (d.isFile() && withFiles) entries.push({ name: d.name, kind: "file" });
      // 符号链接按目标算：链到文件夹的那一行点进去才有意义。
      else if (d.isSymbolicLink()) entries.push({ name: d.name, kind: isDir(path.join(abs, d.name)) ? "dir" : "file" });
    }
  } catch (err: any) {
    return { path: abs, parent, total: 0, truncated: false, entries: [], dirs: [], ...(withFiles ? { files: [] } : {}), ...errorOf(err) };
  }

  let truncated = false;
  if (entries.length > ENTRY_CAP) {
    entries = orderEntries(entries, "name", "asc").slice(0, ENTRY_CAP);
    truncated = true;
  }

  if (opts.sub) {
    // 只补当前目录之外的文件：当前目录的条目已经从 readdir 拿到了，别弄出两份。
    const nested = await listFilesUnder(abs);
    const have = new Set(entries.map((e) => e.name.toLowerCase()));
    const extra: DirEntry[] = [];
    for (const rel of nested) {
      if (!rel.includes("/") || have.has(rel.toLowerCase())) continue;
      extra.push({ name: rel.slice(rel.lastIndexOf("/") + 1), kind: "file", rel });
      if (entries.length + extra.length >= ENTRY_CAP) {
        truncated = true;
        break;
      }
    }
    entries = entries.concat(extra);
  }

  const filtered = filterEntries(entries, opts.q ?? "");
  let statsPending = false;
  if (filtered.length) {
    const finished = await fillStats(abs, filtered, Date.now() + STAT_BUDGET_MS);
    // 按大小/时间排但还没量完：先按名字给一页（别让「按大小降序」表现成「名字倒着排」），
    // 前端看到 statsPending 会隔一会儿再问一次，那时缓存已经热了。
    statsPending = !finished;
  }
  const ordered = statsPending && sort !== "name" ? orderEntries(filtered, "name", "asc") : orderEntries(filtered, sort, dirOrder);
  const page = pageEntries(ordered, offset, limit);
  return {
    path: abs,
    parent,
    total: filtered.length,
    truncated,
    entries: page,
    dirs: page.filter((e) => e.kind === "dir").map((e) => e.name),
    ...(withFiles ? { files: page.filter((e) => e.kind === "file").map((e) => e.name) } : {}),
    ...(statsPending ? { statsPending: true } : {}),
  };
}

export type PathInfo = { path: string; kind: "dir" | "file" | "missing" | "denied"; parent: string | null };

/**
 * What a typed path points at. The file manager's jump box needs this *before* it navigates: asking
 * `listDirs` about a file answers ENOTDIR, which reads like a broken folder, and the box has to tell
 * 「进这个文件夹」from「高亮父目录里的这个文件」from「没有这个路径」.
 *
 * 异步：一个睡着的网络盘上 stat 能卡几秒，同步版会把整个 bridge 一起卡住。
 */
export async function statPath(raw: string): Promise<PathInfo> {
  const { target, abs, parent } = resolveTarget(raw);
  if (!target) return { path: "", kind: "missing", parent: null };
  try {
    const st = await fs.promises.stat(abs);
    return { path: abs, kind: st.isDirectory() ? "dir" : "file", parent };
  } catch (err: any) {
    // 「不让你看」和「不存在」是两条不同的错：别把权限问题说成路径写错了。
    const denied = err?.code === "EACCES" || err?.code === "EPERM";
    return { path: abs, kind: denied ? "denied" : "missing", parent };
  }
}

/**
 * Sizes and mtimes for the files directly inside `dir`. Deliberately a second request (D62): a
 * folder on a sleeping network drive answers `listDirs` in milliseconds but `stat` slowly, so the
 * names paint first and these cells fill in when they are ready.
 */
export function statFiles(raw: string): FileStat[] {
  const target = raw.trim();
  if (!target) return [];
  const abs = path.resolve(target);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => !/^(\$|System Volume Information$)/i.test(d.name));
  } catch {
    return [];
  }
  const out: FileStat[] = [];
  for (const d of entries) {
    if (d.isDirectory()) continue;
    try {
      const st = fs.statSync(path.join(abs, d.name));
      if (st.isDirectory()) continue;
      out.push({ name: d.name, size: st.size, mtime: st.mtimeMs });
    } catch {
      // Vanished between readdir and stat (or a link to nowhere): just leave the row without a size.
    }
  }
  return out;
}

/**
 * Full paths of the files on this machine's clipboard (Explorer / Finder "copy"). The browser only
 * ever sees a pasted file's name and bytes, so the path the CLI would paste has to come from here.
 */
export function clipboardFiles(): Promise<string[]> {
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(cmd, args, { timeout: 8000, windowsHide: true, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
  const lines = (out: string) =>
    out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  if (process.platform === "win32") {
    // Windows PowerShell 5.1 (STA, has -Format FileDropList); UTF-8 out so CJK paths survive.
    const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }";
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]).then(lines);
  }
  if (process.platform === "darwin") {
    const script = 'set out to ""\ntry\nrepeat with f in (the clipboard as «class furl» as list)\nset out to out & POSIX path of f & linefeed\nend repeat\nend try\nreturn out';
    return run("osascript", ["-e", script]).then(lines);
  }
  return run("xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-o"]).then((out) =>
    lines(out)
      .filter((l) => l.startsWith("file://"))
      .map((l) => decodeURIComponent(new URL(l).pathname)),
  );
}

type EntryKind = "文件夹" | "文件";

/**
 * 名字校验：文件夹与文件共用一个 `kind`，只有报错里那个词不一样（「文件夹名…」/「文件名…」）。
 * 规则：一层（不许分隔符）、名字原样（不补扩展名）、Windows 的保留名与结尾空格/点号一律拒绝。
 */
function checkEntryName(kind: EntryKind, rawName: string): string {
  const name = rawName.trim();
  if (!name) throw new Error(`${kind}名不能为空`);
  if (name === "." || name === "..") throw new Error(`${kind}名不能是 . 或 ..`);
  if (name.length > 255) throw new Error(`${kind}名太长`);
  if (/[\\/]/.test(name)) throw new Error(`${kind}名里不能有 / 或 \\（一次只建一层）`);
  // Control characters are rejected on every platform; the rest are invalid in Windows names.
  if (/[\u0000-\u001f]/.test(name)) throw new Error(`${kind}名里有不可见的控制字符`);
  if (process.platform === "win32") {
    if (/[<>:"|?*]/.test(name)) throw new Error(`${kind}名不能包含 < > : " | ? *`);
    if (/[. ]$/.test(name)) throw new Error(`Windows 下${kind}名不能以空格或 . 结尾`);
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(name)) throw new Error(`「${name}」是 Windows 保留名，换一个`);
  }
  return name;
}

/** `parent` 必须是一个已经存在、读得到的目录；返回绝对化的它。 */
function resolveParent(parent: string, kind: EntryKind): string {
  if (!parent.trim()) throw new Error(`先进入一个目录再新建${kind}`);
  const base = path.resolve(parent);
  if (!isDir(base)) throw new Error(`上级目录不存在：${base}`);
  return base;
}

/** Creates one folder `name` directly inside `parent`; throws a user-facing (Chinese) message. */
export function makeDir(parent: string, rawName: string): string {
  const name = checkEntryName("文件夹", rawName);
  const base = resolveParent(parent, "文件夹");
  const target = path.join(base, name);
  try {
    // 不用先 existsSync：mkdir 自己就会对已存在的目标抛 EEXIST，一步到位也就没有「查完到建之间被人占了」的窗口。
    fs.mkdirSync(target);
  } catch (err: any) {
    if (err?.code === "EEXIST") throw new Error(`已经存在：${target}`);
    throw new Error(err?.code === "EACCES" || err?.code === "EPERM" ? `没有权限在这里建文件夹：${base}` : `建不了：${err?.message ?? err}`);
  }
  return target;
}

/**
 * Creates one **empty** file (0 bytes) directly inside `parent`. `wx` is what keeps it from ever
 * clobbering an existing file — an `existsSync` check alone would leave a window where a同名 file
 * created by someone else (an editor, a `touch` in the terminal) gets truncated instead of refused.
 */
export function makeFile(parent: string, rawName: string): string {
  const name = checkEntryName("文件", rawName);
  const base = resolveParent(parent, "文件");
  const target = path.join(base, name);
  try {
    fs.writeFileSync(target, "", { flag: "wx" });
  } catch (err: any) {
    if (err?.code === "EEXIST") throw new Error(`已经存在：${target}`);
    if (err?.code === "EACCES" || err?.code === "EPERM") throw new Error(`没有权限在这里建文件：${base}`);
    throw new Error(`建不了：${err?.message ?? err}`);
  }
  return target;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
