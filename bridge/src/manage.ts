import { readJson, statePath, writeJson } from "./paths.ts";

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

const EMPTY: ManageState = { pin: [], order: [], archived: [] };

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item && !out.includes(item)) out.push(item);
  }
  return out;
}

function time(s: { startedAt?: string; updatedAt: number }): number {
  return Date.parse(s.startedAt ?? "") || s.updatedAt;
}

export class Manage {
  private data: ManageState = { ...EMPTY };
  private readonly file = statePath("manage.json");

  constructor() {
    this.load();
  }

  private load(): void {
    const raw = readJson<Partial<ManageState>>(this.file, {});
    this.data = { pin: ids(raw.pin), order: ids(raw.order), archived: ids(raw.archived) };
  }

  private save(): void {
    try {
      writeJson(this.file, this.data);
    } catch {
      /* an unwritable state dir only costs persistence, same call as names.json */
    }
  }

  snapshot(): ManageState {
    return { pin: [...this.data.pin], order: [...this.data.order], archived: [...this.data.archived] };
  }

  isArchived(id: string): boolean {
    return this.data.archived.includes(id);
  }

  /** The whole arrangement at once: every drag and every ☆ ends up here. */
  arrange(pin: unknown, order: unknown): void {
    const archived = new Set(this.data.archived);
    const nextPin = ids(pin).filter((id) => !archived.has(id));
    const nextOrder = ids(order).filter((id) => !archived.has(id) && !nextPin.includes(id));
    this.data.pin = nextPin;
    this.data.order = nextOrder;
    this.save();
  }

  /**
   * Q-022: a session created from the pin strip's ＋ arrives pinned. Appended, not unshifted, so
   * it lands right next to the button that made it instead of jumping over older pins.
   */
  pinLast(id: string): void {
    if (!id || this.data.archived.includes(id)) return;
    this.data.pin = [...this.data.pin.filter((x) => x !== id), id];
    this.data.order = this.data.order.filter((x) => x !== id);
    this.save();
  }

  /**
   * D125「打开即置顶」：从任何入口打开一个会话，它就得在置顶区里 —— 左栏收起后那条横栏是唯一的
   * 会话入口，不在里面就分不出自己在跟哪个会话说话。已经在置顶区的保持原位（手动拖出来的顺序
   * 不该被每一次点击重排），新来的一律插到最前，这样刚打开的那颗永远在第一行看得见。
   * 归档的会话被打开 = 要接着用它，归档让位（archived 里摘掉）。返回是否有改动。
   */
  opened(id: string): boolean {
    if (!id) return false;
    const archived = this.data.archived.includes(id);
    const pinned = this.data.pin.includes(id);
    if (pinned && !archived) return false;
    if (archived) this.data.archived = this.data.archived.filter((x) => x !== id);
    if (!pinned) {
      this.data.pin = [id, ...this.data.pin.filter((x) => x !== id)];
      this.data.order = this.data.order.filter((x) => x !== id);
    }
    this.save();
    return true;
  }

  setArchived(idsIn: string[], on: boolean): void {
    const keep = new Set(this.data.archived);
    for (const id of idsIn) {
      if (on) keep.add(id);
      else keep.delete(id);
    }
    this.data.archived = [...keep];
    // Archiving wins over pin/order: a hidden card must not hold a slot in the visible list.
    const hidden = new Set(this.data.archived);
    this.data.pin = this.data.pin.filter((id) => !hidden.has(id));
    this.data.order = this.data.order.filter((id) => !hidden.has(id));
    this.save();
  }

  forget(id: string): void {
    this.data.pin = this.data.pin.filter((x) => x !== id);
    this.data.order = this.data.order.filter((x) => x !== id);
    this.data.archived = this.data.archived.filter((x) => x !== id);
    this.save();
  }

  /**
   * Pinned first (by hand), then the manual order, then sessions nobody has placed yet — those
   * are the new ones, newest first, so a fresh session lands on top of 其它 without a re-sort.
   * Archived rows sink to the bottom; the sidebar splits them into their own folded section.
   */
  compare(a: { id: string; startedAt?: string; updatedAt: number }, b: { id: string; startedAt?: string; updatedAt: number }): number {
    const aa = this.data.archived.includes(a.id);
    const ba = this.data.archived.includes(b.id);
    if (aa !== ba) return aa ? 1 : -1;
    const ap = this.data.pin.indexOf(a.id);
    const bp = this.data.pin.indexOf(b.id);
    if (ap >= 0 || bp >= 0) {
      if (ap < 0) return 1;
      if (bp < 0) return -1;
      return ap - bp;
    }
    const ao = this.data.order.indexOf(a.id);
    const bo = this.data.order.indexOf(b.id);
    if (ao >= 0 && bo >= 0) return ao - bo;
    if (ao < 0 && bo < 0) return time(b) - time(a);
    return ao < 0 ? -1 : 1;
  }
}
