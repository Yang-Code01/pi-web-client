/**
 * 目录列表的排序选择（issue #499）：名称 / 大小 / 修改时间 + 方向。
 *
 * 五个入口（新会话弹层、新建工作区、附件选择器、文件管理器、附件控制台）共用同一份记忆，
 * 所以放在这里而不是某个组件里。值会进 localStorage，只用稳定的 id（`name`/`size`/`mtime`），
 * 中文标签在使用处走 `tr()`。
 */
export type DirSortKey = "name" | "size" | "mtime";
export type DirSort = { key: DirSortKey; dir: "asc" | "desc" };

/** 默认：名称升序。文件那两个入口在挂载时传 `defaultSort` 覆盖成修改时间降序。 */
export const DEFAULT_SORT: DirSort = { key: "name", dir: "asc" };

const PREFIX = "pi.web.dirsort.";
const STORE = "shared";

const isKey = (v: unknown): v is DirSortKey => v === "name" || v === "size" || v === "mtime";

/** 读回上次的选择；没有 / 坏了 / 沙箱里 localStorage 抛错都给 fallback。 */
export function loadDirSort(store = STORE, fallback: DirSort = DEFAULT_SORT): DirSort {
  try {
    const raw = localStorage.getItem(PREFIX + store);
    if (!raw) return { ...fallback };
    const parsed = JSON.parse(raw) as Partial<DirSort> | null;
    if (!parsed || !isKey(parsed.key) || (parsed.dir !== "asc" && parsed.dir !== "desc")) return { ...fallback };
    return { key: parsed.key, dir: parsed.dir };
  } catch {
    return { ...fallback };
  }
}

export function saveDirSort(store: string, sort: DirSort): boolean {
  try {
    localStorage.setItem(PREFIX + store, JSON.stringify(sort));
    return true;
  } catch {
    // 预览面板的 CSP 沙箱里 localStorage 会抛：记不住就记不住，不影响这一次的排序。
    return false;
  }
}

/**
 * 点同一列 = 翻方向；换一列 = 名称升序、大小/时间降序（第一次点「大小」想看的就是最大的，
 * 第一次点「修改时间」想看的就是最新的）。
 */
export function nextDirSort(cur: DirSort, key: DirSortKey): DirSort {
  if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "name" ? "asc" : "desc" };
}

/** 「包含子目录」的开关也记一份（默认关：递归在大树上很贵，要用户自己说要）。 */
const SUB_KEY = "pi.web.dirs.sub";

export function loadSubSearch(): boolean {
  try {
    return localStorage.getItem(SUB_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSubSearch(on: boolean): boolean {
  try {
    localStorage.setItem(SUB_KEY, on ? "1" : "0");
    return true;
  } catch {
    // 同上：沙箱里存不下，这一次的勾选照样生效。
    return false;
  }
}
