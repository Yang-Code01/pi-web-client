import { gitRoot } from "./git.ts";
import { readJson, statePath, writeJson } from "./paths.ts";

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

export class Workspaces {
  private data: WorkspaceState = { groups: [], overrides: {}, keys: {} };
  private readonly file = statePath("workspaces.json");
  private readonly root: (dir: string) => Promise<string | null>;

  constructor(options: WorkspacesOptions = {}) {
    this.root = options.root ?? gitRoot;
    this.load();
  }

  private load(): void {
    const raw = readJson<Partial<WorkspaceState>>(this.file, {});
    this.data = {
      groups: readGroups(raw.groups),
      overrides: readRecord(raw.overrides, false),
      keys: readRecord(raw.keys, true),
    };
  }

  private save(): void {
    try {
      writeJson(this.file, this.data);
    } catch {
      /* an unwritable state dir only costs persistence, same call as manage.json */
    }
  }

  snapshot(): WorkspaceState {
    return {
      groups: this.data.groups.map((g) => ({ ...g })),
      overrides: { ...this.data.overrides },
      keys: { ...this.data.keys },
    };
  }

  group(id: string): WsGroup | undefined {
    return this.data.groups.find((g) => g.id === id);
  }

  /**
   * 这个 cwd 的工程根。只查缓存，不跑 git；没缓存过就先拿 cwd 本身顶上 —— 新建会话因此立刻有
   * 组可站，不用等一次异步补缓存。
   */
  keyOf(cwd: string): string {
    const dir = normalizePath(cwd);
    if (!dir) return "";
    return normalizePath(this.data.keys[dir.toLowerCase()] ?? dir);
  }

  /**
   * 这个会话属于哪个工作区（组 id）。override 优先，钉死了就不再跟 cwd 走；否则按工程根找组，
   * 找不到就建（名字留空，显示时取目录名）。空 cwd（脏会话文件）不属于任何工作区 → `""`。
   */
  groupFor(sessionId: string, cwd: string): string {
    const pinned = this.data.overrides[sessionId];
    if (pinned && this.group(pinned)) return pinned;
    const key = this.keyOf(cwd);
    if (!key) return "";
    return this.ensure(key).id;
  }

  private ensure(key: string): WsGroup {
    const id = groupId(key);
    const existing = this.group(id);
    if (existing) return existing;
    const created: WsGroup = { id, name: "", key, manual: false };
    this.data.groups.push(created);
    this.save();
    return created;
  }

  /**
   * 补缓存：只对没见过的 cwd 跑 git，写回 `keys`，顺手清掉「真工程根出现后已经没人指向」的临时组。
   * 返回是否有改动 —— 有改动调用方必须广播新快照，否则页面还停在按 cwd 分的临时组上。
   */
  async resolve(cwds: string[]): Promise<boolean> {
    const pending = new Map<string, string>();
    for (const cwd of cwds) {
      const dir = normalizePath(cwd);
      if (!dir) continue;
      const key = dir.toLowerCase();
      if (this.data.keys[key] || pending.has(key)) continue;
      pending.set(key, dir);
    }
    if (!pending.size) return false;
    for (const [key, dir] of pending) {
      let found: string | null = null;
      try {
        found = await this.root(dir);
      } catch {
        found = null;
      }
      this.data.keys[key] = normalizePath(found ?? dir);
    }
    this.prune();
    this.save();
    return true;
  }

  /**
   * 缓存缺失时按 cwd 建的组是临时的：真工程根一出现（worktree 并回主仓就是这种），它就没用了。
   * 还被 override 指着的组留着（用户拖进去的东西不能因为一次探测就消失）。
   */
  private prune(): void {
    const used = new Set(Object.values(this.data.overrides));
    const keep = this.data.groups.filter((g) => {
      if (g.manual || used.has(g.id)) return true;
      return groupId(this.keyOf(g.id)) === g.id;
    });
    if (keep.length !== this.data.groups.length) this.data.groups = keep;
  }

  /** 改名。空名 = 恢复目录名。返回是否有改动。 */
  rename(id: string, name: string): boolean {
    const group = this.group(id);
    if (!group) return false;
    const next = String(name ?? "").trim().slice(0, 80);
    if (group.name === next) return false;
    group.name = next;
    this.save();
    return true;
  }

  /** 手建一个组（比如「客户 A 的三个仓库」）：v1 里它只是会话的集合，不绑工程根。 */
  create(name: string): WsGroup {
    const id = `manual:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const group: WsGroup = { id, name: String(name ?? "").trim().slice(0, 80), key: "", manual: true };
    this.data.groups.push(group);
    this.save();
    return { ...group };
  }

  /** 拖动落点：写 overrides。`wsId` 为空 = 放回工程（删 override，重新跟 cwd 走）。 */
  move(sessionIds: string[], wsId: string): boolean {
    const target = String(wsId ?? "").trim();
    if (target && !this.group(target)) return false;
    let changed = false;
    for (const id of sessionIds) {
      if (!id) continue;
      if (target) {
        if (this.data.overrides[id] === target) continue;
        this.data.overrides[id] = target;
      } else {
        if (!(id in this.data.overrides)) continue;
        delete this.data.overrides[id];
      }
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  /** 只允许删空的手动组：派生组是 cwd 派生的，删了下次又回来，那是假动作。 */
  drop(id: string): { ok: boolean; reason?: string } {
    const group = this.group(id);
    if (!group) return { ok: false, reason: "找不到这个工作区" };
    if (!group.manual) return { ok: false, reason: "这个工作区跟着目录走，不能删" };
    if (Object.values(this.data.overrides).includes(id)) return { ok: false, reason: "这个工作区里还有会话" };
    this.data.groups = this.data.groups.filter((g) => g.id !== id);
    this.save();
    return { ok: true };
  }

  /** 会话被删掉了：它的 override 跟着消失，不留悬空指向。 */
  forget(sessionId: string): void {
    if (!(sessionId in this.data.overrides)) return;
    delete this.data.overrides[sessionId];
    this.save();
  }
}
