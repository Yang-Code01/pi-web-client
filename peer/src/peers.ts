import fs from "node:fs";
import { quarantineStateFile, readJsonChecked, statePath } from "./config.ts";
import type { PeerIdentity } from "./history.ts";

/**
 * 好友关系（第 3 片，决定 7/8/11）。
 *
 * `friend`（双向已确认）与 `quick`（一键快捷联系人）正交：quick 只放行 1:1 文字，
 * **没有权限含义**（D300：文件与通知都不看关系）。`favorite` 是本机收藏，
 * `outgoing`（我发出、还没被接受），「他请求我」是 `friend === false && incoming === true`。
 */
export interface Contact {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  /** 老关系记录没有这个字段：读的时候按 false 处理，写入时才补上。 */
  quick?: boolean;
  friend: boolean;
  favorite: boolean;
  incoming: boolean;
  outgoing: boolean;
  at: number;
}

interface Stored extends Omit<Contact, "nodeId"> {}

export class Relations {
  private map: Record<string, Stored> = {};
  /** 旧文件读不出来且没能留档时，拒绝落盘 —— 不能拿空表覆盖它。 */
  private blocked = false;

  constructor(private readonly log: (msg: string) => void) {
    this.load();
  }

  private file(): string {
    return statePath("peers.json");
  }

  private load(): void {
    const res = readJsonChecked<Record<string, Stored>>(this.file(), {});
    if (!res.ok) {
      const bak = quarantineStateFile(this.file());
      this.blocked = !bak;
      this.map = {};
      this.log(`好友关系读失败（${res.error ?? "?"}）${bak ? `，已备份到 ${bak}` : "，备份失败，暂停落盘"}`);
      return;
    }
    const raw = res.value;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      const bak = quarantineStateFile(this.file());
      this.blocked = !bak;
      this.map = {};
      this.log(`好友关系内容不是对象${bak ? `，已备份到 ${bak}` : "，备份失败，暂停落盘"}`);
      return;
    }
    this.map = raw;
  }

  private save(): void {
    if (this.blocked) return;
    try {
      fs.writeFileSync(this.file(), JSON.stringify(this.map, null, 2));
    } catch (err) {
      this.log(`好友关系落盘失败：${(err as Error).message}`);
    }
  }

  private touch(who: PeerIdentity, patch: Partial<Stored>): Contact {
    const prev = this.map[who.nodeId] ?? {
      nickname: who.nickname ?? who.nodeId.slice(0, 8),
      hostname: who.hostname ?? "",
      port: who.port ?? 0,
      quick: false,
      friend: false,
      favorite: false,
      incoming: false,
      outgoing: false,
      at: Date.now(),
    };
    this.map[who.nodeId] = { ...prev, ...patch, at: Date.now() };
    this.save();
    return { nodeId: who.nodeId, ...this.map[who.nodeId] };
  }

  list(): Contact[] {
    return Object.entries(this.map)
      .map(([nodeId, value]) => ({ nodeId, ...value }))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || Number(b.friend) - Number(a.friend) || a.nickname.localeCompare(b.nickname));
  }

  get(nodeId: string): Contact | null {
    const value = this.map[nodeId];
    return value ? { nodeId, ...value } : null;
  }

  isFriend(nodeId: string): boolean {
    return Boolean(this.map[nodeId]?.friend);
  }

  /** 一键快捷添加：本机立刻记为 quick，不产生待接受申请。 */
  quickAdd(who: PeerIdentity): Contact {
    return this.touch(who, { quick: true });
  }

  /** 我点「加好友」：先记 outgoing，等对方 accept。 */
  request(who: PeerIdentity): Contact {
    const prev = this.map[who.nodeId];
    if (prev?.friend) return { nodeId: who.nodeId, ...prev };
    return this.touch(who, { outgoing: true, nickname: who.nickname ?? prev?.nickname ?? who.nodeId.slice(0, 8) });
  }

  /** 收到请求：记 incoming，不动 friend —— 等我点「接受」。 */
  incomingRequest(who: PeerIdentity): Contact {
    const prev = this.map[who.nodeId];
    if (prev?.friend) return { nodeId: who.nodeId, ...prev };
    return this.touch(who, { incoming: true, nickname: who.nickname ?? prev?.nickname ?? who.nodeId.slice(0, 8) });
  }

  /** 收到 accept：双向确认。 */
  accepted(who: PeerIdentity): Contact {
    return this.touch(who, { friend: true, incoming: false, outgoing: false });
  }

  /** 我点「接受」：本地先变成好友，再由调用方把 accept 发回去。 */
  accept(who: PeerIdentity): Contact {
    return this.touch(who, { friend: true, incoming: false, outgoing: false });
  }

  /**
   * 改备注名（D303）：只改本机这份记录，**不告诉对方**，也不会被对方的 announce 覆盖
   * —— 对方改自己的名字时，只有在线表里的昵称会变，通讯录里这条备注照旧。
   */
  rename(who: PeerIdentity, nickname: string): Contact {
    return this.touch(who, { nickname });
  }

  /** 收藏只在用户点的时候变（决定 12），不会因为对方拒绝被自动降级。 */
  favorite(who: PeerIdentity, on: boolean): Contact {
    return this.touch(who, { favorite: on });
  }

  remove(nodeId: string): void {
    delete this.map[nodeId];
    this.save();
  }
}
