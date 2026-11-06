import { tr } from "./i18n/index.ts";

/**
 * #100：工作区管理的纯逻辑 —— 改名输入怎么洗、这条 rename 要不要发、这个组能不能删。
 *
 * 规则两端各有一份（桥是权威、页面要在点之前就把「不能删」说清楚），这里只放**决定**，不放 DOM：
 * 页面对话框 / 探针都从这里取答案，免得「置灰的按钮」和「桥真的拒绝了」说出两套话。
 *
 * 语义（`.scratch/workspace/spec.md` + D126）：
 * - 空名字 = 恢复成目录名；桥的 `rename()` 存空串，显示时由 `buildTree()` 回落到目录名。
 * - 只有手建的空组能删：派生组是 cwd 派生的，删了下次又回来，那是假动作。
 */

/** 桥上的组（`WorkspaceState.groups` 的一项）。 */
export interface WsGroupLike {
  id: string;
  name: string;
  key: string;
  manual: boolean;
}

/** 名字上限，与桥的 `rename()` / `create()` 里的 `slice(0, 80)` 对齐。 */
export const WS_NAME_MAX = 80;

/** 固定名额的上下界，与桥 `setTabs()` 的 clamp 1–5 是同一对数（原型量过，D149）。 */
export const PIN_MIN = 1;
export const PIN_MAX = 5;

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
 * 「这个组能不能固定到标签行」：`null` = 能固定（或已经固定了，点一下就是取消）；否则是给人看的原因。
 * 名额满了就拒绝并说清楚 —— 点一下没反应，用户只会以为菜单坏了。
 */
export function pinBlocker(group: { id: string } | undefined, pinned: string[], max: number): string | null {
  if (!group) return tr("这个工作区不在了");
  if (isPinned(pinned, group.id)) return null;
  if (pinned.length >= max) return tr("标签行只有 {p1} 个位置，先取消一个固定组", { p1: max });
  return null;
}

/**
 * 设置面板那一列勾选（#123）：一行一个组，顺序 = 传进来的组序（调用方给左栏序）。
 * `why` 非空 = 那一行置灰并写明原因；已勾着的行永远可点（取消固定不受名额限制）。
 */
export interface PinRow {
  id: string;
  checked: boolean;
  why: string | null;
}

export function pinRows(groups: { id: string }[], pinned: string[], max: number): PinRow[] {
  const known: string[] = [];
  for (const group of groups) if (!known.includes(group.id)) known.push(group.id);
  // 与桥 / 标签行同一把尺子：脏 id 与重复剔掉，再截到名额 —— 面板看到的勾就是这个位置上的勾。
  const effective = pinned.filter((id, i) => known.includes(id) && pinned.indexOf(id) === i).slice(0, Math.max(0, Math.trunc(max)));
  const seen = new Set<string>();
  const rows: PinRow[] = [];
  for (const group of groups) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    rows.push({ id: group.id, checked: effective.includes(group.id), why: pinBlocker(group, effective, max) });
  }
  return rows;
}

/** 名额调小会挤掉几个固定组（桥在同一次写里截断，面板据此把话说清）。 */
export function pinsDropped(pinned: string[], nextMax: number): number {
  const max = Math.min(PIN_MAX, Math.max(PIN_MIN, Math.trunc(Number(nextMax) || PIN_MIN)));
  return Math.max(0, pinned.length - max);
}

/** 这个组是不是固定组（左栏标记 / 菜单两项互斥都看它）。 */
export function isPinned(pinned: string[], id: string): boolean {
  return pinned.includes(id);
}

/** 点一下「固定 / 取消固定」之后应该发给桥的列表：未固定 → 追加到末尾；已固定 → 原地去掉。 */
export function togglePin(pinned: string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id];
}

/**
 * 「这个组能不能删」：`null` = 能删；否则是给人看的原因（菜单里那行灰字）。
 * 顺序有讲究：组不存在 → 派生组 → 有会话，先说的那个才是真正的理由。
 */
export function dropBlocker(group: WsGroupLike | undefined, sessions: number): string | null {
  if (!group) return tr("这个工作区不在了");
  if (!group.manual) return tr("这个工作区跟着目录走，不能删");
  if (sessions > 0) return tr("这个工作区里还有 {p1} 个会话，先把它们拖回工程或删掉", { p1: sessions });
  return null;
}
