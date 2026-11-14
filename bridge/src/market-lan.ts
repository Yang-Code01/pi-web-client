/**
 * 局域网共享市场（pi-lan-market/1）—— bridge 侧的「合并 / 发布 / 安装」。
 *
 * peer/src/market.ts 只管自己磁盘上的公告、墓碑、blob 字节；这里把在线节点的
 * GET /market/manifest 汇总成一张清单，按 (publisher, id) + (version, at) 裁决，
 * 安装时按 sha256 从任一镜像拉字节并强校验，成功后本机转为镜像（D248）。
 *
 * 与既有三套安装器刻意隔离：市场自己写 market-installed.json 账本和
 * .market-meta.json，不写 .pi-store.json / marker.local / pkg.list 的 local 来源。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { unzipSync, zipSync, strFromU8 } from "fflate";
import { agentDir, readJson, writeJson } from "./paths.ts";
import { scanSkillEntries } from "./skills.ts";
import { looseExtensions, mcpEntry } from "./market.ts";
import { mcpFiles } from "./extmgr.ts";
import { runPiCli } from "./picli.ts";
import type { PeerHost } from "./peer.ts";

export const MARKET_SCHEMA = "pi-lan-market/1";
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_FILES = 400;
const MAX_CONCURRENCY = 8;

export type MarketType = "skill" | "extension" | "mcp";
export type MarketDelivery = "archive" | "source-ref" | "config-fragment";

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
export interface ManifestResponse {
  schema: string;
  proto: number;
  nodeId: string;
  nickname: string;
  hostname: string;
  generatedAt: number;
  published: MarketRecord[];
  tombstones: MarketTombstone[];
  blobs: { publisher: string; id: string; version: number; sha256: string; size: number }[];
  truncated?: boolean;
}
export interface MarketProvider {
  nodeId: string;
  nickname: string;
  hostname: string;
  addr: string;
  port: number;
}
export interface MarketPeerState extends MarketProvider {
  ok: boolean;
  self: boolean;
  unsupported: boolean;
  error?: string;
}
export interface InstalledRecord {
  publisher: string;
  id: string;
  version: number;
  sha256: string;
  installedAt: number;
  scope: "global" | "project";
  type: MarketType;
  name: string;
  path: string | null;
}
/** 页面看到的一行：公告 + 谁有字节 + 本机是否装过。 */
export interface MarketItem extends MarketRecord {
  key: string;
  providers: MarketProvider[];
  providerLabel: string;
  installed: boolean;
  installedVersion: number | null;
  hasUpdate: boolean;
  needsNetwork: boolean;
  needsVars: boolean;
}
export interface MarketList {
  items: MarketItem[];
  peers: MarketPeerState[];
  self: { nodeId: string; nickname: string; hostname: string };
  generatedAt: number;
  truncated: boolean;
}

const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const sha = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");
const keyOf = (publisher: string, id: string): string => `${publisher}\u0000${id}`;
/** 比较 (version, at)，墓碑与公告共用一个单调序（D248 R7）。 */
function rank(r: { version: number; at: number }): [number, number] {
  return [num(r.version), num(r.at)];
}
function newer(a: { version: number; at: number }, b: { version: number; at: number }): boolean {
  const [av, at] = rank(a);
  const [bv, bt] = rank(b);
  return av !== bv ? av > bv : at > bt;
}

function normalizeRecord(raw: any): MarketRecord {
  return {
    schema: MARKET_SCHEMA,
    action: "publish",
    publisher: str(raw?.publisher, 200),
    id: str(raw?.id, 200),
    type: (["skill", "extension", "mcp"].includes(raw?.type) ? raw.type : "skill") as MarketType,
    name: str(raw?.name, 300),
    description: str(raw?.description, 4000),
    version: num(raw?.version) || 1,
    category: str(raw?.category, 500),
    nickname: str(raw?.nickname, 200),
    hostname: str(raw?.hostname, 200),
    at: num(raw?.at) || 0,
    delivery: (["archive", "source-ref", "config-fragment"].includes(raw?.delivery) ? raw.delivery : "archive") as MarketDelivery,
    size: num(raw?.size),
    sha256: str(raw?.sha256, 64).toLowerCase(),
    dependencies: str(raw?.dependencies, 8000),
    notes: str(raw?.notes, 8000),
    extensionKind: raw?.extensionKind ? str(raw.extensionKind, 100) : undefined,
    source: raw?.source ? str(raw.source, 1000) : undefined,
    requiresNetwork: raw?.requiresNetwork ? true : undefined,
    config: raw?.config && typeof raw.config === "object" && !Array.isArray(raw.config) ? (raw.config as Record<string, unknown>) : undefined,
    requiredVars: Array.isArray(raw?.requiredVars) ? (raw.requiredVars as unknown[]).filter((s: unknown): s is string => typeof s === "string").slice(0, 64) : undefined,
  };
}
function normalizeTomb(raw: any): MarketTombstone {
  return { schema: MARKET_SCHEMA, action: "delete", publisher: str(raw?.publisher, 200), id: str(raw?.id, 200), version: num(raw?.version) || 1, at: num(raw?.at) || 0 };
}
/** 无字节条目（source-ref / config-fragment）的 sha256：规范 manifest JSON 去掉 sha256 字段。 */
export function recordDigest(rec: MarketRecord): string {
  const { sha256: _ignored, ...rest } = rec;
  return sha(Buffer.from(JSON.stringify(rest), "utf8"));
}

/* ---------------------------------------------------------------- 落盘账本 */

/**
 * 市场自己的安装根。生产里 PI_WEB_STATE 不设，落 agentDir()（pi 会扫描到）。
 * 多开测试环境给每个实例注入不同的 PI_WEB_STATE，用它隔开三台机器的已安装状态，
 * 免得三份 bridge 共用同一个 ~/.pi/agent 导致「A 装了 B 也显示已装」。
 */
function marketRoot(scope: "global" | "project", cwd: string | null): string {
  if (scope === "project") return path.join(cwd || process.cwd(), ".pi");
  const state = process.env.PI_WEB_STATE;
  return state ? path.join(path.resolve(state), "market-home") : agentDir();
}
function ledgerPath(scope: "global" | "project", cwd: string | null): string {
  return path.join(marketRoot(scope, cwd), "market-installed.json");
}
function readLedger(file: string): InstalledRecord[] {
  const rows = readJson<unknown>(file, []);
  return Array.isArray(rows) ? (rows as InstalledRecord[]) : [];
}
export function installedAll(cwd: string | null): InstalledRecord[] {
  return [...readLedger(ledgerPath("global", cwd)), ...readLedger(ledgerPath("project", cwd))];
}
function putLedger(scope: "global" | "project", cwd: string | null, rec: InstalledRecord): void {
  const file = ledgerPath(scope, cwd);
  const rows = readLedger(file).filter((r) => keyOf(r.publisher, r.id) !== keyOf(rec.publisher, rec.id));
  rows.push(rec);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, rows);
}
function dropLedger(cwd: string | null, publisher: string, id: string): InstalledRecord[] {
  const hit: InstalledRecord[] = [];
  for (const scope of ["global", "project"] as const) {
    const file = ledgerPath(scope, cwd);
    const rows = readLedger(file);
    const found = rows.find((r) => keyOf(r.publisher, r.id) === keyOf(publisher, id));
    if (found) {
      hit.push(found);
      writeJson(file, rows.filter((r) => r !== found));
    }
  }
  return hit;
}
function writeMeta(dir: string, rec: InstalledRecord): void {
  writeJson(path.join(dir, ".market-meta.json"), {
    publisher: rec.publisher, id: rec.id, version: rec.version, sha256: rec.sha256, installedAt: rec.installedAt, scope: rec.scope,
  });
}

/* ---------------------------------------------------------------- 清单拉取与合并 */

interface OnlineNode extends MarketProvider {
  self: boolean;
}
async function fetchManifest(node: OnlineNode, host: PeerHost): Promise<{ node: OnlineNode; manifest: ManifestResponse | null; error?: string; unsupported?: boolean }> {
  try {
    const raw = node.self
      ? await host.marketManifestLocal()
      : await host.marketManifestRemote(node.addr, node.port);
    if (!raw || raw.schema !== MARKET_SCHEMA) return { node, manifest: null, error: "清单 schema 不认" };
    return { node, manifest: raw as ManifestResponse };
  } catch (err: any) {
    const text = String(err?.message ?? err);
    return { node, manifest: null, error: text, unsupported: /404|not found|peer 回 404/i.test(text) };
  }
}

/**
 * 打开市场 tab 时逐个在线节点拉一次 GET /market/manifest（D248 R2）。
 * 旧节点没有 /market/* → 404 → unsupported，但照常留在在线表里（R7 / 协议 §9）。
 */
export async function marketList(host: PeerHost, cwd: string | null): Promise<MarketList> {
  const view = host.view();
  const status = view.status;
  const self: OnlineNode = {
    nodeId: status?.nodeId ?? "", nickname: status?.nickname ?? "", hostname: status?.hostname ?? os.hostname(),
    addr: "127.0.0.1", port: status?.port ?? 0, self: true,
  };
  const nodes: OnlineNode[] = [self];
  for (const p of status?.online ?? []) {
    if (p.nodeId === self.nodeId) continue;
    nodes.push({ nodeId: p.nodeId, nickname: p.nickname, hostname: p.hostname, addr: p.addr, port: p.port, self: false });
  }
  // 8 并发，慢节点不拖住整张清单。
  const results: Awaited<ReturnType<typeof fetchManifest>>[] = [];
  for (let i = 0; i < nodes.length; i += MAX_CONCURRENCY) {
    const batch = await Promise.all(nodes.slice(i, i + MAX_CONCURRENCY).map((n) => fetchManifest(n, host)));
    results.push(...batch);
  }
  const peers: MarketPeerState[] = results.map((r) => ({
    nodeId: r.node.nodeId, nickname: r.node.nickname, hostname: r.node.hostname, addr: r.node.addr, port: r.node.port,
    ok: Boolean(r.manifest), self: r.node.self, unsupported: Boolean(r.unsupported), error: r.error,
  }));
  const truncated = results.some((r) => r.manifest?.truncated);

  // 公告 / 墓碑：同 (publisher,id) 取 (version,at) 最大者；墓碑赢则整条隐藏。
  const winners = new Map<string, { rec: MarketRecord | null; tomb: MarketTombstone | null; isTomb: boolean }>();
  const consider = (r: { publisher: string; id: string; version: number; at: number }, isTomb: boolean, rec: MarketRecord | null, tomb: MarketTombstone | null): void => {
    if (!r.publisher || !r.id) return;
    const key = keyOf(r.publisher, r.id);
    const cur = winners.get(key);
    if (!cur || newer(r, cur.isTomb ? cur.tomb! : cur.rec!)) winners.set(key, { rec, tomb, isTomb });
  };
  // 可得性：某节点宣称自己持有 (publisher,id,version,sha256,size) 的字节。
  const blobs = new Map<string, { sha256: string; version: number; providers: MarketProvider[] }>();
  for (const r of results) {
    if (!r.manifest) continue;
    const provider: MarketProvider = { nodeId: r.node.nodeId, nickname: r.node.nickname, hostname: r.node.hostname, addr: r.node.addr, port: r.node.port };
    for (const raw of r.manifest.published ?? []) consider(normalizeRecord(raw), false, normalizeRecord(raw), null);
    for (const raw of r.manifest.tombstones ?? []) consider(normalizeTomb(raw), true, null, normalizeTomb(raw));
    for (const b of r.manifest.blobs ?? []) {
      if (!/^[0-9a-f]{64}$/.test(String(b.sha256 ?? ""))) continue;
      const k = keyOf(String(b.publisher ?? ""), String(b.id ?? "")) + "\u0000" + String(b.sha256);
      const cur = blobs.get(k);
      if (cur) cur.providers.push(provider);
      else blobs.set(k, { sha256: String(b.sha256), version: num(b.version), providers: [provider] });
    }
  }

  const installed = installedAll(cwd);
  const items: MarketItem[] = [];
  for (const [key, w] of winners) {
    if (w.isTomb || !w.rec) continue;
    const rec = w.rec;
    const blobKey = key + "\u0000" + rec.sha256;
    const providers = rec.delivery === "archive" && rec.size > 0 ? (blobs.get(blobKey)?.providers ?? []) : [];
    const mine = installed.find((r) => keyOf(r.publisher, r.id) === key);
    const needsVars = rec.type === "mcp" && (rec.requiredVars?.length ?? 0) > 0;
    items.push({
      ...rec,
      key,
      providers,
      providerLabel: providers.length ? `${providers[0].nickname || providers[0].hostname || providers[0].addr}` : "—",
      installed: Boolean(mine),
      installedVersion: mine?.version ?? null,
      hasUpdate: Boolean(mine && rec.version > mine.version),
      needsNetwork: rec.delivery === "source-ref" || rec.requiresNetwork === true,
      needsVars,
    });
  }
  items.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));

  // R7：把在线节点清单里见过、本机还没有的墓碑回灌本机 peer。
  // delete 帧不带字节，peer.ingest 的 delete 分支直接接受，因此原发布者离线后
  // 镜像之间也能收敛；幂等键含 (publisher,id,version,at)，不会反复写入。
  try {
    const local = results.find((r) => r.node.self)?.manifest;
    const known = new Set((local?.tombstones ?? []).map((t) =>
      keyOf(String(t?.publisher ?? ""), String(t?.id ?? "")) + "@" + num(t?.version) + ":" + num(t?.at)));
    const seen = new Map<string, MarketTombstone>();
    for (const r of results) {
      if (r.node.self || !r.manifest) continue;
      for (const raw of r.manifest.tombstones ?? []) {
        const t = normalizeTomb(raw);
        if (!t.publisher || !t.id) continue;
        const k = keyOf(t.publisher, t.id) + "@" + t.version + ":" + t.at;
        if (known.has(k)) continue;
        seen.set(k, t);
      }
    }
    for (const t of seen.values()) {
      try { await host.marketPublishLocal(frameOf(t, Buffer.alloc(0))); }
      catch { /* 本机 peer 不可用时跳过，下次浏览再收敛 */ }
    }
  } catch { /* 收敛失败不影响本次列表 */ }

  return {
    items, peers, self: { nodeId: self.nodeId, nickname: self.nickname, hostname: self.hostname },
    generatedAt: Date.now(), truncated,
  };
}

/* ---------------------------------------------------------------- 已安装来源（一键发布） */

export interface MarketSourceItem { id: string; name: string; description: string; path: string; scope: string; kind: string }
export interface MarketSources { skills: MarketSourceItem[]; extensions: MarketSourceItem[]; mcp: MarketSourceItem[] }

/** 「从已安装发布」的候选：技能目录、loose 扩展、mcp.json 里的服务。 */
export function marketSources(cwd: string | null): MarketSources {
  const skills: MarketSourceItem[] = scanSkillEntries(cwd).map((s) => ({
    id: s.name, name: s.name, description: s.description, path: s.path ?? "", scope: s.source, kind: "skill",
  }));
  const extensions: MarketSourceItem[] = looseExtensions(cwd)
    .filter((x) => x.scope !== "builtin")
    .map((x) => ({
      id: x.id, name: x.label, description: x.how, scope: x.scope, kind: "extension",
      path: path.join(x.scope === "project" ? path.join(cwd || process.cwd(), ".pi") : marketRoot("global", cwd), "extensions", x.id),
    }));
  const mcp: MarketSourceItem[] = [];
  for (const file of mcpFiles(cwd)) {
    const json = readJson<{ mcpServers?: Record<string, Record<string, unknown>> }>(file, {});
    const servers = json.mcpServers ?? {};
    for (const name of Object.keys(servers)) {
      mcp.push({ id: name, name, description: String(servers[name]?.command ?? servers[name]?.url ?? ""), path: file, scope: file.includes(`${path.sep}.pi${path.sep}`) ? "project" : "global", kind: "mcp" });
    }
  }
  return { skills, extensions, mcp };
}

/* ---------------------------------------------------------------- zip 打包 / 解包 */

function safeName(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s || s === "." || s === ".." || s.length > 64 || /[\/\\\0]/.test(s)) throw new Error("名字不合法（不能有路径分隔符）");
  return s;
}
/** zip 里的文件名必须落在 payload/ 下，不接受绝对路径、..、盘符、NUL、node_modules。 */
function safeRelative(name: string): string {
  const p = name.replace(/\\/g, "/");
  if (!p.startsWith("payload/") || p.includes("\0") || p.split("/").includes("..") || /^[A-Za-z]:/.test(p) || p.includes("node_modules/")) return "";
  const rel = p.slice("payload/".length);
  return rel && !rel.endsWith("/") ? rel : "";
}
function extractPayload(zip: Buffer): Map<string, Uint8Array> {
  const entries = unzipSync(new Uint8Array(zip));
  const out = new Map<string, Uint8Array>();
  let total = 0;
  let count = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (name === "manifest.json") continue;
    const rel = safeRelative(name);
    if (!rel) continue;
    if (++count > MAX_FILES) throw new Error(`文件太多（上限 ${MAX_FILES}）`);
    if (data.byteLength > MAX_FILE) throw new Error(`单文件太大（上限 16 MB）：${rel}`);
    total += data.byteLength;
    if (total > MAX_TOTAL) throw new Error("解压后总量超过 64 MB");
    out.set(rel, data);
  }
  return out;
}
/** 把本机目录打成 payload/** 的 zip（一键发布）。 */
function zipDirectory(dir: string): Buffer<ArrayBufferLike> {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`找不到目录：${abs}`);
  const files: Record<string, Uint8Array> = {};
  let count = 0;
  let total = 0;
  const walk = (cur: string, rel: string): void => {
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const name = ent.name;
      if (name === "node_modules" || name === ".git" || name === "market-installed.json") continue;
      const next = path.join(cur, name);
      const relNext = rel ? `${rel}/${name}` : name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        walk(next, relNext);
        continue;
      }
      if (!ent.isFile()) continue;
      const data = fs.readFileSync(next);
      if (++count > MAX_FILES) throw new Error(`文件太多（上限 ${MAX_FILES}）`);
      if (data.byteLength > MAX_FILE) throw new Error(`单文件太大（上限 16 MB）：${relNext}`);
      total += data.byteLength;
      if (total > MAX_TOTAL) throw new Error("打包后总量超过 64 MB");
      files[`payload/${relNext}`] = new Uint8Array(data);
    }
  };
  walk(abs, "");
  return Buffer.from(zipSync(files, { level: 6 })) as Buffer<ArrayBufferLike>;
}
function writePayload(files: Map<string, Uint8Array>, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const [rel, data] of files) {
    const out = path.resolve(dest, rel);
    const inside = path.resolve(dest);
    if (out !== inside && !out.startsWith(inside + path.sep)) throw new Error(`路径越界：${rel}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(data));
  }
}

/* ---------------------------------------------------------------- 发布 / 删除 */

export interface PublishInput {
  item: Partial<MarketRecord>;
  source: { kind: "skill" | "extension" | "mcp" | "zip" | "none"; path?: string; name?: string; zipB64?: string };
  scope: "global" | "project";
  cwd: string | null;
}
function frameOf(manifest: unknown, zip: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  const json = Buffer.from(JSON.stringify(manifest), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length, 0);
  return Buffer.concat([head, json, zip]);
}
/** MCP 配置片段：去掉本机私密值，只留 ${VAR} 占位符，并列出需要填的变量。 */
function mcpFragment(file: string, name: string): { config: Record<string, unknown>; requiredVars: string[] } {
  const entry = mcpEntry(file, name);
  if (!entry) throw new Error(`mcp.json 里没有 ${name}`);
  const vars = new Set<string>();
  const clean = (v: unknown): JsonValue => {
    if (typeof v === "string") {
      return v.replace(/\$\{([A-Za-z_][\w]*)\}/g, (_m, k: string) => { vars.add(k); return `\${${k}}`; });
    }
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") {
      const out: Record<string, JsonValue> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = clean(val);
      return out;
    }
    if (typeof v === "number" || typeof v === "boolean") return v;
    return null;
  };
  type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
  const cfg = { ...(clean(entry) as Record<string, unknown>) };
  delete cfg.enabled;
  // 环境变量的真实值不能进清单：留 KEY= 前缀，由本机确认页填。
  const env = cfg.env;
  if (Array.isArray(env)) cfg.env = env.map((s) => {
    const t = String(s);
    const k = t.split("=")[0];
    if (/\$\{/.test(t)) { const m = /\$\{([A-Za-z_][\w]*)\}/.exec(t); if (m) vars.add(m[1]); }
    return `${k}=\${${k}}`;
  });
  else if (env && typeof env === "object") {
    const out: Record<string, string> = {};
    for (const k of Object.keys(env as Record<string, unknown>)) { vars.add(k); out[k] = `\${${k}}`; }
    cfg.env = out;
  }
  return { config: { mcpServers: { [name]: cfg } }, requiredVars: [...vars] };
}

export async function marketPublish(host: PeerHost, input: PublishInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  const status = host.view().status;
  if (!status?.nodeId) return { ok: false, error: "内网通还没起来，稍后再试" };
  const manual = String(input.source.kind) === "zip";
  let supplied: Record<string, unknown> = {};
  let zip: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    if (manual) {
      if (!input.source.zipB64) return { ok: false, error: "没选 zip 文件" };
      zip = Buffer.from(input.source.zipB64, "base64");
      const entries = unzipSync(new Uint8Array(zip));
      const mf = entries["manifest.json"];
      if (!mf) return { ok: false, error: "zip 根目录缺 manifest.json" };
      supplied = JSON.parse(strFromU8(mf)) as Record<string, unknown>;
      // 手工 zip 里的发布者字段一律以本机为准，不接受写死的值（协议 §6）。
    } else if (input.source.kind === "mcp") {
      if (!input.source.path || !input.source.name) return { ok: false, error: "没选 MCP 服务" };
      const frag = mcpFragment(input.source.path, input.source.name);
      supplied = { ...frag, delivery: "config-fragment" };
    } else if (input.source.kind === "skill" || input.source.kind === "extension") {
      if (!input.source.path) return { ok: false, error: "没选来源目录" };
      zip = zipDirectory(input.source.path);
      supplied = { delivery: "archive" };
    } else {
      supplied = { delivery: "source-ref", requiresNetwork: true };
    }
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }

  // 手工 zip 以包里的 manifest.json 为准，页面表单只补缺；一键发布反过来让表单覆盖推导值。
  // 发布者 / 昵称 / 主机名 / 时间 / 版本一律不采信包里写死的值（协议 §6）。
  const merged: Record<string, unknown> = manual ? { ...input.item, ...supplied } : { ...supplied, ...input.item };
  const type = (["skill", "extension", "mcp"].includes(String(merged.type)) ? merged.type : "skill") as MarketType;
  const delivery = (["archive", "source-ref", "config-fragment"].includes(String(merged.delivery)) ? merged.delivery : "archive") as MarketDelivery;
  let id: string;
  try { id = safeName(str(merged.id, 200) || str(merged.name, 200)); }
  catch (err: any) { return { ok: false, error: `manifest.json 缺 id / name：${String(err?.message ?? err)}` }; }
  if (delivery === "source-ref" || delivery === "config-fragment") zip = Buffer.alloc(0);
  const base = normalizeRecord({ ...merged, type, id, delivery });
  // 版本只能往上走：连本机见过的墓碑一起算，删后重发才能盖过墓碑（R4 / R7）。
  let maxSeen = 0;
  try {
    const local = await host.marketManifestLocal();
    for (const r of [...(local?.published ?? []), ...(local?.tombstones ?? [])]) {
      if (String(r?.publisher ?? "") === status.nodeId && String(r?.id ?? "") === id) maxSeen = Math.max(maxSeen, num(r?.version));
    }
  } catch { /* 本机清单读不到就按页面给的版本走 */ }
  const version = Math.max(num(merged.version) || 1, maxSeen + 1);
  const rec: MarketRecord = {
    ...base,
    publisher: status.nodeId, nickname: status.nickname || "", hostname: status.hostname || os.hostname(),
    version, at: Date.now(), size: zip.length,
    sha256: delivery === "archive" ? sha(zip) : "",
  };
  if (delivery !== "archive") rec.sha256 = recordDigest(rec);
  rec.action = "publish";
  if (rec.delivery === "archive" && !zip.length) return { ok: false, error: "这个包没有文件，没法发布" };
  try {
    await host.marketPublishLocal(frameOf({ ...rec, action: "publish" }, zip));
    return { ok: true, id };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export async function marketDelete(host: PeerHost, cwd: string | null, publisher: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const status = host.view().status;
  if (status?.nodeId !== publisher) return { ok: false, error: "只有原发布者能删自己的条目" };
  const list = await marketList(host, cwd);
  const item = list.items.find((x) => x.key === keyOf(publisher, id));
  // 墓碑版本比公告高一档，保证 (version, at) 排序里一定压掉公告；重发时再 +1 复活。
  const version = (item?.version ?? 0) + 1;
  const tomb: MarketTombstone = { schema: MARKET_SCHEMA, action: "delete", publisher, id, version, at: Date.now() };
  try {
    await host.marketPublishLocal(frameOf(tomb, Buffer.alloc(0)));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/* ---------------------------------------------------------------- 安装 / 卸载 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
function fillVars(value: unknown, vars: Record<string, string>): JsonValue {
  if (typeof value === "string") return value.replace(/\$\{([A-Za-z_][\w]*)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(value)) return value.map((v) => fillVars(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fillVars(v, vars);
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  return null;
}
function readMcpJson(file: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return {}; }
}
function writeMcpEntry(file: string, name: string, entry: Record<string, unknown>): void {
  const json = readMcpJson(file);
  const servers = (json.mcpServers && typeof json.mcpServers === "object" ? { ...(json.mcpServers as Record<string, unknown>) } : {});
  servers[name] = entry;
  json.mcpServers = servers;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, json);
}
function removeMcpEntry(file: string, name: string): void {
  const json = readMcpJson(file);
  const servers = json.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object") return;
  delete servers[name];
  writeJson(file, json);
}

export async function marketInstall(
  host: PeerHost, pi: { cli: string }, cwd: string | null,
  publisher: string, id: string, scope: "global" | "project", vars: Record<string, string>,
  onProgress?: (text: string) => void,
): Promise<{ ok: boolean; error?: string; name?: string }> {
  const say = onProgress ?? (() => {});
  // 不信任页面传来的条目：重新拉一次清单，按合并后的公告裁决。
  const list = await marketList(host, cwd);
  const item = list.items.find((x) => x.key === keyOf(publisher, id));
  if (!item) return { ok: false, error: "这个条目已经被删除或看不到了，刷新后再试" };
  say("正在从在线节点取包字节…");
  let zip: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let usedProvider: MarketProvider | null = null;
  let installedName = item.name || safeName(item.id);
  if (item.delivery === "archive") {
    if (!item.providers.length) return { ok: false, error: "现在没有在线节点持有这个包的字节（原发布者和镜像都不在）" };
    for (const p of item.providers) {
      try {
        const buf = await host.marketBlobRemote(p.addr, p.port, item.sha256);
        if (buf.length === item.size && sha(buf) === item.sha256) { zip = buf; usedProvider = p; break; }
      } catch { /* 换下一个镜像 */ }
    }
    if (!usedProvider) return { ok: false, error: "包字节与清单的 sha256 / 大小对不上，已拒绝安装" };
  }
  const root = marketRoot(scope, cwd);
  const name = safeName(item.id);
  const installedPath: string | null = item.type === "mcp" ? path.join(root, "mcp.json") : path.join(root, item.type === "skill" ? "skills" : "extensions", name);
  try {
    if (item.type === "skill") {
      const files = extractPayload(zip);
      if (!files.size) return { ok: false, error: "payload/ 里没有文件" };
      fs.rmSync(installedPath, { recursive: true, force: true });
      writePayload(files, installedPath);
    } else if (item.type === "extension" && item.delivery === "source-ref") {
      if (!item.source) return { ok: false, error: "这个扩展缺来源地址" };
      say(`正在运行 pi install ${item.source}（需要联网）…`);
      const run = runPiCli(pi.cli, { op: "pkg.install", source: item.source, local: scope === "project", cwd: cwd ?? undefined }, () => {});
      const out = await run.done;
      if (out.code !== 0) return { ok: false, error: `pi install 失败：${String(out.output ?? "").slice(-400)}` };
    } else if (item.type === "extension") {
      const files = extractPayload(zip);
      if (!files.size) return { ok: false, error: "payload/ 里没有文件" };
      fs.rmSync(installedPath, { recursive: true, force: true });
      writePayload(files, installedPath);
    } else if (item.type === "mcp") {
      const servers = ((item.config ?? {}) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
      const serverName = Object.keys(servers)[0];
      if (!serverName) return { ok: false, error: "这个 MCP 片段里没有 mcpServers" };
      for (const v of item.requiredVars ?? []) if (!(v in vars) || !String(vars[v])) return { ok: false, error: `请先填写变量 ${v}` };
      const entry = fillVars(servers[serverName], vars) as Record<string, unknown>;
      entry.enabled = true;
      writeMcpEntry(installedPath, serverName, entry);
      installedName = serverName;
    } else {
      return { ok: false, error: "不认识的包类型" };
    }
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  const record: InstalledRecord = {
    publisher, id, version: item.version, sha256: item.sha256, installedAt: Date.now(), scope,
    type: item.type, name: installedName, path: installedPath,
  };
  putLedger(scope, cwd, record);
  if (item.type !== "mcp" && installedPath) writeMeta(installedPath, record);
  // 安装成功即成为镜像（D248 R3）：把同一条公告以 action:"mirror" 喂给本机 peer。
  if (item.delivery === "archive" && usedProvider) {
    try {
      await host.marketPublishLocal(frameOf({ ...itemToRecord(item), action: "mirror" }, zip));
      say(`已成为镜像（字节来自 ${usedProvider.nickname || usedProvider.hostname}）`);
    } catch (err: any) {
      say(`镜像登记失败（不影响已安装）：${String(err?.message ?? err)}`);
    }
  }
  return { ok: true, name: installedName };
}

function itemToRecord(item: MarketItem): MarketRecord {
  const { key: _k, providers: _p, providerLabel: _l, installed: _i, installedVersion: _v, hasUpdate: _u, needsNetwork: _n, needsVars: _nv, ...rec } = item;
  return rec as MarketRecord;
}

export async function marketUninstall(cwd: string | null, publisher: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const rows = dropLedger(cwd, publisher, id);
  if (!rows.length) return { ok: false, error: "本机没有装过这个市场的条目" };
  for (const r of rows) {
    try {
      if (r.type === "mcp") {
        const file = r.path;
        if (!file) continue;
        const mcpName = String(file).endsWith("mcp.json") ? r.name : "";
        // 账本记的是服务名，删的时候只撤自己写过的那一个，别碰别人的 MCP。
        const targetName = mcpName ? (r.name || r.id) : "";
        if (targetName) removeMcpEntry(file, targetName);
      } else if (r.path && fs.existsSync(r.path)) {
        const root = path.resolve(marketRoot(r.scope, cwd), r.type === "skill" ? "skills" : "extensions");
        if (path.resolve(r.path).startsWith(root + path.sep)) fs.rmSync(r.path, { recursive: true, force: true });
      }
    } catch { /* 账本先撤，文件删不掉只提示 */ }
  }
  return { ok: true };
}
