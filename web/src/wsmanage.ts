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
 * 顺序有讲究：组不存在 → 派生组 → 有会话，先说的那个才是真正的理由。
 */
export function dropBlocker(group: WsGroupLike | undefined, sessions: number): string | null {
  if (!group) return tr("这个工作区不在了");
  if (!group.manual) return tr("这个工作区跟着目录走，不能删");
  if (sessions > 0) return tr("这个工作区里还有 {p1} 个会话，先把它们拖回工程或删掉", { p1: sessions });
  return null;
}
