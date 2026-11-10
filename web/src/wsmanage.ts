import { tr } from "./i18n/index.ts";

/**
 * #100：工作区管理的纯逻辑 —— 改名输入怎么洗、这条 rename 要不要发、这个组能不能删。
 *
 * 删除事务由桥端权威处理；这里放前端菜单提示与纯逻辑，不放 DOM：
 * UI 允许对现存工作区发起确认，桥校验确认时的会话列表、移入垃圾箱后再删除工作区。
 *
 * 语义（`.scratch/workspace/spec.md` + D126）：
 * - 空名字 = 恢复成目录名；桥的 `rename()` 存空串，显示时由 `buildTree()` 回落到目录名。
 * - #279 起工作区删除前显示成员确认；确认后组内会话进垃圾箱，工作区随后删除；从垃圾箱还原会话时恢复其工作区关联。
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
 * 「这个组能不能删」：`null` = 能发起确认；实际删除前会由桥端把组内会话移入垃圾箱。
 */
export function dropBlocker(group: WsGroupLike | undefined, _sessions: number): string | null {
  return group ? null : tr("这个工作区不在了");
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

/** Deletion moves file-backed sessions into trash; restore recreates the workspace association. */
export function dropHint(_group: WsGroupLike): string {
  return tr("工作区里的会话会移入垃圾箱；从垃圾箱还原会话时工作区也会恢复");
}

/** Translate bridge-owned failure codes without leaking backend-language prose into the UI. */
export function workspaceDeleteReason(code: unknown): string {
  switch (code) {
    case "workspace-not-found":
      return tr("这个工作区不在了");
    case "confirmation-list-required":
      return tr("缺少工作区删除确认列表，请重新确认");
    case "membership-changed":
      return tr("工作区里的会话已变化，请重新确认");
    case "sessions-not-trashed":
      return tr("有会话无法移入垃圾箱，工作区已保留");
    case "workspace-not-empty":
      return tr("工作区仍有会话，无法删除");
    default:
      return tr("请重试");
  }
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

/** D228：上一级目录（`F:/work/app` → `F:/work`，根目录 / 空串给空串）。 */
export function dirParent(raw: unknown): string {
  const clean = cleanDirPath(raw);
  if (!clean || /^[a-zA-Z]:\/$/.test(clean) || clean === "/") return "";
  const cut = clean.lastIndexOf("/");
  if (cut < 0) return "";
  const parent = clean.slice(0, cut);
  if (!parent) return "";
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}/` : parent;
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
