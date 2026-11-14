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

export type MailErrorCode = "auth-failed" | "imap-id" | "imap-error" | "smtp-error" | "net" | "timeout" | "not-found" | "too-large";

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

function clientFor(account: MailAccount): ImapFlow {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.user, pass: account.secret },
    clientInfo: CLIENT_INFO,
    logger: false,
    socketTimeout: OP_MS,
    greetingTimeout: CONNECT_MS,
  } as ConstructorParameters<typeof ImapFlow>[0]);
}

/** 开一条连接跑 fn，无论成败都 logout。错误统一翻成 MailError。 */
export async function withImap<T>(account: MailAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  if (!account.secret) {
    throw new MailError("auth-failed", "没有授权码", "这个账号还没填授权码。在邮箱设置里补上，或重新生成一个。");
  }
  const client = clientFor(account);
  try {
    await withTimeout(client.connect(), CONNECT_MS, "连接 IMAP");
    return await fn(client);
  } catch (err) {
    throw classify(err);
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
  if (node.disposition === "attachment" || (node.disposition === "inline" && node.filename)) return 1;
  let n = 0;
  for (const child of node.childNodes ?? []) n += countParts(child);
  return n;
}

export interface ListOptions {
  limit?: number;
  unreadOnly?: boolean;
}

export async function listMessages(account: MailAccount, folder: string, opts: ListOptions = {}): Promise<MailSummary[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100);
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const exists = Number((client.mailbox as any)?.exists ?? 0);
      if (!exists) return [];
      // 按序号取最后 limit 封：网易的 UID 不保证连续，序号范围最省事。
      const start = Math.max(1, exists - limit + 1);
      const out: MailSummary[] = [];
      for await (const msg of client.fetch(`${start}:*`, { envelope: true, flags: true, uid: true, bodyStructure: true, size: true, internalDate: true })) {
        const unread = !msg.flags?.has?.("\\Seen");
        if (opts.unreadOnly && !unread) continue;
        const from = msg.envelope?.from?.[0];
        out.push({
          uid: Number(msg.uid),
          subject: String(msg.envelope?.subject ?? "(无主题)"),
          from: addrText(from),
          fromAddress: String(from?.address ?? ""),
          date: (msg.internalDate ? new Date(msg.internalDate).getTime() : new Date(msg.envelope?.date ?? 0).getTime()) || 0,
          unread,
          hasAttachments: countParts(msg.bodyStructure) > 0,
          size: Number(msg.size ?? 0),
        });
      }
      return out.sort((a, b) => b.date - a.date);
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
      const one: any = await client.fetchOne(String(uid), { source: true, size: true }, { uid: true });
      if (!one || !one.source) throw new MailError("not-found", `找不到 uid=${uid} 这封信`, "邮件可能已经被移动或删除，刷新一下列表。");
      if (Number(one.size ?? 0) > MAX_RAW_BYTES) {
        throw new MailError("too-large", `这封信 ${Math.round(Number(one.size) / 1024 / 1024)}MB，太大了`, "超过 25MB 的邮件请在邮箱客户端里看。");
      }
      return Buffer.isBuffer(one.source) ? one.source : Buffer.from(one.source);
    } finally {
      lock.release();
    }
  });
}

interface AddrBox {
  name?: string;
  address?: string;
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

async function parseInto(raw: Buffer, uid: number): Promise<MailDetail & { _attachments: any[] }> {
  const parsed = await simpleParser(raw);
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
    attachments: (parsed.attachments ?? []).map((a, i) => ({
      index: i,
      filename: String(a.filename ?? `attachment-${i + 1}`),
      size: Number(a.size ?? 0),
      contentType: String(a.contentType ?? "application/octet-stream"),
    })),
    _attachments: parsed.attachments ?? [],
  };
}

export async function readMessage(account: MailAccount, folder: string, uid: number): Promise<MailDetail> {
  const raw = await fetchRaw(account, folder, uid);
  const { _attachments, ...detail } = await parseInto(raw, uid);
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
  const parsed = await parseInto(raw, uid);
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

export function splitRecipients(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,;，；\n]/);
  return items.map((x) => String(x ?? "").trim()).filter(Boolean);
}

function transportFor(account: MailAccount) {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.user, pass: account.secret },
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
    const transport = transportFor(account);
    const info: any = await withTimeout(transport.sendMail({ ...msg, attachments }), OP_MS, "发送邮件");
    return { messageId: String(info.messageId ?? ""), response: String(info.response ?? "") };
  } catch (err) {
    const e = classify(err);
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
    const transport = transportFor(account);
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
