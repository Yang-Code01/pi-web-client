import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type Listing = { path: string; parent: string | null; dirs: string[]; files?: string[]; error?: string };

/** One level of folders (and files when asked); an empty path lists the roots (drive letters on Windows). */
export function listDirs(raw: string, withFiles = false): Listing {
  const target = raw.trim();
  if (!target) {
    if (process.platform !== "win32") return listDirs("/", withFiles);
    const drives: string[] = [];
    for (let c = 65; c <= 90; c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      if (fs.existsSync(root)) drives.push(root);
    }
    return { path: "", parent: null, dirs: drives, ...(withFiles ? { files: [] } : {}) };
  }
  const abs = path.resolve(target);
  const up = path.dirname(abs);
  // At a drive root the next step up is the drive list itself.
  const parent = up !== abs ? up : process.platform === "win32" ? "" : null;
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
    return { path: abs, parent, dirs: [], ...(withFiles ? { files: [] } : {}), error: err?.code === "ENOENT" ? "目录不存在" : `读不了这个目录：${err?.code ?? err}` };
  }
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

/** Creates one folder `name` directly inside `parent`; throws a user-facing (Chinese) message. */
export function makeDir(parent: string, rawName: string): string {
  const name = rawName.trim();
  if (!name) throw new Error("文件夹名不能为空");
  if (name === "." || name === "..") throw new Error("文件夹名不能是 . 或 ..");
  if (name.length > 255) throw new Error("文件夹名太长");
  if (/[\\/]/.test(name)) throw new Error("文件夹名里不能有 / 或 \\（一次只建一层）");
  // Control characters are rejected on every platform; the rest are invalid in Windows names.
  if (/[\u0000-\u001f]/.test(name)) throw new Error("文件夹名里有不可见的控制字符");
  if (process.platform === "win32") {
    if (/[<>:"|?*]/.test(name)) throw new Error('文件夹名不能包含 < > : " | ? *');
    if (/[. ]$/.test(name)) throw new Error("Windows 下文件夹名不能以空格或 . 结尾");
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(name)) throw new Error(`「${name}」是 Windows 保留名，换一个`);
  }
  if (!parent.trim()) throw new Error("先进入一个目录再新建文件夹");
  const base = path.resolve(parent);
  if (!isDir(base)) throw new Error(`上级目录不存在：${base}`);
  const target = path.join(base, name);
  if (fs.existsSync(target)) throw new Error(`已经存在：${target}`);
  try {
    fs.mkdirSync(target);
  } catch (err: any) {
    throw new Error(err?.code === "EACCES" || err?.code === "EPERM" ? `没有权限在这里建文件夹：${base}` : `建不了：${err?.message ?? err}`);
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
