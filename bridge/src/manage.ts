import { statePath } from "./paths.ts";
import { StateFile, type StateFailure } from "./statefile.ts";

/**
 * Session-list arrangement the user owns: pin, manual order, archive. Nothing here touches pi's
 * session files — it is a display layer, exactly like the rename overlay (D43). pi has no
 * delete/archive RPC, so the bridge is the only place this state can live.
 */
export interface ManageState {
  /** pinned ids, top to bottom */
  pin: string[];
  /** manual order for everything else; ids missing here are "new" and sort above by creation time */
  order: string[];
  /** archived ids: out of the main list, still openable under 已归档 */
  archived: string[];
  /**
   * D420: when each archived id was archived (epoch ms). The archive promise is "five minutes after
   * you archive it, the process goes", so the moment has to survive a bridge restart — a countdown
   * that starts over every boot would never fire on a bridge that gets restarted, and one that
   * counts from the last pi event would kill a session the user just archived.
   */
  archivedAt: Record<string, number>;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item && !out.includes(item)) out.push(item);
  }
  return out;
}

function stamps(raw: unknown, archived: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const id of archived) {
    const at = (raw as Record<string, unknown>)[id];
    // 没戳的（旧文件、或归档那一刻之前写下的）留给启动补写，别在这里编一个时间。
    if (typeof at === "number" && Number.isFinite(at) && at > 0) out[id] = at;
  }
  return out;
}

function normalize(raw: unknown): ManageState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ManageState>;
  const archived = ids(r.archived);
  // 只留还在归档里的戳：手动改文件留下孤儿戳的话，取消归档再归档会拿到旧时间。
  return { pin: ids(r.pin), order: ids(r.order), archived, archivedAt: stamps(r.archivedAt, archived) };
}

function time(s: { startedAt?: string; updatedAt: number }): number {
  return Date.parse(s.startedAt ?? "") || s.updatedAt;
}

export class Manage {
  /** 读状态文件失败时叫人：由 `index.ts` 接到聊天区的通知（同一句错只报一次，见 StateFile）。 */
  onUnreadable?: (failure: StateFailure) => void;

  private readonly state = new StateFile<ManageState>(statePath("manage.json"), { pin: [], order: [], archived: [], archivedAt: {} }, normalize, (failure) =>
    this.onUnreadable?.(failure),
  );

  snapshot(): ManageState {
    const d = this.state.value();
    return { pin: [...d.pin], order: [...d.order], archived: [...d.archived], archivedAt: { ...d.archivedAt } };
  }

  isArchived(id: string): boolean {
    return this.state.value().archived.includes(id);
  }

  /** When this id was archived, or undefined if it is not archived with a stamp (D420). */
  archivedSince(id: string): number | undefined {
    return this.state.value().archivedAt[id];
  }

  /**
   * D420：旧文件里的归档没有时间戳，启动时补一个（此刻 = 桥启动时刻，不早于归档本身）。
   * 只在真有缺口时写盘 —— StateFile 每次 update 都会落一次文件，没必要每次开机都写。
   * 返回补了几个。
   */
  backfillArchived(at: number): number {
    const d = this.state.value();
    const missing = d.archived.filter((id) => d.archivedAt[id] === undefined);
    if (!missing.length) return 0;
    this.state.update((s) => {
      for (const id of missing) s.archivedAt[id] = at;
    });
    return missing.length;
  }

  /** The whole arrangement at once: every drag and every ☆ ends up here. */
  arrange(pin: unknown, order: unknown): void {
    this.state.update((d) => {
      const archived = new Set(d.archived);
      d.pin = ids(pin).filter((id) => !archived.has(id));
      d.order = ids(order).filter((id) => !archived.has(id) && !d.pin.includes(id));
    });
  }

  /**
   * D349 (was Q-022, strip ＋ only): every newly created session arrives pinned. Appended, not
   * unshifted, so it lands right next to the strip's ＋ instead of jumping over older pins.
   */
  pinLast(id: string): void {
    if (!id) return;
    this.state.update((d) => {
      if (d.archived.includes(id)) return;
      d.pin = [...d.pin.filter((x) => x !== id), id];
      d.order = d.order.filter((x) => x !== id);
    });
  }

  // D146 废止了 D125「打开即置顶」：打开一个会话不再改任何排列（pin / order / archived 都不动）。
  // 置顶现在是组内排序，跨组自动重排会打乱用户手工拖出来的顺序，所以这里没有 opened() 这个方法 ——
  // 「打开」不是 manage 的动作，`bridge/src/index.ts` 收到旧页面发来的 opened 只回一份快照。
  // D386 给它开了唯一的口子：打开一条**已归档**的会话时才动排列，见下面的 `revive()`。

  setArchived(idsIn: string[], on: boolean): void {
    this.state.update((d) => {
      const keep = new Set(d.archived);
      for (const id of idsIn) {
        if (on) keep.add(id);
        else keep.delete(id);
      }
      d.archived = [...keep];
      // D420: 归档那一刻就是倒计时的起点；取消归档（含 D386 的复活）把钟一起清掉。
      const now = Date.now();
      for (const id of idsIn) {
        if (on) d.archivedAt[id] = now;
        else delete d.archivedAt[id];
      }
      for (const id of Object.keys(d.archivedAt)) {
        if (!d.archived.includes(id)) delete d.archivedAt[id];
      }
      // Archiving wins over pin/order: a hidden card must not hold a slot in the visible list.
      const hidden = new Set(d.archived);
      d.pin = d.pin.filter((id) => !hidden.has(id));
      d.order = d.order.filter((id) => !hidden.has(id));
    });
  }

  /**
   * D386：打开一条**已归档**的会话 = 请它回来 —— 取消归档 + 插到 ★ 行最前，一个 `update` 里做完。
   * 两件事必须原子：分两步做的话页面会先看到「已取消归档、但还没置顶」的中间态（★ 行里没有它，
   * 顶栏又刚好算不出归属）。非归档会话调用是空操作 —— D146 的「打开不改排列」照旧管它们。
   */
  revive(id: string): void {
    if (!id) return;
    this.state.update((d) => {
      if (!d.archived.includes(id)) return;
      d.archived = d.archived.filter((x) => x !== id);
      delete d.archivedAt[id];
      d.pin = [id, ...d.pin.filter((x) => x !== id)];
      d.order = d.order.filter((x) => x !== id);
    });
  }

  /**
   * D420：归档会话被叫醒（又被用上）时重新计时。「归档后五分钟释放」说的是最后一次用它之后五分钟，
   * 不是归档动作之后五分钟 —— 否则一条睡醒的归档会话会在下一个 tick 被再收一次，用户每发一句话它
   * 就只能活一秒。不归档的 id 空操作。
   */
  touchArchived(id: string, at: number): void {
    const d = this.state.value();
    if (!d.archived.includes(id) || d.archivedAt[id] === at) return;
    this.state.update((s) => {
      if (s.archived.includes(id)) s.archivedAt[id] = at;
    });
  }

  forget(id: string): void {
    this.state.update((d) => {
      d.pin = d.pin.filter((x) => x !== id);
      d.order = d.order.filter((x) => x !== id);
      d.archived = d.archived.filter((x) => x !== id);
      delete d.archivedAt[id];
    });
  }

  /**
   * Pinned first (by hand), then the manual order, then sessions nobody has placed yet — those
   * are the new ones, newest first, so a fresh session lands on top of 其它 without a re-sort.
   * Archived rows sink to the bottom; the sidebar splits them into their own folded section.
   */
  compare(a: { id: string; startedAt?: string; updatedAt: number }, b: { id: string; startedAt?: string; updatedAt: number }): number {
    const d = this.state.value();
    const aa = d.archived.includes(a.id);
    const ba = d.archived.includes(b.id);
    if (aa !== ba) return aa ? 1 : -1;
    const ap = d.pin.indexOf(a.id);
    const bp = d.pin.indexOf(b.id);
    if (ap >= 0 || bp >= 0) {
      if (ap < 0) return 1;
      if (bp < 0) return -1;
      return ap - bp;
    }
    const ao = d.order.indexOf(a.id);
    const bo = d.order.indexOf(b.id);
    if (ao >= 0 && bo >= 0) return ao - bo;
    if (ao < 0 && bo < 0) return time(b) - time(a);
    return ao < 0 ? -1 : 1;
  }
}
