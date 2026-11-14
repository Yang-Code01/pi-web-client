/**
 * 邮箱面板的配置、策略与审计（这一层不碰网络，纯读写 + 判定）。
 *
 * 三件事分开：
 *   1. `MailConfig` 落 `<状态目录>/mail/config.json`，照 Jira 的惯例存明文凭据 —— 页面只拿掩码，
 *      日志不带凭据（`bridge/src/jira.ts` 同一口径）。想换成 DPAPI 加密是后续的事，别在路由里散着判。
 *   2. `policyDenial()` 是权限的唯一判据：HTTP 路由和 agent 工具都走它，不在别处另写一套「能不能发」。
 *   3. 审计只追加、不进模型上下文 —— 它存在的理由是「谁在什么时候用哪个账号发了什么」能事后查，
 *      顺便当日发信上限的计数来源。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJsonChecked, statePath } from "./paths.ts";

export type MailPreset =
  | "163"
  | "126"
  | "yeah"
  | "qiye163"
  | "qq"
  | "exmail"
  | "aliyun"
  | "aliyunqy"
  | "sina"
  | "189"
  | "gmail"
  | "outlook"
  | "icloud"
  | "yahoo"
  | "zoho"
  | "yandex"
  | "custom";

export interface MailEndpoint {
  host: string;
  port: number;
  secure: boolean;
}

export interface MailAccount {
  id: string;
  label: string;
  address: string;
  preset: MailPreset;
  imap: MailEndpoint;
  smtp: MailEndpoint;
  /** 登录名：网易就是整个地址，但企业邮有别名的情况，所以单独存一份。 */
  user: string;
  /** 客户端授权码（不是登录密码）。页面只看得到掩码。 */
  secret: string;
  enabled: boolean;
  verifiedAt: number | null;
  /** 上次验证失败的原因，只留一行；页面用它解释「为什么没连上」。 */
  lastError: string | null;
}

/** 每个开关拦的是什么，写在 `docs/` 与设置页里；这里只存值。 */
export interface MailPolicy {
  read: boolean;
  send: boolean;
  draft: boolean;
  attachments: boolean;
  mutate: boolean;
  confirmSend: boolean;
  /** 收件人白名单（完整地址或 `@域名`）；空数组 = 不限。 */
  recipients: string[];
  /** 每账号每日成功发信上限；0 = 不限。 */
  dailySendLimit: number;
  /** agent 能用的账号；空数组 = 全部启用账号。 */
  accountIds: string[];
}

export interface MailConfig {
  version: 1;
  accounts: MailAccount[];
  policy: MailPolicy;
  defaultAccount: string | null;
}

export const DEFAULT_POLICY: MailPolicy = {
  read: true,
  send: true,
  draft: true,
  attachments: false,
  mutate: false,
  confirmSend: true,
  recipients: [],
  dailySendLimit: 50,
  accountIds: [],
};

/**
 * 常见邮箱的服务器。网易排在最前（这一栏最常填的就是它），后面按国内、国外分。
 * `custom` 不给默认值 —— 填错了要人说，不要猜。
 *
 * 只列 993/465 这两组「隐式 TLS」的端口，唯一例外是 Outlook 与 iCloud：它们把 587 留给
 * STARTTLS，`secure: false` 时 nodemailer 会自己升级。
 */
export const PRESETS: Record<Exclude<MailPreset, "custom">, { label: string; imap: MailEndpoint; smtp: MailEndpoint }> = {
  "163": {
    label: "163 邮箱",
    imap: { host: "imap.163.com", port: 993, secure: true },
    smtp: { host: "smtp.163.com", port: 465, secure: true },
  },
  "126": {
    label: "126 邮箱",
    imap: { host: "imap.126.com", port: 993, secure: true },
    smtp: { host: "smtp.126.com", port: 465, secure: true },
  },
  yeah: {
    label: "yeah.net",
    imap: { host: "imap.yeah.net", port: 993, secure: true },
    smtp: { host: "smtp.yeah.net", port: 465, secure: true },
  },
  qiye163: {
    label: "网易企业邮",
    imap: { host: "imap.qiye.163.com", port: 993, secure: true },
    smtp: { host: "smtp.qiye.163.com", port: 465, secure: true },
  },
  qq: {
    label: "QQ 邮箱",
    imap: { host: "imap.qq.com", port: 993, secure: true },
    smtp: { host: "smtp.qq.com", port: 465, secure: true },
  },
  exmail: {
    label: "腾讯企业邮",
    imap: { host: "imap.exmail.qq.com", port: 993, secure: true },
    smtp: { host: "smtp.exmail.qq.com", port: 465, secure: true },
  },
  aliyun: {
    label: "阿里云邮箱",
    imap: { host: "imap.aliyun.com", port: 993, secure: true },
    smtp: { host: "smtp.aliyun.com", port: 465, secure: true },
  },
  aliyunqy: {
    label: "阿里企业邮",
    imap: { host: "imap.qiye.aliyun.com", port: 993, secure: true },
    smtp: { host: "smtp.qiye.aliyun.com", port: 465, secure: true },
  },
  sina: {
    label: "新浪邮箱",
    imap: { host: "imap.sina.com", port: 993, secure: true },
    smtp: { host: "smtp.sina.com", port: 465, secure: true },
  },
  "189": {
    label: "天翼邮箱",
    imap: { host: "imap.189.cn", port: 993, secure: true },
    smtp: { host: "smtp.189.cn", port: 465, secure: true },
  },
  gmail: {
    label: "Gmail",
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
  },
  outlook: {
    label: "Outlook / Hotmail",
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
  },
  icloud: {
    label: "iCloud 邮箱",
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
  },
  yahoo: {
    label: "Yahoo 邮箱",
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true },
  },
  zoho: {
    label: "Zoho 邮箱",
    imap: { host: "imap.zoho.com", port: 993, secure: true },
    smtp: { host: "smtp.zoho.com", port: 465, secure: true },
  },
  yandex: {
    label: "Yandex 邮箱",
    imap: { host: "imap.yandex.com", port: 993, secure: true },
    smtp: { host: "smtp.yandex.com", port: 465, secure: true },
  },
};

/**
 * 下拉框里的顺序。不用 `Object.keys(PRESETS)`：`"126"` / `"163"` / `"189"` 是数字样字符串，
 * 会被当成整数键排到最前面，于是 163 落到第二位、天翼跑到 yean 前面。顺序要自己写。
 */
export const PRESET_IDS: MailPreset[] = [
  "163",
  "126",
  "yeah",
  "qiye163",
  "qq",
  "exmail",
  "aliyun",
  "aliyunqy",
  "sina",
  "189",
  "gmail",
  "outlook",
  "icloud",
  "yahoo",
  "zoho",
  "yandex",
  "custom",
];

function configFile(): string {
  return statePath("mail", "config.json");
}

function auditFile(): string {
  return statePath("mail", "audit.jsonl");
}

/** 授权码掩码：16 位留头尾各 2 位。空串原样返回（未填就是未填）。 */
export function maskSecret(secret: string): string {
  const s = String(secret ?? "").trim();
  if (!s) return "";
  if (s.length <= 4) return "*".repeat(s.length);
  return `${s.slice(0, 2)}${"*".repeat(s.length - 4)}${s.slice(-2)}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x)).filter(Boolean);
}

function endpointOf(raw: any, fallback: MailEndpoint): MailEndpoint {
  const port = Number(raw?.port);
  return {
    host: str(raw?.host) || fallback.host,
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : fallback.port,
    secure: bool(raw?.secure, fallback.secure),
  };
}

function presetOf(raw: unknown): MailPreset {
  const p = str(raw) as MailPreset;
  return PRESET_IDS.includes(p) ? p : "custom";
}

/** 坏文件（半截 / 非 JSON / 字段丢失）当「没有这个账号」丢掉，别把面板卡在错误态。 */
export function readMailConfig(): MailConfig {
  const { ok, value } = readJsonChecked<Partial<MailConfig> | null>(configFile(), null);
  const raw = ok && value && typeof value === "object" ? value : {};
  const accounts: MailAccount[] = [];
  for (const item of Array.isArray(raw.accounts) ? raw.accounts : []) {
    const a = item as Partial<MailAccount>;
    const address = str(a.address);
    const secret = str(a.secret);
    if (!address) continue;
    const preset = presetOf(a.preset);
    const fallback = preset === "custom" ? { host: "", port: 993, secure: true } : PRESETS[preset].imap;
    const smtpFallback = preset === "custom" ? { host: "", port: 465, secure: true } : PRESETS[preset].smtp;
    accounts.push({
      id: str(a.id) || `m${randomUUID().slice(0, 8)}`,
      label: str(a.label) || address,
      address,
      preset,
      imap: endpointOf(a.imap, fallback),
      smtp: endpointOf(a.smtp, smtpFallback),
      user: str(a.user) || address,
      secret,
      enabled: bool(a.enabled, true),
      verifiedAt: typeof a.verifiedAt === "number" ? a.verifiedAt : null,
      lastError: a.lastError ? str(a.lastError) : null,
    });
  }
  const p = (raw.policy && typeof raw.policy === "object" ? raw.policy : {}) as Partial<MailPolicy>;
  const policy: MailPolicy = {
    read: bool(p.read, DEFAULT_POLICY.read),
    send: bool(p.send, DEFAULT_POLICY.send),
    draft: bool(p.draft, DEFAULT_POLICY.draft),
    attachments: bool(p.attachments, DEFAULT_POLICY.attachments),
    mutate: bool(p.mutate, DEFAULT_POLICY.mutate),
    confirmSend: bool(p.confirmSend, DEFAULT_POLICY.confirmSend),
    recipients: strList(p.recipients),
    dailySendLimit:
      typeof p.dailySendLimit === "number" && p.dailySendLimit >= 0 ? Math.floor(p.dailySendLimit) : DEFAULT_POLICY.dailySendLimit,
    accountIds: strList(p.accountIds),
  };
  const wanted = str(raw.defaultAccount);
  return {
    version: 1,
    accounts,
    policy,
    defaultAccount: wanted && accounts.some((a) => a.id === wanted) ? wanted : (accounts[0]?.id ?? null),
  };
}

export function writeMailConfig(config: MailConfig): void {
  const file = configFile();
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  // Windows 上没有 POSIX 权限位；别的平台把组/其他用户收掉。尽力而为，不因为失败拒绝保存。
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 尽力而为 */
  }
}

export function findAccount(config: MailConfig, id?: string | null): MailAccount | null {
  if (id) return config.accounts.find((a) => a.id === id) ?? null;
  const def = config.defaultAccount;
  return config.accounts.find((a) => a.id === def) ?? config.accounts.find((a) => a.enabled) ?? config.accounts[0] ?? null;
}

/** 发给页面的形状：永远不含 `secret`。 */
export function publicAccount(a: MailAccount) {
  return {
    id: a.id,
    label: a.label,
    address: a.address,
    preset: a.preset,
    imap: a.imap,
    smtp: a.smtp,
    user: a.user,
    secretMask: maskSecret(a.secret),
    hasSecret: a.secret.length > 0,
    enabled: a.enabled,
    verifiedAt: a.verifiedAt,
    lastError: a.lastError,
  };
}

// ---------------------------------------------------------------- 策略判定

export type MailAction = "read" | "send" | "draft" | "attachments" | "mutate";

const ACTION_LABEL: Record<MailAction, string> = {
  read: "读邮件",
  send: "发邮件",
  draft: "存草稿",
  attachments: "取附件",
  mutate: "改邮箱状态",
};

/**
 * 这个动作允许吗？允许返回 `null`，不允许返回稳定的错误码。
 * 调用方**只**看这个函数，别在路由里自己念 `policy.send`。
 */
export function policyDenial(config: MailConfig, action: MailAction, account?: MailAccount | null): string | null {
  const p = config.policy;
  if (!p[action]) return `policy-denied:${action}`;
  if (account) {
    if (!account.enabled) return "no-account";
    if (p.accountIds.length && !p.accountIds.includes(account.id)) return `policy-denied:account`;
  }
  return null;
}

/** 策略拒绝时给人看的一句话（模型和页面读同一句）。 */
export function denialText(code: string): string {
  const [, key] = code.split(":");
  if (key && key in ACTION_LABEL) return `设置里的「${ACTION_LABEL[key as MailAction]}」是关着的，这次没有执行。`;
  if (key === "account") return "设置里没把这个账号开放给 AI。";
  if (code === "no-account") return "这个账号被停用了（或者没有可用账号）。";
  return "被邮箱设置里的权限挡住了。";
}

/** 白名单校验：`@域名` 后缀匹配，或整串相等（不分大小写）。空白名单 = 不限。 */
export function recipientsDenied(config: MailConfig, addrs: string[]): string[] {
  const list = config.policy.recipients.map((x) => x.toLowerCase());
  if (!list.length) return [];
  return addrs.filter((raw) => {
    const addr = String(raw ?? "").trim().toLowerCase();
    if (!addr) return false;
    if (!addr.includes("@")) return true;
    return !list.some((rule) => rule.startsWith("@") ? addr.endsWith(rule) : addr === rule);
  });
}

// ---------------------------------------------------------------- 审计

export interface AuditEntry {
  t: number;
  account: string;
  from: string;
  to: string[];
  subject: string;
  messageId?: string;
  by: "agent" | "page";
  tool?: string;
  ok: boolean;
  error?: string;
}

function day(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function appendAudit(entry: AuditEntry): void {
  const line = { ...entry, d: day(entry.t) };
  try {
    const file = auditFile();
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    // 审计里有收件人与主题：跟 config.json 一样只给自己读（POSIX 有效，Windows 上无害）。
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* 文件系统不支持就算了，别因为记账失败让一次发送失败 */
    }
  } catch {
    // 记账失败不能让一次发送失败：上层已经发出去了，这里只是少一行历史。
  }
}

/** 当天某账号成功发出的封数。只读尾部 64KB —— 审计文件是只追加的，越老的行越用不着。 */
export function sentToday(accountId: string, now = Date.now()): number {
  let text = "";
  try {
    const file = auditFile();
    const size = fs.statSync(file).size;
    const from = Math.max(0, size - 64 * 1024);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
  const want = day(now);
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.ok && row?.d === want && row?.account === accountId) n++;
    } catch {
      // 半截行（正好切在尾部窗口边界）跳过。
    }
  }
  return n;
}

/** 设置页「最近的活动」：倒序取 n 条，只给页面看，不进模型上下文。 */
export function recentAudit(n = 20): AuditEntry[] {
  let text = "";
  try {
    const size = fs.statSync(auditFile()).size;
    const from = Math.max(0, size - 96 * 1024);
    const fd = fs.openSync(auditFile(), "r");
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const rows: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 同上：边界上的半截行。
    }
  }
  return rows.slice(-n).reverse();
}

// ---------------------------------------------------------------- 校验

export interface AccountInput {
  id?: string;
  label?: string;
  address?: string;
  preset?: string;
  imap?: Partial<MailEndpoint>;
  smtp?: Partial<MailEndpoint>;
  user?: string;
  secret?: string;
  enabled?: boolean;
}

/**
 * 把页面/工具递来的账号输入合成一份完整账号。`secret` 传空或传回掩码 = 保留原值（编辑时不重填授权码）。
 * 返回 `{ error }` 时调用方原样回 400，别自己拼提示。
 */
export function normalizeAccount(input: AccountInput, prev?: MailAccount | null): { account?: MailAccount; error?: string } {
  const preset = presetOf(input.preset ?? prev?.preset);
  const address = str(input.address) || prev?.address || "";
  if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { error: "邮箱地址不像一个地址（例如 you@163.com）" };
  const secretRaw = str(input.secret);
  const masked = prev ? maskSecret(prev.secret) : "";
  const keepSecret = !secretRaw || (masked && (secretRaw === masked || secretRaw.includes("****")));
  const secret = keepSecret ? (prev?.secret ?? "") : secretRaw.replace(/\s+/g, "");
  const base = preset === "custom" ? null : PRESETS[preset];
  const imap = endpointOf(input.imap, base?.imap ?? prev?.imap ?? { host: "", port: 993, secure: true });
  const smtp = endpointOf(input.smtp, base?.smtp ?? prev?.smtp ?? { host: "", port: 465, secure: true });
  if (!imap.host) return { error: "IMAP 服务器地址没填" };
  if (!smtp.host) return { error: "SMTP 服务器地址没填" };
  return {
    account: {
      id: prev?.id ?? str(input.id) ?? "",
      label: str(input.label) || prev?.label || address,
      address,
      preset,
      imap,
      smtp,
      user: str(input.user) || prev?.user || address,
      secret,
      enabled: typeof input.enabled === "boolean" ? input.enabled : (prev?.enabled ?? true),
      verifiedAt: prev?.verifiedAt ?? null,
      lastError: prev?.lastError ?? null,
    },
  };
}

export function newAccountId(): string {
  return `m${randomUUID().slice(0, 8)}`;
}

export { configFile as mailConfigFile, auditFile as mailAuditFile };
