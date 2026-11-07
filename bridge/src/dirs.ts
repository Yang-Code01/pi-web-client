import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
