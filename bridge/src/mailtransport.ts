/**
 * 邮箱的网络层：IMAP 读、SMTP 发、草稿 APPEND。上层只跟这里的 `MailError` 打交道。
 *
 * 为什么用 imapflow 而不是手写 IMAP：网易在 LOGIN 之后要求先发 `ID` 命令，不发就回
 * `Unsafe Login. Please contact kefu@188.com for help`。imapflow 的 `clientInfo` 正好管这件事，
 * 中文 MIME 解码（GBK/GB18030 主题、附件名）也由 mailparser 兜住 —— 这两块自己写全是坑。
 *
 * 每次操作开一条连接、用完就 logout：邮箱面板是低频交互，连接池省下的那点时间不值得多一层
 * 「连接卡在别人手里」的状态。失败一律翻成 `MailError`（带稳定 code），原始文本只留在 message 尾部。
 */
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import type { MailAccount } from "./mailconfig.ts";
// 与 mailoauth 的循环依赖只在函数体里用（`accessTokenFor` / `MailError` 都是模块级导出的值），
// ESM 的循环绑定在这里是安全的：没有任何一侧在模块求值时用到对方。
import { accessTokenFor } from "./mailoauth.ts";

export type MailErrorCode =
  | "auth-failed"
  | "imap-id"
  | "imap-error"
  | "smtp-error"
  | "net"
  | "timeout"
  | "not-found"
  | "too-large"
  /** 参数不对（收件人不是地址、缺 uid 这种）—— 路由按 400 回，别混进 500。 */
  | "bad-input"
  /** 账号需要用户重新走一次 Microsoft 登录（没登录过 / 刷新令牌失效）—— 页面据此弹「用 Microsoft 登录」。 */
  | "oauth-needed"
  /** Microsoft 授权本身没走通（应用 ID、租户、权限没同意）—— 提示里带着可行动的那一步。 */
  | "oauth";

export class MailError extends Error {
  code: MailErrorCode;
  /** 给人看的一句「下一步怎么办」，页面与工具都读它。 */
  hint: string;
  constructor(code: MailErrorCode, message: string, hint = "") {
    super(message);
    this.code = code;
    this.hint = hint || message;
  }
}

const CLIENT_INFO = { name: "pi-web-client", version: "1" };
const CONNECT_MS = 20_000;
const OP_MS = 45_000;
/** 单封邮件超过这个大小就不一次拉全文（面板与工具都只拿得到头与摘要）。 */
const MAX_RAW_BYTES = 25 * 1024 * 1024;
/** 列表一次最多给几封（`limit` 的上限）。 */
const LIST_LIMIT_MAX = 100;
/** 为了挑出「最近的 N 封」而愿意翻多少封信封（见 D264：序号序不一定等于时间序）。 */
const SCAN_BUDGET = 2000;
/** 一次 FETCH 拿多少封（太大服务器会掐，QQ 对长区间不友好）。 */
const SCAN_CHUNK = 200;
/** 按 uid 列表取的时候每条命令带几个 uid。 */
const UID_BATCH = 200;

function classify(err: any): MailError {
  const text = String(err?.responseText ?? err?.message ?? err ?? "");
  const code = String(err?.code ?? "");
  if (/Unsafe Login|kefu@188\.com/i.test(text)) {
    return new MailError("imap-id", text, "网易把这次登录当成不安全客户端。确认用的是「客户端授权码」而不是登录密码，并已开启 IMAP 服务。");
  }
  if (err?.authenticationFailed || /AUTHENTICATIONFAILED|invalid credentials|LOGIN failed|535/i.test(text)) {
    return new MailError("auth-failed", text, "授权码不对，或者邮箱设置里没开 IMAP/SMTP。去邮箱的「设置 → POP3/SMTP/IMAP」重新生成一个授权码。");
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|EAI_AGAIN/i.test(code) || /ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i.test(text)) {
    return new MailError("net", text, "连不上服务器。检查网络，或确认服务器地址与端口填对了（IMAP 993 / SMTP 465）。");
  }
  if (/ETIMEDOUT|timeout/i.test(code) || /timed out|timeout/i.test(text)) {
    return new MailError("timeout", text, "服务器没有及时回应，过一会儿再试。");
  }
  if (err instanceof MailError) return err;
  return new MailError("imap-error", text || "IMAP 操作失败", text || "IMAP 操作失败了。");
}

/**
 * OAuth 账号报「认证失败」时，下一步永远是「重新登录」而不是「重新生成授权码」——
 * 后者对 Outlook / Microsoft 365 根本不存在。只在服务器真的拒了令牌时才翻译，其余错误原样走。
 */
export function authFailureFor(account: MailAccount, e: MailError): MailError {
  if (account.auth !== "oauth" || (e.code !== "auth-failed" && e.code !== "imap-id")) return e;
  return new MailError(
    "oauth-needed",
    e.message,
    "Microsoft 登录已经不被服务器接受了（令牌过期或被撤销）。在邮箱面板里点「重新登录」。",
  );
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MailError("timeout", `${what}超时（${Math.round(ms / 1000)}s）`, `${what}没有及时回应，过一会儿再试。`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * IMAP 的认证块。OAuth 账号用 access token（imapflow 会发 AUTHENTICATE XOAUTH2），
 * 授权码账号还是 LOGIN。令牌在每次连接时现拿（过期就顺手刷新）。
 */
async function imapAuth(account: MailAccount): Promise<{ user: string; pass?: string; accessToken?: string }> {
  if (account.auth === "oauth") return { user: account.user, accessToken: await accessTokenFor(account) };
  return { user: account.user, pass: account.secret };
}

async function clientFor(account: MailAccount): Promise<ImapFlow> {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: await imapAuth(account),
    clientInfo: CLIENT_INFO,
    logger: false,
    socketTimeout: OP_MS,
    greetingTimeout: CONNECT_MS,
  } as ConstructorParameters<typeof ImapFlow>[0]);
}

/** 开一条连接跑 fn，无论成败都 logout。错误统一翻成 MailError。 */
export async function withImap<T>(account: MailAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  if (account.auth !== "oauth" && !account.secret) {
    throw new MailError("auth-failed", "没有授权码", "这个账号还没填授权码。在邮箱设置里补上，或重新生成一个。");
  }
  const client = await clientFor(account);
  try {
    await withTimeout(client.connect(), CONNECT_MS, "连接 IMAP");
    return await fn(client);
  } catch (err) {
    throw authFailureFor(account, classify(err));
  } finally {
    try {
      await client.logout();
    } catch {
      // 连接可能已经断了；logout 失败不影响结果。
    }
  }
}

// ---------------------------------------------------------------- 文件夹

export interface MailFolder {
  path: string;
  name: string;
  specialUse: string | null;
  /** 网关口径：发信后要往「已发送」里放一份时用它。 */
  kind: "inbox" | "drafts" | "sent" | "trash" | "junk" | "other";
}

function kindOf(path: string, specialUse: string | null | undefined): MailFolder["kind"] {
  const s = String(specialUse ?? "").toLowerCase();
  const p = path.toLowerCase();
  if (s === "\\inbox" || p === "inbox") return "inbox";
  if (s === "\\drafts" || p.includes("draft") || p.includes("草稿")) return "drafts";
  if (s === "\\sent" || p.includes("sent") || p.includes("已发送")) return "sent";
  if (s === "\\trash" || p.includes("trash") || p.includes("deleted") || p.includes("已删除")) return "trash";
  if (s === "\\junk" || p.includes("junk") || p.includes("spam") || p.includes("垃圾")) return "junk";
  return "other";
}

export async function listFolders(account: MailAccount): Promise<MailFolder[]> {
  return withImap(account, async (client) => {
    const rows = await client.list();
    return rows.map((row: any) => ({
      path: String(row.path),
      name: String(row.name ?? row.path),
      specialUse: row.specialUse ?? null,
      kind: kindOf(String(row.path), row.specialUse),
    }));
  });
}

/** 草稿 / 已发送这类目标文件夹：先认 special-use，再按名字猜，最后回退到给定默认值。 */
export function pickFolder(folders: MailFolder[], kind: MailFolder["kind"], fallback: string): string {
  return folders.find((f) => f.kind === kind)?.path ?? fallback;
}

// ---------------------------------------------------------------- 列表

export interface MailSummary {
  uid: number;
  subject: string;
  from: string;
  fromAddress: string;
  date: number;
  unread: boolean;
  hasAttachments: boolean;
  size: number;
}

function addrText(a: any): string {
  if (!a) return "";
  const name = String(a.name ?? "").trim();
  const address = String(a.address ?? "").trim();
  if (name && address) return `${name} <${address}>`;
  return name || address;
}

function countParts(node: any): number {
  if (!node) return 0;
  // 📎 只算真正的附件。内嵌图片（`Content-Disposition: inline` + Content-ID）属于正文，
  // 以前把它们也算进去，营销邮件每封都挂一个回形针，反而看不出哪封真带文件。
  if (String(node.disposition ?? "").toLowerCase() === "attachment") return 1;
  let n = 0;
  for (const child of node.childNodes ?? []) n += countParts(child);
  return n;
}

export interface ListOptions {
  limit?: number;
  /** 跳过最近几封（按时间倒序），用来翻页。 */
  offset?: number;
  unreadOnly?: boolean;
}

/** 信封查询：**不要** bodyStructure —— 扫描时它又大又用不上，选定之后再补。 */
const ENVELOPE_QUERY = { envelope: true, flags: true, uid: true, size: true, internalDate: true } as const;

/**
 * 从「最后一封」往回切序号区间，按从新到旧返回，总共不超过 budget 封。
 *
 * 纯函数，方便单测：`exists=450, budget=2000, chunk=200` → `{251:450}` 一段；
 * `exists=450, budget=300` → `{151:450}`（第二段只要 250:450 里剩下的 300 封，就从 251 开始往回数）。
 */
export function seqWindows(exists: number, budget: number, chunk: number): { start: number; end: number }[] {
  const total = Math.max(0, Math.min(Math.floor(exists), Math.max(0, Math.floor(budget))));
  const size = Math.max(1, Math.floor(chunk));
  const out: { start: number; end: number }[] = [];
  let end = Math.floor(exists);
  let left = total;
  while (left > 0 && end >= 1) {
    const take = Math.min(size, left);
    const start = Math.max(1, end - take + 1);
    out.push({ start, end });
    left -= end - start + 1;
    end = start - 1;
  }
  return out;
}

/** 时间倒序（拿不到时间的排最后）。纯函数。 */
export function orderByDateDesc<T extends { date: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (b.date || 0) - (a.date || 0));
}

/** 翻页：跳过 offset 封，取 limit 封。纯函数。 */
export function takeWindow<T>(rows: T[], limit: number, offset: number): T[] {
  const from = Math.max(0, Math.floor(offset) || 0);
  const size = Math.max(1, Math.floor(limit) || 1);
  return rows.slice(from, from + size);
}

function summaryOf(msg: any, unread: boolean): MailSummary {
  const from = msg.envelope?.from?.[0];
  const stamp = msg.internalDate ? new Date(msg.internalDate).getTime() : new Date(msg.envelope?.date ?? 0).getTime();
  return {
    uid: Number(msg.uid),
    subject: String(msg.envelope?.subject ?? "(无主题)"),
    from: addrText(from),
    fromAddress: String(from?.address ?? ""),
    date: Number.isFinite(stamp) ? stamp || 0 : 0,
    unread,
    hasAttachments: false,
    size: Number(msg.size ?? 0),
  };
}

/**
 * internalDate ≥ `cutoff` 的信，是不是都已经在 `seen` 里了？
 *
 * 这是「扫描窗口够不够」的证明：只要比我们第 want 封更新的信全都扫到了，那按时间排出来的前 want
 * 封就是真的前 want 封 —— 不必把整箱信封都拉下来（D264）。一次 SEARCH 比多扫几百封信封便宜得多。
 */
async function noNewerOutside(client: ImapFlow, seen: Set<number>, cutoff: number): Promise<boolean> {
  // SINCE 只认到「天」，而且 imapflow 按 UTC 拼日期、服务器按自己的时区比 —— 两边差一天是常事。
  // 往回退一天，让检查偏「宽」：只会多扫，不会少扫（少扫才是错的）。
  const since = new Date(cutoff - 24 * 60 * 60 * 1000);
  const hit = (await client.search({ since }, { uid: true })) as number[] | false;
  if (!Array.isArray(hit)) return false;
  for (const uid of hit) if (!seen.has(Number(uid))) return false;
  return true;
}

/**
 * 从最新到达的一批往回扫，直到「按时间的前 want 封」能被证明找全了（或到预算上限）。
 *
 * 为什么不一次拉全：1092 封的信封在这台服务器上要约 6 秒，面板每次刷新都吃这一下受不了。
 * 现在常见的信箱一批（200 封）就够，一次 SEARCH 验完就收手；只有序号序和时间序真的乱到
 * 少数批之外（从备份恢复过的信箱）才会继续往回扫，最坏也就 SCAN_BUDGET 封。
 */
async function scanByDate(client: ImapFlow, exists: number, want: number): Promise<MailSummary[]> {
  const out: MailSummary[] = [];
  const seen = new Set<number>();
  let scanned = 0;
  for (const win of seqWindows(exists, SCAN_BUDGET, SCAN_CHUNK)) {
    for await (const msg of client.fetch(`${win.start}:${win.end}`, ENVELOPE_QUERY)) {
      const row = summaryOf(msg, !msg.flags?.has?.("\\Seen"));
      out.push(row);
      seen.add(row.uid);
    }
    scanned += win.end - win.start + 1;
    const sorted = orderByDateDesc(out);
    if (sorted.length >= Math.max(1, want)) {
      const cutoff = sorted[Math.max(1, want) - 1].date;
      // 少于一批的信箱一次就到底了（end 已经 < 1），不必再问服务器。
      if (!cutoff || win.start <= 1 || (await noNewerOutside(client, seen, cutoff))) break;
    }
    if (scanned >= SCAN_BUDGET) break;
  }
  return out;
}

/**
 * 未读：**先在服务器上 SEARCH UNSEEN**，再只取那些信。
 *
 * 以前是「取最近 N 封，再在本地滤掉已读」—— 未读藏在窗口外面就永远看不到（实测 6 封 vs 23 封）。
 * 未读多到超过扫描预算时取 uid 最大的那批（到达得最晚），代价写在 D264。
 */
async function scanUnseen(client: ImapFlow): Promise<MailSummary[]> {
  const uids = ((await client.search({ seen: false }, { uid: true })) as number[] | false) || [];
  if (!Array.isArray(uids) || !uids.length) return [];
  // 未读多到超过预算时只能取「到达得最晚」的那一批（默认 2000 封之内都是全的）。
  const picked = uids.slice(-SCAN_BUDGET);
  const out: MailSummary[] = [];
  for (let i = 0; i < picked.length; i += UID_BATCH) {
    const batch = picked.slice(i, i + UID_BATCH);
    for await (const msg of client.fetch(batch.join(","), ENVELOPE_QUERY, { uid: true })) {
      out.push(summaryOf(msg, true));
    }
  }
  return out;
}

/** 只为最终要显示的那几封补 bodyStructure（`hasAttachments`）。失败就当没有附件，不拖垮列表。 */
async function fillHasAttachments(client: ImapFlow, rows: MailSummary[]): Promise<void> {
  if (!rows.length) return;
  const uids = rows.map((r) => r.uid);
  const hit = new Map<number, boolean>();
  try {
    for (let i = 0; i < uids.length; i += UID_BATCH) {
      const batch = uids.slice(i, i + UID_BATCH);
      for await (const msg of client.fetch(batch.join(","), { bodyStructure: true, uid: true }, { uid: true })) {
        hit.set(Number(msg.uid), countParts(msg.bodyStructure) > 0);
      }
    }
  } catch {
    return;
  }
  for (const row of rows) row.hasAttachments = hit.get(row.uid) ?? false;
}

/**
 * 列邮件：**按时间挑最近的，不按序号挑**。
 *
 * 序号（`1:*` 的顺序）是「进这个文件夹的先后」，不是邮件时间：从别处搬回来 / 从备份恢复过的信箱里，
 * 两回事。以前「取最后 limit 个序号再按时间排」在这种信箱上会给出一个既不是最近、又互相错位的窗口
 * （用户报的「邮件不全，只看到 2022 年」就是这么来的，见 D264）。现在的做法：往回扫到预算为止，
 * 按时间排好，再 `slice(offset, offset+limit)`。
 */
export async function listMessages(account: MailAccount, folder: string, opts: ListOptions = {}): Promise<MailSummary[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20) || 1, 1), LIST_LIMIT_MAX);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0) || 0);
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const exists = Number((client.mailbox as any)?.exists ?? 0);
      if (!exists) return [];
      const rows = opts.unreadOnly ? await scanUnseen(client) : await scanByDate(client, exists, limit + offset);
      const picked = takeWindow(orderByDateDesc(rows), limit, offset);
      await fillHasAttachments(client, picked);
      return picked;
    } finally {
      lock.release();
    }
  });
}

// ---------------------------------------------------------------- 读一封

export interface MailAttachmentInfo {
  index: number;
  filename: string;
  size: number;
  contentType: string;
  /** `Content-ID`（去掉尖括号）；内嵌图片才有。 */
  contentId: string | null;
  /** 正文里引用的内嵌资源（`multipart/related` / `Content-Disposition: inline`）。 */
  inline: boolean;
}

export interface MailDetail {
  uid: number;
  subject: string;
  from: string;
  fromAddress: string;
  to: string[];
  cc: string[];
  date: number;
  messageId: string;
  text: string;
  html: string | null;
  attachments: MailAttachmentInfo[];
}

async function fetchRaw(account: MailAccount, folder: string, uid: number): Promise<Buffer> {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      // 先只问大小、再决定要不要拉正文：以前是 source + size 一起要，25MB 的闸门在**下载完之后**
      // 才判，等于没挡（D264）。
      const meta: any = await client.fetchOne(String(uid), { size: true }, { uid: true });
      if (!meta) throw new MailError("not-found", `找不到 uid=${uid} 这封信`, "邮件可能已经被移动或删除，刷新一下列表。");
      if (Number(meta.size ?? 0) > MAX_RAW_BYTES) {
        throw new MailError("too-large", `这封信 ${Math.round(Number(meta.size) / 1024 / 1024)}MB，太大了`, "超过 25MB 的邮件请在邮箱客户端里看。");
      }
      const one: any = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!one || !one.source) throw new MailError("not-found", `找不到 uid=${uid} 这封信`, "邮件可能已经被移动或删除，刷新一下列表。");
      const raw = Buffer.isBuffer(one.source) ? one.source : Buffer.from(one.source);
      if (raw.length > MAX_RAW_BYTES) {
        throw new MailError("too-large", `这封信 ${Math.round(raw.length / 1024 / 1024)}MB，太大了`, "超过 25MB 的邮件请在邮箱客户端里看。");
      }
      return raw;
    } finally {
      lock.release();
    }
  });
}

interface AddrBox {
  name?: string;
  address?: string;
}

/** `Content-ID` 在不同解析器里带不带尖括号都见过；统一成裸值，`cid:` 匹配才稳。 */
export function contentIdOf(part: any): string {
  return String(part?.contentId ?? part?.cid ?? "")
    .trim()
    .replace(/^<|>$/g, "")
    .trim();
}

/** 内嵌图片：有 Content-ID，且被标成 related / inline。正文里的 `cid:` 就靠它找回来。 */
export function isInlineAttachment(part: any): boolean {
  const cid = contentIdOf(part);
  if (!cid) return false;
  const disposition = String(part?.contentDisposition ?? "").toLowerCase();
  // 有的服务器把内嵌图写成 image/* + Content-ID、不写 Content-Disposition；也算内嵌，
  // 否则它会同时出现在「附件」里，正文里的 cid: 又找不到。
  return part?.related === true || disposition === "inline" || (!disposition && String(part?.contentType ?? "").startsWith("image/"));
}

/** mailparser 的地址是 `AddressObject[]`，每项再包一层 `value`；这里摊平成 {name,address}。 */
function flattenAddress(addr: unknown): AddrBox[] {
  const boxes = Array.isArray(addr) ? addr : addr ? [addr] : [];
  const out: AddrBox[] = [];
  for (const box of boxes as any[]) {
    const vals = box?.value;
    if (Array.isArray(vals)) out.push(...vals);
    else if (box?.address || box?.name) out.push(box);
  }
  return out;
}

function listOf(addr: unknown): string[] {
  return flattenAddress(addr)
    .map((a) => addrText(a))
    .filter(Boolean);
}

export interface ParsedMailSource extends MailDetail {
  _attachments: any[];
}

/**
 * 原始 MIME → 详情。`keepCidLinks` 留给工具口：HTML 里保留 `cid:` 引用，正文不会因为
 * 内嵌图片的 base64 变成几十万字；面板口用默认值，mailparser 会把 `cid:` 换成 data URI，
 * 一张图只下载一次，不用为每张图重新拉整封信。
 */
export async function parseMailSource(
  raw: Buffer,
  uid: number,
  opts: { keepCidLinks?: boolean } = {},
): Promise<ParsedMailSource> {
  const parsed = await simpleParser(raw, { keepCidLinks: opts.keepCidLinks === true });
  const from = flattenAddress(parsed.from)[0];
  return {
    uid,
    subject: String(parsed.subject ?? "(无主题)"),
    from: from ? addrText(from) : "",
    fromAddress: String(from?.address ?? ""),
    to: listOf(parsed.to),
    cc: listOf(parsed.cc),
    date: parsed.date ? new Date(parsed.date).getTime() : 0,
    messageId: String(parsed.messageId ?? ""),
    text: String(parsed.text ?? ""),
    html: parsed.html === false || parsed.html == null ? null : String(parsed.html),
    attachments: (parsed.attachments ?? []).map((a: any, i: number) => ({
      index: i,
      filename: String(a.filename ?? a.contentId ?? "").replace(/^<|>$/g, "").trim() || `attachment-${i + 1}`,
      size: Number(a.size ?? 0),
      contentType: String(a.contentType ?? "application/octet-stream"),
      contentId: contentIdOf(a) || null,
      inline: isInlineAttachment(a),
    })),
    _attachments: parsed.attachments ?? [],
  };
}

export async function readMessage(
  account: MailAccount,
  folder: string,
  uid: number,
  opts: { keepCidLinks?: boolean } = {},
): Promise<MailDetail> {
  const raw = await fetchRaw(account, folder, uid);
  const { _attachments, ...detail } = await parseMailSource(raw, uid, opts);
  void _attachments;
  return detail;
}

export async function readAttachment(
  account: MailAccount,
  folder: string,
  uid: number,
  index: number,
): Promise<{ filename: string; size: number; contentType: string; content: Buffer }> {
  const raw = await fetchRaw(account, folder, uid);
  const parsed = await parseMailSource(raw, uid);
  const hit = (parsed._attachments ?? [])[index];
  if (!hit) throw new MailError("not-found", `没有第 ${index + 1} 个附件`, `这封信的附件清单只有 ${parsed.attachments.length} 项，刷新一下再试。`);
  const content = Buffer.isBuffer(hit.content) ? hit.content : Buffer.from(hit.content ?? []);
  return {
    filename: String(hit.filename ?? `attachment-${index + 1}`),
    size: content.length,
    contentType: String(hit.contentType ?? "application/octet-stream"),
    content,
  };
}

// ---------------------------------------------------------------- 发信 / 草稿

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; path: string }[];
}

/**
 * 收件人串 → 数组。逗号 / 分号 / 换行都算分隔符，**但不切引号和尖括号里的**：
 * `"Doe, John" <j@x.com>, a@y.com` 是两个人，不是一个半。
 */
export function splitRecipients(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw.map((x) => String(x ?? "")) : [String(raw ?? "")];
  const out: string[] = [];
  for (const item of items) {
    let buf = "";
    let quoted = false;
    let angle = 0;
    for (const ch of item) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === "<") angle += 1;
      else if (!quoted && ch === ">" && angle > 0) angle -= 1;
      if (!quoted && angle === 0 && /[,;，；\n]/.test(ch)) {
        out.push(buf);
        buf = "";
        continue;
      }
      buf += ch;
    }
    out.push(buf);
  }
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * SMTP 的认证块。OAuth 账号走 `type: OAuth2`（nodemailer 发 AUTH XOAUTH2），令牌同样现拿。
 * 以前这是同步的，加了 OAuth 之后要等令牌，所以整条发信链路改成 await 它。
 */
async function transportFor(account: MailAccount) {
  const auth =
    account.auth === "oauth"
      ? { type: "OAuth2" as const, user: account.user, accessToken: await accessTokenFor(account) }
      : { user: account.user, pass: account.secret };
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth,
    connectionTimeout: CONNECT_MS,
    greetingTimeout: CONNECT_MS,
    socketTimeout: OP_MS,
  });
}

export async function sendOutgoing(
  account: MailAccount,
  mail: OutgoingMail,
  opts: { dryRun?: boolean } = {},
): Promise<{ messageId: string; response: string; raw?: Buffer }> {
  const attachments = (mail.attachments ?? []).filter((a) => a?.path);
  const msg = {
    from: account.address,
    to: mail.to.join(", "),
    cc: mail.cc?.length ? mail.cc.join(", ") : undefined,
    bcc: mail.bcc?.length ? mail.bcc.join(", ") : undefined,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  };
  try {
    if (opts.dryRun) {
      // 草稿要的是原始 MIME：用 streamTransport 生成同一份内容，不真发。
      const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
      const info: any = await t.sendMail({ ...msg, attachments });
      return { messageId: String(info.messageId ?? ""), response: "draft", raw: Buffer.isBuffer(info.message) ? info.message : Buffer.from(info.message) };
    }
    const transport = await transportFor(account);
    const info: any = await withTimeout(transport.sendMail({ ...msg, attachments }), OP_MS, "发送邮件");
    return { messageId: String(info.messageId ?? ""), response: String(info.response ?? "") };
  } catch (err) {
    const e = authFailureFor(account, classify(err));
    // SMTP 的失败给 SMTP 的码：页面按它区分「授权码错」和「发信被限」。
    if (e.code === "imap-error") throw new MailError("smtp-error", e.message, "SMTP 拒绝了这封信。常见原因是日发信量超限，或收件人被退信策略拦下。");
    throw e;
  }
}

/** 把原始 MIME 塞进「草稿箱」：SMTP 不发，IMAP APPEND。 */
export async function appendDraft(account: MailAccount, raw: Buffer): Promise<string> {
  return withImap(account, async (client) => {
    const rows = await client.list();
    const folders = rows.map((row: any) => ({
      path: String(row.path),
      name: String(row.name ?? row.path),
      specialUse: row.specialUse ?? null,
      kind: kindOf(String(row.path), row.specialUse),
    }));
    const target = pickFolder(folders, "drafts", "Drafts");
    const res: any = await client.append(target, raw, ["\\Draft"]);
    return String(res?.uid ?? "");
  });
}

// ---------------------------------------------------------------- 连通性自检

export interface TestResult {
  imap: { ok: boolean; folders?: number; error?: string; code?: string };
  smtp: { ok: boolean; error?: string; code?: string };
  ok: boolean;
}

export async function testAccount(account: MailAccount): Promise<TestResult> {
  const out: TestResult = { imap: { ok: false }, smtp: { ok: false }, ok: false };
  try {
    const folders = await listFolders(account);
    out.imap = { ok: true, folders: folders.length };
  } catch (err: any) {
    out.imap = { ok: false, error: String(err?.message ?? err), code: err?.code ?? "imap-error" };
  }
  try {
    const transport = await transportFor(account);
    await withTimeout(transport.verify(), CONNECT_MS, "SMTP 握手");
    out.smtp = { ok: true };
  } catch (err: any) {
    const e = classify(err);
    // SMTP 的失败给 SMTP 的码，别让页面以为 IMAP 坏了（`sendOutgoing` 同一条规矩）。
    out.smtp = { ok: false, error: String(err?.message ?? err), code: e.code === "imap-error" ? "smtp-error" : e.code };
  }
  out.ok = out.imap.ok && out.smtp.ok;
  return out;
}
