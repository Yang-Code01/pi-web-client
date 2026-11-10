import { tr } from "./i18n/index.ts";

/**
 * #100：工作区管理的纯逻辑 —— 改名输入怎么洗、这条 rename 要不要发、这个组能不能删。
 *
 * 规则两端各有一份（桥是权威、页面要在点之前就把「不能删」说清楚），这里只放**决定**，不放 DOM：
 * 页面对话框 / 探针都从这里取答案；桥的 `drop()` 拒绝时说的是同一组句子（手动组带会话计数），
 * 免得「置灰的按钮」和「桥真的拒绝了」说出两套话。
 *
 * 语义（`.scratch/workspace/spec.md` + D126）：
 * - 空名字 = 恢复成目录名；桥的 `rename()` 存空串，显示时由 `buildTree()` 回落到目录名。
 * - #279 起删除边界是「有会话才拦」：空的手动组与空的目录组都能删（D217）；有会话时仍说原来的
 *   那句话 —— 手动组「还有 N 个会话」，目录组「跟着目录走」。
 *
 * #173：旧的分组名额助手（`fixedBlocker` / `fixedRows` / `fixedDropped` / `toggleFixed`）已退役，
 * 顺序统一由桥端的 `order` 管，这里只剩改名与删除。
 */

/** 桥上的组（`WorkspaceState.groups` 的一项）。 */
export interface WsGroupLike {
  id: string;
  name: string;
  key: string;
  manual: boolean;
  /** #276：新桥的横条成员标记；旧桥没有这个字段。 */
  inRow?: boolean;
}

/**
 * #276：当前快照是不是认识横条成员。
 * 旧桥的组没有 `inRow`，此时所有组都当成员、不画 ⊙、左栏菜单也不放「在横条中」（而不是置灰）。
 */
export function hasRowMembership(groups: readonly Pick<WsGroupLike, "inRow">[]): boolean {
  return groups.length > 0 && groups.every((g) => typeof g.inRow === "boolean");
}

/** 名字上限，与桥的 `rename()` / `create()` 里的 `slice(0, 80)` 对齐。 */
export const WS_NAME_MAX = 80;

/**
 * 用户输入 → 发给桥的名字：折叠内部空白、去首尾、截 80。
 * 空串保留空串：它表示「恢复成目录名」，不是「名字叫空」。
 */
export function cleanGroupName(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, WS_NAME_MAX);
}

/**
 * 要不要发这条 `ws.rename`：`null` = 名字没变，一个字都不用发（空发一条只会让树重画一次）。
 * 返回值直接就是 msg.name —— 清空输入时是空串，桥据此恢复目录名。
 */
export function renameIntent(current: string, draft: unknown): string | null {
  const next = cleanGroupName(draft);
  return next === String(current ?? "").trim() ? null : next;
}

/**
 * 「这个组能不能删」：`null` = 能删；否则是给人看的原因（菜单里那行灰字）。
 * 顺序有讲究：组不存在 → 有会话 → 空，先说的那个才是真正的理由。#279 之后空组一律可删，
 * 「跟着目录走」不再是拒绝理由，只剩给「还有会话的目录组」解释为什么它删不掉。
 */
export function dropBlocker(group: WsGroupLike | undefined, sessions: number): string | null {
  if (!group) return tr("这个工作区不在了");
  if (sessions > 0) {
    return group.manual
      ? tr("这个工作区里还有 {p1} 个会话，先把它们拖回工程或删掉", { p1: sessions })
      : tr("这个工作区跟着目录走，不能删");
  }
  return null;
}

/**
 * #279：删掉一个组之后，页面该落到哪 —— 按「右邻优先、再左邻」排好的候选组 id。
 *
 * 只给候选，不替调用方挑：真正的落点还得是「这一组里有会话可开」，空组只能把左栏亮出来。
 * `droppedId` 不在组序里（快照已经翻篇）→ 空数组，调用方就别硬切了。
 */
export function wsNeighborsAfterDrop(order: string[], droppedId: string): string[] {
  const at = order.indexOf(droppedId);
  if (at < 0) return [];
  return [...order.slice(at + 1), ...order.slice(0, at).reverse()];
}

/**
 * #279：能删时，删除那一项底下挂的说明 —— 手动组删掉的是「组」本身，目录组只是把这一项移出列表，
 * 目录里的文件一概不动。两句话分开写，免得让人以为删组会删文件。
 */
export function dropHint(group: WsGroupLike): string {
  return group.manual
    ? tr("只删这个空组，组里的东西一概不动")
    : tr("只把这个目录移出列表，目录里的文件一概不动");
}

// ---------------------------------------------------------------- #278 按目录建组

/**
 * #278：路径归一化，与桥端 `normalizePath()` 同一套 —— 反斜杠转正斜杠、折叠重复斜杠、去尾斜杠、
 * 盘符根保留 `F:/`。页面只用它比对「是不是同一个目录」，权威判断仍在桥。
 */
export function cleanDirPath(raw: unknown): string {
  let s = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!s) return "";
  const unc = s.startsWith("//");
  s = s.replace(/\/{2,}/g, "/");
  if (unc) s = `/${s}`;
  s = s.replace(/\/+$/, "");
  if (!s) return "/";
  return /^[a-zA-Z]:$/.test(s) ? `${s}/` : s;
}

/** #278：目录名（`F:/work/app/` → `app`），空路径给空串。新组名字就取这个（显示层自己回落）。 */
export function dirBaseName(raw: unknown): string {
  const parts = cleanDirPath(raw).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** #278：这个目录已经在列表里了吗 —— 组身份是 `key`，忽略大小写 / 正反斜杠 / 尾斜杠后比较。 */
export function groupAtDir(groups: readonly WsGroupLike[], dir: unknown): WsGroupLike | undefined {
  const want = cleanDirPath(dir).toLowerCase();
  if (!want) return undefined;
  return groups.find((g) => !g.manual && Boolean(g.key) && cleanDirPath(g.key).toLowerCase() === want);
}

/**
 * #278：桥对「这个目录折回到哪个组」的只读回答 —— 子目录 / worktree 会被折回工程根，
 * 逐字比 `key` 比不出来。`id: null` = 桥说这个目录不落在已有组里。
 */
export interface DirResolution {
  /** 问的是哪个目录（`cleanDirPath()` 过）。 */
  dir: string;
  /** 命中的组 id；null = 没有。 */
  id: string | null;
}

/**
 * #278：先信桥的折回回答（对号入座到当前目录），没有回答 / 组不在快照里就退回逐字比较。
 * 旧桥不会回答，行为与 `groupAtDir()` 一样。
 */
export function groupAtResolvedDir(
  groups: readonly WsGroupLike[],
  dir: unknown,
  resolved?: DirResolution | null,
): WsGroupLike | undefined {
  const clean = cleanDirPath(dir);
  if (resolved && resolved.dir === clean) {
    if (!resolved.id) return undefined;
    const hit = groups.find((g) => g.id === resolved.id);
    if (hit) return hit;
  }
  return groupAtDir(groups, clean);
}

/** #278：新建对话框底部那颗按钮的答案。 */
export interface WsCreateAction {
  /** 发出去的路径（已归一化）；空串 = 还没选目录。 */
  dir: string;
  /** false = 不发送创建（已在列表里 / 没选目录）。 */
  create: boolean;
  label: string;
  existing?: WsGroupLike;
}

/**
 * #278：这个目录点下去该干什么 —— 已经在列表里就只带你过去（按钮改口），
 * 否则就在这里新建。判断与桥一致，免得说出两套话。`resolved` = 桥对折回工程根的回答
 * （子目录 / worktree）；没问过就退回逐字比较。
 */
export function wsCreateAction(groups: readonly WsGroupLike[], dir: unknown, resolved?: DirResolution | null): WsCreateAction {
  const clean = cleanDirPath(dir);
  const existing = groupAtResolvedDir(groups, clean, resolved);
  if (existing) return { dir: clean, create: false, label: tr("带你过去"), existing };
  return { dir: clean, create: Boolean(clean), label: tr("就在这里新建") };
}
