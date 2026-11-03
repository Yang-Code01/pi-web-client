import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { statePath } from "./config.ts";
import type { PeerConfig } from "./config.ts";
import { PROTO, VERSION } from "./config.ts";
import type { Discovery } from "./discovery.ts";
import type { Entry, History, PeerIdentity } from "./history.ts";
import { uuidv7 } from "./messages.ts";
import type { Relations } from "./peers.ts";

/** 分块大小：1 MB。局域网里 TCP 已经帮我们做了分片，再切细只多几个 RTT。 */
export const CHUNK = 1024 * 1024;

/** 收件目录所在盘的下限（决定 20）：留 5 GB 与 10%，两个都要满。 */
const KEEP_BYTES = 5 * 1024 * 1024 * 1024;
const KEEP_RATIO = 0.1;

/** token 的有效期，每次收到分块就往后推（决定 24）。 */
const TOKEN_MS = 60_000;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain;charset=utf-8",
  ".md": "text/markdown;charset=utf-8",
  ".json": "application/json",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

export function mimeOf(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

export interface Transfer {
  id: string;
  peerId: string;
  direction: "out" | "in";
  name: string;
  size: number;
  bytes: number;
  status: "sending" | "receiving" | "done" | "failed";
  error?: string;
  at: number;
}

interface Waiting {
  token: string;
  messageId: string;
  peerId: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  part: string;
  received: number;
  at: number;
}

export interface FileResult {
  status: number;
  body: unknown;
}

/** 收到的文件：`<entryId>` → 磁盘上的位置。历史里只有一张卡片，文件本体留在收件目录。 */
type Stored = Record<string, { path: string; name: string; size: number; mime: string }>;

export class Files {
  private tokens = new Map<string, Waiting>();
  private transfers = new Map<string, Transfer>();
  private stored: Stored = {};

  constructor(
    private readonly ctx: {
      cfg: PeerConfig;
      nodeId: string;
      discovery: Discovery;
      history: History;
      relations: Relations;
      log: (msg: string) => void;
    },
  ) {
    for (const dir of [this.inbox(), statePath("out")]) fs.mkdirSync(dir, { recursive: true });
    this.loadStored();
    setInterval(() => this.prune(), 10_000).unref();
  }

  inbox(): string {
    return this.ctx.cfg.inbox;
  }

  private filesFile(): string {
    return statePath("files.json");
  }

  private loadStored(): void {
    try {
      this.stored = JSON.parse(fs.readFileSync(this.filesFile(), "utf8")) as Stored;
    } catch {
      this.stored = {};
    }
  }

  private saveStored(): void {
    try {
      fs.writeFileSync(this.filesFile(), JSON.stringify(this.stored));
    } catch (err) {
      this.ctx.log(`文件索引写不进去：${(err as Error).message}`);
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, waiting] of this.tokens) {
      if (now - waiting.at > TOKEN_MS) {
        this.tokens.delete(token);
        try {
          fs.rmSync(waiting.part, { force: true });
        } catch {
          /* 删不掉就留着 */
        }
      }
    }
  }

  /** 收件盘还剩多少；`statfs` 不可用时退回 Infinity，宁可收下也不要误拒。 */
  free(): number {
    try {
      const st = fs.statfsSync(this.inbox());
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      return Infinity;
    }
  }

  transfers_(): Transfer[] {
    return [...this.transfers.values()].sort((a, b) => b.at - a.at).slice(0, 20);
  }

  // ------------------------------------------------------------------ 收

  /** 对方要发文件：查好友、查盘、开 token，并告诉他我这边已经有多少字节（续传用）。 */
  begin(fromAddr: string, body: any, verify: (addr: string, who: PeerIdentity) => Promise<FileResult | null>): Promise<FileResult> {
    return (async () => {
      const from = body?.from as PeerIdentity | undefined;
      const messageId = String(body?.messageId ?? "");
      const name = String(body?.name ?? "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 180) || "文件";
      const size = Number(body?.size) || 0;
      if (!from?.nodeId || !messageId || size <= 0) return { status: 400, body: { error: "bad begin", retryable: false } };
      const check = await verify(fromAddr, from);
      if (check) return check;
      // 决定 9：文件只给好友。文字谁都能发，文件不行——写盘是不可撤销的。
      if (!this.ctx.relations.isFriend(from.nodeId)) {
        return { status: 403, body: { error: "先加好友才能收文件", retryable: false } };
      }
      if (this.ctx.cfg.pauseFiles) return { status: 503, body: { error: "我这边暂停收文件了", retryable: true } };
      const free = this.free();
      if (free < size + KEEP_BYTES || free < size / KEEP_RATIO) {
        return { status: 507, body: { error: `收件盘不够了（剩 ${Math.round(free / 1024 ** 3)} GB）`, retryable: true } };
      }

      // 同一个 messageId 重发：复用原来的 .part，把已收字节数告诉对方接着传。
      const existing = [...this.tokens.values()].find((t) => t.messageId === messageId);
      if (existing) {
        existing.at = Date.now();
        return { status: 200, body: { ok: true, token: existing.token, offset: existing.received } };
      }
      const token = randomUUID();
      const part = path.join(this.inbox(), `${token}.part`);
      fs.writeFileSync(part, "");
      this.tokens.set(token, {
        token,
        messageId,
        peerId: from.nodeId,
        name,
        size,
        mime: mimeOf(name),
        sha256: String(body?.sha256 ?? ""),
        part,
        received: 0,
        at: Date.now(),
      });
      this.transfers.set(messageId, {
        id: messageId,
        peerId: from.nodeId,
        direction: "in",
        name,
        size,
        bytes: 0,
        status: "receiving",
        at: Date.now(),
      });
      this.ctx.log(`开始收 ${name}（${Math.round(size / 1024)} KB）来自 ${from.nickname ?? from.nodeId.slice(0, 8)}`);
      return { status: 200, body: { ok: true, token, offset: 0 } };
    })();
  }

  /** 一个分块。`offset` 必须正好接上（按序写，不做稀疏文件）。 */
  chunk(token: string, offset: number, data: Buffer): FileResult {
    const waiting = this.tokens.get(token);
    if (!waiting) return { status: 410, body: { error: "token 过期了，重新 begin" } };
    if (offset !== waiting.received) {
      return { status: 409, body: { error: `错位：我这边到 ${waiting.received}`, offset: waiting.received, retryable: true } };
    }
    if (waiting.received + data.length > waiting.size) return { status: 400, body: { error: "超出声明的大小" } };
    const fd = fs.openSync(waiting.part, "r+");
    try {
      fs.writeSync(fd, data, 0, data.length, waiting.received);
    } finally {
      fs.closeSync(fd);
    }
    waiting.received += data.length;
    waiting.at = Date.now();
    const transfer = this.transfers.get(waiting.messageId);
    if (transfer) transfer.bytes = waiting.received;
    return { status: 200, body: { ok: true, received: waiting.received } };
  }

  /** 传完了：核对大小与哈希，改名落盘，往历史里写一张卡片。 */
  end(token: string): FileResult {
    const waiting = this.tokens.get(token);
    if (!waiting) return { status: 410, body: { error: "token 过期了" } };
    if (waiting.received !== waiting.size) {
      return { status: 400, body: { error: `还差 ${waiting.size - waiting.received} 字节`, offset: waiting.received, retryable: true } };
    }
    if (waiting.sha256) {
      const hash = createHash("sha256");
      hash.update(fs.readFileSync(waiting.part));
      const got = hash.digest("hex");
      if (got !== waiting.sha256) {
        this.tokens.delete(token);
        fs.rmSync(waiting.part, { force: true });
        this.fail(waiting.messageId, "内容对不上（哈希不一致），已丢弃");
        return { status: 400, body: { error: "哈希不一致，已丢弃", retryable: false } };
      }
    }
    const final = this.uniquePath(waiting.name);
    fs.renameSync(waiting.part, final);
    this.tokens.delete(token);
    this.stored[waiting.messageId] = { path: final, name: path.basename(final), size: waiting.size, mime: waiting.mime };
    this.saveStored();
    this.ctx.history.append(waiting.peerId, {
      id: waiting.messageId,
      at: Date.now(),
      from: { nodeId: waiting.peerId },
      to: { kind: "node", id: this.ctx.nodeId },
      kind: "file",
      file: { name: path.basename(final), size: waiting.size, mime: waiting.mime, sha256: waiting.sha256 || undefined },
    });
    const transfer = this.transfers.get(waiting.messageId);
    if (transfer) {
      transfer.status = "done";
      transfer.bytes = waiting.size;
      transfer.name = path.basename(final);
    }
    this.ctx.log(`收到 ${path.basename(final)}（${Math.round(waiting.size / 1024)} KB）`);
    return { status: 200, body: { ok: true, name: path.basename(final), id: waiting.messageId } };
  }

  /** 同名文件不覆盖：`报告.pdf` → `报告 (2).pdf`。 */
  private uniquePath(name: string): string {
    const dir = this.inbox();
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let candidate = path.join(dir, name);
    for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
    return candidate;
  }

  private fail(id: string, error: string): void {
    const transfer = this.transfers.get(id);
    if (transfer) {
      transfer.status = "failed";
      transfer.error = error;
    }
  }

  /** 收件目录里的文件给页面看（图片气泡、下载都用它）。只认索引里的 id，不接受任意路径。 */
  storedPath(id: string): Stored[string] | null {
    return this.stored[id] ?? null;
  }

  // ------------------------------------------------------------------ 发

  /**
   * 发一个文件：先算 sha256（大文件也只读一遍），再 begin → 逐块 POST → end。
   * 出错不抛给调用方：写进 transfers，让页面能显示「失败了 / 在传」。
   */
  async send(peerId: string, localPath: string, name: string): Promise<{ ok: true; id: string }> {
    const stat = fs.statSync(localPath);
    const id = uuidv7();
    this.transfers.set(id, {
      id,
      peerId,
      direction: "out",
      name,
      size: stat.size,
      bytes: 0,
      status: "sending",
      at: Date.now(),
    });
    void this.run(peerId, localPath, name, id, stat.size).catch((err: Error) => {
      this.fail(id, err.message);
      this.ctx.log(`发 ${name} 失败：${err.message}`);
    });
    return { ok: true, id };
  }

  private async run(peerId: string, localPath: string, name: string, id: string, size: number): Promise<void> {
    const peer = this.ctx.discovery.byId(peerId);
    if (!peer) throw new Error("这个人已经不在线了");
    const sha256 = await this.sha256(localPath);
    const me = { nodeId: this.ctx.nodeId, nickname: this.ctx.cfg.nickname, hostname: process.env.COMPUTERNAME ?? "", port: this.ctx.cfg.port };
    const base = `http://${peer.addr}:${peer.port}`;
    const beginRes = await fetch(`${base}/peer/file/begin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proto: PROTO, messageId: id, name, size, sha256, from: me }),
      signal: AbortSignal.timeout(8000),
    });
    const begin = (await beginRes.json().catch(() => ({}))) as { token?: string; offset?: number; error?: string };
    if (!beginRes.ok || !begin.token) throw new Error(begin.error ?? `对方拒收（HTTP ${beginRes.status}）`);

    const fd = fs.openSync(localPath, "r");
    try {
      let offset = Math.min(Number(begin.offset) || 0, size);
      const buf = Buffer.alloc(CHUNK);
      while (offset < size) {
        const read = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - offset), offset);
        if (read <= 0) throw new Error("读文件读到 0 字节");
        const res = await fetch(`${base}/peer/file/chunk?token=${encodeURIComponent(begin.token)}&offset=${offset}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: buf.subarray(0, read),
          signal: AbortSignal.timeout(30_000),
        });
        const reply = (await res.json().catch(() => ({}))) as { received?: number; offset?: number; error?: string };
        if (!res.ok) throw new Error(reply.error ?? `分块被拒（HTTP ${res.status}）`);
        offset = Number(reply.received) || offset + read;
        const transfer = this.transfers.get(id);
        if (transfer) transfer.bytes = offset;
      }
    } finally {
      fs.closeSync(fd);
    }

    const endRes = await fetch(`${base}/peer/file/end?token=${encodeURIComponent(begin.token)}`, { method: "POST", signal: AbortSignal.timeout(8000) });
    const end = (await endRes.json().catch(() => ({}))) as { name?: string; error?: string };
    if (!endRes.ok) throw new Error(end.error ?? `收尾失败（HTTP ${endRes.status}）`);

    // 自己这边也留一张卡片：发出去的东西在对话里要看得见。
    this.ctx.history.append(peerId, {
      id,
      at: Date.now(),
      from: { nodeId: this.ctx.nodeId, nickname: this.ctx.cfg.nickname, port: this.ctx.cfg.port },
      to: { kind: "node", id: peerId },
      kind: "file",
      file: { name: end.name ?? name, size, mime: mimeOf(name), sha256 },
    });
    const transfer = this.transfers.get(id);
    if (transfer) {
      transfer.status = "done";
      transfer.bytes = size;
    }
    this.ctx.log(`发出 ${name}（${Math.round(size / 1024)} KB）`);
  }

  private sha256(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      pipeline(fs.createReadStream(file), hash).then(() => resolve(hash.digest("hex")), reject);
    });
  }

  version(): string {
    return VERSION;
  }
}

export type { Entry };
