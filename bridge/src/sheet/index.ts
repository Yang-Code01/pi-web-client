/**
 * 表格预览的只读凭据与取数入口（D127）。
 *
 * 凭据只由 /api/preview 在预审文件时发放：token → 路径 + mtime。
 * 表格端点不接受前端给的任意路径；mtime 变了就是文件被改过，让用户重新打开。
 */
import fs from "node:fs";
import { readBook, findInSheet, readWindow as readWindowFrom, type Book, type SheetMatches, type SheetWindow, type WorkbookMeta } from "./xlsx.ts";

interface Grant {
  abs: string;
  mtime: number;
  at: number;
}

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_GRANTS = 500;
const grants = new Map<string, Grant>();

/** 预览一个 .xlsx/.xlsm（或任何要交给 Excel 的表格）时登记；只读端点凭这个 token 找文件。 */
export function registerFileGrant(token: string, abs: string, mtime: number): void {
  const now = Date.now();
  for (const [key, grant] of grants) if (now - grant.at > TTL_MS) grants.delete(key);
  if (grants.size >= MAX_GRANTS) {
    const oldest = grants.keys().next().value;
    if (oldest) grants.delete(oldest);
  }
  grants.set(token, { abs, mtime, at: now });
}

export function fileGrant(token: string): Grant | null {
  const grant = grants.get(token);
  if (!grant) return null;
  if (Date.now() - grant.at > TTL_MS) {
    grants.delete(token);
    return null;
  }
  return grant;
}

/** 文件在预览之后被改过（Excel 另存、脚本重写）——旧 token 不再能取数。 */
export function grantIsStale(grant: Grant, mtimeMs: number): boolean {
  return Math.abs(mtimeMs - grant.mtime) > 1;
}

// 只缓存元数据（sheet 清单 / 尺寸 / zip 内路径），不缓存共享字符串或表 XML（D127）。
const books = new Map<string, Book>();
const MAX_BOOKS = 8;

function cacheKey(abs: string, mtimeMs: number, size: number): string {
  return `${abs}\u0000${mtimeMs}\u0000${size}`;
}

async function loadBook(abs: string): Promise<Book> {
  const st = await fs.promises.stat(abs);
  if (!st.isFile()) throw new Error("不是文件");
  const key = cacheKey(abs, st.mtimeMs, st.size);
  const hit = books.get(key);
  if (hit) {
    books.delete(key);
    books.set(key, hit);
    return hit;
  }
  const buf = await fs.promises.readFile(abs);
  const book = readBook(buf);
  books.set(key, book);
  if (books.size > MAX_BOOKS) {
    const oldest = books.keys().next().value;
    if (oldest) books.delete(oldest);
  }
  return book;
}

export async function readMeta(abs: string): Promise<WorkbookMeta> {
  return (await loadBook(abs)).meta;
}

export async function readWindow(
  abs: string,
  sheet: string,
  r0: number,
  r1: number,
  c0: number,
  c1: number,
): Promise<SheetWindow> {
  const book = await loadBook(abs);
  const info = book.meta.sheets.find((s) => s.name === sheet);
  if (!info) throw new Error("找不到这个工作表");
  // 单次窗口设上限：前端再乱要，也不会一次拖走整张表（D127「永不整表发前端」）。
  const rr0 = Math.max(0, Math.min(info.rows - 1, Math.trunc(r0)));
  const rr1 = Math.max(rr0, Math.min(info.rows - 1, Math.trunc(r1), rr0 + 399));
  const cc0 = Math.max(0, Math.min(info.cols - 1, Math.trunc(c0)));
  const cc1 = Math.max(cc0, Math.min(info.cols - 1, Math.trunc(c1), cc0 + 99));
  if (info.rows === 0 || info.cols === 0) return { sheet, r0: 0, r1: 0, c0: 0, c1: 0, rows: [] };
  const buf = await fs.promises.readFile(abs);
  return readWindowFrom(buf, book, sheet, rr0, rr1, cc0, cc1);
}

/** #107：查找。整表扫描，只回坐标；文件版本仍按 loadBook 的缓存来。 */
export async function findSheet(abs: string, sheet: string, query: string): Promise<SheetMatches> {
  const book = await loadBook(abs);
  const buf = await fs.promises.readFile(abs);
  return findInSheet(buf, book, sheet, query);
}
