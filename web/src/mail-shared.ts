/**
 * 邮箱面板与 `/api/mail/*` 之间的形状。凭据只有掩码 —— 桥从不把授权码发下来。
 *
 * 单独一份而不是塞进 `types.ts`：面板、api、测试三处都要用，而 `types.ts` 已经很大了。
 */
import { formatBytes } from "./bytes.ts";

export interface MailEndpoint {
  host: string;
  port: number;
  secure: boolean;
}

/** `publicAccount()` 的镜像：没有 `secret`，只有 `secretMask` / `hasSecret`。 */
export interface MailAccountView {
  id: string;
  label: string;
  address: string;
  preset: string;
  imap: MailEndpoint;
  smtp: MailEndpoint;
  user: string;
  secretMask: string;
  hasSecret: boolean;
  enabled: boolean;
  verifiedAt: number | null;
  lastError: string | null;
}

export interface MailPolicyView {
  read: boolean;
  send: boolean;
  draft: boolean;
  attachments: boolean;
  mutate: boolean;
  confirmSend: boolean;
  recipients: string[];
  dailySendLimit: number;
  accountIds: string[];
}

export interface MailFolderView {
  path: string;
  name: string;
  specialUse: string | null;
  /** `inbox` / `sent` / `drafts` / `trash` / `junk` / `other` */
  kind: string;
}

export interface MailSummary {
  uid: number;
  subject: string;
  from: string;
  date: number;
  unread: boolean;
  hasAttachments: boolean;
}

export interface MailAttachmentView {
  index: number;
  filename: string;
  contentType: string;
  size: number;
}

export interface MailDetailView {
  uid: number;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: number;
  text: string;
  html?: string;
  attachments: MailAttachmentView[];
}

export interface MailAuditRow {
  t: number;
  account: string;
  from: string;
  to: string[];
  subject: string;
  by: string;
  tool?: string;
  ok: boolean;
  error?: string;
  messageId?: string;
}

export interface MailPresetView {
  label: string;
  imap: MailEndpoint;
  smtp: MailEndpoint;
}

export interface MailConfigView {
  accounts: MailAccountView[];
  policy: MailPolicyView;
  defaultAccount: string | null;
  presets: Record<string, MailPresetView>;
  presetIds: string[];
  audit: MailAuditRow[];
  /** config.json 读不出来时的原因（此时 `accounts` 是空的，且桥会拒写）。 */
  configError?: string | null;
  /** 配置文件的本机路径，横幅里给人指路。 */
  configPath?: string;
}

export interface MailAccountInput {
  id?: string;
  label: string;
  address: string;
  preset: string;
  user: string;
  secret: string;
  imap?: MailEndpoint;
  smtp?: MailEndpoint;
  enabled?: boolean;
}

export interface MailSendInput {
  account?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  draft?: boolean;
}

/** 确认弹窗要回答的东西：桥端的 `mail.confirm` 帧带 `reqId` + `mail`。 */
export interface MailConfirmFrame {
  reqId: string;
  sessionId?: string;
  mail: MailConfirmRequest;
}

/** 页面对一条确认请求的回答，走同一条 ws 回给桥。 */
export interface MailConfirmAck {
  reqId: string;
  ok: boolean;
  reason?: string;
  text?: string;
}

/** 桥推给页面的「这封信发不发」。正文只带前 800 字，够认出来是哪封。 */
export interface MailConfirmRequest {
  account: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: string[];
}

export const MAIL_POLICY_LABELS: { key: keyof MailPolicyView; label: string; hint: string }[] = [
  { key: "read", label: "读邮件", hint: "关掉后 AI 读不到任何信，也列不了文件夹" },
  { key: "send", label: "发邮件", hint: "关掉后 AI 发不出去；存草稿由下一项单独管" },
  { key: "draft", label: "存草稿", hint: "允许 AI 往草稿箱里写，但不真的发出去" },
  { key: "attachments", label: "取附件", hint: "允许把附件下载到本机（会写磁盘）" },
  { key: "mutate", label: "改邮箱状态", hint: "已读/未读、归档、移动、删除；默认关" },
  { key: "confirmSend", label: "发送前让我确认", hint: "关掉后 AI 能直接发出，不再问你" },
];

/** 白名单输入框 → 数组：逗号、分号、空白都算分隔符（与桥端 `recipientsDenied` 的语义对得上）。 */
export function parseRecipients(text: string): string[] {
  return String(text ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 审计行的结果：`draft` / `sent` / `failed`。
 *
 * 桥端把「存草稿」也写进同一个审计文件，而两种存法长得不一样：
 * - AI 调 `mail_draft` → `tool: "mail_draft"`；
 * - 页面自己的「存草稿」走 `/api/mail/send` + `draft: true` → 没有 `tool`（桥不知道该叫它什么）。
 * 两者都会写 `messageId: "draft"`（见 `bridge/src/mail.ts` 的 `appendAudit`），所以两个都得认。
 * 只看 `ok` 会把草稿说成「已发出」，用户以为信寄出去了，实际还在草稿箱。
 */
export function auditOutcome(row: { tool?: string; ok: boolean; messageId?: string }): "draft" | "sent" | "failed" {
  if (!row.ok) return "failed";
  if (row.tool === "mail_draft" || row.messageId === "draft") return "draft";
  return "sent";
}

/** 邮件时间：今天只给 `HH:MM`，其余给日期（列表行很窄）。`0` 表示拿不到时间。 */
export function whenText(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const t = new Date(now);
  if (d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 附件大小：和「设置 → 本机管理」的文件表同一口径（`512 B` / `1.5 KB` / `2 MB`，见 `bytes.ts`）。
 *
 * 以前这里自己算一套（`2KB`、`1.0MB`，KB 档还四舍五入成整数）：同一个文件在邮箱面板和本机管理里
 * 显示的位数、空格、单位都不一样，看着像两个值。名字留着，免得三个调用点跟着改。
 */
export function sizeText(n: number): string {
  return formatBytes(n);
}

/*************************************************************** 自定义服务器的端口与 TLS

   以前面板里写死 `secure: !port.startsWith("587")`（SMTP）与恒 `true`（IMAP）：自定义服务器填 143
   / 25 / 110 这些走 STARTTLS 的端口永远连不上。判据收到这里，能单测（D264）。 */

/**
 * 自定义服务器时 TLS 怎么算：先看端口，认不出来再用 IMAP 默认开、SMTP 默认关。
 *
 * 以前是 `secure: !port.startsWith("587")` 一句拍了 SMTP、IMAP 恒 true —— 143 / 25 / 110
 * 这些明文（STARTTLS 升级）的端口永远连不上。
 */
export function secureForPort(port: number, kind: "imap" | "smtp"): boolean {
  if (port === 993 || port === 995 || port === 465) return true;
  if (port === 143 || port === 25 || port === 110 || port === 587) return false;
  return kind === "imap";
}

/** 端口输入框的值 → 端口号：空 / 非数字就用预设的默认值。 */
export function portOf(text: string, fallback: number): number {
  const n = Number(String(text ?? "").trim());
  return Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : fallback;
}

/**
 * 「这封发不发」的排队与回执 —— 不带任何 DOM，面板画不画都归它说了算。
 *
 * 桥一封一个 `reqId`，同时可能压着两封（AI 连着发两封）。规则：
 *   1. 一次只摊开一封，按到达顺序来；
 *   2. 结掉当前那封（点发送 / 不发 / Esc / 超时）之后自动进入下一封；
 *   3. 回执只回给**当前**那封的 `reqId` —— 迟到的点击不会替另一封点头。
 */
export class MailConfirmQueue {
  private readonly send: (ack: MailConfirmAck) => void;
  private readonly onChange: () => void;
  private items: { reqId: string; mail: MailConfirmRequest }[] = [];

  constructor(send: (ack: MailConfirmAck) => void, onChange: () => void = () => {}) {
    this.send = send;
    this.onChange = onChange;
  }

  push(reqId: string, mail: MailConfirmRequest): void {
    if (!reqId || !mail) return;
    this.items.push({ reqId, mail });
    this.onChange();
  }

  /** 正在等回答的那封。 */
  get current(): { reqId: string; mail: MailConfirmRequest } | null {
    return this.items[0] ?? null;
  }

  /** 还压着几封（含当前那封）。 */
  get size(): number {
    return this.items.length;
  }

  /** 结掉当前那封。队列空了 `current` 就是 null。 */
  settle(ok: boolean, reason?: string, text?: string): void {
    const cur = this.items.shift();
    if (!cur) return;
    this.send({ reqId: cur.reqId, ok, reason, text });
    this.onChange();
  }
}
