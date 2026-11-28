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
export function normalizeGroup(raw: any): Group | null {
  const id = typeof raw?.id === "string" ? raw.id : "";
  if (!isGroupId(id) || id.length > 80 || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  const seen = new Set<string>();
  const members: PeerIdentity[] = [];
  for (const m of Array.isArray(raw?.members) ? raw.members : []) {
    const nodeId = typeof m?.nodeId === "string" ? m.nodeId : "";
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    members.push({
      nodeId,
      ...(typeof m.nickname === "string" ? { nickname: m.nickname.slice(0, 64) } : {}),
      ...(typeof m.hostname === "string" ? { hostname: m.hostname.slice(0, 128) } : {}),
      ...(Number.isFinite(Number(m.port)) ? { port: Number(m.port) } : {}),
    });
    if (members.length >= MAX_GROUP_MEMBERS) break;
  }
  return {
    id,
    name: String(raw?.name ?? "").trim().slice(0, 64) || "群聊",
    members,
    owner: String(raw?.owner ?? ""),
    createdAt: Number(raw?.createdAt) || Date.now(),
    v: Number(raw?.v) || 1,
    at: Number(raw?.at) || Date.now(),
    ...(raw?.announceOnly === true ? { announceOnly: true } : {}),
    ...(typeof raw?.publisher === "string" && raw.publisher
      ? { publisher: raw.publisher.slice(0, 64) }
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
  const stamp = optOutFileStamp();
  if (optOutCache && stamp === optOutStamp) return optOutCache;
  try {
    const raw = JSON.parse(fs.readFileSync(optOutFile(), "utf8"));
    optOutCache = new Set((Array.isArray(raw) ? raw : []).filter((x) => typeof x === "string"));
  } catch {
    optOutCache = new Set();
  }
  optOutStamp = stamp;
  return optOutCache;
}

export function setOptOut(id: string, on: boolean): void {
  const set = optOutIds();
  if (on) set.add(id);
  else set.delete(id);
  try {
    fs.writeFileSync(optOutFile(), JSON.stringify([...set], null, 2));
  } catch {
    /* 落盘失败时内存里仍然是新的，下次启动会丢，但不影响这一次 */
  }
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
   * `claimer` = 发送方 nodeId。只读群换发布者（D441）时它会是**新**发布者，而新机器上的 v 可能
   * 比旧机器小（它从没进过这个组）—— 这种快照照收：版本抬到 `before.v + 1`，名册取并集，
   * 否则「换一台机器发布」就永远推不动。其他情况仍然谁 v 大听谁的。
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
    const incoming = next.publisher && !next.members.some((m) => m.nodeId === next.publisher)
      ? [{ nodeId: next.publisher }, ...next.members]
      : next.members;
    const seen = new Set<string>();
    const merged: Group = takeover && before
      ? {
          ...next,
          v: before.v + 1,
          at: Math.max(next.at, Date.now()),
          members: [...incoming, ...before.members]
            .filter((m) => {
              if (seen.has(m.nodeId)) return false;
              seen.add(m.nodeId);
              return true;
            })
            .slice(0, MAX_GROUP_MEMBERS),
        }
      : next;
    const after: Group = { ...merged, ...(merged.members.some((m) => m.nodeId === me) ? {} : { left: true }) };
    this.put(after);
    return { before, after };
  }
}
