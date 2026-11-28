import fs from "node:fs";
import { statePath } from "./config.ts";
import type { PeerIdentity } from "./history.ts";

/**
 * 基础群聊：没有服务器，群就是「一份成员名单 + 一个 id」，每台机器各存一份。
 *
 * - 群 id 以 `grp-` 开头：会话列表、历史文件、outbox 都拿它当「会话 id」，和 nodeId 不会撞。
 * - 发消息 = 发送方挨个投给其他成员（outbox 逐人补投），没有中转。
 * - 名单 / 群名的改动带一个版本号 `v`，谁的大听谁的；同版本比 `at`（谁后改听谁）。
 *   名单快照跟着每一条群消息走，所以漏掉一次「改名」，下一条消息就把它补上。
 */
export interface Group {
  id: string;
  name: string;
  members: PeerIdentity[];
  owner: string;
  createdAt: number;
  v: number;
  at: number;
  /** 我已经退出（或被移出）：会话还留着、能看历史，但不能再发。 */
  left?: boolean;
  /**
   * 只读群（D441）：只有 `publisher` 能往里发；成员只能看。
   * 更新组用它，但协议里不限于更新组 —— 普通群只要发布者同意也能是只读的。
   */
  announceOnly?: boolean;
  /** 只读群的发布者 nodeId；`announceOnly` 时才有意义。 */
  publisher?: string;
}

export const GROUP_PREFIX = "grp-";
export const MAX_GROUP_MEMBERS = 50;

export function isGroupId(id: string): boolean {
  return id.startsWith(GROUP_PREFIX);
}

/** 对端发来的快照：只收形状对的，名字截短，成员去重。 */
export function normalizeGroup(raw: unknown): Group | null {
  const src = (raw ?? {}) as Record<string, unknown>;
  const id = typeof src.id === "string" ? src.id : "";
  if (!isGroupId(id) || id.length > 80 || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  const seen = new Set<string>();
  const members: PeerIdentity[] = [];
  for (const item of Array.isArray(src.members) ? src.members : []) {
    const m = (item ?? {}) as Record<string, unknown>;
    const nodeId = typeof m.nodeId === "string" ? m.nodeId : "";
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    members.push({
      nodeId,
      ...(typeof m.nickname === "string" ? { nickname: String(m.nickname).slice(0, 64) } : {}),
      ...(typeof m.hostname === "string" ? { hostname: String(m.hostname).slice(0, 128) } : {}),
      ...(Number.isFinite(Number(m.port)) ? { port: Number(m.port) } : {}),
    });
    if (members.length >= MAX_GROUP_MEMBERS) break;
  }
  return {
    id,
    name: String(src.name ?? "").trim().slice(0, 64) || "群聊",
    members,
    owner: String(src.owner ?? ""),
    createdAt: Number(src.createdAt) || Date.now(),
    v: Number(src.v) || 1,
    at: Number(src.at) || Date.now(),
    ...(src.announceOnly === true ? { announceOnly: true } : {}),
    ...(typeof src.publisher === "string" && src.publisher
      ? { publisher: String(src.publisher).slice(0, 64) }
      : {}),
  };
}

/**
 * 退出更新组 = opt-out（D441）：记在本机，之后收到这个组的快照也不再合并回去。
 * 发布者会在 announce 里读到这份名单，跳过已经退出的人，不再邀请。
 */
let optOutCache: Set<string> | null = null;
/** 上次读文件时的 mtime + 大小：手动删改 / 多实例共用 state 目录时也能看见变化（评审 #3）。 */
let optOutStamp = "";
/** 上一次 stat 的时间：optOutIds 挂在 merge / announce 的热路径上，别每 10 秒都同步摸盘。 */
let optOutCheckedAt = 0;
const OPT_OUT_TTL_MS = 1000;
/** 读失败后的退避：EBUSY / 权限问题不该让 merge 热路径每秒同步读一次盘（评审 #7）。 */
let optOutRetryAt = 0;

function optOutFile(): string {
  return statePath("updates-optout.json");
}

function optOutFileStamp(): string {
  try {
    const st = fs.statSync(optOutFile());
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

export function optOutIds(): Set<string> {
  const now = Date.now();
  if (optOutCache && now < optOutRetryAt) return new Set(optOutCache); // 退避期间也别把可变缓存交出去（评审 #30）
  if (optOutCache && now - optOutCheckedAt < OPT_OUT_TTL_MS) return optOutCache;
  optOutCheckedAt = now;
  const stamp = optOutFileStamp();
  if (optOutCache && stamp === optOutStamp) return optOutCache;
  try {
    const raw = JSON.parse(fs.readFileSync(optOutFile(), "utf8"));
    optOutCache = new Set((Array.isArray(raw) ? raw : []).filter((x) => typeof x === "string"));
  } catch (err) {
    // 读失败（EBUSY / 权限）不是「没人退出」：别把有效缓存清空；文件真不在才置空（评审 #20）。
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      optOutCache = new Set();
      optOutStamp = stamp;
    } else {
      // 非 ENOENT：别把空集记成「已读过」再推进 stamp，否则退避命中 stamp 后永远返回空集，
      // 权限恢复也不会重读，用户的退群名单被静默丢掉（评审 #4）。
      optOutRetryAt = now + 10_000;
      return optOutCache ?? new Set();
    }
    return optOutCache;
  }
  optOutStamp = stamp;
  return optOutCache;
}

export function setOptOut(id: string, on: boolean): void {
  // 复制一份再改：optOutIds() 返回的是缓存本身，不能让调用方共享同一份可变 Set（评审 #21）。
  const set = new Set(optOutIds());
  if (on) set.add(id);
  else set.delete(id);
  try {
    fs.writeFileSync(optOutFile(), JSON.stringify([...set], null, 2));
  } catch (err) {
    // 写失败（磁盘满 / 权限）时不能假装成功：清掉缓存，下一次 optOutIds() 读盘拿真实状态（评审 #1）。
    optOutCache = null;
    optOutStamp = "";
    throw err;
  }
  // 我们就是刚写这份文件的人：缓存换成新 Set，stamp 跟着更新（评审 #7/#21）。
  optOutCache = set;
  optOutStamp = optOutFileStamp();
  optOutCheckedAt = Date.now();
}

/** 只读群里谁能写：publisher 定了就是它，没定就回退 owner（旧快照的恢复路径）。
 *  这是**唯一**一份判定，messages 的写门与 files 的收/发文件都调它，别各写一遍。 */
export function canWriteGroup(
  group: { announceOnly?: boolean; publisher?: string; owner: string },
  nodeId: string,
): boolean {
  if (group.announceOnly !== true) return true;
  return group.publisher ? group.publisher === nodeId : group.owner === nodeId;
}

/** 发出去的快照：不带本机才有的 `left`。 */
export function snapshot(group: Group): Omit<Group, "left"> {
  const { left: _left, ...rest } = group;
  return rest;
}

export class Groups {
  private map = new Map<string, Group>();

  constructor(private readonly log: (msg: string) => void) {
    this.load();
  }

  private file(): string {
    return statePath("groups.json");
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as Group[];
      for (const item of Array.isArray(raw) ? raw : []) {
        const g = normalizeGroup(item);
        if (g) this.map.set(g.id, { ...g, ...(item.left ? { left: true } : {}) });
      }
    } catch {
      /* 第一次用：没有文件 */
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file(), JSON.stringify([...this.map.values()], null, 2));
    } catch (err) {
      this.log(`groups 落盘失败：${(err as Error).message}`);
    }
  }

  get(id: string): Group | null {
    return this.map.get(id) ?? null;
  }

  list(): Group[] {
    return [...this.map.values()];
  }

  put(group: Group): Group {
    this.map.set(group.id, group);
    this.save();
    return group;
  }

  /**
   * 收到对端的快照：新于本机才收。返回 `null` = 没变化；否则返回变化前后两份（调用方据此
   * 往会话里写一行「X 改了群名」这类灰条）。
   *
   * `claimer` = 发送方 nodeId。takeover 只处理一种情况：组已经开了只读、但 `publisher` 还是空的，
   * 此时由建组人（owner）把这台机器认成发布者。已经在用的只读群换发布者**不走这里** ——
   * 新机器先被拉进组拿到当前 v，再调 `claimPublisher()` 发 v+1 的快照，正常版本比较就能推进。
   * 其他情况仍然谁 v 大听谁的。
   */
  merge(raw: unknown, me: string, claimer = ""): { before: Group | null; after: Group } | null {
    const next = normalizeGroup(raw);
    if (!next) return null;
    if (optOutIds().has(next.id)) return null;
    const before = this.get(next.id);
    // 接管只认建组的那台（owner）：名单随快照从局域网来，谁都能伪造一份「发布者是我」的快照；
    // 放开给任意成员，等于把只读群的所有权交给任何能发群消息的人（评审 #1）。
    // 从没进过组的新机器仍可以正常接管：先被发布者拉进组（拿到 v），再打开开关走 v+1。
    const takeover = Boolean(
      before &&
        next.announceOnly === true &&
        next.publisher &&
        next.publisher === claimer &&
        next.publisher !== before.publisher &&
        !before.publisher &&
        before.owner === claimer,
    );
    if (!takeover && before && (next.v < before.v || (next.v === before.v && next.at <= before.at))) return null;
    // 发布者必须在新名册里：旧名单满员时不能把他挤掉（评审 #2）。
    // 补进去的是「完整身份」而不是裸 nodeId：before 里已经有昵称/头像就沿用（评审 #9）。
    const pub = next.publisher;
    const pubIdentity = pub
      ? (next.members.find((m) => m.nodeId === pub) ??
        before?.members.find((m) => m.nodeId === pub) ?? { nodeId: pub })
      : null;
    let incoming: PeerIdentity[] = next.members;
    if (pubIdentity && !next.members.some((m) => m.nodeId === pubIdentity.nodeId)) {
      // 满员也要补：publisher 不在名册里会让只读群没人能写（评审 #3）。
      // 挤掉最后一位（最近拉进来的）而不是发布者；名册本身仍受 MAX 约束。
      const room = next.members.length >= MAX_GROUP_MEMBERS ? next.members.slice(0, MAX_GROUP_MEMBERS - 1) : next.members;
      incoming = [pubIdentity, ...room];
    }
    const seen = new Set<string>();
    // takeover 也只信新快照：把 before.members 拼回来会让新快照里被移出的人复活（评审 #6）。
    const members = [...incoming]
      .filter((m) => {
        if (seen.has(m.nodeId)) return false;
        seen.add(m.nodeId);
        return true;
      })
      .slice(0, MAX_GROUP_MEMBERS);
    const merged: Group = takeover && before
      ? { ...next, v: before.v + 1, at: Math.max(next.at, Date.now()), members }
      : { ...next, members };
    const after: Group = { ...merged, ...(merged.members.some((m) => m.nodeId === me) ? {} : { left: true }) };
    this.put(after);
    return { before, after };
  }
}
