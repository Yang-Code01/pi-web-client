import { tr } from "./i18n/index.ts";
import { ACCENTS, ACCENT_IDS } from "./palette.ts";
import { wsAccent } from "./nowchip.ts";

/**
 * #95：左栏的「工作区 → 会话」两级树。
 *
 * 这个文件只做一件事：把桥给的三份数据（会话列表、manage 快照、workspace 快照）变成一份已经
 * 分好组、排好序、筛过过滤词的树，DOM 渲染照单画。放成纯函数是为了能脱离页面测 —— 排序规则
 * 有十来条分支，靠浏览器探针去验会既慢又脆。
 *
 * 语义（见 `.scratch/workspace/spec.md`）：
 * - 工作区 = 工程，一级分组；组 id 由桥按 cwd 推导（worktree 已经并回主仓），手动组 id 形如
 *   `manual:*`。前端不重算归属，只认会话上的 `ws`；`ws` 缺席（旧桥 / 桩桥）时按 cwd 兜底。
 * - 归档是末尾的全局分区，不属于任何工作区 —— 归档的会话连 ★ 都不该把它拉回来。
 * - 组内 ★ 在前（按 `pin` 的顺序），其次手动顺序（`order`），最后按新建时间倒序。
 * - 组之间：有待处理在前 → 最近活动倒序 → 名字。
 *
 * 收起状态不在这里：那是浏览器口味（`pi.prefs`），渲染层按 `pi.prefs.wsCollapsed` 过滤。
 */

/** 组件眼里的一颗会话 —— `SessionState` 结构上是它的超集，直接传进来就行。 */
export interface TreeSession {
  id: string;
  name?: string;
  cwd?: string;
  /** 桥算好的工作区 id（#94）。缺席时按 cwd 兜底。 */
  ws?: string;
  /** 新建时间（ISO）。组内都没有手动顺序时按它倒序，和桥的 arrangeCompare 一致。 */
  startedAt?: string;
  updatedAt?: number;
  asks?: number;
  approvals?: number;
}

export interface TreeGroupInfo {
  id: string;
  name: string;
  key: string;
  manual: boolean;
}

export interface TreeWorkspace {
  groups?: TreeGroupInfo[];
  overrides?: Record<string, string>;
  keys?: Record<string, string>;
  /** #173 一份组序（含折叠组）：左栏与标签行共用；缺省 / 缺项的组按名字排到末尾。 */
  order?: string[];
}

export interface TreeManage {
  pin?: string[];
  order?: string[];
  archived?: string[];
}

export interface TreeGroup<T extends TreeSession = TreeSession> {
  id: string;
  /** 用户起的名字 → 目录名 → 「未分组」。 */
  name: string;
  key: string;
  manual: boolean;
  /** 组头那颗色点的颜色：稳定取自既有调色板。 */
  color: string;
  sessions: T[];
  /**
   * 组里的会话总数，**含已归档**：归档在左栏不进屋，但桥删组时照样数它们（#279），
   * 于是「空不空 / 能不能删」只能看这个数，不能看 `sessions.length`。
   */
  count: number;
  /** 组里在等你的会话数（待回答 / 待确认），组头上那个角标。 */
  pending: number;
}

export interface Tree<T extends TreeSession = TreeSession> {
  groups: TreeGroup<T>[];
  archived: T[];
}

/**
 * 组色：从 `ACCENTS`（`web/src/palette.ts`）派生色值，哈希用 `wsAccent()` 那套 FNV-1a ——
 * 与顶栏「当前在哪」那颗（`nowchip.ts`）同源，左栏树 / 标签行 / 竖列与它永远同桶。
 * 保留这个导出是为了老调用方（`app.ts` 等）拿色值；新代码建议直接用 accent id。
 */
export const WS_COLORS = ACCENT_IDS.map((id) => ACCENTS[id].accent);

export function wsColor(id: string): string {
  return ACCENTS[wsAccent(id)].accent;
}

/** 归一化：反斜杠转正斜杠、折叠重复斜杠、去尾斜杠；显示用，保留大小写。 */
function normalizePath(value: unknown): string {
  let s = String(value ?? "").trim().replace(/\\/g, "/");
  if (!s) return "";
  s = s.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:$/.test(s) ? `${s}/` : s;
}

/** 目录名：组没名字时用它顶上（`F:/pi-web-client` → `pi-web-client`）。 */
function baseName(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

const UNGROUPED = "";

function nameOf(info: TreeGroupInfo | undefined, key: string): string {
  const own = (info?.name ?? "").trim();
  if (own) return own;
  const base = baseName(key);
  if (base) return base;
  return info?.manual ? tr("新工作区") : tr("未分组");
}

function pendingOf(session: TreeSession): boolean {
  return (session.asks ?? 0) > 0 || (session.approvals ?? 0) > 0;
}

function createdAt(session: TreeSession): number {
  return Date.parse(session.startedAt ?? "") || session.updatedAt || 0;
}

export function buildTree<T extends TreeSession>(
  sessions: T[],
  manage: TreeManage,
  workspace?: TreeWorkspace | null,
  filter = "",
): Tree<T> {
  const pin = manage.pin ?? [];
  const order = manage.order ?? [];
  // #173 工作区组序是另一份（`ws.order`）：会话的 manage.order 管的是组内会话，别混用。
  const groupOrder = workspace?.order ?? [];
  const archived = new Set(manage.archived ?? []);
  const known = new Map((workspace?.groups ?? []).map((g) => [g.id, g]));

  // 归组：先按会话自己的 ws，`ws` 查不到（旧桥 / 桩桥 / 脏会话）就按 cwd 兜底。
  const buckets = new Map<string, { info?: TreeGroupInfo; key: string; sessions: T[]; count: number }>();
  const bucket = (id: string, key: string) => {
    let found = buckets.get(id);
    if (!found) {
      found = { info: known.get(id), key, sessions: [], count: 0 };
      buckets.set(id, found);
    }
    return found;
  };
  // 快照里声明的组都先占位：手建的空组也要能显示空态。
  for (const info of known.values()) bucket(info.id, info.key);

  // 归属规则只写一处：归档与可见会话都按它落到组里，只是归档的不进 `sessions`。
  const bucketFor = (session: T) => {
    const declared = session.ws ? known.get(session.ws) : undefined;
    if (declared) return bucket(declared.id, declared.key);
    const key = normalizePath(session.cwd);
    return key ? bucket(key.toLowerCase(), key) : bucket(UNGROUPED, "");
  };
  for (const session of sessions) {
    const found = bucketFor(session);
    found.count += 1;
    if (archived.has(session.id)) continue; // 归档是全局分区，不进任何工作区
    found.sessions.push(session);
  }

  const rank = (list: string[], id: string) => {
    const at = list.indexOf(id);
    return at < 0 ? -1 : at;
  };
  const compare = (a: T, b: T): number => {
    const ap = rank(pin, a.id);
    const bp = rank(pin, b.id);
    if (ap >= 0 || bp >= 0) {
      if (ap < 0) return 1;
      if (bp < 0) return -1;
      return ap - bp;
    }
    const ao = rank(order, a.id);
    const bo = rank(order, b.id);
    if (ao >= 0 && bo >= 0) return ao - bo;
    if (ao < 0 && bo < 0) return createdAt(b) - createdAt(a);
    // `order` 里没有位置的算「新会话」，排在手排过的上面（与 `bridge/src/manage.ts` 的约定一致）。
    return ao < 0 ? -1 : 1;
  };

  const q = filter.trim().toLowerCase();
  const hit = (session: T) => !q || `${session.name ?? ""} ${session.cwd ?? ""}`.toLowerCase().includes(q);

  const groups: TreeGroup<T>[] = [];
  for (const [id, found] of buckets) {
    const whole = Boolean(q) && nameOf(found.info, found.key).toLowerCase().includes(q);
    const list = (whole ? found.sessions : found.sessions.filter(hit)).sort(compare);
    // 过滤态下没有命中的组整个收起来；空态只在「这个组本来就没会话」时出现。
    if (!list.length && q && !whole) continue;
    groups.push({
      id,
      name: nameOf(found.info, found.key),
      key: normalizePath(found.info?.key ?? found.key),
      manual: found.info?.manual === true,
      color: wsColor(id),
      sessions: list,
      count: found.count,
      pending: list.filter(pendingOf).length,
    });
  }

  // #173 组间顺序只认 `order` 这一份（缺的 / 新组按名字排到末尾，再靠 id 稳定）。
  // 待处理角标照旧计算，但不再拿它 / 最近活动来插队。
  const position = new Map(groupOrder.map((id, i) => [id, i] as const));
  const at = (g: TreeGroup<T>): number => position.get(g.id) ?? Number.POSITIVE_INFINITY;
  groups.sort((a, b) => {
    const ia = at(a);
    const ib = at(b);
    if (ia !== ib) return ia < ib ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
  });

  const archivedList = sessions.filter((x) => archived.has(x.id) && hit(x)).sort(compare);

  return { groups, archived: archivedList };
}
