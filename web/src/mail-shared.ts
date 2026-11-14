/**
 * 邮箱面板与 `/api/mail/*` 之间的形状。凭据只有掩码 —— 桥从不把授权码发下来。
 *
 * 单独一份而不是塞进 `types.ts`：面板、api、测试三处都要用，而 `types.ts` 已经很大了。
 */

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
  { key: "read", label: "读邮件", hint: "列文件夹、读正文；关掉后 AI 只能看到「有几封未读」" },
  { key: "send", label: "发邮件", hint: "关掉后 AI 写好的信只能当草稿给你自己发" },
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

/** 附件大小：与 Jira 面板的 `formatBytes` 同一口径（B / KB / MB，KB 起不进位小数）。 */
export function sizeText(n: number): string {
  if (!n || n < 0) return "0B";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
