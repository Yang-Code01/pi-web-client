/**
 * `/api/mail/*`（页面，cookie 闸内）与 `/api/mail/tool/*`（工具，回环 + token，闸外）。
 *
 * 和 `jira.ts` 一样自包含：`json()` / `fail()` / body 解析写在本地，不 import index 的私有函数
 * （index 反过来 import 这里，共用会成环）。
 *
 * 两条规矩贯穿全文：
 *   1. **权限只看 `policyDenial()`**：路由和工具都走它，不在别处另写「能不能发」。
 *   2. **凭据只出掩码**：任何回给页面 / 模型的 JSON 都不含 `secret`。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { statePath } from "./paths.ts";
import { BAD_ADDRESS_HINT, bareAddress, isEmailAddress } from "./mailaddr.ts";
import {
  DEFAULT_POLICY,
  PRESETS,
  PRESET_IDS,
  appendAudit,
  denialText,
  findAccount,
  newAccountId,
  normalizeAccount,
  policyDenial,
  publicAccount,
  readMailConfig,
  readMailConfigChecked,
  recentAudit,
  recipientsDenied,
  sentToday,
  writeMailConfig,
  mailConfigFile,
  type MailAccount,
  type MailAction,
  type MailConfig,
  type MailPolicy,
} from "./mailconfig.ts";
import {
  MailError,
  listFolders,
  listMessages,
  readAttachment,
  readMessage,
  sendOutgoing,
  appendDraft,
  splitRecipients,
  testAccount,
  type OutgoingMail,
} from "./mailtransport.ts";
import { cancelDeviceLogin, logoutOAuth, pollDeviceLogin, startDeviceLogin } from "./mailoauth.ts";

const MAX_BODY = 2 * 1024 * 1024;
/** 回给模型的单张内嵌图片上限（base64 后约 4MB，pi 的图片通道还能接住）。 */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export interface MailConfirmRequest {
  account: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: string[];
}

export interface MailConfirmAck {
  ok: boolean;
  reason?: string;
  text?: string;
}

export interface MailCtx {
  publicReq: boolean;
  /** 页面口用：向正在看某个会话的页面要一次「确认发送」。工具口必传。 */
  confirm?: (sessionId: string, req: MailConfirmRequest) => Promise<MailConfirmAck>;
}

export interface MailToolCtx extends MailCtx {
  /** 会话级回环 token → 会话 id（`sessions.byLoopbackToken`）。 */
  byToken: (token: string) => { id: string } | null;
}

// ---------------------------------------------------------------- HTTP 小件

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function fail(res: http.ServerResponse, status: number, code: string, error: string): void {
  json(res, status, { error, code });
}

/**
 * 写之前先确认磁盘上那份能读。读不出来就不写 —— 否则一次「改个开关」就把账号与授权码
 * 覆盖成空（实测把 config.json 截断一下，再点一下权限开关，文件里的授权码没了，D264）。
 */
function writeGuard(res: http.ServerResponse): boolean {
  const { error } = readMailConfigChecked();
  if (!error) return true;
  fail(
    res,
    409,
    "config-corrupt",
    `邮箱配置文件读不出来（${error}），为了不覆盖掉里面的账号和授权码，这次没有保存。文件在 ${mailConfigFile()}：修好或删掉它再试。`,
  );
  return false;
}

/**
 * 页面口取账号：**停用的账号连人也不给用**（面板那边会显示「已停用」，并给出 no-account 的说明）。
 * 工具口走 `policyDenial`，停用同样被拦 —— 两边都拦，别只在一边。
 */
function pageAccount(res: http.ServerResponse, config: MailConfig, id?: string | null): MailAccount | null {
  const account = findAccount(config, id ?? null);
  if (!account) {
    fail(res, 404, "no-account", "没有这个账号");
    return null;
  }
  if (!account.enabled) {
    fail(res, 409, "account-disabled", "这个账号被停用了：邮箱面板「账号」页勾上「启用」再用。");
    return null;
  }
  return account;
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------- 共用动作

function asInt(v: unknown, fallback: number): number {
  // 注意 `Number(null) === 0`：以前 `?limit=` 缺省会被当成 0，再被夹成 1（「不带 limit 只回一封」）。
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/** 白名单比的是裸地址：`Name <a@b.com>` 与 `a@b.com` 是同一个人。 */
function recipientSet(mail: { to?: unknown; cc?: unknown; bcc?: unknown }): string[] {
  return [...splitRecipients(mail.to), ...splitRecipients(mail.cc), ...splitRecipients(mail.bcc)].map((one) => bareAddress(one));
}

/** 附件参数 → `{filename, path}`，存在性在这里就查。草稿与回复共用。导出去是为了单测。 */
export function normalizeAttachments(raw: unknown): { filename: string; path: string }[] {
  const attachments = (Array.isArray(raw) ? raw : [])
    .map((a: any) => (typeof a === "string" ? { filename: path.basename(a), path: a } : { filename: String(a?.filename ?? ""), path: String(a?.path ?? "") }))
    .filter((a: any) => a.path);
  for (const a of attachments) {
    if (!fs.existsSync(a.path)) throw new MailError("not-found", `附件不存在：${a.path}`, "附件要给本机绝对路径，并且文件得真的在那儿。");
    if (!a.filename) a.filename = path.basename(a.path);
  }
  return attachments;
}

/** 工具/页面的发信参数 → `OutgoingMail`。导出去是为了单测（带显示名的收件人、附件校验）。 */
export function normalizeMail(input: any): OutgoingMail {
  const to = splitRecipients(input?.to);
  if (!to.length) throw new MailError("bad-input", "没有收件人", "至少要填一个收件人（`to`）。");
  for (const addr of to) {
    // `Name <a@b.com>` 是合法收件人：以前这里拿正则直接怼整串，面板「回复」一带显示名就 500（D264）。
    if (!isEmailAddress(addr)) throw new MailError("bad-input", `收件人不像地址：${addr}`, BAD_ADDRESS_HINT);
  }
  const text = typeof input?.text === "string" ? input.text : "";
  const html = typeof input?.html === "string" ? input.html : "";
  if (!text.trim() && !html.trim()) throw new MailError("bad-input", "正文是空的", "至少给 `text`（纯文本）或 `html` 写点内容。");
  return {
    to,
    cc: splitRecipients(input?.cc),
    bcc: splitRecipients(input?.bcc),
    subject: String(input?.subject ?? "").trim() || "(无主题)",
    text,
    html: html || undefined,
    attachments: normalizeAttachments(input?.attachments),
  };
}

interface SendOutcome {
  ok: boolean;
  messageId?: string;
  code?: string;
  error?: string;
  /** 草稿 uid。 */
  draftUid?: string;
}

/**
 * 发送的唯一执行点（页面与工具共用）。返回值里 `code` 是稳定错误码：
 * `policy-denied:*` / `recipients` / `rate-limited` / `declined` / `no-page` / `auth-failed` / `smtp-error`。
 *
 * **权限只管 AI**（`by === "agent"`）：开关页写的是「AI 能做什么」「只约束 AI；你自己点的不受限」，
 * 所以白名单、日上限、发/草稿/附件开关、发送前确认全在 agent 分支里。以前这些不管谁发都拦，
 * 把「读邮件」一关连人自己都看不了信，附件权限默认关着连自己的附件都下不了（D264）。
 */
async function performSend(opts: {
  config: MailConfig;
  account: MailAccount;
  mail: OutgoingMail;
  by: "agent" | "page";
  tool?: string;
  sessionId?: string;
  confirm?: MailCtx["confirm"];
  asDraft?: boolean;
}): Promise<SendOutcome> {
  const { config, account, mail, by } = opts;
  const action: MailAction = opts.asDraft ? "draft" : "send";

  if (by === "agent") {
    const denied = policyDenial(config, action, account);
    if (denied) return { ok: false, code: denied, error: denialText(denied) };

    if (mail.attachments?.length) {
      const deniedAttach = policyDenial(config, "attachments", account);
      if (deniedAttach) return { ok: false, code: deniedAttach, error: denialText(deniedAttach) };
    }

    const bad = recipientsDenied(config, recipientSet(mail));
    if (bad.length) {
      return { ok: false, code: "recipients", error: `收件人不在白名单里：${bad.join(", ")}（设置里「收件人白名单」只允许名单内的地址）` };
    }

    if (!opts.asDraft && config.policy.dailySendLimit > 0) {
      const used = sentToday(account.id, Date.now(), "agent");
      if (used >= config.policy.dailySendLimit) {
        return { ok: false, code: "rate-limited", error: `今天这个账号已经发了 ${used} 封，到上限了（设置里「每日发信上限」）。明天再发，或者把上限调高。` };
      }
    }

    // 人自己点的发送不再二次确认：他眼前就是收件人和正文。AI 发才要。
    if (!opts.asDraft && config.policy.confirmSend) {
      if (!opts.sessionId || !opts.confirm) return { ok: false, code: "no-page", error: "这封邮件要人确认后才能发，但请求没有带上会话，没法在页面上问。" };
      const ack = await opts.confirm(opts.sessionId, {
        account: account.label,
        from: account.address,
        to: mail.to,
        cc: [...(mail.cc ?? []), ...(mail.bcc ?? [])],
        subject: mail.subject,
        text: (mail.text || "").slice(0, 800),
        attachments: (mail.attachments ?? []).map((a) => a.filename),
      });
      if (!ack.ok) {
        const code = ack.reason ?? "declined";
        return { ok: false, code, error: ack.text ?? (code === "no-page" ? "没有页面在看这个会话，没法确认，这封信没有发。" : "用户没有确认发送。") };
      }
    }
  }

  try {
    if (opts.asDraft) {
      const built = await sendOutgoing(account, mail, { dryRun: true });
      const raw = built.raw ?? Buffer.from("");
      const uid = await appendDraft(account, raw);
      appendAudit({ t: Date.now(), account: account.id, from: account.address, to: mail.to, subject: mail.subject, by, tool: opts.tool, ok: true, messageId: "draft" });
      return { ok: true, draftUid: uid };
    }
    const sent = await sendOutgoing(account, mail);
    appendAudit({
      t: Date.now(),
      account: account.id,
      from: account.address,
      to: mail.to,
      subject: mail.subject,
      messageId: sent.messageId,
      by,
      tool: opts.tool,
      ok: true,
    });
    return { ok: true, messageId: sent.messageId };
  } catch (err) {
    const e = err instanceof MailError ? err : new MailError("smtp-error", String((err as Error)?.message ?? err), "发送失败了。");
    appendAudit({ t: Date.now(), account: account.id, from: account.address, to: mail.to, subject: mail.subject, by, tool: opts.tool, ok: false, error: e.code });
    return { ok: false, code: e.code, error: e.hint || e.message };
  }
}

// ---------------------------------------------------------------- 页面口

/**
 * 处理 `/api/mail/*`；返回 true 表示这个请求归它管（调用方直接 return）。
 * 两条口径：页面口是人**自己**动手（读、发、取附件都不看「AI 权限」），工具口才看 `policyDenial`；
 * 隧道访客一律 403，不管读写。
 */
export async function handleMail(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: MailCtx): Promise<boolean> {
  if (!url.pathname.startsWith("/api/mail/")) return false;
  if (url.pathname.startsWith("/api/mail/tool/")) return false; // 工具口在闸外，另一条路
  if (ctx.publicReq) {
    fail(res, 403, "tunnel_readonly", "邮箱面板只在本机可用（公网隧道进不来）。");
    return true;
  }
  const method = req.method ?? "GET";
  try {
    if (url.pathname === "/api/mail/config") {
      if (method !== "GET") {
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      }
      const { config, error } = readMailConfigChecked();
      json(res, 200, {
        accounts: config.accounts.map(publicAccount),
        policy: config.policy,
        defaultAccount: config.defaultAccount,
        presets: PRESETS,
        presetIds: PRESET_IDS,
        audit: recentAudit(20),
        // 读坏了的文件不能默默当「没账号」：面板要盖一条横幅，告诉人先修文件再动手。
        configError: error,
        configPath: mailConfigFile(),
      });
      return true;
    }

    if (url.pathname === "/api/mail/accounts") {
      if (method !== "POST") {
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      }
      if (!writeGuard(res)) return true;
      const body = await readJsonBody(req);
      const config = readMailConfig();
      const prev = body?.id ? (config.accounts.find((a) => a.id === String(body.id)) ?? null) : null;
      const { account, error } = normalizeAccount(body ?? {}, prev);
      if (!account || error) {
        fail(res, 400, "bad_input", error ?? "账号信息不完整");
        return true;
      }
      account.id = prev?.id ?? newAccountId();
      // 换了授权码 / 认证方式 / Microsoft 应用 / 服务器，之前的验证结论作废。
      if (
        prev &&
        (prev.secret !== account.secret ||
          prev.auth !== account.auth ||
          prev.oauth?.clientId !== account.oauth?.clientId ||
          prev.oauth?.tenant !== account.oauth?.tenant ||
          prev.imap.host !== account.imap.host ||
          prev.smtp.host !== account.smtp.host)
      ) {
        account.verifiedAt = null;
        account.lastError = null;
      }
      // 地址不分大小写（QQ / 163 / Gmail 都当同一个信箱）。
      const dup = config.accounts.find((a) => a.address.toLowerCase() === account.address.toLowerCase() && a.id !== account.id);
      if (dup) {
        fail(res, 400, "duplicate", `${account.address} 已经配过了（${dup.label}）`);
        return true;
      }
      config.accounts = prev ? config.accounts.map((a) => (a.id === prev.id ? account : a)) : [...config.accounts, account];
      config.defaultAccount = config.defaultAccount ?? account.id;
      writeMailConfig(config);
      json(res, 200, { ok: true, account: publicAccount(account) });
      return true;
    }

    // ---------------------------------------------------------------- Microsoft OAuth
    //
    // 三个动作都是「对着一个已经存下的 oauth 账号」做的：先把账号（与客户端 ID）存好，再登录。
    // 令牌只能从这条进来（`saveOAuthTokens`），页面从头到尾看不到令牌值。
    if (url.pathname.startsWith("/api/mail/oauth/")) {
      const action = url.pathname.slice("/api/mail/oauth/".length);
      if (method !== "POST") {
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      }
      if (!writeGuard(res)) return true;
      const body = (await readJsonBody(req)) ?? {};
      const config = readMailConfig();
      const account = config.accounts.find((a) => a.id === String(body.accountId ?? ""));
      if (!account) {
        fail(res, 404, "not_found", "没有这个账号（先保存账号再登录）");
        return true;
      }
      if (account.auth !== "oauth" || !account.oauth) {
        fail(res, 400, "bad_input", "这个账号不是 Microsoft 登录账号");
        return true;
      }
      if (action === "start") {
        const login = await startDeviceLogin(account.id, account.oauth);
        json(res, 200, { ok: true, login });
        return true;
      }
      if (action === "poll") {
        const state = await pollDeviceLogin(account.id);
        // 登录成功就把账号的新状态顺手带上：页面不用再拉一遍 /config。
        const fresh = state.status === "done" ? findAccount(readMailConfig(), account.id) : null;
        json(res, 200, { ok: true, ...state, account: fresh ? publicAccount(fresh) : undefined });
        return true;
      }
      if (action === "cancel") {
        cancelDeviceLogin(account.id);
        json(res, 200, { ok: true });
        return true;
      }
      if (action === "logout") {
        logoutOAuth(account.id);
        // 重新读一遍再写：上面那份 `config` 是退出登录之前的快照，写回去会把刚清掉的令牌又写回来。
        const after = readMailConfig();
        const fresh = after.accounts.find((a) => a.id === account.id) ?? null;
        if (fresh) {
          fresh.verifiedAt = null;
          fresh.lastError = null;
          writeMailConfig(after);
        }
        json(res, 200, { ok: true, account: fresh ? publicAccount(fresh) : undefined });
        return true;
      }
      fail(res, 404, "not_found", "没有这个操作");
      return true;
    }

    if (url.pathname.startsWith("/api/mail/accounts/")) {
      const rest = url.pathname.slice("/api/mail/accounts/".length);
      const cut = rest.indexOf("/");
      const id = cut === -1 ? rest : rest.slice(0, cut);
      const action = cut === -1 ? "" : rest.slice(cut + 1);
      if (method === "DELETE" && !action) {
        if (!writeGuard(res)) return true;
        const config = readMailConfig();
        const before = config.accounts.length;
        config.accounts = config.accounts.filter((a) => a.id !== id);
        if (config.accounts.length === before) {
          fail(res, 404, "not_found", "没有这个账号");
          return true;
        }
        if (config.defaultAccount === id) config.defaultAccount = config.accounts[0]?.id ?? null;
        // 删了的账号不能留在「AI 能用哪些账号」里：它已经不在了，勾着就等于谁都不允许。
        config.policy.accountIds = config.policy.accountIds.filter((one) => one !== id);
        writeMailConfig(config);
        json(res, 200, { ok: true });
        return true;
      }
      if (method === "POST" && action === "test") {
        if (!writeGuard(res)) return true;
        const config = readMailConfig();
        const account = config.accounts.find((a) => a.id === id);
        if (!account) {
          fail(res, 404, "not_found", "没有这个账号");
          return true;
        }
        const result = await testAccount(account);
        account.verifiedAt = result.ok ? Date.now() : null;
        account.lastError = result.ok ? null : (result.imap.error ?? result.smtp.error ?? null);
        writeMailConfig(config);
        json(res, 200, result);
        return true;
      }
      fail(res, 405, "bad_method", "不支持这个请求方法");
      return true;
    }

    if (url.pathname === "/api/mail/policy") {
      if (method !== "POST") {
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      }
      if (!writeGuard(res)) return true;
      const body = (await readJsonBody(req)) ?? {};
      const config = readMailConfig();
      const p = body ?? {};
      const next: MailPolicy = {
        read: typeof p.read === "boolean" ? p.read : config.policy.read,
        send: typeof p.send === "boolean" ? p.send : config.policy.send,
        draft: typeof p.draft === "boolean" ? p.draft : config.policy.draft,
        attachments: typeof p.attachments === "boolean" ? p.attachments : config.policy.attachments,
        mutate: typeof p.mutate === "boolean" ? p.mutate : config.policy.mutate,
        confirmSend: typeof p.confirmSend === "boolean" ? p.confirmSend : config.policy.confirmSend,
        recipients: Array.isArray(p.recipients) ? p.recipients.map((x: unknown) => String(x ?? "").trim()).filter(Boolean) : config.policy.recipients,
        dailySendLimit: typeof p.dailySendLimit === "number" && p.dailySendLimit >= 0 ? Math.floor(p.dailySendLimit) : config.policy.dailySendLimit,
        accountIds: Array.isArray(p.accountIds) ? p.accountIds.map((x: unknown) => String(x ?? "")).filter(Boolean) : config.policy.accountIds,
      };
      config.policy = next;
      writeMailConfig(config);
      json(res, 200, { ok: true, policy: next });
      return true;
    }

    // 页面上的读、取附件、发信都是**人自己**在动手：不受「AI 权限」管（D264）。
    // 唯一还拦的是「账号被停用」与隧道访客（上面已经 403）。
    if (url.pathname === "/api/mail/folders") {
      const config = readMailConfig();
      const account = pageAccount(res, config, url.searchParams.get("account"));
      if (!account) return true;
      json(res, 200, { folders: await listFolders(account) });
      return true;
    }

    if (url.pathname === "/api/mail/messages") {
      const config = readMailConfig();
      const account = pageAccount(res, config, url.searchParams.get("account"));
      if (!account) return true;
      const folder = url.searchParams.get("folder") || "INBOX";
      const messages = await listMessages(account, folder, {
        limit: asInt(url.searchParams.get("limit"), 20),
        offset: asInt(url.searchParams.get("offset"), 0),
        unreadOnly: url.searchParams.get("unread") === "1",
      });
      json(res, 200, { folder, messages });
      return true;
    }

    if (url.pathname === "/api/mail/message") {
      const config = readMailConfig();
      const account = pageAccount(res, config, url.searchParams.get("account"));
      if (!account) return true;
      const folder = url.searchParams.get("folder") || "INBOX";
      const uid = asInt(url.searchParams.get("uid"), -1);
      if (uid < 0) {
        fail(res, 400, "bad_input", "缺少 uid");
        return true;
      }
      const detail = await readMessage(account, folder, uid);
      // 人自己在面板里看信 / 下附件：不受「取附件」那个 AI 开关管（D264）。
      json(res, 200, {
        message: detail,
        attachmentsAllowed: true,
      });
      return true;
    }

    if (url.pathname === "/api/mail/attachment") {
      const config = readMailConfig();
      const account = pageAccount(res, config, url.searchParams.get("account"));
      if (!account) return true;
      const folder = url.searchParams.get("folder") || "INBOX";
      const uid = asInt(url.searchParams.get("uid"), -1);
      const index = asInt(url.searchParams.get("index"), 0);
      if (uid < 0) {
        fail(res, 400, "bad_input", "缺少 uid");
        return true;
      }
      const file = await readAttachment(account, folder, uid, index);
      // `inline=1` 给正文里的 <img> 用：同一份字节，只是别让浏览器当成下载。
      const inline = url.searchParams.get("inline") === "1";
      res.writeHead(200, {
        "content-type": file.contentType || "application/octet-stream",
        "content-length": String(file.content.length),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "cache-control": inline ? "private, max-age=3600" : "no-store",
      });
      res.end(file.content);
      return true;
    }

    if (url.pathname === "/api/mail/send" && method === "POST") {
      const body = (await readJsonBody(req)) ?? {};
      const config = readMailConfig();
      const account = pageAccount(res, config, body?.account);
      if (!account) return true;
      const mail = normalizeMail(body);
      const out = await performSend({ config, account, mail, by: "page", asDraft: Boolean(body?.draft), confirm: ctx.confirm });
      if (!out.ok) {
        // 页面发信不过 AI 权限，所以这里不会再有 policy-denied（D264）。
        fail(res, 400, out.code ?? "send_failed", out.error ?? "发送失败");
        return true;
      }
      json(res, 200, out);
      return true;
    }

    if (url.pathname === "/api/mail/repair") {
      if (method !== "POST") {
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      }
      // 只修「策略缺字段」这种半截文件：读一次、写回去（读的时候已经补了默认值）。
      if (!writeGuard(res)) return true;
      const config = readMailConfig();
      writeMailConfig({ ...config, policy: { ...DEFAULT_POLICY, ...config.policy } });
      json(res, 200, { ok: true });
      return true;
    }

    fail(res, 404, "not_found", "没有这个接口");
    return true;
  } catch (err) {
    if (err instanceof MailError) {
      const status = err.code === "not-found" ? 404 : err.code === "bad-input" || err.code === "auth-failed" || err.code === "imap-id" ? 400 : 500;
      fail(res, status, err.code, err.hint || err.message);
      return true;
    }
    fail(res, 500, "mail_internal", `邮箱面板处理失败：${String((err as Error)?.message ?? err)}`);
    return true;
  }
}

// ---------------------------------------------------------------- 工具口

function toolFail(code: string, error: string) {
  return { ok: false, code, error };
}

/** 报给模型的策略视图：去掉 v1 没有任何动作的 `mutate`（D264）。 */
function agentPolicyView(policy: MailPolicy): Omit<MailPolicy, "mutate"> {
  const { mutate: _unused, ...rest } = policy;
  void _unused;
  return rest;
}

/**
 * 工具口的 HTML 先去掉 <head>/<style>/<script>，再截断。营销邮件经常前 20k 全是 CSS，
 * 直接截会把正文（以及 `[图片]` 标记）切没；模型也不需要 CSS。
 */
export function htmlForModel(html: string): string {
  return String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

/** 长正文截断并注明（工具口专用：上下文有限）。 */
function clip(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…（${what}太长，已截断，原文 ${text.length} 字）`;
}

/** 工具口的统一返回形状；一切失败都在这里归口，模型只读 `ok/code/error`。 */
function toolJson(res: http.ServerResponse, body: unknown): void {
  json(res, 200, body);
}

/**
 * 处理 `/api/mail/tool/<name>`。站在 cookie 闸**前**：只认回环对端 + 会话级 token（样板同
 * `/api/preview/open`）。每个工具都按 `policyDenial` 判过再动手。
 */
export async function handleMailTool(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: MailToolCtx): Promise<boolean> {
  if (!url.pathname.startsWith("/api/mail/tool/")) return false;
  if (req.method !== "POST") {
    toolJson(res, toolFail("bad_method", "工具口只接受 POST"));
    return true;
  }
  const name = url.pathname.slice("/api/mail/tool/".length);
  const body = (await readJsonBody(req).catch(() => ({}))) as any;
  const session = ctx.byToken(String(body?.token ?? ""));
  if (!session) {
    json(res, 403, { error: "回环凭据不对。", code: "bad-token" });
    return true;
  }
  const args = (body?.args ?? {}) as any;
  const config = readMailConfig();
  try {
    switch (name) {
      case "mail_accounts": {
        const allowed = config.accounts.filter((a) => a.enabled && (!config.policy.accountIds.length || config.policy.accountIds.includes(a.id)));
        // 默认账号如果停用 / 没对 AI 开放，换成第一个可用的，别让人拿到一个必定被拒的默认值。
        const fallback = allowed[0]?.id ?? null;
        const wantDefault = allowed.some((a) => a.id === config.defaultAccount) ? config.defaultAccount : fallback;
        return toolJson(res, {
          ok: true,
          accounts: allowed.map((a) => ({ id: a.id, label: a.label, address: a.address, verifiedAt: a.verifiedAt })),
          defaultAccount: wantDefault,
          // `mutate` 在 v1 没有对应动作、面板也不给这个开关：别把「改状态」报成一个可调的权限（D264）。
          policy: agentPolicyView(config.policy),
        }), true;
      }

      case "mail_list": {
        const account = findAccount(config, args?.account ?? null);
        if (!account) return toolJson(res, toolFail("no-account", "还没有配邮箱账号。先让用户在邮箱面板里加一个。")), true;
        const denied = policyDenial(config, "read", account);
        if (denied) return toolJson(res, toolFail(denied, denialText(denied))), true;
        const messages = await listMessages(account, String(args?.folder ?? "INBOX"), {
          limit: asInt(args?.limit, 20),
          offset: asInt(args?.offset, 0),
          unreadOnly: Boolean(args?.unread),
        });
        return toolJson(res, { ok: true, account: account.id, folder: String(args?.folder ?? "INBOX"), messages }), true;
      }

      case "mail_read": {
        const account = findAccount(config, args?.account ?? null);
        if (!account) return toolJson(res, toolFail("no-account", "还没有配邮箱账号。")), true;
        const denied = policyDenial(config, "read", account);
        if (denied) return toolJson(res, toolFail(denied, denialText(denied))), true;
        const uid = asInt(args?.uid, -1);
        if (uid < 0) return toolJson(res, toolFail("bad-input", "要给 `uid`（从 mail_list 里拿）。")), true;
        // 工具口保留 cid:：内嵌图片的 base64 不进模型上下文，图片另走 mail_image。
        const detail = await readMessage(account, String(args?.folder ?? "INBOX"), uid, { keepCidLinks: true });
        // 「取附件」管的是往磁盘写文件，正文不该连坐：纯 HTML 的信以前就变成「没有纯文本正文」。
        const canAttach = !policyDenial(config, "attachments", account);
        return toolJson(res, {
          ok: true,
          message: {
            ...detail,
            // 正文太长会把上下文吃满：留 20000 字，多的截断并说清楚。
            text: clip(detail.text, 20000, "正文"),
            html: clip(htmlForModel(detail.html ?? ""), 20000, "HTML 正文") || null,
            // 附件能不能落盘由 `attachmentsAllowed` 一个信号说清，别每项再塞一个没人读的字段。
            attachments: detail.attachments,
          },
          attachmentsAllowed: canAttach,
        }), true;
      }

      case "mail_send":
      case "mail_draft":
      case "mail_reply": {
        const account = findAccount(config, args?.account ?? null);
        if (!account) return toolJson(res, toolFail("no-account", "还没有配邮箱账号。")), true;
        let mail: OutgoingMail;
        if (name === "mail_reply") {
          const deniedRead = policyDenial(config, "read", account);
          if (deniedRead) return toolJson(res, toolFail(deniedRead, denialText(deniedRead))), true;
          const uid = asInt(args?.uid, -1);
          if (uid < 0) return toolJson(res, toolFail("bad-input", "要给 `uid`（要回复的那封信）。")), true;
          const src = await readMessage(account, String(args?.folder ?? "INBOX"), uid);
          const bodyText = typeof args?.text === "string" ? args.text : "";
          if (!bodyText.trim()) return toolJson(res, toolFail("bad-input", "回复要有 `text` 正文。")), true;
          const quoted = src.text
            .split("\n")
            .map((line: string) => `> ${line}`)
            .join("\n");
          if (!src.fromAddress) {
            return toolJson(res, toolFail("bad-input", `这封（uid=${uid}）没有可用的发件人地址，回不了；用 mail_send 自己填收件人。`)), true;
          }
          mail = {
            to: [src.fromAddress],
            subject: /^re:/i.test(src.subject) ? src.subject : `Re: ${src.subject}`,
            text: `${bodyText}\n\n---\n${src.from} 写道：\n${quoted}`,
            // 以前这里硬写 `[]`：schema 声明了 attachments，传进来却被静静丢掉。
            attachments: normalizeAttachments(args?.attachments),
          };
          if (args?.replyAll) {
            mail.cc = [...src.to, ...src.cc].filter((a) => !a.includes(account!.address) && !a.includes(src.fromAddress));
          }
        } else {
          mail = normalizeMail(args ?? {});
        }
        const out = await performSend({
          config,
          account,
          mail,
          by: "agent",
          tool: name,
          sessionId: session.id,
          confirm: ctx.confirm,
          asDraft: name === "mail_draft",
        });
        if (!out.ok) return toolJson(res, toolFail(out.code ?? "send_failed", out.error ?? "发送失败")), true;
        return toolJson(res, { ...out, account: account.id }), true;
      }

      case "mail_image": {
        const account = findAccount(config, args?.account ?? null);
        if (!account) return toolJson(res, toolFail("no-account", "还没有配邮箱账号。")), true;
        // 看内嵌图片不写磁盘，归「读邮件」管；不用让用户为了看一张图打开「取附件」。
        const denied = policyDenial(config, "read", account);
        if (denied) return toolJson(res, toolFail(denied, denialText(denied))), true;
        const uid = asInt(args?.uid, -1);
        if (uid < 0) return toolJson(res, toolFail("bad-input", "要给 `uid`。")), true;
        const file = await readAttachment(account, String(args?.folder ?? "INBOX"), uid, asInt(args?.index, 0));
        const mime = String(file.contentType ?? "").split(";")[0].trim().toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
        if (!mime.startsWith("image/")) {
          return toolJson(res, toolFail("not-image", `第 ${asInt(args?.index, 0)} 项不是图片（${mime || "未知类型"}），用 mail_attachment 下载。`)), true;
        }
        if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) {
          return toolJson(res, toolFail("not-image", `图片格式 ${mime} 不能直接看，用 mail_attachment 存到本机再用 open_preview。`)), true;
        }
        if (file.content.length > MAX_IMAGE_BYTES) {
          return toolJson(res, toolFail("image-too-large", `这张图 ${Math.round(file.content.length / 1024 / 1024 * 10) / 10}MB，超过 3MB，用 mail_attachment 存到本机再看。`)), true;
        }
        return toolJson(res, {
          ok: true,
          filename: file.filename,
          contentType: mime,
          size: file.content.length,
          base64: file.content.toString("base64"),
        }), true;
      }

      case "mail_attachment": {
        const account = findAccount(config, args?.account ?? null);
        if (!account) return toolJson(res, toolFail("no-account", "还没有配邮箱账号。")), true;
        const denied = policyDenial(config, "attachments", account);
        if (denied) return toolJson(res, toolFail(denied, denialText(denied))), true;
        const uid = asInt(args?.uid, -1);
        if (uid < 0) return toolJson(res, toolFail("bad-input", "要给 `uid`。")), true;
        const file = await readAttachment(account, String(args?.folder ?? "INBOX"), uid, asInt(args?.index, 0));
        const dir = path.join(statePath("mail"), "downloads", account.id);
        fs.mkdirSync(dir, { recursive: true });
        // eslint-disable-next-line no-control-regex -- 控制字符本来就该从文件名里剔掉
        const safe = file.filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "attachment.bin";
        let target = path.join(dir, safe);
        for (let i = 2; fs.existsSync(target) && i < 100; i++) {
          const ext = path.extname(safe);
          target = path.join(dir, `${path.basename(safe, ext)}-${i}${ext}`);
        }
        fs.writeFileSync(target, file.content);
        return toolJson(res, { ok: true, path: target, filename: path.basename(target), size: file.content.length }), true;
      }

      default:
        return toolJson(res, toolFail("bad_tool", `没有 mail_${name.replace(/^mail_/, "")} 这个工具`)), true;
    }
  } catch (err) {
    if (err instanceof MailError) return toolJson(res, toolFail(err.code, err.hint || err.message)), true;
    return toolJson(res, toolFail("mail_internal", String((err as Error)?.message ?? err))), true;
  }
}
