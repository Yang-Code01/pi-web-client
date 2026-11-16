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

/** 图片要和一段说明一起回：模型先看到「这是什么」，再看到图片本身。 */
const imageResult = (text: string, data: string, mimeType: string, details: Record<string, unknown> = {}) => ({
  content: [
    { type: "text" as const, text },
    { type: "image" as const, data, mimeType },
  ],
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
  "policy-denied:account": "这个账号没有开放给 AI，让用户在设置里勾上它。",
  declined: "用户没有确认发送。把这封信的内容写给他看，等他改完再说。",
  "no-page": "没有页面在看这个会话，没法确认发送；把邮件内容写出来，让用户自己发或回到网页里再试。",
  // 页面在 5 分钟内没回执（弹窗没画出来 / 页签关了）：同样是「没发出去」，别重试。
  "no-ack": "确认弹窗没有回音，这封信没发出去。把内容写出来，让用户回到网页里自己发。",
  // 弹窗画出来了，但一直没人点：人不在，别重试。
  "confirm-timeout": "确认弹窗放了 5 分钟没人点，这封信没发出去。等用户在的时候再发。",
  "rate-limited": "今天的额度用完了，别重试；把情况告诉用户。",
  recipients: "收件人不在白名单里，别换个写法重试；告诉用户被拦了。",
  "auth-failed": "授权码或服务开关有问题，让用户在邮箱设置里重新验证。",
  "imap-id": "网易拦了这次登录，让用户确认填的是客户端授权码并已开 IMAP。",
  "no-account": "用户还没配邮箱账号，先请他打开邮箱面板加一个。",
  "not-found": "这封信或这个账号不在了，重新列一下再试。",
  "bad-input": "参数不对，按工具说明补齐再试。",
  "too-large": "邮件太大，别重试；让用户用邮箱客户端打开。",
  "not-image": "这一项不是可直接看的图片；要落盘就用 mail_attachment。",
  "image-too-large": "这张图超过 3MB；用 mail_attachment 存到本机，再让用户用图片查看器打开。",
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

function decodeHtmlText(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * 纯 HTML 的信没有纯文本部分：把标签剥了给模型看，总比「没有正文」强。导出去是为了单测。
 *
 * `<img>` 不能静默消失：以前剥完标签只剩空白，模型完全不知道信里有图。现在保留成
 * `[图片：alt]` / `[图片]`，和 `mail_read` 的内嵌图片清单对得上。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      const label = decodeHtmlText(String(alt?.[2] ?? alt?.[3] ?? alt?.[4] ?? "").trim());
      return label ? ` [图片：${label}] ` : " [图片] ";
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
      // 「改邮箱状态」（mutate）在 v1 里没有对应动作，面板也不给那个开关：别向模型报一个不存在的项。
      const policy = `读 ${on(p.read)} / 发 ${on(p.send)} / 草稿 ${on(p.draft)} / 附件 ${on(p.attachments)} / 发送前确认 ${on(p.confirmSend)} / 日上限 ${p.dailySendLimit || "不限"}`;
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
    "列出某个文件夹里最近的邮件（默认 INBOX、20 封、按时间倒序）。每项给 uid / 时间 / 发件人 / 主题 / 是否未读 / 是否有附件。想读正文用 mail_read（带 uid）。更早的信用 `offset` 往后翻（offset=20 就是跳过最近的 20 封），别以为列表就是全部。",
  promptSnippet: "mail_list(account?, folder?, limit?, offset?, unread?) → 最近邮件的摘要列表（不含正文）",
  parameters: {
    type: "object",
    properties: {
      account: accountParam,
      folder: folderParam,
      limit: { type: "number", description: "最多几封，默认 20，上限 100" },
      offset: { type: "number", description: "跳过最近几封（按时间倒序），用来翻更早的邮件；默认 0" },
      unread: { type: "boolean", description: "只看未读" },
    },
    additionalProperties: false,
  },
  async execute(_id: string, params: any) {
    try {
      const reply = await callTool("mail_list", params ?? {}, READ_MS);
      if (!reply.ok) return textResult(`没列出来：${explain(reply, "原因不明")}`, { ok: false, code: reply.code });
      const rows = (reply.messages as any[]) ?? [];
      if (!rows.length) return textResult(`${reply.folder} 里没有${params?.unread ? "未读" : params?.offset ? "更早的" : ""}邮件。`, { ok: true, messages: [] });
      const lines = rows.map(
        (m) =>
          `- uid=${m.uid} · ${dateText(m.date)} · ${m.unread ? "未读 · " : ""}${m.hasAttachments ? "📎 · " : ""}${m.from || "(未知发件人)"} — ${m.subject}`,
      );
      const more = rows.length >= Number(params?.limit ?? 20) ? `\n（可能还有更早的：再调一次带 offset=${Number(params?.offset ?? 0) + rows.length}）` : "";
      return textResult(`${reply.folder}（${rows.length} 封）：\n${lines.join("\n")}${more}`, { ok: true, folder: reply.folder, messages: rows });
    } catch (err: any) {
      return textResult(`没列出来：${String(err?.message ?? err)}`, { ok: false, code: "channel" });
    }
  },
};

const mailReadTool = {
  name: "mail_read",
  label: "读邮件",
  description:
    "读一封信的完整内容：发件人 / 收件人 / 时间 / 正文 / 附件与内嵌图片清单。默认不改「已读」标记（用 PEEK 读）。正文超过 20000 字会被截断并注明；只有 HTML 正文的信会把标签剥掉，图片保留成 `[图片]` / `[图片：alt]`。真正看内嵌图片用 mail_image；附件要落盘用 mail_attachment。",
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
      const all: any[] = m.attachments ?? [];
      // `inline` 是桥按 Content-Disposition / related 判出来的；带 Content-ID 的普通图片附件
      // （disposition=attachment）仍应留在附件清单里，不能只看 cid。
      const images = all.filter((a) => a.inline && a.contentId && String(a.contentType ?? "").toLowerCase().startsWith("image/"));
      const files = all.filter((a) => !a.inline);
      const attach = files.length
        ? `\n\n附件（${files.length}）：\n${files.map((a: any) => `- #${a.index} ${a.filename}（${Math.round((a.size ?? 0) / 1024)}KB，${a.contentType}）`).join("\n")}`
        : "";
      const imageList = images.length
        ? `\n\n内嵌图片（${images.length}）：\n${images
            .map((a: any) => `- #${a.index} ${a.filename}（${Math.round((a.size ?? 0) / 1024)}KB，${a.contentType}${a.contentId ? `，cid: ${a.contentId}` : ""}）`)
            .join("\n")}\n（要看图片内容用 mail_image，带同样的 uid 和 index）`
        : "";
      // 纯 HTML 的信以前到这里就只剩「(没有纯文本正文)」—— 扒标签给模型看一眼。
      const plain = String(m.text ?? "").trim();
      const fromHtml = !plain && m.html ? htmlToText(String(m.html)) : "";
      const body = plain || fromHtml || "";
      const head = `主题：${m.subject}\n发件人：${m.from}\n收件人：${(m.to ?? []).join(", ") || "(无)"}\n时间：${dateText(m.date)}`;
      const note = fromHtml ? "\n\n（这封信只有 HTML 正文，下面是扒掉标签的纯文本）" : "";
      // 附件清单照样给，但「落盘」要用户开过「取附件」：说清，别让人以为点了就能下。
      const lock = files.length && reply.attachmentsAllowed === false ? "\n（要存到本机得让用户在邮箱设置里打开「取附件」。）" : "";
      return textResult(`${head}\n\n${body || "(没有可读正文)"}${note}${attach}${imageList}${lock}`, {
        ok: true,
        message: m,
        attachmentsAllowed: reply.attachmentsAllowed,
        inlineImages: images,
      });
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

const mailImageTool = {
  name: "mail_image",
  label: "看邮件图片",
  description:
    "把邮件里的一张内嵌图片作为图片返回给模型看（png / jpeg / gif / webp，单张不超过 3MB）。编号从 mail_read 的「内嵌图片」清单里拿。图片太大或格式不支持时改用 mail_attachment 存到本机。",
  promptSnippet: "mail_image(account?, uid, index, folder?) → 内嵌图片内容（ImageContent）",
  parameters: {
    type: "object",
    properties: {
      account: accountParam,
      folder: folderParam,
      uid: { type: "number", description: "邮件 uid" },
      index: { type: "number", description: "内嵌图片的附件序号（mail_read 清单里的 #）" },
    },
    required: ["uid", "index"],
    additionalProperties: false,
  },
  async execute(_id: string, params: any) {
    try {
      const reply = await callTool("mail_image", params ?? {}, READ_MS);
      if (!reply.ok) return textResult(`没看到这张图：${explain(reply, "原因不明")}`, { ok: false, code: reply.code });
      const data = String(reply.base64 ?? "");
      if (!data) return textResult("没看到这张图：桥没有返回图片数据。", { ok: false, code: "empty" });
      return imageResult(
        `内嵌图片：${reply.filename}（${Math.round(Number(reply.size ?? 0) / 1024)}KB，${reply.contentType}）`,
        data,
        String(reply.contentType),
        { ok: true, filename: reply.filename, size: reply.size, contentType: reply.contentType },
      );
    } catch (err: any) {
      return textResult(`没看到这张图：${String(err?.message ?? err)}`, { ok: false, code: "channel" });
    }
  },
};

const mailAttachmentTool = {
  name: "mail_attachment",
  label: "取附件",
  description:
    "把某封信的第 index 个附件（含内嵌图片）下载到本机（`<状态目录>/mail/downloads/<账号>/`），返回落盘路径。index 从 0 开始，用 mail_read 的附件 / 内嵌图片清单确认序号。下载后要给人看可以用 open_preview。",
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
  mailImageTool,
  mailAttachmentTool,
];

const MAIL_TOOL_NAMES = TOOLS.map((tool) => tool.name);

/**
 * 用户这一句提到邮件了吗。只看用户原话（`input` 事件拿到的是展开 `/skill:` 之前的文本）。
 * 宁可漏判也别乱开：漏了用户再说一句「看邮件」就行，乱开会往一个跟邮件无关的会话中途塞 8 个工具。
 */
const MAIL_INTENT = /邮件|邮箱|收件箱|发件箱|草稿箱|e-?mail|\bmail|inbox|メール/i;

export function mentionsMail(text: unknown): boolean {
  return typeof text === "string" && MAIL_INTENT.test(text);
}

/**
 * 邮箱工具默认不挂，用户提到邮件时才挂上（D280）。
 *
 * 每个工具都占系统提示与工具清单；更要紧的是工具清单在会话中途一变，pi 就要补一条 system 消息，
 * 碰上能中途调思考强度的模型（opus-5.5）会被 Anthropic 400 拒掉（pi-ai 1.5.0 的排序问题）。
 * 所以：没提邮件的会话一个 `mail_*` 都不带；一旦挂上就留到会话结束，不来回卸，
 * pi 把清单记在会话里，续聊时自己恢复。
 */
export default function mailTools(pi: any): void {
  for (const tool of TOOLS) pi.registerTool({ ...tool, defaultActive: false });
  pi.on("input", async (event: any) => {
    if (event?.source === "extension" || !mentionsMail(event?.text)) return { action: "continue" };
    const active: string[] = pi.getActiveTools();
    const missing = MAIL_TOOL_NAMES.filter((name) => !active.includes(name));
    if (missing.length > 0) {
      pi.setActiveTools([...active, ...missing]);
      console.error(`[mail] tools on: ${missing.join(",")}`);
    }
    return { action: "continue" };
  });
}
