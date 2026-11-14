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
  recentAudit,
  recipientsDenied,
  sentToday,
  writeMailConfig,
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

const MAX_BODY = 2 * 1024 * 1024;

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
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function recipientSet(mail: { to?: unknown; cc?: unknown; bcc?: unknown }): string[] {
  return [...splitRecipients(mail.to), ...splitRecipients(mail.cc), ...splitRecipients(mail.bcc)];
}

function normalizeMail(input: any): OutgoingMail {
  const to = splitRecipients(input?.to);
  if (!to.length) throw new MailError("smtp-error", "没有收件人", "至少要填一个收件人（`to`）。");
  for (const addr of to) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) throw new MailError("smtp-error", `收件人不像地址：${addr}`, "收件人写成 someone@example.com 这样的完整地址。");
  }
  const text = typeof input?.text === "string" ? input.text : "";
  const html = typeof input?.html === "string" ? input.html : "";
  if (!text.trim() && !html.trim()) throw new MailError("smtp-error", "正文是空的", "至少给 `text`（纯文本）或 `html` 写点内容。");
  const attachments = (Array.isArray(input?.attachments) ? input.attachments : [])
    .map((a: any) => (typeof a === "string" ? { filename: path.basename(a), path: a } : { filename: String(a?.filename ?? ""), path: String(a?.path ?? "") }))
    .filter((a: any) => a.path);
  for (const a of attachments) {
    if (!fs.existsSync(a.path)) throw new MailError("not-found", `附件不存在：${a.path}`, "附件要给本机绝对路径，并且文件得真的在那儿。");
    if (!a.filename) a.filename = path.basename(a.path);
  }
  return {
    to,
    cc: splitRecipients(input?.cc),
    bcc: splitRecipients(input?.bcc),
    subject: String(input?.subject ?? "").trim() || "(无主题)",
    text,
    html: html || undefined,
    attachments,
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
    const used = sentToday(account.id);
    if (used >= config.policy.dailySendLimit) {
      return { ok: false, code: "rate-limited", error: `今天这个账号已经发了 ${used} 封，到上限了（设置里「每日发信上限」）。明天再发，或者把上限调高。` };
    }
  }

  // 人自己点的发送不再二次确认：他眼前就是收件人和正文。AI 发才要。
  if (by === "agent" && !opts.asDraft && config.policy.confirmSend) {
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
 * 邮箱比 Jira 更私密：隧道访客一律 403，不管读写。
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
      const config = readMailConfig();
      json(res, 200, {
        accounts: config.accounts.map(publicAccount),
        policy: config.policy,
        defaultAccount: config.defaultAccount,
        presets: PRESETS,
        presetIds: PRESET_IDS,
        audit: recentAudit(20),
      });
      return true;
    }

    if (url.pathname === "/api/mail/accounts") {
      if (method !== "POST") {
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      }
      const body = await readJsonBody(req);
      const config = readMailConfig();
      const prev = body?.id ? (config.accounts.find((a) => a.id === String(body.id)) ?? null) : null;
      const { account, error } = normalizeAccount(body ?? {}, prev);
      if (!account || error) {
        fail(res, 400, "bad_input", error ?? "账号信息不完整");
        return true;
      }
      account.id = prev?.id ?? newAccountId();
      // 换了授权码 / 服务器，之前的验证结论作废。
      if (prev && (prev.secret !== account.secret || prev.imap.host !== account.imap.host || prev.smtp.host !== account.smtp.host)) {
        account.verifiedAt = null;
        account.lastError = null;
      }
      const dup = config.accounts.find((a) => a.address === account.address && a.id !== account.id);
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

    if (url.pathname.startsWith("/api/mail/accounts/")) {
      const rest = url.pathname.slice("/api/mail/accounts/".length);
      const cut = rest.indexOf("/");
      const id = cut === -1 ? rest : rest.slice(0, cut);
      const action = cut === -1 ? "" : rest.slice(cut + 1);
      if (method === "DELETE" && !action) {
        const config = readMailConfig();
        const before = config.accounts.length;
        config.accounts = config.accounts.filter((a) => a.id !== id);
        if (config.accounts.length === before) {
          fail(res, 404, "not_found", "没有这个账号");
          return true;
        }
        if (config.defaultAccount === id) config.defaultAccount = config.accounts[0]?.id ?? null;
        writeMailConfig(config);
        json(res, 200, { ok: true });
        return true;
      }
      if (method === "POST" && action === "test") {
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

    if (url.pathname === "/api/mail/folders") {
      const config = readMailConfig();
      const account = findAccount(config, url.searchParams.get("account"));
      if (!account) {
        fail(res, 404, "no-account", "没有这个账号");
        return true;
      }
      const denied = policyDenial(config, "read", account);
      if (denied) {
        fail(res, 403, denied, denialText(denied));
        return true;
      }
      json(res, 200, { folders: await listFolders(account) });
      return true;
    }

    if (url.pathname === "/api/mail/messages") {
      const config = readMailConfig();
      const account = findAccount(config, url.searchParams.get("account"));
      if (!account) {
        fail(res, 404, "no-account", "没有这个账号");
        return true;
      }
      const denied = policyDenial(config, "read", account);
      if (denied) {
        fail(res, 403, denied, denialText(denied));
        return true;
      }
      const folder = url.searchParams.get("folder") || "INBOX";
      const messages = await listMessages(account, folder, {
        limit: asInt(url.searchParams.get("limit"), 20),
        unreadOnly: url.searchParams.get("unread") === "1",
      });
      json(res, 200, { folder, messages });
      return true;
    }

    if (url.pathname === "/api/mail/message") {
      const config = readMailConfig();
      const account = findAccount(config, url.searchParams.get("account"));
      if (!account) {
        fail(res, 404, "no-account", "没有这个账号");
        return true;
      }
      const denied = policyDenial(config, "read", account);
      if (denied) {
        fail(res, 403, denied, denialText(denied));
        return true;
      }
      const folder = url.searchParams.get("folder") || "INBOX";
      const uid = asInt(url.searchParams.get("uid"), -1);
      if (uid < 0) {
        fail(res, 400, "bad_input", "缺少 uid");
        return true;
      }
      const detail = await readMessage(account, folder, uid);
      // 附件要不要露出来由权限决定：关着就只说「有几个附件」，不给下载口。
      const canAttach = !policyDenial(config, "attachments", account);
      json(res, 200, {
        message: detail,
        attachmentsAllowed: canAttach,
      });
      return true;
    }

    if (url.pathname === "/api/mail/attachment") {
      const config = readMailConfig();
      const account = findAccount(config, url.searchParams.get("account"));
      if (!account) {
        fail(res, 404, "no-account", "没有这个账号");
        return true;
      }
      const denied = policyDenial(config, "attachments", account);
      if (denied) {
        fail(res, 403, denied, denialText(denied));
        return true;
      }
      const folder = url.searchParams.get("folder") || "INBOX";
      const uid = asInt(url.searchParams.get("uid"), -1);
      const index = asInt(url.searchParams.get("index"), 0);
      if (uid < 0) {
        fail(res, 400, "bad_input", "缺少 uid");
        return true;
      }
      const file = await readAttachment(account, folder, uid, index);
      res.writeHead(200, {
        "content-type": file.contentType || "application/octet-stream",
        "content-length": String(file.content.length),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "cache-control": "no-store",
      });
      res.end(file.content);
      return true;
    }

    if (url.pathname === "/api/mail/send" && method === "POST") {
      const body = (await readJsonBody(req)) ?? {};
      const config = readMailConfig();
      const account = findAccount(config, body?.account);
      if (!account) {
        fail(res, 404, "no-account", "没有这个账号");
        return true;
      }
      const mail = normalizeMail(body);
      const out = await performSend({ config, account, mail, by: "page", asDraft: Boolean(body?.draft), confirm: ctx.confirm });
      if (!out.ok) {
        fail(res, out.code === "policy-denied" || out.code?.startsWith("policy-denied") ? 403 : 400, out.code ?? "send_failed", out.error ?? "发送失败");
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
      const config = readMailConfig();
      writeMailConfig({ ...config, policy: { ...DEFAULT_POLICY, ...config.policy } });
      json(res, 200, { ok: true });
      return true;
    }

    fail(res, 404, "not_found", "没有这个接口");
    return true;
  } catch (err) {
    if (err instanceof MailError) {
      fail(res, err.code === "not-found" ? 404 : err.code === "auth-failed" || err.code === "imap-id" ? 400 : 500, err.code, err.hint || err.message);
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
        return toolJson(res, {
          ok: true,
          accounts: allowed.map((a) => ({ id: a.id, label: a.label, address: a.address, verifiedAt: a.verifiedAt })),
          defaultAccount: config.defaultAccount,
          policy: config.policy,
        }), true;
      }

      case "mail_list": {
        const account = findAccount(config, args?.account ?? null);
        if (!account) return toolJson(res, toolFail("no-account", "还没有配邮箱账号。先让用户在邮箱面板里加一个。")), true;
        const denied = policyDenial(config, "read", account);
        if (denied) return toolJson(res, toolFail(denied, denialText(denied))), true;
        const messages = await listMessages(account, String(args?.folder ?? "INBOX"), {
          limit: asInt(args?.limit, 20),
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
        if (uid < 0) return toolJson(res, toolFail("bad_input", "要给 `uid`（从 mail_list 里拿）。")), true;
        const detail = await readMessage(account, String(args?.folder ?? "INBOX"), uid);
        const canAttach = !policyDenial(config, "attachments", account);
        return toolJson(res, {
          ok: true,
          message: {
            ...detail,
            // 正文太长会把上下文吃满：留 20000 字，多的截断并说清楚。
            text: detail.text.length > 20000 ? `${detail.text.slice(0, 20000)}\n\n…（正文太长，已截断，原文 ${detail.text.length} 字）` : detail.text,
            html: canAttach ? detail.html : null,
            attachments: canAttach ? detail.attachments : detail.attachments.map((a) => ({ ...a, downloadable: false })),
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
          if (uid < 0) return toolJson(res, toolFail("bad_input", "要给 `uid`（要回复的那封信）。")), true;
          const src = await readMessage(account, String(args?.folder ?? "INBOX"), uid);
          const bodyText = typeof args?.text === "string" ? args.text : "";
          if (!bodyText.trim()) return toolJson(res, toolFail("bad_input", "回复要有 `text` 正文。")), true;
          const quoted = src.text
            .split("\n")
            .map((line: string) => `> ${line}`)
            .join("\n");
          mail = {
            to: [src.fromAddress].filter(Boolean),
            subject: /^re:/i.test(src.subject) ? src.subject : `Re: ${src.subject}`,
            text: `${bodyText}\n\n---\n${src.from} 写道：\n${quoted}`,
            attachments: [],
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

      case "mail_attachment": {
        const account = findAccount(config, args?.account ?? null);
        if (!account) return toolJson(res, toolFail("no-account", "还没有配邮箱账号。")), true;
        const denied = policyDenial(config, "attachments", account);
        if (denied) return toolJson(res, toolFail(denied, denialText(denied))), true;
        const uid = asInt(args?.uid, -1);
        if (uid < 0) return toolJson(res, toolFail("bad_input", "要给 `uid`。")), true;
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
