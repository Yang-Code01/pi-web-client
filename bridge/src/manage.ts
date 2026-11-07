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
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item && !out.includes(item)) out.push(item);
  }
  return out;
}

function normalize(raw: unknown): ManageState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ManageState>;
  return { pin: ids(r.pin), order: ids(r.order), archived: ids(r.archived) };
}

function time(s: { startedAt?: string; updatedAt: number }): number {
  return Date.parse(s.startedAt ?? "") || s.updatedAt;
}

export class Manage {
  /** 读状态文件失败时叫人：由 `index.ts` 接到聊天区的通知（同一句错只报一次，见 StateFile）。 */
  onUnreadable?: (failure: StateFailure) => void;

  private readonly state = new StateFile<ManageState>(statePath("manage.json"), { pin: [], order: [], archived: [] }, normalize, (failure) =>
    this.onUnreadable?.(failure),
  );

  snapshot(): ManageState {
    const d = this.state.value();
    return { pin: [...d.pin], order: [...d.order], archived: [...d.archived] };
  }

  isArchived(id: string): boolean {
    return this.state.value().archived.includes(id);
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
   * Q-022: a session created from the pin strip's ＋ arrives pinned. Appended, not unshifted, so
   * it lands right next to the button that made it instead of jumping over older pins.
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

  setArchived(idsIn: string[], on: boolean): void {
    this.state.update((d) => {
      const keep = new Set(d.archived);
      for (const id of idsIn) {
        if (on) keep.add(id);
        else keep.delete(id);
      }
      d.archived = [...keep];
      // Archiving wins over pin/order: a hidden card must not hold a slot in the visible list.
      const hidden = new Set(d.archived);
      d.pin = d.pin.filter((id) => !hidden.has(id));
      d.order = d.order.filter((id) => !hidden.has(id));
    });
  }

  forget(id: string): void {
    this.state.update((d) => {
      d.pin = d.pin.filter((x) => x !== id);
      d.order = d.order.filter((x) => x !== id);
      d.archived = d.archived.filter((x) => x !== id);
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
