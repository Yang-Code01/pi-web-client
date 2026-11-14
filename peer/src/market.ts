import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateDir } from "./config.ts";

/**
 * 局域网市场的「每个节点」视角（pi-lan-market/1）。
 * - published / tombstones：见过的公告与墓碑快照，GET /market/manifest 时原样转发（D248 R7）。
 * - blobs：本机磁盘上真实持有的包字节，GET /market/blob 只按 sha256 命中（D248 R4/R5）。
 * peer 不解析 zip，也不决定谁赢；合并排序全在 bridge 做。
 */
export const MARKET_SCHEMA = "pi-lan-market/1";
export const MARKET_PROTO = 1;
/** POST /market/publish 整个帧的上限，和 /files/upload 对齐：64 MB。 */
export const MAX_MARKET_FRAME = 64 * 1024 * 1024;
/** 镜像字节缓存软上限，超过就淘汰最久没用的镜像。 */
export const MARKET_CACHE_SOFT_LIMIT = 2 * 1024 * 1024 * 1024;
/** GET /market/manifest 响应体积上限，超了按 at 丢最旧的公告并置 truncated。 */
const MAX_MANIFEST_BYTES = 1024 * 1024;

export type MarketDelivery = "archive" | "source-ref" | "config-fragment";
export type MarketType = "skill" | "extension" | "mcp";

export interface MarketRecord {
  schema: string;
  action: "publish";
  publisher: string;
  id: string;
  type: MarketType;
  name: string;
  description: string;
  version: number;
  category: string;
  nickname: string;
  hostname: string;
  at: number;
  delivery: MarketDelivery;
  size: number;
  sha256: string;
  dependencies: string;
  notes: string;
  extensionKind?: string;
  source?: string;
  requiresNetwork?: boolean;
  config?: Record<string, unknown>;
  requiredVars?: string[];
}

export interface MarketTombstone {
  schema: string;
  action: "delete";
  publisher: string;
  id: string;
  version: number;
  at: number;
}

/** 落盘的 blob 记录；前 5 个字段会对外暴露，后 3 个只用于淘汰，不出现在 manifest 里。 */
export interface BlobEntry {
  publisher: string;
  id: string;
  version: number;
  sha256: string;
  size: number;
  original: boolean;
  installedAt: number | null;
  lastUsedAt: number;
}

interface MarketIndex {
  published: MarketRecord[];
  tombstones: MarketTombstone[];
  blobs: BlobEntry[];
}

export interface ManifestResponse {
  schema: string;
  proto: number;
  nodeId: string;
  nickname: string;
  hostname: string;
  generatedAt: number;
  published: MarketRecord[];
  tombstones: MarketTombstone[];
  /** 对外只暴露可得性，不含淘汰用的私有字段。 */
  blobs: Pick<BlobEntry, "publisher" | "id" | "version" | "sha256" | "size">[];
  truncated?: boolean;
}

function marketDir(): string {
  return path.join(stateDir(), "market");
}
function blobsDir(): string {
  return path.join(marketDir(), "blobs");
}
function indexPath(): string {
  return path.join(marketDir(), "index.json");
}
export function blobPath(sha256: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  return path.join(blobsDir(), sha256);
}

function ensureDirs(): void {
  fs.mkdirSync(blobsDir(), { recursive: true });
}

function readIndex(): MarketIndex {
  const fallback: MarketIndex = { published: [], tombstones: [], blobs: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(), "utf8")) as Partial<MarketIndex>;
    return {
      published: Array.isArray(raw.published) ? raw.published : [],
      tombstones: Array.isArray(raw.tombstones) ? raw.tombstones : [],
      blobs: Array.isArray(raw.blobs) ? raw.blobs : [],
    };
  } catch {
    return fallback;
  }
}

function writeIndex(index: MarketIndex): void {
  ensureDirs();
  const tmp = indexPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, indexPath());
}

const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 把任意 manifest 规整成一条 publish 公告（补齐默认字段，防止镜像转发时缺列）。 */
export function normalizeRecord(raw: any): MarketRecord {
  return {
    schema: MARKET_SCHEMA,
    action: "publish",
    publisher: str(raw.publisher, 200),
    id: str(raw.id, 200),
    type: (["skill", "extension", "mcp"].includes(raw.type) ? raw.type : "skill") as MarketType,
    name: str(raw.name, 300),
    description: str(raw.description, 4000),
    version: num(raw.version) || 1,
    category: str(raw.category, 500),
    nickname: str(raw.nickname, 200),
    hostname: str(raw.hostname, 200),
    at: num(raw.at) || Date.now(),
    delivery: (["archive", "source-ref", "config-fragment"].includes(raw.delivery) ? raw.delivery : "archive") as MarketDelivery,
    size: num(raw.size),
    sha256: str(raw.sha256, 64).toLowerCase(),
    dependencies: str(raw.dependencies, 8000),
    notes: str(raw.notes, 8000),
    extensionKind: raw.extensionKind ? str(raw.extensionKind, 100) : undefined,
    source: raw.source ? str(raw.source, 1000) : undefined,
    requiresNetwork: raw.requiresNetwork ? true : undefined,
    config: raw.config && typeof raw.config === "object" ? (raw.config as Record<string, unknown>) : undefined,
    requiredVars: Array.isArray(raw.requiredVars) ? (raw.requiredVars as unknown[]).filter((s: unknown): s is string => typeof s === "string").slice(0, 64) : undefined,
  };
}

function normalizeTombstone(raw: any): MarketTombstone {
  return {
    schema: MARKET_SCHEMA,
    action: "delete",
    publisher: str(raw.publisher, 200),
    id: str(raw.id, 200),
    version: num(raw.version) || 1,
    at: num(raw.at) || Date.now(),
  };
}

export interface Frame {
  manifest: any;
  zip: Buffer;
}

/** POST /market/publish 帧：uint32BE manifestLen + manifestJson + zipBytes。 */
export function parseFrame(buf: Buffer): Frame {
  if (buf.length < 4) throw new Error("帧太短");
  const len = buf.readUInt32BE(0);
  if (len < 2 || len > MAX_MARKET_FRAME || 4 + len > buf.length) throw new Error("manifest 长度越界");
  let manifest: any;
  try {
    manifest = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
  } catch {
    throw new Error("manifest 不是合法 JSON");
  }
  const zip = buf.subarray(4 + len);
  return { manifest, zip };
}

function sha256hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sameRecord(a: MarketRecord, b: MarketRecord): boolean {
  return a.publisher === b.publisher && a.id === b.id && a.version === b.version && a.at === b.at;
}
function sameTomb(a: MarketTombstone, b: MarketTombstone): boolean {
  return a.publisher === b.publisher && a.id === b.id && a.version === b.version && a.at === b.at;
}

/** 淘汰：只删可淘汰的镜像字节，公告与墓碑永远保留（D248 R5）。 */
function evict(index: MarketIndex): void {
  let total = index.blobs.reduce((n, b) => n + (b.size || 0), 0);
  if (total <= MARKET_CACHE_SOFT_LIMIT) return;
  while (total > MARKET_CACHE_SOFT_LIMIT) {
    const candidates = index.blobs
      .filter((b) => !b.original && b.installedAt === null)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    if (!candidates.length) break; // 全是本机原创或已安装，软上限只淘汰镜像
    const victim = candidates[0];
    index.blobs = index.blobs.filter((b) => b !== victim);
    total -= victim.size || 0;
    try {
      const p = blobPath(victim.sha256);
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* 淘汰失败不影响主流程 */
    }
  }
}

function storeBlob(index: MarketIndex, rec: MarketRecord, zip: Buffer, original: boolean, installed: boolean): void {
  if (rec.delivery !== "archive" || rec.size <= 0 || !/^[0-9a-f]{64}$/.test(rec.sha256)) return;
  ensureDirs();
  const p = blobPath(rec.sha256)!;
  if (!fs.existsSync(p)) fs.writeFileSync(p, zip);
  const existing = index.blobs.find((b) => b.sha256 === rec.sha256);
  const now = Date.now();
  if (existing) {
    existing.original = existing.original || original;
    existing.installedAt = existing.installedAt ?? (installed ? now : null);
    existing.lastUsedAt = now;
  } else {
    index.blobs.push({
      publisher: rec.publisher,
      id: rec.id,
      version: rec.version,
      sha256: rec.sha256,
      size: rec.size,
      original,
      installedAt: installed ? now : null,
      lastUsedAt: now,
    });
  }
  evict(index);
}

/**
 * 处理一条 publish / mirror / delete 帧。
 * - publish：只能本机作为原发布者（publisher === nodeId）；
 * - mirror：publisher 是别人，安装成功后本机成为镜像（D248 R3）；
 * - delete：只能原发布者删（publisher === nodeId），删本地镜像字节（D248 R4）。
 */
export function ingest(manifest: any, zip: Buffer, nodeId: string): { ok: boolean; error?: string } {
  const action = str(manifest?.action, 40);
  const publisher = str(manifest?.publisher, 200);
  const id = str(manifest?.id, 200);
  if (!publisher || !id) return { ok: false, error: "缺 publisher / id" };
  if (manifest?.schema !== MARKET_SCHEMA) return { ok: false, error: "schema 不认" };

  if (action === "delete") {
    // 原发布者自己删，或镜像把见过的墓碑转发过来（publisher 是别人）。
    // 只有本机 bridge 能调这个端点，冒名风险按 D248 R6「局域网可信」接受。
    const tomb = normalizeTombstone(manifest);
    const index = readIndex();
    if (!index.tombstones.some((t) => sameTomb(t, tomb))) index.tombstones.push(tomb);
    // 删掉这个 (publisher,id) 的镜像字节；还被别的 blob 引用的文件保留。
    const removed = index.blobs.filter((b) => b.publisher === publisher && b.id === id);
    index.blobs = index.blobs.filter((b) => !(b.publisher === publisher && b.id === id));
    for (const b of removed) {
      if (index.blobs.some((x) => x.sha256 === b.sha256)) continue;
      try {
        const p = blobPath(b.sha256);
        if (p && fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    writeIndex(index);
    return { ok: true };
  }

  if (action !== "publish" && action !== "mirror") return { ok: false, error: "action 不认" };
  if (action === "publish" && publisher !== nodeId) return { ok: false, error: "只能发布本机自己的条目" };

  const rec = normalizeRecord(manifest);
  if (!/^[0-9a-f]{64}$/.test(rec.sha256)) return { ok: false, error: "sha256 要是 64 位十六进制" };
  if (rec.size !== zip.length) return { ok: false, error: `size ${rec.size} 与实际 ${zip.length} 不符` };
  if (rec.delivery === "archive" && rec.size > 0 && sha256hex(zip) !== rec.sha256) {
    return { ok: false, error: "包字节与 sha256 不符" };
  }

  const index = readIndex();
  if (!index.published.some((r) => sameRecord(r, rec))) index.published.push(rec);
  storeBlob(index, rec, zip, action === "publish", action === "mirror");
  writeIndex(index);
  return { ok: true };
}

/** 本机作为发布者发布 / 镜像 / 删除时，构造 GET /market/manifest 的响应。 */
export function manifestResponse(nodeId: string, nickname: string, hostname: string): ManifestResponse {
  const index = readIndex();
  let published = [...index.published].sort((a, b) => b.at - a.at);
  const tombstones = [...index.tombstones].sort((a, b) => b.at - a.at);
  const blobs = index.blobs
    .filter((b) => {
      const p = blobPath(b.sha256);
      return p ? fs.existsSync(p) : false;
    })
    .map((b) => ({ publisher: b.publisher, id: b.id, version: b.version, sha256: b.sha256, size: b.size }));

  let truncated = false;
  const build = (pub: MarketRecord[]): ManifestResponse => ({
    schema: MARKET_SCHEMA,
    proto: MARKET_PROTO,
    nodeId,
    nickname,
    hostname,
    generatedAt: Date.now(),
    published: pub,
    tombstones,
    blobs,
  });
  let resp = build(published);
  while (Buffer.byteLength(JSON.stringify(resp)) > MAX_MANIFEST_BYTES && published.length > 1) {
    published = published.slice(0, published.length - 1);
    truncated = true;
    resp = build(published);
  }
  if (truncated) resp.truncated = true;
  return resp;
}

/** GET /market/blob 命中时顺手刷新 lastUsedAt（淘汰用）。 */
export function touchBlob(sha256: string): string | null {
  const p = blobPath(sha256);
  if (!p || !fs.existsSync(p)) return null;
  try {
    const index = readIndex();
    const b = index.blobs.find((x) => x.sha256 === sha256);
    if (b) {
      b.lastUsedAt = Date.now();
      writeIndex(index);
    }
  } catch {
    /* ignore */
  }
  return p;
}
