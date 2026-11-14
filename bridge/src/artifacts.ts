/**
 * D208: 「这个会话的产物里，哪些是新建的、哪些改过、改了多少」。
 *
 * 一个文件的新增 / 修改不是工具能回答的问题 —— `write` 覆盖一个已有文件时和新建一个文件长得一模一样，
 * 所以判定必须拿「会话开始前的那份原文」去比。这份原文由 `bridge/ext/artifact-snapshot.ts` 在
 * `tool_call` 钩子里抓：钩子被 pi await，桥在这段时间里读完磁盘，写入还没发生，零竞态。
 *
 * 抓不到基线的情况（桥重启过、扩展被关、文件在会话前就改过）不猜：能问 git 就标「按 git 估算」，
 * 问不到就老实说「未知」。界面上的徽章宁可少一个，也不能把「我猜的」画成「事实」。
 *
 * 存的东西很小：每个会话一个目录（statePath('artifacts', sessionId)），
 * index.json 记元数据，`<sha256(abs)>.orig` 存第一次被写之前的字节（仅文本、≤2 MB）。
 * 删会话时整目录删掉，不额外维护生命周期。
 *
 * D252: 上面这套只认 write 系工具。脚本 / Playwright / ffmpeg 在 bash 里批量生成的目录产物
 * 从来不会进 `inputs`，但它们确实被 assistant 正文声明成「产物」。清单在工具行之后按会话声明补
 * 这些目录里的新文件，标成「本次生成」，不套用 git 基线，也不伪造工具名和写入次数。
 * 会话会持续变长，声明可能早于末尾几 MB，所以流式扫整份 JSONL，不只读尾部。
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { countLines, diffTexts, looksBinary, type DiffHunk } from "./diff.ts";
import { statePath } from "./paths.ts";
import { resolvePreviewPath } from "./preview.ts";
import { utf8Bytes } from "./sheet/gbk.ts";

const run = promisify(execFile);

export type ArtifactOrigin = "tool" | "directory";
export type ArtifactStatus = "new" | "modified" | "same" | "deleted" | "unknown" | "generated";

export interface ArtifactInput {
  path: string;
  tool: string;
  writes: number;
}

export interface ArtifactRow {
  /** 模型写的那个路径（行里显示它，点开时也用它）。 */
  path: string;
  abs: string;
  status: ArtifactStatus;
  /** D252: 工具写入事实，还是会话声明目录里发现的批量生成物。 */
  origin: ArtifactOrigin;
  /** 目录行所属声明目录（绝对路径，带尾斜杠），界面按它分组。 */
  group?: string;
  /** 目录行：确实来自 assistant 正文的明确交付声明。 */
  declared?: boolean;
  /** 目录行：相对声明目录的路径；工具行：相对 cwd 的路径。 */
  rel?: string;
  tool: string;
  writes: number;
  added: number;
  removed: number;
  /** 基线来自 git（会话开始时没有快照）。 */
  estimate: boolean;
  binary: boolean;
  diffable: boolean;
  sizeBefore: number | null;
  sizeAfter: number | null;
  /** 为什么是未知 / 为什么只能给统计。是码不是句子：文案在页面的 tr() 里（D208）。 */
  why?: ArtifactWhy;
}

/** `why` 的取值。桥不拼中文，页面按码取译文。 */
export type ArtifactWhy =
  | "no-baseline"
  | "git-head-missing"
  | "snapshot-too-big"
  | "size-only"
  | "binary-size-only"
  | "built-then-deleted"
  | "diff-too-large"
  | "diff-rewrite"
  | "generated-no-baseline";

export interface ArtifactSummary {
  new: number;
  modified: number;
  same: number;
  deleted: number;
  unknown: number;
  /** D252: 会话声明目录里发现的批量生成物，独立计数，不混进「修改」。 */
  generated: number;
  added: number;
  removed: number;
}

export interface ArtifactList {
  items: ArtifactRow[];
  summary: ArtifactSummary;
  /** exact = 每个可比的工具写入都有写入前的原文；仅目录行时也算 exact（D252）。 */
  baseline: "exact" | "partial" | "none";
}

export interface ArtifactDiff {
  path: string;
  abs: string;
  status: ArtifactStatus;
  estimate: boolean;
  binary: boolean;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  truncated: boolean;
  reason?: string;
  sizeBefore: number | null;
  sizeAfter: number | null;
}

/** 与预览编辑同一个上限：超过它就只记元数据。 */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_STORAGE_BYTES = 50 * 1024 * 1024;
const isWin = process.platform === "win32";
/** D252: 一次扫描最多看多少文件，避免声明到一个超大目录时把桥拖住。 */
const MAX_DIR_SCAN_ENTRIES = 5000;
/** 会话开始前 5 分钟内的文件不算「这次生成」的旧物，给时钟误差留余量。 */
const DECLARED_MTIME_SLACK_MS = 5 * 60_000;
/** 不扫「整个 cwd」，也不扫构建缓存；`.scratch` 故意不在名单里（目标目录就在它下面）。 */
const FORBIDDEN_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".cache",
]);

interface Snap {
  /** 抓基线的那个绝对路径（Windows 上按大小写不敏感比，但存原样给人看）。 */
  abs: string;
  existed: boolean;
  size: number;
  mtime: number;
  /** 字节存在 `<sha256(abs)>.orig` 里。 */
  stored: boolean;
  binary: boolean;
  at: number;
}

interface SnapIndex {
  v: 1;
  bytes: number;
  files: Record<string, Snap>;
}

function safeId(sessionId: string): string {
  return String(sessionId || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "unknown";
}

export function snapshotDir(sessionId: string): string {
  return statePath("artifacts", safeId(sessionId));
}

function indexFile(dir: string): string {
  return path.join(dir, "index.json");
}

function keyOf(abs: string): string {
  return isWin ? abs.toLowerCase() : abs;
}

function origFile(dir: string, abs: string): string {
  return path.join(dir, `${crypto.createHash("sha256").update(keyOf(abs)).digest("hex")}.orig`);
}

function readIndex(dir: string): SnapIndex {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(dir), "utf8"));
    if (raw && raw.v === 1 && raw.files && typeof raw.files === "object") {
      return { v: 1, bytes: Number(raw.bytes) || 0, files: raw.files as Record<string, Snap> };
    }
  } catch {
    /* 没索引 / 坏了：当成空的重来，别让一次坏写挡住整个弹窗 */
  }
  return { v: 1, bytes: 0, files: {} };
}

function writeIndex(dir: string, idx: SnapIndex): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${indexFile(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(idx));
  fs.renameSync(tmp, indexFile(dir));
}

function decode(buf: Buffer): string {
  return utf8Bytes(buf) ? buf.toString("utf8") : new TextDecoder("gbk").decode(buf);
}

function readOrNull(abs: string): Buffer | null {
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

function statOrNull(abs: string): fs.Stats | null {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/**
 * 记下这个文件「现在」的样子 —— 只在第一次见到它时真写盘。之后同一个文件被改多少次都不再采，
 * 基线永远是会话开始前那一份。
 */
export function recordSnapshot(sessionId: string, abs: string): { kept: boolean; snap: Snap | null } {
  const dir = snapshotDir(sessionId);
  const idx = readIndex(dir);
  const key = keyOf(abs);
  const seen = idx.files[key];
  if (seen) return { kept: true, snap: seen };
  if (Object.keys(idx.files).length >= MAX_FILES) return { kept: false, snap: null };

  const st = statOrNull(abs);
  const snap: Snap = {
    abs,
    existed: Boolean(st),
    size: st?.size ?? 0,
    mtime: st?.mtimeMs ?? 0,
    stored: false,
    binary: false,
    at: Date.now(),
  };
  if (st && st.size <= MAX_SNAPSHOT_BYTES) {
    const buf = readOrNull(abs);
    if (buf) {
      snap.binary = looksBinary(buf);
      if (!snap.binary) {
        if (idx.bytes + buf.length <= MAX_STORAGE_BYTES) {
          try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(origFile(dir, abs), buf);
            snap.stored = true;
            idx.bytes += buf.length;
          } catch {
            /* 写不进就不存字节：状态会退化成「按大小猜」，比崩掉强 */
          }
        }
      }
    }
  }
  idx.files[key] = snap;
  writeIndex(dir, idx);
  return { kept: false, snap };
}

/** 基线字节：stored 时读 .orig，existed=false 时是空文件，没基线时 null。 */
function baselineBytes(dir: string, snap: Snap): Buffer | null {
  if (!snap.existed) return Buffer.alloc(0);
  if (!snap.stored) return null;
  return readOrNull(origFile(dir, snap.abs));
}

// ------------------------------------------------------------------ git 兜底
async function gitBytes(cwd: string, args: string[]): Promise<Buffer | null> {
  try {
    const { stdout } = await run("git", ["-C", cwd, "-c", "core.fsmonitor=false", ...args], {
      timeout: 4000,
      windowsHide: true,
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024,
    });
    return Buffer.isBuffer(stdout) ? stdout : null;
  } catch {
    return null;
  }
}

async function gitRoot(cwd: string): Promise<string | null> {
  const out = await gitBytes(cwd, ["rev-parse", "--show-toplevel"]);
  const text = out ? out.toString("utf8").trim() : "";
  return text ? path.resolve(text) : null;
}

async function gitTracked(root: string, rel: string): Promise<boolean> {
  const out = await gitBytes(root, ["ls-files", "--error-unmatch", "--", rel]);
  return out !== null;
}

/** HEAD 里那份内容。空仓库 / 没这个路径 → null。 */
async function gitHeadBytes(root: string, rel: string): Promise<Buffer | null> {
  return gitBytes(root, ["show", `HEAD:${rel.split(path.sep).join("/")}`]);
}

interface Resolved {
  input: ArtifactInput;
  abs: string;
  rel: string;
}

/** D252: 路由从 `sessions.locate()` 得到的会话文件 / 开始时间。 */
export interface ArtifactSession {
  file?: string | null;
  startedAt?: string;
}

// ------------------------------------------------------------------ 列表
function emptySummary(): ArtifactSummary {
  return { new: 0, modified: 0, same: 0, deleted: 0, unknown: 0, generated: 0, added: 0, removed: 0 };
}

/**
 * 把「这个会话写过的路径」和「写入前的原文」对上，给出每一行的状态。
 *
 * `inputs` 由页面给（它重放历史时就在收集 write/edit，按最近写的在前）。桥只负责解析路径、
 * 查基线、算行数 —— 路径来自已登录页面，读盘这件事它本来就能通过 /api/preview 做，没有新权限。
 *
 * D252: `session` 有值时，再从 assistant 正文明确声明的产物目录补「本次生成」的文件。
 */
export async function listArtifacts(sessionId: string, cwd: string, inputs: ArtifactInput[], session?: ArtifactSession): Promise<ArtifactList> {
  const dir = snapshotDir(sessionId);
  const idx = readIndex(dir);
  const seen = new Set<string>();
  const resolved: Resolved[] = [];
  for (const input of inputs) {
    let abs: string;
    try {
      abs = resolvePreviewPath({ cwd }, String(input.path || ""));
    } catch {
      continue;
    }
    const key = keyOf(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ input: { ...input, writes: Math.max(1, Number(input.writes) || 1) }, abs, rel: path.relative(cwd, abs) });
  }

  const root = resolved.some((r) => !idx.files[keyOf(r.abs)]) ? await gitRoot(cwd) : null;
  const items: ArtifactRow[] = [];
  let exact = 0;

  for (const r of resolved) {
    const st = statOrNull(r.abs);
    const now = st && st.size <= MAX_SNAPSHOT_BYTES ? readOrNull(r.abs) : null;
    const snap = idx.files[keyOf(r.abs)];
    let before: Buffer | null = null;
    let known = false;
    let estimate = false;
    let why: ArtifactWhy | undefined;

    if (snap) {
      before = baselineBytes(dir, snap);
      known = before !== null;
      if (!known && !snap.binary) why = "snapshot-too-big";
      if (before !== null) exact++;
    } else if (root && !r.rel.startsWith("..") && !path.isAbsolute(r.rel)) {
      const rel = r.rel;
      if (await gitTracked(root, rel)) {
        before = await gitHeadBytes(root, rel);
        known = before !== null;
        estimate = known;
        if (!known) why = "git-head-missing";
      } else if (st) {
        before = Buffer.alloc(0);
        known = true;
        estimate = true;
      }
    }
    if (!known && !why) why = "no-baseline";

    const binary = Boolean(snap?.binary) || Boolean(now && looksBinary(now)) || Boolean(!now && before && looksBinary(before));
    const sizeBefore = snap ? (snap.existed ? snap.size : null) : before ? before.length : null;
    const sizeAfter = st ? st.size : null;

    let status: ArtifactStatus = "unknown";
    let added = 0;
    let removed = 0;
    let diffable = false;

    if (known && before) {
      if (!snap?.existed && snap) {
        // 基线明确「当时不存在」。
        if (st) {
          status = "new";
          added = binary ? 0 : countLines(now ? decode(now) : "");
          diffable = !binary;
        } else {
          status = "same";
          why = "built-then-deleted";
        }
      } else if (!st) {
        status = "deleted";
        removed = binary ? 0 : countLines(decode(before));
        diffable = !binary;
      } else if (binary) {
        status = before.length === st.size && now && before.equals(now) ? "same" : "modified";
      } else if (now && before.equals(now)) {
        status = "same";
      } else {
        // 不直接比字节：CRLF ↔ LF 在 diff 里会被归一，比字节会把它算成「整个文件重写」。
        const text = now ? decode(now) : "";
        const d = diffTexts(decode(before), text);
        const unchanged = d.added === 0 && d.removed === 0;
        // too-large 时 diffTexts 回 0/0 —— 那是「没比」，不是「没变」；写成「未变」就是编事实。
        const tooLarge = d.reason === "too-large";
        status = tooLarge ? "unknown" : unchanged ? "same" : "modified";
        added = d.added;
        removed = d.removed;
        diffable = !unchanged && !tooLarge;
        if (tooLarge) why = "diff-too-large";
        else if (d.reason === "rewrite") why = "diff-rewrite";
      }
    } else if (snap && snap.existed && st) {
      // 没存字节但知道当时存在：只能比大小，说清楚这是猜的。
      status = st.size === snap.size && st.mtimeMs === snap.mtime ? "same" : "modified";
      why = snap.binary ? "binary-size-only" : "size-only";
    }

    items.push({
      path: r.input.path,
      abs: r.abs,
      status,
      origin: "tool",
      rel: r.rel.split(path.sep).join("/"),
      tool: r.input.tool || "write",
      writes: r.input.writes,
      added,
      removed,
      estimate,
      binary,
      diffable,
      sizeBefore,
      sizeAfter,
      why,
    });
  }

  // D252: 工具行优先；同一路径被脚本生成过也只留精确基线那一行。
  await appendDeclaredDirectoryArtifacts(items, seen, cwd, session, MAX_FILES - items.length);

  const summary = emptySummary();
  for (const it of items) {
    summary[it.status]++;
    summary.added += it.added;
    summary.removed += it.removed;
  }
  // 目录行没有「写入前原文」这一说，不能把整份清单拖成 partial/none。
  const toolItems = items.filter((it) => it.origin === "tool");
  const baseline = toolItems.length === 0
    ? "exact"
    : exact === toolItems.length ? "exact" : exact === 0 ? "none" : "partial";
  return { items, summary, baseline };
}

// ------------------------------------------------------------------ D252: 会话声明的目录
function slash(p: string): string {
  return p.split(path.sep).join("/");
}

function under(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 流式扫整份会话 JSONL，只认 assistant 正文里的「产物（`绝对目录`）」。
 *
 * 不能只读尾部：真实「功能测试」会话的声明在第 520 行，之后又写了 1,477,819 字节，
 * 512 KB 的尾巴窗口会把声明挤出去。用 readline 逐行读，内存不随会话长度增长；
 * system / thinking / 工具输出 / 压缩摘要都不算声明。
 */
async function declaredDirectories(session: ArtifactSession | undefined, cwd: string): Promise<string[]> {
  const file = session?.file;
  if (!file || !session?.startedAt) return [];
  const root = path.resolve(cwd);
  const dirs = new Set<string>();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      // 绝大多数行与产物无关；先做便宜的预筛，别为每行都 JSON.parse 一遍。
      // 中文若被序列化成 \uXXXX，这里也要放行，JSON.parse 会还原成「产物」。
      if (!line.includes("产物") && !line.includes("\\u4ea7\\u7269")) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
      const content = entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type !== "text" || typeof part.text !== "string") continue;
        const re = /产物\*{0,2}\s*[（(]\s*`([^`]+)`/g;
        for (let m = re.exec(part.text); m; m = re.exec(part.text)) {
          const raw = String(m[1] || "").trim().replace(/^["']|["']$/g, "");
          // 必须是绝对路径；相对路径、URL、文件名一概不扫。
          if (!raw || !path.isAbsolute(raw)) continue;
          const abs = path.resolve(raw);
          if (!under(abs, root)) continue;
          const rel = path.relative(root, abs);
          if (rel.split(path.sep).some((seg) => FORBIDDEN_DIR_NAMES.has(seg))) continue;
          // 拒绝符号链接把扫描带到 cwd 外。
          let real: string;
          try { real = fs.realpathSync(abs); } catch { continue; }
          if (!under(real, root)) continue;
          try { if (!fs.statSync(real).isDirectory()) continue; } catch { continue; }
          dirs.add(real);
        }
      }
    }
  } catch {
    // 会话文件正被写 / 中途被删：已收集到的声明照样算数，不要让弹窗整个挂掉。
  } finally {
    rl.close();
  }
  return [...dirs];
}

function fileBinary(abs: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(8192);
    const got = fs.readSync(fd, buf, 0, buf.length, 0);
    return looksBinary(buf.subarray(0, Math.max(0, got)));
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

interface DeclaredFile {
  abs: string;
  dir: string;
  st: fs.Stats;
}

/** 只收常规文件：符号链接、设备文件、构建缓存都不碰。 */
function walkDeclaredFiles(dir: string, out: DeclaredFile[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_DIR_SCAN_ENTRIES) return;
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink() || FORBIDDEN_DIR_NAMES.has(e.name)) continue;
    if (e.isDirectory()) {
      walkDeclaredFiles(abs, out);
    } else if (e.isFile()) {
      let st: fs.Stats;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isFile()) out.push({ abs, dir, st });
    }
  }
}

async function appendDeclaredDirectoryArtifacts(
  items: ArtifactRow[],
  seen: Set<string>,
  cwd: string,
  session: ArtifactSession | undefined,
  cap: number,
): Promise<void> {
  if (cap <= 0) return;
  const startedMs = Date.parse(String(session?.startedAt || ""));
  if (!Number.isFinite(startedMs)) return;
  const all: { file: DeclaredFile; root: string }[] = [];
  for (const dir of await declaredDirectories(session, cwd)) {
    const found: DeclaredFile[] = [];
    walkDeclaredFiles(dir, found);
    for (const file of found) all.push({ file, root: dir });
  }
  all.sort((a, b) => b.file.st.mtimeMs - a.file.st.mtimeMs);

  for (const { file, root } of all) {
    if (items.length >= MAX_FILES) break;
    const key = keyOf(file.abs);
    if (seen.has(key)) continue;
    if (file.st.mtimeMs < startedMs - DECLARED_MTIME_SLACK_MS) continue;
    seen.add(key);
    items.push({
      path: slash(path.relative(cwd, file.abs)),
      abs: file.abs,
      status: "generated",
      origin: "directory",
      group: `${slash(root)}/`,
      declared: true,
      rel: slash(path.relative(root, file.abs)),
      tool: "",
      writes: 0,
      added: 0,
      removed: 0,
      estimate: false,
      binary: fileBinary(file.abs),
      diffable: false,
      sizeBefore: null,
      sizeAfter: file.st.size,
      why: "generated-no-baseline",
    });
    cap--;
    if (cap <= 0) break;
  }
}

// ------------------------------------------------------------------ 单个文件的差异
export async function diffArtifact(sessionId: string, cwd: string, rawPath: string): Promise<ArtifactDiff> {
  const abs = resolvePreviewPath({ cwd }, rawPath);
  const dir = snapshotDir(sessionId);
  const idx = readIndex(dir);
  const snap = idx.files[keyOf(abs)];
  const st = statOrNull(abs);
  const now = st && st.size <= MAX_SNAPSHOT_BYTES ? readOrNull(abs) : null;

  let before: Buffer | null = null;
  let estimate = false;
  let status: ArtifactStatus = "unknown";
  if (snap) {
    before = baselineBytes(dir, snap);
    status = !snap.existed ? "new" : st ? "modified" : "deleted";
    if (!snap.existed) before = Buffer.alloc(0);
  } else {
    const root = await gitRoot(cwd);
    const rel = root ? path.relative(root, abs) : "";
    if (root && rel && !rel.startsWith("..") && !path.isAbsolute(rel) && (await gitTracked(root, rel))) {
      before = await gitHeadBytes(root, rel);
      estimate = true;
      status = st ? "modified" : "deleted";
    }
  }

  const binary = Boolean(snap?.binary) || Boolean(now && looksBinary(now)) || Boolean(!now && before && looksBinary(before));
  const base: ArtifactDiff = {
    path: rawPath,
    abs,
    status,
    estimate,
    binary,
    added: 0,
    removed: 0,
    hunks: [],
    truncated: false,
    sizeBefore: before ? before.length : null,
    sizeAfter: st ? st.size : null,
  };
  // 二进制只报大小变化，没有字节也没什么可说的 —— 先于 no-baseline 判断。
  if (binary) return { ...base, reason: "binary" };
  if (before === null) {
    return { ...base, reason: "no-baseline" };
  }

  const beforeText = decode(before);
  const afterText = !st ? "" : now ? decode(now) : "";
  if (!st) {
    const d = diffTexts(beforeText, "");
    return { ...base, status: "deleted", added: d.added, removed: d.removed, hunks: d.hunks, truncated: d.truncated, reason: d.reason };
  }
  if (!now && st.size > MAX_SNAPSHOT_BYTES) {
    return { ...base, status: "modified", reason: "too-large" };
  }
  const d = diffTexts(beforeText, afterText);
  const same = d.added === 0 && d.removed === 0;
  return {
    ...base,
    status: same ? "same" : snap && !snap.existed ? "new" : "modified",
    added: d.added,
    removed: d.removed,
    hunks: d.hunks,
    truncated: d.truncated,
    reason: d.reason,
  };
}

/** 删会话时一起清掉（跟 trash / logs 一样的生命周期，D208）。 */
export function forgetSession(sessionId: string): void {
  try {
    fs.rmSync(snapshotDir(sessionId), { recursive: true, force: true });
  } catch {
    /* 删不掉只是留垃圾，不影响会话本身 */
  }
}
