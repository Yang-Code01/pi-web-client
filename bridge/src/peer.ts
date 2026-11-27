import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PeerView {
  nodeId: string;
  nickname: string;
  hostname: string;
  addr: string;
  port: number;
  lastSeen: number;
  ips: string[];
  /** 对端自报的头像 id（见 peer/src/avatars.ts），没报就是空。 */
  avatar?: string;
}

export interface PeerStatus {
  ok: boolean;
  proto: number;
  version: string;
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  status?: string;
  /** 我自己的头像 id。 */
  avatar?: string;
  idleMs?: number;
  online: PeerView[];
  config: { hidden: boolean; pauseFiles: boolean; dnd: boolean; inbox: string; manual: string[] };
}

/** `/threads` 里一条会话（只声明 bridge 用得着的字段，其余原样透传给页面）。 */
export interface PeerThread {
  nodeId: string;
  nickname: string;
  muted?: boolean;
  /** 未读里有「紧急」/ 有人 @ 我：免打扰也要提醒。 */
  urgent?: boolean;
  mention?: boolean;
  pinned?: boolean;
  unread?: number;
  last: { id: string; at: number; kind: string; text?: string; from: { nodeId: string; nickname?: string }; file?: { name: string } } | null;
}

/** 子进程跑满这么久再退出，重启计数清零。 */
const STABLE_MS = 60_000;
/**
 * 端口被占（退出码 2）之后隔多久探一次。另一份 peer 在跑时不该反复抢端口，但也不能永远放弃：
 * 占用者走了就自己重新 fork。30 秒一次，日志里不会刷屏。
 */
const PORT_PROBE_MS = Number(process.env.PI_PEER_PORT_PROBE_MS ?? 30_000) || 30_000;

/**
 * peer 的 HTTP 错误：带上游状态码，桥原样回给页面。
 * 上传头像那层最在意 413（太大）和 400（不是图）的区别，不能都压成 400。
 */
export class PeerRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PeerRequestError";
    this.status = status;
  }
}

/**
 * peer 子进程的托管：fork + 退避重启 + 5 秒轮询 `/status`。
 *
 * 为什么是 fork 而不是把 peer 编进 bridge：peer 要绑 7865、要被局域网访问，而 bridge 默认只
 * 绑回环；两者生命周期也不同（peer 崩了 bridge 必须活着，好把「peer 没起来」显示出来）。
 */
export class PeerHost {
  private child: ChildProcess | null = null;
  private restarts = 0;
  /** 这一份子进程什么时候起的：稳定跑过 `STABLE_MS` 再退出，就不算「连续」退出。 */
  private spawnedAt = 0;
  private stopped = false;
  private status: PeerStatus | null = null;
  private reason = "";
  private timer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  /** 端口被占之后的下一次探测。有它就不重复排。 */
  private probeTimer: NodeJS.Timeout | null = null;
  /** 已经通知过（或看过）的消息 id，只留最近 500 条：重启后从「当前这一批」重新记账。 */
  private seen = new Set<string>();
  /** 首次轮询只记账不推送：否则装上 D299 之后第一次打开会把全部历史推一遍。 */
  private threadPollPrimed = false;
  private onNewMessage: ((thread: PeerThread) => void) | null = null;

  private readonly opts: { port: number; entry: string | null; log: (msg: string) => void };

  constructor(opts: { port: number; entry: string | null; log: (msg: string) => void }) {
    this.opts = opts;
    if (!opts.entry) this.reason = "peer 还没构建：在仓库根目录跑 npm run build:peer";
  }

  start(): void {
    if (!this.opts.entry) return;
    this.spawn();
    this.timer = setInterval(() => void this.poll(), 5000);
  }

  /** 新消息回调（D299 / P4）：`bridge/src/index.ts` 接上 Notifier 就能推 Web Push。 */
  onNew(fn: (thread: PeerThread) => void): void {
    this.onNewMessage = fn;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.child?.kill();
    this.child = null;
  }

  /**
   * 页面上的「重试」：子进程已经退出时重新 fork 一次。
   *
   * 不抢正在服务的那一份：`/status` 有人答（可能是另一份 peer）就只回状态；子进程还在起的路上也不
   * 重复 fork。端口被占时用户可以立刻点这一下，不用等 30 秒的自动探测。
   */
  restart(): { ok: boolean; running: boolean; reason: string } {
    if (this.status) return { ok: true, running: true, reason: "" };
    if (this.child) return { ok: true, running: false, reason: "peer 正在启动" };
    if (this.stopped || !this.opts.entry) return { ok: false, running: false, reason: this.reason };
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    this.restarts = 0;
    this.spawn();
    return { ok: true, running: false, reason: this.reason || "peer 正在启动" };
  }

  private spawn(): void {
    const entry = this.opts.entry;
    if (!entry) return;
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    // 进了这个函数就是「没有可用的子进程」：旧的失败原因（退出 / 端口被占）不该继续挂在页面上。
    this.reason = "";
    const child = fork(entry, [], {
      env: { ...process.env, PI_PEER_PORT: String(this.opts.port) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      // fork 的 windowsHide 默认 false：bridge 自己没有控制台时（服务 / 计划任务 / detached 启动器），
      // Windows 会给 peer 新分配一个全黑的空控制台窗口。peer 的输出走 pipe，不需要那个窗口。
      windowsHide: true,
    });
    this.child = child;
    this.spawnedAt = Date.now();
    const relay = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) if (line.trim()) this.opts.log(`[peer] ${line.trim()}`);
    };
    child.stdout?.on("data", relay);
    child.stderr?.on("data", relay);
    child.on("exit", (code, signal) => {
      this.child = null;
      this.status = null;
      if (this.stopped) return;
      // 退出码 2 = peer 自己说的「端口被占」。这时候重启只会反复失败，所以先只报不试；
      // 但占用者可能是另一份 bridge / 探针，它迟早会走，所以每 PORT_PROBE_MS 探一次端口，
      // 一空出来就自己重新 fork（见 schedulePortProbe）。
      if (code === 2) {
        this.reason = `peer 端口 ${this.opts.port} 被占用：另一份 peer 在跑（或者别的程序占了）`;
        this.schedulePortProbe();
        return;
      }
      // 「连续退出」要真的连续：以前计数从不清零，隔几天崩一次、累计第 4 次就再也不重启，
      // 内网通一直挂到 bridge 重启。跑稳了一分钟再退出，就从头算。
      if (Date.now() - this.spawnedAt > STABLE_MS) this.restarts = 0;
      this.restarts += 1;
      if (this.restarts > 3) {
        this.reason = `peer 连续退出 ${this.restarts} 次（最后一次 ${signal ?? code}），不再重启`;
        return;
      }
      this.reason = `peer 退出了（${signal ?? code}），${2 ** (this.restarts - 1)} 秒后重启`;
      this.restartTimer = setTimeout(() => this.spawn(), 1000 * 2 ** (this.restarts - 1));
    });
  }

  private async poll(): Promise<void> {
    const next = await this.fetchStatus();
    if (next) this.reason = "";
    this.status = next;
    void this.pollThreads();
  }

  /** 退出码 2 之后排一次端口探测；已经在排就不重复排。 */
  private schedulePortProbe(): void {
    if (this.probeTimer || this.stopped) return;
    this.probeTimer = setTimeout(() => this.probePort(), PORT_PROBE_MS);
    this.probeTimer.unref?.();
  }

  /**
   * 端口还热着吗？连得上（哪怕不答 HTTP）就算有人占着，继续等；只有 ECONNREFUSED 才说明
   * 监听者走了，这时候重新 fork。别的错误（EACCES、超时之外的异常）按「仍被占」处理，宁可多等一轮。
   */
  private probePort(): void {
    this.probeTimer = null;
    if (this.stopped || this.child || this.status) return;
    const sock = net.connect({ host: "127.0.0.1", port: this.opts.port });
    let settled = false;
    const settle = (busy: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      if (busy) this.schedulePortProbe();
      else this.restart();
    };
    sock.setTimeout(1000, () => settle(true));
    sock.once("connect", () => settle(true));
    sock.once("error", (err: NodeJS.ErrnoException) => settle(err.code !== "ECONNREFUSED"));
  }

  /**
   * 轮询会话列表，只为「推到桌面」这一件事（P4）。
   *
   * 判据都在这里：自己发的不推、静音会话不推、免打扰不推、已经记过账的不推。
   */
  private async pollThreads(): Promise<void> {
    if (!this.status) return;
    let data: { threads?: PeerThread[] };
    try {
      data = await this.threads();
    } catch {
      return;
    }
    const me = this.status.nodeId;
    const dnd = this.status.config?.dnd === true;
    for (const thread of data.threads ?? []) {
      const last = thread.last;
      if (!last) continue;
      if (this.seen.has(last.id)) continue;
      this.seen.add(last.id);
      if (this.seen.size > 500) {
        const drop = [...this.seen].slice(0, this.seen.size - 500);
        for (const id of drop) this.seen.delete(id);
      }
      if (!this.threadPollPrimed) continue;
      if (last.from.nodeId === me) continue;
      if (thread.muted && !thread.urgent && !thread.mention) continue;
      if (dnd) continue;
      this.onNewMessage?.(thread);
    }
    this.threadPollPrimed = true;
  }

  private fetchStatus(): Promise<PeerStatus | null> {
    return new Promise((resolve) => {
      const req = http.get(
        { host: "127.0.0.1", port: this.opts.port, path: "/status", timeout: 1500 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as PeerStatus);
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
    });
  }

  /** 页面要的一句话：能不能用、为什么不能用、在线几台。 */
  view(): { enabled: boolean; running: boolean; reason: string; status: PeerStatus | null } {
    return {
      enabled: Boolean(this.opts.entry),
      running: this.status !== null,
      reason: this.status ? "" : this.reason || "peer 正在启动",
      status: this.status,
    };
  }

  private async request(method: "GET" | "POST", pathname: string, body?: unknown, opts: { repoll?: boolean } = {}): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${this.opts.port}${pathname}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(4000),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
    if (!res.ok) throw new Error(parsed?.error ?? `peer 回 ${res.status}`);
    if (method === "POST" && opts.repoll !== false) await this.poll();
    return parsed;
  }

  private call(pathname: string, body?: unknown): Promise<any> {
    return this.request("POST", pathname, body);
  }

  threads(): Promise<{ threads: PeerThread[] }> {
    return this.request("GET", "/threads");
  }

  /** 隐身 / 免打扰 / 暂停收文件 / 名字 / 头像：改 peer 的 cfg 并落盘到 `~/.pi-peer/config.json`。 */
  setConfig(patch: { hidden?: boolean; dnd?: boolean; pauseFiles?: boolean; nickname?: string; avatar?: string }): Promise<{
    ok: boolean;
    nickname?: string;
    avatar?: string;
    config: { hidden: boolean; dnd: boolean; pauseFiles: boolean; inbox: string; manual: string[] };
  }> {
    return this.request("POST", "/config", patch);
  }

  /** 换自定义头像：页面已经把图裁成 192×192、转成 WebP，这里只负责把原始字节递给 peer。 */
  async uploadAvatar(raw: Buffer, signal?: AbortSignal): Promise<{ ok: boolean; avatar: string }> {
    const res = await fetch(`http://127.0.0.1:${this.opts.port}/avatar`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: raw,
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    const parsed = (await res.json().catch(() => ({}))) as { avatar?: string; error?: string };
    if (!res.ok) throw new PeerRequestError(parsed.error ?? `peer 回 ${res.status}`, res.status);
    // 不等这一轮 poll：peer 的 announce 是异步的，立刻 poll 也拿不到新状态，只会把上传 RT 拉长。
    // 先把返回值写进缓存（页面紧接着 GET /api/peer 要看到新头像），其余状态让后台 poll 慢慢刷。
    if (parsed.avatar && this.status) this.status.avatar = parsed.avatar;
    void this.poll();
    return { ok: true, avatar: parsed.avatar ?? "" };
  }

  /**
   * 某人的自定义头像字节。自己 → peer 读本地文件；对端 → peer 按 hash 去拉（带缓存）。
   * 返回原始响应，由桥转给浏览器；`<img>` 每次渲染都会要一次，不重新 poll。
   */
  avatarStream(nodeId: string, hash: string, signal?: AbortSignal): Promise<Response> {
    const query = hash ? `?h=${encodeURIComponent(hash)}` : "";
    return fetch(`http://127.0.0.1:${this.opts.port}/avatar/${encodeURIComponent(nodeId)}${query}`, {
      signal: signal ?? AbortSignal.timeout(10_000),
    });
  }

  /** 自己上传过的头像（设置页「上传过的」一排）。只含上传记录，不含对端缓存。 */
  customAvatars(): Promise<{ ok: boolean; uploads: unknown[]; current: string }> {
    return this.request("GET", "/custom-avatars");
  }

  /** 删掉一张上传过的头像；删的要是当前这张，peer 会自动换到下一张。 */
  deleteAvatar(hash: string): Promise<{ ok: boolean; avatar: string; removed: string }> {
    return this.request("POST", "/custom-avatars/delete", { hash });
  }

  /** 忽略名单是通讯录自己的读口；页面拿它挡住「在线表兜底」把人加回来。 */
  ignored(): Promise<{ ok: boolean; nodeIds: string[] }> {
    return this.request("GET", "/ignored");
  }

  /** 设置页整体清空忽略名单：只动那份独立名单，不改关系记录。 */
  clearIgnored(): Promise<{ ok: boolean; cleared: number }> {
    return this.request("POST", "/ignored/clear");
  }

  history(peer: string, limit = 200): Promise<{ entries: unknown[] }> {
    return this.request("GET", `/messages?peer=${encodeURIComponent(peer)}&limit=${limit}`);
  }

  /** 记录包（#507）：正文 + 截图清单一帧；截图本体随后逐张 sendFile。 */
  sendNote(peer: string, note: unknown): Promise<{ ok: boolean; id: string; at: number; seq: number }> {
    return this.request("POST", "/note", { peer, note });
  }

  sendText(
    peer: string,
    text: string,
    via?: "pi",
    replyTo?: { id: string; from: string; excerpt: string },
    extra: { priority?: string; topic?: string } = {},
  ): Promise<{ ok: boolean; id: string; at: number; seq: number }> {
    const body: Record<string, unknown> = { peer, text };
    if (extra.priority) body.priority = extra.priority;
    if (extra.topic) body.topic = extra.topic;
    if (via) body.via = via;
    if (replyTo) body.replyTo = replyTo;
    return this.request("POST", "/send", body);
  }

  /** P2：重发同一条消息（同一个 id），不造新消息。 */
  retrySend(peer: string, id: string): Promise<{ ok: boolean }> {
    return this.request("POST", "/send/retry", { peer, id });
  }

  /** P3：撤回（2 分钟窗口在 peer 侧判，bridge 只转发）。 */
  recall(peer: string, id: string): Promise<{ ok: boolean; at: number }> {
    return this.request("POST", "/recall", { peer, id });
  }

  /** 表情回应：`on:false` 取消。 */
  react(peer: string, id: string, emoji: string, on: boolean): Promise<{ ok: boolean; at: number }> {
    return this.request("POST", "/react", { peer, id, emoji, on });
  }

  /** 固定消息（会话顶部的置顶条）：`on:false` 取消固定；双方 / 群成员都会看到。 */
  pin(peer: string, id: string, on: boolean): Promise<{ ok: boolean; at: number }> {
    return this.request("POST", "/pin", { peer, id, on });
  }

  /** 群聊：列表。 */
  groups(): Promise<{ ok: boolean; groups: unknown[] }> {
    return this.request("GET", "/groups");
  }

  /** 群聊：create / rename / invite / leave（D-群聊，见 peer/src/groups.ts）。 */
  group(body: Record<string, unknown>): Promise<{ ok: boolean; group?: unknown }> {
    return this.request("POST", "/groups", body);
  }

  /** P3：输入中。刻意不 await 结果也不报错：心跳丢了就丢了。 */
  typing(peer: string): Promise<{ ok: boolean }> {
    return this.request("POST", "/typing", { peer }, { repoll: false });
  }

  /** P1：已读水位 / 置顶 / 静音 / 草稿。 */
  markRead(peer: string, at: number, id: string): Promise<{ ok: boolean }> {
    return this.request("POST", "/threads/read", { peer, at, id });
  }

  patchThread(peer: string, patch: { pinned?: boolean; muted?: boolean; draft?: string; unread?: boolean }): Promise<{ ok: boolean }> {
    return this.request("POST", "/threads/patch", { peer, ...patch });
  }

  /** P4：页面还开着 = 有人在（away 由 peer 按最后一次 touch 推算）。 */
  presence(): Promise<{ ok: boolean; status: string }> {
    return this.request("POST", "/presence", {}, { repoll: false });
  }

  contacts(): Promise<{ contacts: unknown[] }> {
    return this.request("GET", "/contacts");
  }

  friend(peer: string, action: "request" | "quick" | "accept" | "favorite" | "remove" | "rename", on?: boolean, name?: string): Promise<unknown> {
    return this.request("POST", "/friend", { peer, action, on, name });
  }

  /** 发文件：只把**路径**交给 peer，字节由 peer 自己读盘（同机，省一次全量中转）。 */
  sendFile(peer: string, file: string, name?: string): Promise<{ ok: boolean; id: string }> {
    return this.request("POST", "/files/send", { peer, path: file, name });
  }

  /** 剪贴板里的图没有路径，只能把字节递过去。 */
  async upload(peer: string, name: string, data: Buffer): Promise<{ ok: boolean; id: string }> {
    const res = await fetch(`http://127.0.0.1:${this.opts.port}/files/upload?peer=${encodeURIComponent(peer)}&name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: data,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(parsed?.error ?? `HTTP ${res.status}`);
    return parsed;
  }

  /** 「我的表情」：本机收藏的小图（存在 peer 的 state 目录里）。 */
  stickers(): Promise<{ stickers: unknown[] }> {
    return this.request("GET", "/stickers");
  }

  async addSticker(name: string, data: Buffer): Promise<{ ok: boolean; sticker: unknown }> {
    const res = await fetch(`http://127.0.0.1:${this.opts.port}/stickers/add?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: data,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(parsed?.error ?? `HTTP ${res.status}`);
    return parsed;
  }

  removeSticker(id: string): Promise<{ ok: boolean }> {
    return this.request("POST", "/stickers/remove", { id }, { repoll: false });
  }

  sendSticker(peer: string, id: string): Promise<{ ok: boolean; id: string }> {
    return this.request("POST", "/stickers/send", { peer, id });
  }

  stickerStream(id: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.opts.port}/stickers/raw?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
  }

  transfers(): Promise<{ transfers: unknown[]; free: number }> {
    return this.request("GET", "/transfers");
  }

  browse(dir: string): Promise<any> {
    return this.request("GET", `/fs?path=${encodeURIComponent(dir)}`);
  }

  /**
   * 收件目录里的文件；返回原始响应，由调用方 pipe 给浏览器（图片是几 MB，不能转 JSON）。
   *
   * 30 秒只卡「拿到响应头」。以前把 `AbortSignal.timeout(30_000)` 直接交给 fetch，它按整段
   * 响应计时：几百 MB 的文件下到一半就被掐断，用户拿到截断的文件。头到了之后由调用方
   * 在浏览器断开时 abort。
   */
  async fileStream(id: string, signal?: AbortSignal): Promise<Response> {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    const timer = setTimeout(abort, 30_000);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      return await fetch(`http://127.0.0.1:${this.opts.port}/files?id=${encodeURIComponent(id)}`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** D209：入站文件在收件目录里的绝对路径（只问本机 peer 守护进程，拿不到就 null）。 */
  async filePath(id: string): Promise<string | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.opts.port}/files/meta?id=${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { path?: unknown };
      return typeof body.path === "string" && body.path ? body.path : null;
    } catch {
      return null;
    }
  }

  addManual(addr: string): Promise<any> {
    return this.call("/peer/add", { addr });
  }

  refresh(): Promise<any> {
    return this.call("/peer/refresh");
  }

  /** 局域网市场：本机 peer 的公告 / 墓碑 / 可得性清单（GET 对 LAN 开放）。 */
  marketManifestLocal(): Promise<any> {
    return this.request("GET", "/market/manifest");
  }

  /** 打开市场 tab 时逐个在线节点拉一次；404 = 旧节点，不支持市场但仍算在线。 */
  async marketManifestRemote(addr: string, port: number): Promise<any> {
    const res = await fetch(`http://${peerHost(addr)}:${port}/market/manifest`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let message = `peer 回 ${res.status}`;
      try { message = (JSON.parse(body) as { error?: string }).error || message; } catch { /* plain text */ }
      throw new Error(message);
    }
    return await res.json();
  }

  /** 只按 sha256 取字节；下载方自己按清单的 sha256 + size 强校验。 */
  async marketBlobRemote(addr: string, port: number, sha256: string): Promise<Buffer> {
    const res = await fetch(`http://${peerHost(addr)}:${port}/market/blob?sha256=${encodeURIComponent(sha256)}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`peer 回 ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** POST /market/publish 只对本机回环开放，bridge 把自描述帧原样交给 peer。 */
  async marketPublishLocal(frame: Buffer): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${this.opts.port}/market/publish`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: frame,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let message = `peer 回 ${res.status}`;
      try { message = (JSON.parse(body) as { error?: string }).error || message; } catch { /* plain text */ }
      throw new Error(message);
    }
    return await res.json();
  }
}

/** IPv6 字面量要套方括号才能拼进 URL；IPv4 / 主机名原样。 */
function peerHost(addr: string): string {
  return addr.includes(":") && !addr.startsWith("[") ? `[${addr}]` : addr;
}

/** `peer/dist/index.js`，从 bridge 的 dist 与 src 都指得对。 */
export function peerEntry(): string | null {
  const found: string[] = [];
  try {
    found.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "peer", "dist", "index.js"));
  } catch {
    /* exotic loader */
  }
  found.push(path.resolve(process.cwd(), "peer", "dist", "index.js"));
  return found.find((p) => fs.existsSync(p)) ?? null;
}
