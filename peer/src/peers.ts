import fs from "node:fs";
import { statePath } from "./config.ts";
import type { PeerIdentity } from "./history.ts";

/**
 * 好友关系（第 3 片，决定 7/8/11）。
 *
 * 状态只有三个字段：`friend`（双向已确认）、`favorite`（收藏，一定是好友）、
 * `outgoing`（我发出、还没被接受）。「他请求我」是 `friend === false && incoming === true`。
 */
export interface Contact {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  friend: boolean;
  favorite: boolean;
  incoming: boolean;
  outgoing: boolean;
  at: number;
}

interface Stored extends Omit<Contact, "nodeId"> {}

export class Relations {
  private map: Record<string, Stored> = {};

  constructor(private readonly log: (msg: string) => void) {
    this.load();
  }

  private file(): string {
    return statePath("peers.json");
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as Record<string, Stored>;
      this.map = raw && typeof raw === "object" ? raw : {};
    } catch {
      this.map = {};
    }
  }

  private save(): void {
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

  /** 收藏只在用户点的时候变（决定 12），不会因为对方拒绝被自动降级。 */
  favorite(who: PeerIdentity, on: boolean): Contact {
    return this.touch(who, { favorite: on });
  }

  remove(nodeId: string): void {
    delete this.map[nodeId];
    this.save();
  }
}
