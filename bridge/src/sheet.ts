import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { applyCsvEdits, readCsv, writeCsv, type CsvDoc } from "./csv.ts";
import { applyCellEdits, type CellEdit } from "./xlsx-write.ts";
import type { SheetDoc, SheetMeta, WireCell } from "./sheet-types.ts";

/**
 * 页面上的「表」：一支 worker 一份工作簿，按窗口取格子（D116）。
 *
 * 生命周期：`/api/sheet/open` 建会话（同一份文件同一 mtime 复用），`window` / `find` 按 token 复用，
 * 空闲 5 分钟或超过 3 支就收掉。保存走 D113 的写锁，key 是文件路径。
 */

const SHEET_EXT = new Set([".xlsx", ".xlsm", ".csv", ".tsv"]);
export const isSheetFile = (file: string): boolean => SHEET_EXT.has(path.extname(file).toLowerCase());

const IDLE_MS = 5 * 60 * 1000;
const MAX_WORKERS = 3;

interface Session {
  token: string;
  file: string;
  mtime: number;
  size: number;
  worker: Worker | null;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>;
  seq: number;
  at: number;
  doc: SheetDoc;
  csv: CsvDoc | null;
}

const sessions = new Map<string, Session>();

function workerFile(): URL {
  const js = new URL("./sheet-worker.js", import.meta.url);
  try {
    if (fs.existsSync(fileURLToPath(js))) return js;
  } catch {
    /* fallthrough */
  }
  return new URL("./sheet-worker.ts", import.meta.url);
}

function spawn(file: string): Worker {
  const worker = new Worker(workerFile(), { workerData: { file } });
  worker.unref();
  return worker;
}

function waitFor<T>(session: Session, job: Record<string, unknown>): Promise<T> {
  const worker = session.worker;
  if (!worker) return Promise.reject(new Error("表格会话已经关了，重新打开一次"));
  const id = ++session.seq;
  session.at = Date.now();
  return new Promise<T>((resolve, reject) => {
    session.pending.set(id, { resolve, reject });
    worker.postMessage({ ...job, id });
    setTimeout(() => {
      if (!session.pending.has(id)) return;
      session.pending.delete(id);
      reject(new Error("读这张表超时了"));
    }, 30_000).unref?.();
  });
}

function wire(session: Session): void {
  const worker = session.worker!;
  worker.on("message", (msg: any) => {
    const slot = session.pending.get(msg?.id);
    if (!slot) return;
    session.pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg.data);
    else slot.reject(new Error(String(msg.error ?? "读表失败")));
  });
  worker.on("error", (err) => {
    for (const slot of session.pending.values()) slot.reject(err);
    session.pending.clear();
    session.worker = null;
  });
  worker.on("exit", () => {
    session.worker = null;
  });
}

function kill(session: Session): void {
  sessions.delete(session.token);
  void session.worker?.terminate();
  session.worker = null;
}

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) if (now - session.at > IDLE_MS) kill(session);
}, 60_000).unref?.();

function prune(): void {
  while (sessions.size >= MAX_WORKERS) {
    let oldest: Session | null = null;
    for (const s of sessions.values()) if (!oldest || s.at < oldest.at) oldest = s;
    if (!oldest) break;
    kill(oldest);
  }
}

// ---------------------------------------------------------------- csv

function csvDoc(file: string, st: fs.Stats): SheetDoc {
  const csv = readCsv(fs.readFileSync(file));
  const name = path.basename(file, path.extname(file));
  const rows = csv.rows;
  const colCount = Math.max(1, ...rows.map((r) => r.length));
  const widths: { w: number }[] = [];
  for (let c = 0; c < colCount; c++) {
    let chars = 4;
    for (let r = 0; r < Math.min(rows.length, 400); r++) chars = Math.max(chars, (rows[r]?.[c] ?? "").length);
    widths.push({ w: Math.min(420, chars * 7 + 12) });
  }
  const meta: SheetMeta = {
    name,
    index: 0,
    hidden: false,
    rowCount: rows.length,
    colCount,
    defColW: 64,
    defRowH: 20,
    cols: widths,
    rows: {},
    merges: [],
    freeze: { rows: 0, cols: 0 },
    charts: [],
    cfRanges: 0,
  };
  return {
    path: file,
    name: path.basename(file),
    mtime: st.mtimeMs,
    size: st.size,
    mode: "full",
    cells: rows.length * colCount,
    sheets: [meta],
    csv: { encoding: csv.dialect.encoding, delimiter: csv.dialect.delimiter === "\t" ? "\\t" : csv.dialect.delimiter, bom: csv.dialect.bom, eol: csv.dialect.eol },
  };
}

const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function csvWindow(session: Session, r0: number, r1: number, c0: number, c1: number): { cells: WireCell[]; styles: never[]; cfs: never[] } {
  const rows = session.csv?.rows ?? [];
  const cells: WireCell[] = [];
  for (let r = Math.max(0, r0); r <= r1 && r < rows.length; r++) {
    const row = rows[r] ?? [];
    for (let c = Math.max(0, c0); c <= c1 && c < row.length; c++) {
      const text = row[c] ?? "";
      if (text === "") continue;
      const numeric = NUMERIC.test(text) && text.length < 16;
      cells.push(numeric ? { r, c, k: "n", v: Number(text), t: text, s: -1 } : { r, c, k: "s", v: text, t: text, s: -1 });
    }
  }
  return { cells, styles: [], cfs: [] };
}

// ---------------------------------------------------------------- 对外

export interface OpenArgs {
  sessionId: string;
  abs: string;
}

export async function openSheet(abs: string, st: fs.Stats): Promise<SheetDoc> {
  const ext = path.extname(abs).toLowerCase();
  const key = `${abs.toLowerCase()}|${st.mtimeMs}|${st.size}`;
  for (const s of sessions.values()) {
    if (`${s.file.toLowerCase()}|${s.mtime}|${s.size}` === key) {
      s.at = Date.now();
      return s.doc;
    }
  }
  prune();
  const token = crypto.randomBytes(12).toString("base64url");
  if (ext === ".csv" || ext === ".tsv") {
    const doc = csvDoc(abs, st);
    const session: Session = {
      token,
      file: abs,
      mtime: st.mtimeMs,
      size: st.size,
      worker: null,
      pending: new Map(),
      seq: 0,
      at: Date.now(),
      doc,
      csv: readCsv(fs.readFileSync(abs)),
    };
    doc.token = token;
    sessions.set(token, session);
    return doc;
  }
  const worker = spawn(abs);
  const session: Session = {
    token,
    file: abs,
    mtime: st.mtimeMs,
    size: st.size,
    worker,
    pending: new Map(),
    seq: 0,
    at: Date.now(),
    doc: null as unknown as SheetDoc,
    csv: null,
  };
  wire(session);
  const opened = await waitFor<{ doc: Omit<SheetDoc, "path" | "name" | "mtime" | "size"> }>(session, { op: "open" });
  const doc: SheetDoc = {
    path: abs,
    name: path.basename(abs),
    mtime: st.mtimeMs,
    size: st.size,
    ...opened.doc,
  };
  doc.token = token;
  session.doc = doc;
  sessions.set(token, session);
  return doc;
}

function need(token: string): Session {
  const session = sessions.get(token);
  if (!session) throw Object.assign(new Error("这张表已经关了，重新打开一次"), { status: 404 });
  session.at = Date.now();
  return session;
}

/** token 只对自己的文件有效：页面顺手改个 sheet 名也读不到别人的表。 */
function own(session: Session, sheet: string): void {
  if (!session.doc.sheets.some((s) => s.name === sheet)) throw Object.assign(new Error(`这张表里没有「${sheet}」`), { status: 404 });
}

export async function sheetWindow(token: string, sheet: string, r0: number, r1: number, c0: number, c1: number) {
  const session = need(token);
  own(session, sheet);
  if (!session.worker) return csvWindow(session, r0, r1, c0, c1);
  return waitFor<{ cells: WireCell[]; styles: unknown[]; cfs: unknown[] }>(session, { op: "window", sheet, r0, r1, c0, c1 });
}

export async function sheetFind(token: string, sheet: string, q: string, row: number, col: number) {
  const session = need(token);
  own(session, sheet);
  if (!session.worker) {
    const needle = q.toLowerCase();
    const hits: { r: number; c: number }[] = [];
    const rows = session.csv?.rows ?? [];
    for (let r = Math.max(0, row); r < rows.length; r++) {
      for (let c = 0; c < (rows[r]?.length ?? 0); c++) {
        if (r === row && c <= col) continue;
        if ((rows[r][c] ?? "").toLowerCase().includes(needle)) hits.push({ r, c });
      }
    }
    return { hits: hits.slice(0, 200), more: hits.length > 200 };
  }
  return waitFor<{ hits: { r: number; c: number }[]; more: boolean }>(session, { op: "find", sheet, q, row, col });
}

/** 文件被改过之后（excel 存了盘、pi 改了它），把会话作废，下次打开重新解析。 */
export function dropSheet(abs: string): void {
  for (const s of [...sessions.values()]) if (s.file.toLowerCase() === abs.toLowerCase()) kill(s);
}

export function sheetTokenFor(abs: string): string | null {
  for (const s of sessions.values()) if (s.file.toLowerCase() === abs.toLowerCase()) return s.token;
  return null;
}

export interface SaveArgs {
  token: string;
  groups: { sheet: string; edits: CellEdit[] }[];
  copy?: boolean;
  mtime: number;
  size: number;
}

export interface SaveOut {
  path: string;
  mtime: number;
  size: number;
  mode?: string;
}

function uniqueCopy(file: string): string {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  for (let i = 1; i < 100; i++) {
    const cand = path.join(dir, i === 1 ? `${base}.copy${ext}` : `${base}.copy-${i}${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  throw Object.assign(new Error("副本文档太多了，先清理一下"), { status: 409 });
}

function writeAtomic(target: string, bytes: Buffer): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* renamed already */
    }
    throw err;
  }
}

/** 把改过的格子写回。真写之前先比 mtime + size，撞了就 409 让页面弹冲突条。 */
export function saveSheet(input: SaveArgs): SaveOut {
  const session = need(input.token);
  const ext = path.extname(session.file).toLowerCase();
  const groups = Array.isArray(input.groups) ? input.groups : [];
  for (const group of groups) own(session, group.sheet);
  const source = session.file;
  if (!isSheetFile(source)) throw Object.assign(new Error("这个文件不是表格"), { status: 400 });
  let st: fs.Stats;
  try {
    st = fs.statSync(source);
  } catch {
    throw Object.assign(new Error(`文件不见了：${source}`), { status: 404 });
  }
  if (!input.copy && (Math.abs(st.mtimeMs - Number(input.mtime)) > 0.5 || st.size !== Number(input.size))) {
    throw Object.assign(new Error("文件在你编辑期间被改过了"), { status: 409 });
  }
  const target = input.copy ? uniqueCopy(source) : source;
  const total = groups.reduce((n, g) => n + g.edits.length, 0);
  if (!total) return { path: target, mtime: st.mtimeMs, size: st.size };
  let bytes: Buffer;
  let mode = "";
  if (ext === ".csv" || ext === ".tsv") {
    const csv = readCsv(fs.readFileSync(source));
    const merged = groups.flatMap((g) => g.edits);
    bytes = writeCsv(csv, applyCsvEdits(csv.rows, merged));
  } else {
    const out = applyCellEdits(fs.readFileSync(source), groups);
    bytes = out.bytes;
    mode = out.mode;
  }
  writeAtomic(target, bytes);
  const after = fs.statSync(target);
  if (!input.copy) dropSheet(source);
  return { path: target, mtime: after.mtimeMs, size: after.size, mode };
}

/** token → 它对应的文件（stat 用；不让页面拿 token 去 stat 别的路径）。 */
export function sheetFileOf(token: string): string | null {
  return sessions.get(token)?.file ?? null;
}

export function sheetStat(abs: string): { mtime: number; size: number } | null {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? { mtime: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}
