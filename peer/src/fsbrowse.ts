import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mimeOf } from "./files.ts";

/**
 * 「文件管理器式」的选择器（#45 第 4 片，用户要求参考资源管理器）。
 * 只在本机回环上开放：它是一个能列出整块磁盘的接口，绝不能出现在局域网面上。
 */

export interface BrowseEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
  mime?: string;
}

export interface Browse {
  path: string;
  parent: string | null;
  roots: { name: string; path: string }[];
  places: { name: string; path: string }[];
  entries: BrowseEntry[];
}

/** Windows 上是各盘符，其它系统只有 `/`。 */
function roots(): { name: string; path: string }[] {
  if (process.platform !== "win32") return [{ name: "/", path: "/" }];
  const out: { name: string; path: string }[] = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZAB") {
    const p = `${letter}:\\`;
    try {
      if (fs.existsSync(p)) out.push({ name: letter === "C" ? "C: 系统盘" : p, path: p });
    } catch {
      /* 没插的盘符会抛，忽略 */
    }
  }
  return out;
}

function places(): { name: string; path: string }[] {
  const home = os.homedir();
  const candidates: { name: string; path: string }[] = [
    { name: "桌面", path: path.join(home, "Desktop") },
    { name: "下载", path: path.join(home, "Downloads") },
    { name: "文档", path: path.join(home, "Documents") },
    { name: "图片", path: path.join(home, "Pictures") },
    { name: "用户目录", path: home },
  ];
  return candidates.filter((item) => {
    try {
      return fs.statSync(item.path).isDirectory();
    } catch {
      return false;
    }
  });
}

/** 列一个目录。`dirsOnly` 用于「选文件夹」场景（v1 只发文件，但面包屑里要能穿越）。 */
export function listDir(target: string, dirsOnly = false): Browse {
  const wanted = target && target.trim() ? path.resolve(target) : os.homedir();
  const stat = fs.statSync(wanted);
  if (!stat.isDirectory()) throw new Error("这不是一个文件夹");
  const parent = path.dirname(wanted);
  const entries: BrowseEntry[] = [];
  for (const item of fs.readdirSync(wanted, { withFileTypes: true })) {
    if (item.name.startsWith(".") || item.name === "node_modules") continue;
    const full = path.join(wanted, item.name);
    try {
      const info = fs.statSync(full);
      const dir = info.isDirectory();
      if (dirsOnly && !dir) continue;
      entries.push({
        name: item.name,
        path: full,
        dir,
        size: dir ? 0 : info.size,
        mtime: info.mtimeMs,
        mime: dir ? undefined : mimeOf(item.name),
      });
    } catch {
      /* 被占用 / 无权限的条目跳过，不因为一个文件让整个列表失败 */
    }
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, "zh-CN") : a.dir ? -1 : 1));
  return {
    path: wanted,
    parent: parent === wanted ? null : parent,
    roots: roots(),
    places: places(),
    // 一屏放不下的长目录截断；选择器只用来挑一个文件，不需要滚 5000 行。
    entries: entries.slice(0, 800),
  };
}
