/**
 * 工作区记忆（#647 / D391）：切回一个工作区时打开「你上次停下的那颗会话」。
 *
 * 这个文件只有纯函数：落点怎么挑、`pi.ws.last` 这份记忆怎么解析 / 写入 / 剪枝。碰 DOM 与
 * `localStorage` 的部分留在页面里（`App.noteLastSession()` / `App.wsLanding()`），这样这一层
 * 能被单测（`web/tests/ws-memory-unit.mjs`）、坏数据也不会在启动时就炸掉整个页面。
 *
 * 一条规则：**有记忆开记忆，没记忆开最近写过文件的那颗**。`updatedAt` 是会话文件最近写过的
 * 时刻（D162：打开会话本身不刷它），与「组的天」（D290）同一个口径。
 */

/** 一颗组只记一颗会话：`{ 组 id: { 会话 id, 写进来的时刻 } }`。 */
export interface WsLast {
  [wsId: string]: { id: string; at: number };
}

/** 记忆的上限。工作区数量远低于这个数，留一个足够宽松的天花板防止 localStorage 长毛。 */
export const LAST_CAP = 64;

/** 落点要的那两列：id 与活动时间。`TreeSession` 直接满足。 */
export interface LandingSession {
  id: string;
  updatedAt?: number;
}

/**
 * 这一组该打开哪颗（#647）：
 * 1. 记忆命中（那颗仍在本组可见会话里）→ 它 —— 用户最后停下的那颗，别的会话再新也抢不走；
 * 2. 否则 `updatedAt` 最大那颗 —— 「最近写过文件」；
 * 3. 并列取数组里靠前那颗（树序：★ > 手排 > 最新新建），不引入随机；
 * 4. 空组 → `null`，调用方交回 D374 的空态路径。
 *
 * 记忆失效（被删 / 被归档 / 被拖去别的工作区）由第 2 条兜底 —— 这里只回答「落哪」，清死记忆是
 * 调用方的事（它才知道快照里现在有什么）。
 */
export function pickLanding(sessions: readonly LandingSession[], lastId: string | null | undefined): string | null {
  if (lastId && sessions.some((s) => s.id === lastId)) return lastId;
  let best: LandingSession | null = null;
  for (const s of sessions) {
    if (!best || stamp(s) > stamp(best)) best = s;
  }
  return best ? best.id : null;
}

/** `updatedAt` 缺失 / NaN / 非数字一律当 0：坏数据不能把落点抢走。 */
function stamp(s: LandingSession): number {
  const at = Number(s.updatedAt);
  return Number.isFinite(at) ? at : 0;
}

/**
 * 读 `localStorage["pi.ws.last"]`：坏 JSON、非对象、条目结构不对都只会**少几条**，永远不会抛，
 * 也不会把整份记忆一起丢掉。`at` 坏掉按 0（只影响超上限时的淘汰顺序）。
 */
export function parseLast(raw: string | null | undefined): WsLast {
  let data: unknown;
  try {
    data = JSON.parse(raw ?? "");
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: WsLast = {};
  for (const [wsId, value] of Object.entries(data as Record<string, unknown>)) {
    if (!wsId || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const id = String((value as { id?: unknown }).id ?? "").trim();
    if (!id) continue;
    const at = Number((value as { at?: unknown }).at);
    out[wsId] = { id, at: Number.isFinite(at) ? at : 0 };
  }
  return out;
}

/**
 * 写进一条记忆：返回新表，不改传进来的那份（页面可以直接把它交给 `writeWsLast()`）。
 * 超过 `LAST_CAP` 时按 `at` 淘汰最旧的 —— 这份东西只该有几条，留大值是防「工作区建了又删」攒垃圾。
 */
export function recordLast(last: WsLast, wsId: string, sessionId: string, at = Date.now()): WsLast {
  const next: WsLast = { ...last, [wsId]: { id: sessionId, at } };
  const ids = Object.keys(next);
  if (ids.length <= LAST_CAP) return next;
  const keep = new Set(
    ids
      .sort((a, b) => next[b].at - next[a].at || a.localeCompare(b))
      .slice(0, LAST_CAP),
  );
  const trimmed: WsLast = {};
  for (const id of ids) if (keep.has(id)) trimmed[id] = next[id];
  return trimmed;
}

/**
 * 剪枝：`keep` 说这一条还算数吗（组还在、那颗会话还在这一组）。没有可剪的就**原样返回同一个对象**，
 * 调用方据此判断要不要写盘 —— 每次切组都写一次 `pi.ws.last` 是没必要的。
 */
export function pruneLast(last: WsLast, keep: (entry: { id: string; at: number }, wsId: string) => boolean): WsLast {
  const ids = Object.keys(last);
  const alive = ids.filter((wsId) => keep(last[wsId], wsId));
  if (alive.length === ids.length) return last;
  const out: WsLast = {};
  for (const id of alive) out[id] = last[id];
  return out;
}
