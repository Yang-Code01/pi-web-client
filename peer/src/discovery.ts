import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import os from "node:os";
import { PROTO, type PeerConfig } from "./config.ts";

/** announce 里带的东西：对端据此渲染在线列表、据此把 `from` 反查成身份（决定 7/10）。 */
export interface Announce {
  proto: number;
  t: "hello" | "hello-reply";
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  version: string;
}

export interface SeenPeer {
  nodeId: string;
  nickname: string;
  hostname: string;
  /** 最近一次 announce 的来源地址（不是对端自报的地址——自己报的能被伪造）。 */
  addr: string;
  port: number;
  lastSeen: number;
  /** 5 分钟内的来源地址集合（决定 7：换网卡 / DHCP 换 IP 不算伪造）。 */
  ips: string[];
}

/** 30 秒没 announce 就当离线（announce 间隔 10 秒，允许丢两包）。 */
const OFFLINE_MS = 30_000;
/** IP 集合留 5 分钟就删（决定 7）。 */
const IP_TTL_MS = 5 * 60_000;
const ANNOUNCE_MS = 10_000;

export class Discovery extends EventEmitter {
  private sock: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private readonly seen = new Map<string, SeenPeer>();
  private readonly ipSeenAt = new Map<string, number>();
  /** 收到同一条 hello 就回一次，回得太多会把局域网变成广播风暴。 */
  private readonly repliedAt = new Map<string, number>();

  constructor(
    private readonly cfg: PeerConfig,
    private readonly nodeId: string,
    private readonly log: (msg: string) => void,
  ) {
    super();
  }

  start(): void {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.sock = sock;
    sock.on("error", (err) => {
      this.log(`discovery socket: ${err.message}`);
      this.emit("error", err);
    });
    sock.on("message", (buf, rinfo) => this.onMessage(buf, rinfo.address, rinfo.port));
    sock.bind(this.cfg.group.port, () => {
      try {
        sock.addMembership(this.cfg.group.address);
      } catch (err) {
        // 没有组播的机器（部分 VPN / 容器）：手动地址仍然能救。
        this.log(`addMembership 失败（${(err as Error).message}）：只能走手动地址`);
      }
      this.announce();
      this.timer = setInterval(() => this.announce(), ANNOUNCE_MS);
      this.pruneTimer = setInterval(() => this.prune(), 5_000);
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = this.pruneTimer = null;
    try {
      this.sock?.close();
    } catch {
      /* 已经关了 */
    }
    this.sock = null;
  }

  /** 手动地址：组播不通时把 `ip:port` 直接单播一份 announce。 */
  private manualTargets(): Array<{ address: string; port: number }> {
    const out: Array<{ address: string; port: number }> = [];
    for (const raw of this.cfg.manual) {
      const m = /^([^:\s]+):(\d+)$/.exec(raw.trim());
      if (m) out.push({ address: m[1], port: Number(m[2]) });
    }
    return out;
  }

  announce(): void {
    // D99：隐身的人不发 announce —— 组播里那一包带 nodeId / nickname / hostname / port，
    // 发出去就等于自己报门牌。以前只拦了 sendHello，定时器每 10 秒照样组播一次。
    if (this.cfg.hidden) return;
    const payload = JSON.stringify(this.packet("hello"));
    const sock = this.sock;
    if (!sock) return;
    sock.send(payload, this.cfg.group.port, this.cfg.group.address, (err) => {
      if (err) this.log(`组播发送失败：${err.message}`);
    });
    for (const target of this.manualTargets()) {
      // 手动地址填的是对端的 HTTP 口（`ip:7865`），不是组播端口：UDP 单播到那里没人收，
      // 所以每轮都敲一次 `/peer/hello`。组播被交换机挡住时，这是唯一能把在线状态维持住的路
      // —— 只敲一次的话，对方 30 秒不上 announce 就从列表里掉出去了。
      void this.sendHello(target.address, target.port);
    }
  }

  private packet(t: Announce["t"]): Announce {
    return {
      proto: PROTO,
      t,
      nodeId: this.nodeId,
      nickname: this.cfg.nickname,
      hostname: os.hostname(),
      port: this.cfg.port,
      version: "0.1.0",
    };
  }

  private onMessage(buf: Buffer, addr: string, _port: number): void {
    let msg: Announce;
    try {
      msg = JSON.parse(buf.toString("utf8")) as Announce;
    } catch {
      return;
    }
    if (msg?.proto !== PROTO || !msg.nodeId || msg.nodeId === this.nodeId) return;
    if (this.cfg.hidden) {
      // 隐身：自己广播、也回别人，但不进别人的列表 —— 所以隐身时不回 hello，
      // 只被动记录（在线列表里仍然能看到别人）。
      this.remember(msg, addr);
      return;
    }
    this.remember(msg, addr);
    // 决定 7/10：见到「没见过的对端 / 换了 IP 的对端」当场回一份 hello，走 HTTP 而不是 UDP——
    // 组播被交换机挡住时，这是唯一能把对方立刻拉进列表的路（手动地址也用它）。
    // 10 秒内同一个 nodeId 只回一次，避免把局域网变成乒乓。
    const replied = this.repliedAt.get(msg.nodeId) ?? 0;
    if (msg.t === "hello" && Date.now() - replied > 10_000) {
      this.repliedAt.set(msg.nodeId, Date.now());
      void this.sendHello(addr, Number(msg.port) || this.cfg.port);
    }
    this.emit("change", this.online());
  }

  private remember(msg: Announce, addr: string): void {
    const known = this.seen.get(msg.nodeId);
    const ips = new Set(known?.ips ?? []);
    ips.add(addr);
    this.ipSeenAt.set(`${msg.nodeId}|${addr}`, Date.now());
    const peer: SeenPeer = {
      nodeId: msg.nodeId,
      nickname: msg.nickname || msg.hostname || msg.nodeId.slice(0, 8),
      hostname: msg.hostname || "",
      addr,
      port: Number(msg.port) || this.cfg.port,
      lastSeen: Date.now(),
      ips: [...ips],
    };
    this.seen.set(msg.nodeId, peer);
  }

  /**
   * 对端把 announce 单播到 http 端口（`/peer/hello`）时也走这里：组播被交换机挡住时，
   * 手动地址那条路就靠它把对端拉进在线表。
   */
  recordHello(msg: Pick<Announce, "nodeId" | "nickname" | "hostname" | "port">, addr: string): void {
    if (!msg.nodeId || msg.nodeId === this.nodeId) return;
    this.remember(
      {
        proto: PROTO,
        t: "hello",
        nodeId: msg.nodeId,
        nickname: String(msg.nickname ?? ""),
        hostname: String(msg.hostname ?? ""),
        port: Number(msg.port) || this.cfg.port,
        version: "0.1.0",
      },
      addr,
    );
    this.emit("change", this.online());
  }

  /** 单播一份 hello 到对方的 HTTP 口（`/peer/hello`）。失败就算了：下一轮 announce 还会来。 */
  async sendHello(addr: string, port: number): Promise<void> {
    if (this.cfg.hidden) return;
    try {
      const res = await fetch(`http://${addr}:${port}/peer/hello`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.packet("hello")),
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return;
      const body = (await res.json()) as Partial<Announce> & { hidden?: boolean };
      if (body?.hidden) return;
      if (typeof body.nodeId === "string" && body.nodeId !== this.nodeId) {
        this.recordHello(
          {
            nodeId: body.nodeId,
            nickname: String(body.nickname ?? ""),
            hostname: String(body.hostname ?? ""),
            port: Number(body.port) || port,
          },
          addr,
        );
      }
    } catch {
      /* 对方没起 / 端口不对 / 用户手动填错：都只是「这次没成」 */
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, at] of this.ipSeenAt) {
      if (now - at > IP_TTL_MS) this.ipSeenAt.delete(key);
    }
    for (const [id, peer] of this.seen) {
      const fresh = peer.ips.filter((ip) => now - (this.ipSeenAt.get(`${id}|${ip}`) ?? 0) <= IP_TTL_MS);
      if (!fresh.length) this.seen.delete(id);
      else peer.ips = fresh;
    }
    this.emit("change", this.online());
  }

  /** 在线 = 30 秒内说过话。离线的不留（要历史的去历史里翻）。 */
  online(): SeenPeer[] {
    const now = Date.now();
    return [...this.seen.values()]
      .filter((p) => now - p.lastSeen <= OFFLINE_MS)
      .sort((a, b) => a.nickname.localeCompare(b.nickname, "zh-Hans-CN"));
  }

  /** 决定 7/10：`from` 只能按 IP 反查，反查不到就当场单播确认，不直接拒收。 */
  byAddr(addr: string): SeenPeer | null {
    for (const peer of this.seen.values()) if (peer.ips.includes(addr)) return peer;
    return null;
  }

  byId(nodeId: string): SeenPeer | null {
    return this.seen.get(nodeId) ?? null;
  }

  /** 手动添加（`ip:port`）：记进配置后立刻单播问候一次，不用等 10 秒。 */
  addManual(addr: string): void {
    const value = addr.trim();
    if (!/^[^:\s]+:\d+$/.test(value)) throw new Error("地址要写成 ip:port");
    if (!this.cfg.manual.includes(value)) this.cfg.manual.push(value);
    // 隐身时只记地址、不发包：单播 hello 里同样带 nodeId / nickname / hostname / port，
    // 发出去就把自己报给了这个地址（sendHello 早就早退了，UDP 这一发以前漏在这里）。
    if (this.cfg.hidden) return;
    const [host, port] = value.split(":");
    this.sock?.send(JSON.stringify(this.packet("hello")), Number(port), host, () => {
      /* UDP 只是碰运气，真正的确认走下面的 HTTP */
    });
    void this.sendHello(host, Number(port));
  }
}
