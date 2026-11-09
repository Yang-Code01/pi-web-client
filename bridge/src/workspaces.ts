import { gitRoot } from "./git.ts";
import { statePath } from "./paths.ts";
import { StateFile, type StateFailure } from "./statefile.ts";

/**
 * 工作区（#72 / #94）= 工程 = 会话列表的一级分组。它不是 pi 的会话，也不是磁盘上某个目录的别名：
 * 它是「这个会话属于哪个工程」的答案，由 cwd 推导，用户拖过的那几条用 override 钉死。
 *
 * 两层，故意分开：
 * - 读路径（`keyOf` / `groupFor`）只查状态文件里的 `keys` 缓存，同步、不跑 git —— `Session.list()`
 *   要得急，等不了一个子进程。
 * - 写路径（`resolve`）异步补缓存：只对没见过的 cwd 跑一次 `git rev-parse --git-common-dir`，结果
 *   落盘，重启后不必重算。缓存命中时它一次 git 都不跑。
 *
 * 落盘与 `manage.json` 并列，同一个状态目录、同一套 readJson/writeJson。
 */
export interface WsGroup {
  /** 派生组 = 归一化工程根的小写形式；手动组 = `manual:<随机>`。 */
  id: string;
  /** 用户起的名字；空串 = 显示时取目录名（前端按 `key` 的 basename 算）。 */
  name: string;
  /** 工程根（保留原样大小写，只做路径归一化）；手动组为空串。 */
  key: string;
  /** 用户手建的组：可以删（空的时候），派生组跟着目录走。 */
  manual: boolean;
}

export interface WorkspaceState {
  groups: WsGroup[];
  /** sessionId → groupId：拖过就钉死，优先于 cwd 推导；「放回工程」= 删掉这一条。 */
  overrides: Record<string, string>;
  /** 归一化 cwd 的小写 → 工程根。缓存，只由 `resolve()` 写。 */
  keys: Record<string, string>;
  /**
   * #173 一份顺序：全量组 id（含被折叠的），顺序即左栏 / 标签行顺序。存量文件没有这条 →
   * 迁移：旧 `pinned` 顺序打头，其余按显示名字母序；`pinned` 从此退役。
   */
  order?: string[];
  /** 标签行最多画几颗，默认 6，只接受 1–12 的整数（#176）。 */
  max?: number;
}

export interface WorkspacesOptions {
  /** Test seam: count or stub the git call. Defaults to `gitRoot` from git.ts. */
  root?: (dir: string) => Promise<string | null>;
}

/**
 * 归一化：反斜杠转正斜杠、折叠重复斜杠、去尾斜杠、盘符根保留 `F:/`。大小写原样保留（显示用）；
 * 要比大小写的时候用 `groupId`。
 */
export function normalizePath(value: unknown): string {
  let s = String(value ?? "").trim().replace(/\\/g, "/");
  if (!s) return "";
  const unc = s.startsWith("//");
  s = s.replace(/\/{2,}/g, "/");
  if (unc) s = `/${s}`;
  s = s.replace(/\/+$/, "");
  if (!s) return "/";
  // A drive root (`F:\`) collapses to `F:` — put the slash back so all roots look alike.
  return /^[a-zA-Z]:$/.test(s) ? `${s}/` : s;
}

/** 组 id：归一化路径的小写形式。Windows 路径大小写不敏感，id 必须可比。 */
export function groupId(root: unknown): string {
  return normalizePath(root).toLowerCase();
}

/** 标签行名额：默认 6，可调范围 1–12（#176）。 */
export const TABS_DEFAULT = 6;
export const TABS_MIN = 1;
export const TABS_MAX = 12;

/**
 * 名额：只认 1–12 的整数；字符串 / null / NaN / 小数 / 越界一律返回 `null` = 非法。
 * 非法值由调用方回 notice 且**什么都不改**，不在这里悄悄 clamp（#172 R27）。
 */
function readMax(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < TABS_MIN || value > TABS_MAX) return null;
  return value;
}

/** 组在界面上的名字：用户起的名字 → 目录名 → 「新工作区」（与左栏 `buildTree()` 的回落同一套）。 */
function displayName(group: WsGroup): string {
  const own = group.name.trim();
  if (own) return own;
  const parts = normalizePath(group.key).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "新工作区";
}

/** 显示名字母序，大小写不敏感；同名靠 id 稳定。 */
function byDisplayName(a: WsGroup, b: WsGroup): number {
  return displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
}

/**
 * order 的唯一洗法（#173）：去重、剔掉已经不存在的组、把缺的组补到末尾。
 * `seed` 只在旧文件没有 order 时用 —— 旧 `pinned` 的顺序原样打头（迁移）；迁移补齐按显示名，
 * 之后的日常补齐按创建序（`groups` 数组序），不按名字插队。
 */
function readOrder(value: unknown, groups: WsGroup[], seed: readonly unknown[] = []): string[] {
  const known = new Set(groups.map((g) => g.id));
  const out: string[] = [];
  const add = (id: unknown): void => {
    if (typeof id !== "string" || !id || !known.has(id) || out.includes(id)) return;
    out.push(id);
  };
  if (Array.isArray(value)) for (const id of value) add(id);
  else for (const id of seed) add(id);
  const missing = groups.filter((g) => !out.includes(g.id));
  if (!Array.isArray(value)) missing.sort(byDisplayName);
  for (const group of missing) out.push(group.id);
  return out;
}

function readGroups(value: unknown): WsGroup[] {
  if (!Array.isArray(value)) return [];
  const out: WsGroup[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const g = item as Partial<WsGroup>;
    if (typeof g.id !== "string" || !g.id) continue;
    const manual = g.manual === true;
    const id = manual ? g.id : groupId(g.id);
    if (!id || out.some((x) => x.id === id)) continue;
    out.push({ id, name: typeof g.name === "string" ? g.name : "", key: manual ? "" : normalizePath(g.key ?? g.id), manual });
  }
  return out;
}

function readRecord(value: unknown, normalize: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string" || !raw) continue;
    out[normalize ? normalizePath(key) : key] = normalize ? normalizePath(raw) : raw;
  }
  return out;
}

function emptyState(): WorkspaceState {
  return { groups: [], overrides: {}, keys: {}, order: [], max: TABS_DEFAULT };
}

/**
 * 存量文件缺字段是常态：缺 `order` 时按旧 `pinned` + 显示名迁移，缺 `max` 按默认名额。
 * 迁移只在读时做；下一次写盘才落新形状，平时不改写旧文件。
 */
function normalize(raw: unknown): WorkspaceState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<WorkspaceState> & { pinned?: unknown };
  const groups = readGroups(r.groups);
  const legacy = !Array.isArray(r.order);
  return {
    groups,
    overrides: readRecord(r.overrides, false),
    keys: readRecord(r.keys, true),
    // #173 一份顺序接管：旧文件没有 order → 旧 pinned 打头、其余按显示名；此后 order 说了算。
    order: readOrder(r.order, groups, legacy && Array.isArray(r.pinned) ? r.pinned : []),
    max: readMax(r.max) ?? TABS_DEFAULT,
  };
}

/** 组没了，order 里就不该还留着它的 id（#173）：悬空 id 会让顺序少一格却不知道少了谁。 */
function pruneOrder(d: WorkspaceState): void {
  const ids = new Set(d.groups.map((g) => g.id));
  const next = (d.order ?? []).filter((id) => ids.has(id));
  if (next.length !== (d.order ?? []).length) d.order = next;
}

/**
 * 缓存缺失时按 cwd 建的组是临时的：真工程根一出现（worktree 并回主仓就是这种），它就没用了。
 * 还被 override 指着的组留着（用户拖进去的东西不能因为一次探测就消失）。
 */
function prune(d: WorkspaceState): void {
  const used = new Set(Object.values(d.overrides));
  const keep = d.groups.filter((g) => {
    if (g.manual || used.has(g.id)) return true;
    const dir = normalizePath(g.id);
    return groupId(d.keys[dir.toLowerCase()] ?? dir) === g.id;
  });
  if (keep.length !== d.groups.length) {
    d.groups = keep;
    pruneOrder(d);
  }
}

export class Workspaces {
  /** 读状态文件失败时叫人：由 `index.ts` 接到聊天区的通知（同一句错只报一次，见 StateFile）。 */
  onUnreadable?: (failure: StateFailure) => void;

  /**
   * 同 `manage.json`：读-改-写，读不到就拒绝落盘并等文件恢复 —— 一次「没读到」不能变成整片工作区
   * 配置被空状态覆盖，也不能让整个进程从此不再保存。
   */
  private readonly state = new StateFile<WorkspaceState>(statePath("workspaces.json"), emptyState(), normalize, (failure) =>
    this.onUnreadable?.(failure),
  );
  private readonly root: (dir: string) => Promise<string | null>;

  constructor(options: WorkspacesOptions = {}) {
    this.root = options.root ?? gitRoot;
  }

  snapshot(): WorkspaceState {
    const d = this.state.value();
    return {
      groups: d.groups.map((g) => ({ ...g })),
      overrides: { ...d.overrides },
      keys: { ...d.keys },
      // 坏文件里的悬空 / 重复 id 不进画布：树 / 标签行只该看到还存在的组，顺序永远完整。
      order: readOrder(d.order, d.groups),
      max: d.max ?? TABS_DEFAULT,
    };
  }

  group(id: string): WsGroup | undefined {
    return this.state.value().groups.find((g) => g.id === id);
  }

  /**
   * 这个 cwd 的工程根。只查缓存，不跑 git；没缓存过就先拿 cwd 本身顶上 —— 新建会话因此立刻有
   * 组可站，不用等一次异步补缓存。
   */
  keyOf(cwd: string): string {
    const d = this.state.value();
    const dir = normalizePath(cwd);
    if (!dir) return "";
    return normalizePath(d.keys[dir.toLowerCase()] ?? dir);
  }

  /**
   * 这个会话属于哪个工作区（组 id）。override 优先，钉死了就不再跟 cwd 走；否则按工程根找组，
   * 找不到就建（名字留空，显示时取目录名）。空 cwd（脏会话文件）不属于任何工作区 → `""`。
   */
  groupFor(sessionId: string, cwd: string): string {
    const override = this.state.value().overrides[sessionId];
    if (override && this.group(override)) return override;
    const key = this.keyOf(cwd);
    if (!key) return "";
    return this.ensure(key).id;
  }

  private ensure(key: string): WsGroup {
    const id = groupId(key);
    const existing = this.group(id);
    if (existing) return existing;
    const created: WsGroup = { id, name: "", key, manual: false };
    this.state.update((d) => {
      if (!d.groups.some((g) => g.id === id)) d.groups.push({ ...created });
      // #173 新出现的组追加到末尾：ensure 是「补一个」，不能插队改用户顺序。
      d.order = readOrder(d.order, d.groups);
    });
    return created;
  }

  /**
   * 补缓存：只对没见过的 cwd 跑 git，写回 `keys`，顺手清掉「真工程根出现后已经没人指向」的临时组。
   * 返回是否有改动 —— 有改动调用方必须广播新快照，否则页面还停在按 cwd 分的临时组上。
   */
  async resolve(cwds: string[]): Promise<boolean> {
    const known = this.state.value().keys;
    const pending = new Map<string, string>();
    for (const cwd of cwds) {
      const dir = normalizePath(cwd);
      if (!dir) continue;
      const key = dir.toLowerCase();
      if (known[key] || pending.has(key)) continue;
      pending.set(key, dir);
    }
    if (!pending.size) return false;
    const found = new Map<string, string>();
    for (const [key, dir] of pending) {
      let root: string | null = null;
      try {
        root = await this.root(dir);
      } catch {
        root = null;
      }
      found.set(key, normalizePath(root ?? dir));
    }
    this.state.update((d) => {
      for (const [key, value] of found) d.keys[key] = value;
      prune(d);
    });
    return true;
  }

  /** 改名。空名 = 恢复目录名。返回是否有改动。 */
  rename(id: string, name: string): boolean {
    const group = this.group(id);
    if (!group) return false;
    const next = String(name ?? "").trim().slice(0, 80);
    if (group.name === next) return false;
    this.state.update((d) => {
      const g = d.groups.find((x) => x.id === id);
      if (g) g.name = next;
    });
    return true;
  }

  /** 手建一个组（比如「客户 A 的三个仓库」）：v1 里它只是会话的集合，不绑工程根。 */
  create(name: string): WsGroup {
    const id = `manual:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const group: WsGroup = { id, name: String(name ?? "").trim().slice(0, 80), key: "", manual: true };
    this.state.update((d) => {
      d.groups.push({ ...group });
      // #173 新组排到末尾，不按显示名插队。
      d.order = readOrder(d.order, d.groups);
    });
    return { ...group };
  }

  /** 拖动落点：写 overrides。`wsId` 为空 = 放回工程（删 override，重新跟 cwd 走）。 */
  move(sessionIds: string[], wsId: string): boolean {
    const target = String(wsId ?? "").trim();
    if (target && !this.group(target)) return false;
    let changed = false;
    this.state.update((d) => {
      for (const id of sessionIds) {
        if (!id) continue;
        if (target) {
          if (d.overrides[id] === target) continue;
          d.overrides[id] = target;
        } else {
          if (!(id in d.overrides)) continue;
          delete d.overrides[id];
        }
        changed = true;
      }
    });
    return changed;
  }

  /**
   * 删工作区（#279）：只拦有会话的组 —— 空的手动组与空的目录组都能删。
   *
   * 会话数由调用方数（`Sessions.dropWorkspace`）传进来：组里的会话可能来自 override，也可能来自 cwd
   * 派生，只看 `overrides` 会漏掉后者 —— 带着会话删掉一个派生组，下一次 `groupFor` 又把它建回来。
   * 有会话时仍说原来的那句话（手动组「还有会话」，目录组「跟着目录走」）。
   */
  drop(id: string, sessions: number): { ok: boolean; reason?: string } {
    const group = this.group(id);
    if (!group) return { ok: false, reason: "找不到这个工作区" };
    if (sessions > 0) {
      return { ok: false, reason: group.manual ? "这个工作区里还有会话" : "这个工作区跟着目录走，不能删" };
    }
    this.state.update((d) => {
      d.groups = d.groups.filter((g) => g.id !== id);
      pruneOrder(d);
      // 顺手清掉还指着它的 override：那些会话已经不在列表里了，留着就是悬空指向。
      for (const [sessionId, wsId] of Object.entries(d.overrides)) if (wsId === id) delete d.overrides[sessionId];
    });
    return { ok: true };
  }

  /**
   * 标签行的顺序 + 名额（#173）：两个字段各自可缺省，缺省的那个一个字都不动；给了就**一次落盘**。
   *
   * `order` 是全量顺序（含折叠组），不按名额截断 —— 名额只决定画几颗，不影响顺序本身。
   * 写前洗一遍：去重、剔掉已经不存在的组、缺的组按创建序补到末尾。名额只接受 1–12 的整数；
   * 非法时返回原因且**什么都不改** —— 调用方据此回 notice。旧页面发来的 `pinned` 不参与排序。
   */
  setTabs(input: { order?: unknown; max?: unknown }): { ok: boolean; reason?: string } {
    const d0 = this.state.value();
    let max = d0.max ?? TABS_DEFAULT;
    if (input.max !== undefined) {
      const next = readMax(input.max);
      if (next == null) return { ok: false, reason: `最多显示要是 ${TABS_MIN}–${TABS_MAX} 之间的整数` };
      max = next;
    }
    let order: string[];
    if (input.order !== undefined) {
      if (!Array.isArray(input.order)) return { ok: false, reason: "标签行顺序要是一份组 id 列表" };
      order = readOrder(input.order, d0.groups);
    } else {
      order = readOrder(d0.order, d0.groups);
    }
    this.state.update((d) => {
      d.order = order;
      d.max = max;
    });
    return { ok: true };
  }

  /** 会话被删掉了：它的 override 跟着消失，不留悬空指向。 */
  forget(sessionId: string): void {
    if (!(sessionId in this.state.value().overrides)) return;
    this.state.update((d) => {
      delete d.overrides[sessionId];
    });
  }
}
