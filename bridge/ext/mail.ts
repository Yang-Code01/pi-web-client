/**
 * `mail_*` —— 让模型读、写、发用户自己的邮箱。
 *
 * 这个扩展跑在 pi 子进程里，没有界面也没有凭据：它只带着会话级 token 敲桥的本机回环路由
 * （`/api/mail/tool/<name>`），由桥读配置、判权限、连 IMAP/SMTP。所以**策略只有桥里那一份**
 * ——扩展不缓存账号，也不替桥决定「能不能发」。
 *
 * 发送类工具可能要在页面上等用户点「确认」：桥最长等 5 分钟，这里的超时设得比它长一点，
 * 否则用户还在看正文、这边先报「没回应」了。
 *
 * stdout 属于 RPC 协议：日志只能走 console.error。
 */

const textResult = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const READ_MS = 60_000;
/** 桥等页面确认是 5 分钟，这条回环请求要比它长。 */
const WRITE_MS = 330_000;

interface ToolReply {
  ok: boolean;
  code?: string;
  error?: string;
  [key: string]: unknown;
}

async function callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolReply> {
  const base = process.env.PI_WEB_LOOPBACK;
  const token = process.env.PI_WEB_LOOPBACK_TOKEN;
  if (!base || !token) throw new Error("邮箱通道未配置（缺 PI_WEB_LOOPBACK / PI_WEB_LOOPBACK_TOKEN）");
  const res = await fetch(`${base}/api/mail/tool/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, args }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    return { ok: false, code: String(body?.code ?? `http-${res.status}`), error: String(body?.error ?? `桥回了 HTTP ${res.status}`) };
  }
  return body as ToolReply;
}

/** 已知错误码只补一句「下一步」，解释用桥回来的 `error`（同一个错误不能有三个作者）。 */
const NEXT_STEP: Record<string, string> = {
  "policy-denied:read": "让用户在邮箱面板设置里打开「读邮件」。",
  "policy-denied:send": "让用户在邮箱面板设置里打开「发邮件」。",
  "policy-denied:draft": "让用户在邮箱面板设置里打开「存草稿」。",
  "policy-denied:attachments": "让用户在邮箱面板设置里打开「取附件」。",
  "policy-denied:mutate": "让用户在邮箱面板设置里打开「改邮箱状态」。",
  "policy-denied:account": "这个账号没有开放给 AI，让用户在设置里勾上它。",
  declined: "用户没有确认发送。把这封信的内容写给他看，等他改完再说。",
  "no-page": "没有页面在看这个会话，没法确认发送；把邮件内容写出来，让用户自己发或回到网页里再试。",
  "rate-limited": "今天的额度用完了，别重试；把情况告诉用户。",
  recipients: "收件人不在白名单里，别换个写法重试；告诉用户被拦了。",
  "auth-failed": "授权码或服务开关有问题，让用户在邮箱设置里重新验证。",
  "imap-id": "网易拦了这次登录，让用户确认填的是客户端授权码并已开 IMAP。",
  "no-account": "用户还没配邮箱账号，先请他打开邮箱面板加一个。",
  "not-found": "这封信或这个账号不在了，重新列一下再试。",
  "bad-input": "参数不对，按工具说明补齐再试。",
  "too-large": "邮件太大，别重试；让用户用邮箱客户端打开。",
};

function explain(reply: ToolReply, fallback: string): string {
  const code = String(reply.code ?? "");
  const detail = String(reply.error ?? "").trim();
  const step = NEXT_STEP[code] ?? "";
  if (!detail && !step) return fallback;
  if (!step) return detail;
  if (!detail) return step;
  return `${detail}${/[。！？]$/.test(detail) ? "" : "。"}${step}`;
}

function dateText(ms: number): string {
  if (!ms) return "?";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const accountParam = { type: "string", description: "账号 id（不填就用默认账号）。先用 mail_accounts 看有哪些" };
const folderParam = { type: "string", description: "文件夹路径，默认 INBOX" };

const mailAccountsTool = {
  name: "mail_accounts",
  label: "看邮箱账号",
  description:
    "列出用户在邮箱面板里配好的账号（id / 名字 / 地址）、默认账号，以及当前的权限策略。不含任何凭据。第一次用邮箱类工具前先调它，别猜账号 id。",
  promptSnippet: "mail_accounts() → 已配置的邮箱账号与当前权限策略",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    try {
      const reply = await callTool("mail_accounts", {}, READ_MS);
      if (!reply.ok) return textResult(`没拿到账号：${explain(reply, "原因不明")}`, { ok: false, code: reply.code });
      const accounts = (reply.accounts as any[]) ?? [];
      if (!accounts.length) return textResult("用户还没有配置任何邮箱账号。请他打开顶栏的「邮箱」面板，填地址和客户端授权码。", { ok: false, code: "no-account" });
      const lines = accounts.map((a) => `- ${a.id} · ${a.label} · ${a.address}${a.id === reply.defaultAccount ? "（默认）" : ""}`);
      const p = (reply.policy as any) ?? {};
      const on = (v: boolean) => (v ? "开" : "关");
      const policy = `读 ${on(p.read)} / 发 ${on(p.send)} / 草稿 ${on(p.draft)} / 附件 ${on(p.attachments)} / 改状态 ${on(p.mutate)} / 发送前确认 ${on(p.confirmSend)} / 日上限 ${p.dailySendLimit || "不限"}`;
      return textResult(`账号：\n${lines.join("\n")}\n\n权限：${policy}`, { ok: true, accounts: reply.accounts, policy: reply.policy });
    } catch (err: any) {
      return textResult(`没拿到账号：${String(err?.message ?? err)}`, { ok: false, code: "channel" });
    }
  },
};

const mailListTool = {
  name: "mail_list",
  label: "列邮件",
  description:
    "列出某个文件夹里最近的邮件（默认 INBOX、20 封、按时间倒序）。每项给 uid / 时间 / 发件人 / 主题 / 是否未读 / 是否有附件。想读正文用 mail_read（带 uid）。",
  promptSnippet: "mail_list(account?, folder?, limit?, unread?) → 最近邮件的摘要列表（不含正文）",
  parameters: {
    type: "object",
    properties: {
      account: accountParam,
      folder: folderParam,
      limit: { type: "number", description: "最多几封，默认 20，上限 100" },
      unread: { type: "boolean", description: "只看未读" },
    },
    additionalProperties: false,
  },
  async execute(_id: string, params: any) {
    try {
      const reply = await callTool("mail_list", params ?? {}, READ_MS);
      if (!reply.ok) return textResult(`没列出来：${explain(reply, "原因不明")}`, { ok: false, code: reply.code });
      const rows = (reply.messages as any[]) ?? [];
      if (!rows.length) return textResult(`${reply.folder} 里没有${params?.unread ? "未读" : ""}邮件。`, { ok: true, messages: [] });
      const lines = rows.map(
        (m) =>
          `- uid=${m.uid} · ${dateText(m.date)} · ${m.unread ? "未读 · " : ""}${m.hasAttachments ? "📎 · " : ""}${m.from || "(未知发件人)"} — ${m.subject}`,
      );
      return textResult(`${reply.folder}（${rows.length} 封）：\n${lines.join("\n")}`, { ok: true, folder: reply.folder, messages: rows });
    } catch (err: any) {
      return textResult(`没列出来：${String(err?.message ?? err)}`, { ok: false, code: "channel" });
    }
  },
};

const mailReadTool = {
  name: "mail_read",
  label: "读邮件",
  description:
    "读一封信的完整内容：发件人 / 收件人 / 时间 / 纯文本正文 / 附件清单。默认不改「已读」标记（用 PEEK 读）。正文超过 20000 字会被截断并注明。附件要落盘用 mail_attachment。",
  promptSnippet: "mail_read(account?, uid, folder?) → 一封信的正文与附件清单",
  parameters: {
    type: "object",
    properties: {
      account: accountParam,
      folder: folderParam,
      uid: { type: "number", description: "邮件 uid（从 mail_list 拿）" },
    },
    required: ["uid"],
    additionalProperties: false,
  },
  async execute(_id: string, params: any) {
    try {
      const reply = await callTool("mail_read", params ?? {}, READ_MS);
      if (!reply.ok) return textResult(`没读出来：${explain(reply, "原因不明")}`, { ok: false, code: reply.code });
      const m = reply.message as any;
      const attach = (m.attachments ?? []).length
        ? `\n\n附件（${m.attachments.length}）：\n${m.attachments.map((a: any) => `- #${a.index} ${a.filename}（${Math.round((a.size ?? 0) / 1024)}KB，${a.contentType}）`).join("\n")}`
        : "";
      const head = `主题：${m.subject}\n发件人：${m.from}\n收件人：${(m.to ?? []).join(", ") || "(无)"}\n时间：${dateText(m.date)}`;
      return textResult(`${head}\n\n${m.text || "(没有纯文本正文)"}${attach}`, { ok: true, message: m, attachmentsAllowed: reply.attachmentsAllowed });
    } catch (err: any) {
      return textResult(`没读出来：${String(err?.message ?? err)}`, { ok: false, code: "channel" });
    }
  },
};

const sendParams = {
  account: accountParam,
  to: { type: "string", description: "收件人，多个用逗号分隔" },
  cc: { type: "string", description: "抄送，多个用逗号分隔" },
  bcc: { type: "string", description: "密送，多个用逗号分隔" },
  subject: { type: "string", description: "主题" },
  text: { type: "string", description: "纯文本正文（写邮件时优先给这个）" },
  html: { type: "string", description: "HTML 正文（可选，和 text 二选一或都给）" },
  attachments: { type: "array", items: { type: "string" }, description: "附件的本机绝对路径列表" },
};

const mailSendTool = {
  name: "mail_send",
  label: "发邮件",
  description:
    "用用户配好的邮箱账号发一封邮件。发送前可能要用户在页面上确认（取决于设置），所以这一步会等。失败时按 `code` 处置：`declined`/`no-page` = 没发出，别重试；`rate-limited` = 当天额度用完；`recipients` = 收件人不在白名单；`policy-denied:send` = 设置里关着发信。成功后返回 messageId。",
  promptSnippet: "mail_send(account?, to, subject, text, cc?, bcc?, html?, attachments?) → 发一封邮件（可能需要在页面上确认）",
  parameters: {
    type: "object",
    properties: sendParams,
    required: ["to", "subject"],
    additionalProperties: false,
  },
  async execute(_id: string, params: any) {
    try {
      const reply = await callTool("mail_send", params ?? {}, WRITE_MS);
      if (!reply.ok) return textResult(`没发出：${explain(reply, "原因不明")}`, { ok: false, code: reply.code });
      return textResult(`已发送（messageId: ${reply.messageId || "无"}）。`, { ok: true, messageId: reply.messageId });
    } catch (err: any) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      return textResult(`没发出：${timedOut ? "页面一直没回应确认请求。" : String(err?.message ?? err)}`, { ok: false, code: "channel" });
    }
  },
};

const mailDraftTool = {
  name: "mail_draft",
  label: "存草稿",
  description:
    "把一封信存进邮箱的草稿箱，不当场发。参数和 mail_send 一样。用户说「先起草」时用它；确认要发再用 mail_send。",
  promptSnippet: "mail_draft(account?, to, subject, text, cc?, bcc?, html?, attachments?) → 存进草稿箱，不发送",
  parameters: {
    type: "object",
    properties: sendParams,
    required: ["to", "subject"],
    additionalProperties: false,
  },
  async execute(_id: string, params: any) {
    try {
      const reply = await callTool("mail_draft", params ?? {}, WRITE_MS);
      if (!reply.ok) return textResult(`没存成草稿：${explain(reply, "原因不明")}`, { ok: false, code: reply.code });
      return textResult(`已存进草稿箱（uid: ${reply.draftUid || "无"}）。`, { ok: true, draftUid: reply.draftUid });
    } catch (err: any) {
      return textResult(`没存成草稿：${String(err?.message ?? err)}`, { ok: false, code: "channel" });
    }
  },
};

const mailReplyTool = {
  name: "mail_reply",
  label: "回复邮件",
  description:
    "回复一封信：自动取原信的发件人当收件人、主题加 `Re: `、正文末尾附上原文引用。`replyAll` 会把原信的其他收件人放进抄送。参数里的 text 只写你要说的话，不用自己复制原文。",
  promptSnippet: "mail_reply(account?, uid, text, folder?, replyAll?, attachments?) → 回复一封信",
  parameters: {
    type: "object",
    properties: {
      account: accountParam,
      folder: folderParam,
      uid: { type: "number", description: "要回复的那封信的 uid" },
      text: { type: "string", description: "回复正文（不用含原文引用）" },
      replyAll: { type: "boolean", description: "是否回复全部（原信的其他收件人进抄送）" },
      attachments: { type: "array", items: { type: "string" }, description: "附件的本机绝对路径" },
    },
    required: ["uid", "text"],
    additionalProperties: false,
  },
  async execute(_id: string, params: any) {
    try {
      const reply = await callTool("mail_reply", params ?? {}, WRITE_MS);
      if (!reply.ok) return textResult(`没发出去：${explain(reply, "原因不明")}`, { ok: false, code: reply.code });
      return textResult(`已回复（messageId: ${reply.messageId || "无"}）。`, { ok: true, messageId: reply.messageId });
    } catch (err: any) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      return textResult(`没发出去：${timedOut ? "页面一直没回应确认请求。" : String(err?.message ?? err)}`, { ok: false, code: "channel" });
    }
  },
};

const mailAttachmentTool = {
  name: "mail_attachment",
  label: "取附件",
  description:
    "把某封信的第 index 个附件下载到本机（`<状态目录>/mail/downloads/<账号>/`），返回落盘路径。index 从 0 开始，用 mail_read 的附件清单确认序号。下载后要给人看可以用 open_preview。",
  promptSnippet: "mail_attachment(account?, uid, index, folder?) → 下载附件到本机并返回路径",
  parameters: {
    type: "object",
    properties: {
      account: accountParam,
      folder: folderParam,
      uid: { type: "number", description: "邮件 uid" },
      index: { type: "number", description: "附件序号，从 0 开始" },
    },
    required: ["uid"],
    additionalProperties: false,
  },
  async execute(_id: string, params: any) {
    try {
      const reply = await callTool("mail_attachment", params ?? {}, READ_MS);
      if (!reply.ok) return textResult(`没取下来：${explain(reply, "原因不明")}`, { ok: false, code: reply.code });
      return textResult(`已保存到 ${reply.path}（${Math.round(Number(reply.size ?? 0) / 1024)}KB）。`, { ok: true, path: reply.path, size: reply.size });
    } catch (err: any) {
      return textResult(`没取下来：${String(err?.message ?? err)}`, { ok: false, code: "channel" });
    }
  },
};

const TOOLS = [
  mailAccountsTool,
  mailListTool,
  mailReadTool,
  mailSendTool,
  mailDraftTool,
  mailReplyTool,
  mailAttachmentTool,
];

export default function mailTools(pi: any): void {
  for (const tool of TOOLS) pi.registerTool(tool);
  pi.on("session_start", async () => {
    console.error("[mail] active");
  });
}
