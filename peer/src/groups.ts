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
  };
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
   */
  merge(raw: unknown, me: string): { before: Group | null; after: Group } | null {
    const next = normalizeGroup(raw);
    if (!next) return null;
    const before = this.get(next.id);
    if (before && (next.v < before.v || (next.v === before.v && next.at <= before.at))) return null;
    const after: Group = { ...next, ...(next.members.some((m) => m.nodeId === me) ? {} : { left: true }) };
    this.put(after);
    return { before, after };
  }
}
