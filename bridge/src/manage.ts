import { randomUUID } from "node:crypto";
import { readJson, statePath, writeJson } from "./paths.ts";

/**
 * Session-list arrangement the user owns: workspaces, membership, pin, archive. Nothing here
 * touches pi's session files — it is a display layer, exactly like the rename overlay (D43).
 * pi has no delete/archive RPC, so the bridge is the only place this state can live.
 */

/**
 * A workspace is a user-named folder of sessions. It is **not** bound to a cwd: two sessions in
 * one workspace may run in different directories, and nothing here guesses a grouping from a path.
 */
export interface Workspace {
  id: string;
  name: string;
  /** `ACCENTS` id (`ice` / `teal` / …), not a literal colour — same rule as `pi.prefs.accent`. */
  color: string;
  /** Optional emoji shown instead of / next to the colour dot. */
  icon: string;
}

/** The pseudo-workspace that catches every session nobody has filed. Never renameable, always last. */
export const UNGROUPED = "";

export interface ManageState {
  /** Tab order, top to bottom. `未分组` is deliberately *not* in here — it is virtual. */
  workspaces: Workspace[];
  /**
   * Membership **and** order in one place: `members[wsId]` is exactly what the sidebar shows top
   * to bottom (and what the top strip shows left to right). `members[UNGROUPED]` catches the rest.
   * A session missing from every bucket is "new" and sorts above by creation time (see `compare`).
   */
  members: Record<string, string[]>;
  /**
   * ★ is a **set** now, not an order: the top strip lists every unarchived session of the current
   * workspace, so pinning only means "keep this one above the rest" — the position inside a group
   * comes from `members`, never from this array.
   */
  pin: string[];
  /**
   * ★ on **workspaces**: only these reach the top strip, and they come first in the left column.
   * An empty list is legal — the strip then falls back to showing just the workspace you are in.
   */
  pinned: string[];
  /** Archived ids: out of the groups, still openable under 已归档. Their `members` slot is kept. */
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

function buckets(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, list] of Object.entries(value as Record<string, unknown>)) {
    const clean = ids(list);
    if (clean.length) out[key] = clean;
  }
  return out;
}

function spaces(value: unknown): Workspace[] {
  if (!Array.isArray(value)) return [];
  const out: Workspace[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    // `UNGROUPED` must not be a real workspace: the pseudo-bucket has no name and cannot be removed.
    if (!id || id === UNGROUPED || out.some((w) => w.id === id)) continue;
    out.push({
      id,
      name: typeof row.name === "string" ? row.name : "",
      color: typeof row.color === "string" ? row.color : "",
      icon: typeof row.icon === "string" ? row.icon : "",
    });
  }
  return out;
}

function time(s: { startedAt?: string; updatedAt: number }): number {
  return Date.parse(s.startedAt ?? "") || s.updatedAt;
}

/** Old files stored a flat `order`; membership now lives in `members`, so fold it into 未分组. */
type RawState = Partial<ManageState> & { order?: unknown };

export class Manage {
  private data: ManageState = { workspaces: [], members: {}, pin: [], pinned: [], archived: [] };
  private readonly file = statePath("manage.json");

  constructor() {
    this.load();
  }

  private load(): void {
    const raw = readJson<RawState>(this.file, {});
    const pin = ids(raw.pin);
    const archived = ids(raw.archived);
    const members = buckets(raw.members);
    // D116 migration: `{pin, order}` → `members[""]`. Pin order first so the old sidebar order is
    // preserved as the new display order; dropping this would silently reshuffle everyone's list.
    if (!Object.keys(members).length) {
      const legacy = [...pin, ...ids(raw.order)];
      if (legacy.length) members[UNGROUPED] = legacy;
    }
    this.data = { workspaces: spaces(raw.workspaces), members, pin, pinned: ids(raw.pinned), archived };
    // A bucket for a workspace that no longer exists would keep its sessions invisible.
    const live = new Set(Object.keys(members));
    for (const key of live) {
      if (key === UNGROUPED) continue;
      if (!this.data.workspaces.some((w) => w.id === key)) {
        this.data.members[UNGROUPED] = [...(this.data.members[UNGROUPED] ?? []), ...(this.data.members[key] ?? [])];
        delete this.data.members[key];
      }
    }
  }

  private save(): void {
    try {
      writeJson(this.file, this.data);
    } catch {
      /* an unwritable state dir only costs persistence, same call as names.json */
    }
  }

  snapshot(): ManageState {
    const members: Record<string, string[]> = {};
    for (const [key, list] of Object.entries(this.data.members)) members[key] = [...list];
    return {
      workspaces: this.data.workspaces.map((w) => ({ ...w })),
      members,
      pin: [...this.data.pin],
      pinned: [...this.data.pinned],
      archived: [...this.data.archived],
    };
  }

  isArchived(id: string): boolean {
    return this.data.archived.includes(id);
  }

  /** Which workspace a session sits in; `UNGROUPED` when nobody filed it. */
  workspaceOf(id: string): string {
    for (const [key, list] of Object.entries(this.data.members)) if (list.includes(id)) return key;
    return UNGROUPED;
  }

  private spaceIndex(wsId: string): number {
    if (wsId === UNGROUPED) return this.data.workspaces.length;
    const at = this.data.workspaces.findIndex((w) => w.id === wsId);
    return at < 0 ? this.data.workspaces.length : at;
  }

  // ---------------------------------------------------------------- membership

  /** Drop an id out of every bucket (the caller decides where it lands next). */
  private detach(id: string): void {
    for (const [key, list] of Object.entries(this.data.members)) {
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
      if (!list.length && key !== UNGROUPED) delete this.data.members[key];
    }
  }

  /** File one session into a workspace, at the end. Used by 「移动到…」 and by drag fallbacks. */
  assign(list: string[], wsId: string, at?: number): void {
    const moving = ids(list);
    if (!moving.length) return;
    // 先全部摘出来，再建目标桶：`detach` 会删空桶，先建桶会被它当垃圾删掉（写进孤儿数组）。
    for (const id of moving) this.detach(id);
    const dest = (this.data.members[wsId] ??= []);
    const where = at == null ? dest.length : Math.max(0, Math.min(at, dest.length));
    dest.splice(where, 0, ...moving);
    this.save();
  }

  /**
   * The whole arrangement after a drop: `{wsId: [ids in display order]}`. Replacing `members`
   * wholesale keeps one ordering source of truth — the DOM the user just arranged.
   */
  arrangeGroups(groups: unknown): void {
    const before = new Map<string, string>();
    for (const [key, list] of Object.entries(this.data.members)) for (const id of list) before.set(id, key);
    const next = buckets(groups);
    const placed = new Set<string>();
    for (const list of Object.values(next)) for (const id of list) placed.add(id);
    // Sessions the DOM could not show (archived, or filtered out) keep their slot behind the rest.
    for (const [id, key] of before) {
      if (placed.has(id)) continue;
      next[key] ??= [];
      next[key].push(id);
    }
    this.data.members = next;
    this.save();
  }

  // ---------------------------------------------------------------- workspaces

  addWorkspace(name: string, color: string, icon = ""): Workspace {
    const id = `ws-${randomUUID().slice(0, 8)}`;
    const space: Workspace = { id, name, color, icon };
    this.data.workspaces.push(space);
    this.save();
    return space;
  }

  patchWorkspace(id: string, patch: { name?: string; color?: string; icon?: string }): void {
    const space = this.data.workspaces.find((w) => w.id === id);
    if (!space) return;
    if (typeof patch.name === "string" && patch.name.trim()) space.name = patch.name.trim();
    if (typeof patch.color === "string") space.color = patch.color;
    if (typeof patch.icon === "string") space.icon = patch.icon;
    this.save();
  }

  /** ★ on a workspace: only pinned ones reach the top strip (an empty set is legal). */
  setSpacePinned(id: string, on: boolean): void {
    if (!id || !this.data.workspaces.some((w) => w.id === id)) return;
    const has = this.data.pinned.includes(id);
    if (on === has) return;
    this.data.pinned = on ? [...this.data.pinned, id] : this.data.pinned.filter((x) => x !== id);
    this.save();
  }

  /** Reorder the tabs; ids missing from `order` keep their relative place at the end. */
  orderWorkspaces(order: unknown): void {
    const want = ids(order).filter((id) => this.data.workspaces.some((w) => w.id === id));
    const rest = this.data.workspaces.filter((w) => !want.includes(w.id));
    const byId = new Map(this.data.workspaces.map((w) => [w.id, w]));
    this.data.workspaces = [...want.map((id) => byId.get(id)!), ...rest];
    this.save();
  }

  /**
   * 「按目录建组」：把计划的几批会话一次性落成工作区。名字由前端算好（包括撞名后的后缀），
   * 桥只负责建组 + 归位，不猜目录、也不自动合并同名已有组。
   */
  groupByDirs(plans: unknown): void {
    if (!Array.isArray(plans)) return;
    for (const raw of plans) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const list = ids(row.ids);
      if (!list.length) continue;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const color = typeof row.color === "string" ? row.color : "";
      const space = this.addWorkspace(name, color);
      this.assign(list, space.id);
    }
  }

  /**
   * Deleting a workspace never deletes sessions: everything inside falls back to 未分组, appended in
   * its current order so nothing visibly shuffles.
   */
  removeWorkspace(id: string): void {
    const at = this.data.workspaces.findIndex((w) => w.id === id);
    if (at < 0) return;
    const orphaned = this.data.members[id] ?? [];
    this.data.workspaces.splice(at, 1);
    this.data.pinned = this.data.pinned.filter((x) => x !== id);
    delete this.data.members[id];
    if (orphaned.length) this.data.members[UNGROUPED] = [...(this.data.members[UNGROUPED] ?? []), ...orphaned];
    this.save();
  }

  // ---------------------------------------------------------------- pin / archive

  /** Q-022: a session created from the strip's ＋ arrives pinned (appended, so it sits after older ones). */
  pinLast(id: string): void {
    if (!id || this.data.archived.includes(id)) return;
    this.data.pin = [...this.data.pin.filter((x) => x !== id), id];
    this.save();
  }

  setPinned(id: string, on: boolean): void {
    const has = this.data.pin.includes(id);
    if (on === has) return;
    this.data.pin = on ? [...this.data.pin, id] : this.data.pin.filter((x) => x !== id);
    this.save();
  }

  setArchived(idsIn: string[], on: boolean): void {
    const keep = new Set(this.data.archived);
    for (const id of idsIn) {
      if (on) keep.add(id);
      else keep.delete(id);
    }
    this.data.archived = [...keep];
    // Archiving wins over pin: a hidden card must not keep a ★ (its `members` slot is kept, so
    // un-archiving puts it back where it was).
    const hidden = new Set(this.data.archived);
    this.data.pin = this.data.pin.filter((id) => !hidden.has(id));
    this.save();
  }

  forget(id: string): void {
    this.detach(id);
    this.data.pin = this.data.pin.filter((x) => x !== id);
    this.data.archived = this.data.archived.filter((x) => x !== id);
    this.save();
  }

  // ---------------------------------------------------------------- ordering

  /**
   * Archived rows sink to the bottom. Everything else sorts by workspace, then by its slot inside
   * that workspace, then — for sessions nobody has placed yet — newest first, so a fresh session
   * lands on top of its group without a re-sort.
   */
  compare(a: { id: string; startedAt?: string; updatedAt: number }, b: { id: string; startedAt?: string; updatedAt: number }): number {
    const aa = this.data.archived.includes(a.id);
    const ba = this.data.archived.includes(b.id);
    if (aa !== ba) return aa ? 1 : -1;
    const aw = this.workspaceOf(a.id);
    const bw = this.workspaceOf(b.id);
    if (aw !== bw) return this.spaceIndex(aw) - this.spaceIndex(bw);
    const list = this.data.members[aw] ?? [];
    const ap = list.indexOf(a.id);
    const bp = list.indexOf(b.id);
    if (ap !== bp) {
      if (ap < 0) return -1;
      if (bp < 0) return 1;
      return ap - bp;
    }
    return time(b) - time(a);
  }
}
