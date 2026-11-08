/**
 * `open_preview` (#224) — 让模型把一份文件推到用户眼前的网页预览面板里。
 *
 * 预览是「页面」的事：pi 子进程里没有界面，能打开它的只有正看着这个会话的那个标签页。
 * 所以这个工具只做一件事 —— 带着会话级凭据去敲桥的本机回环路由，由桥决定投不投递；
 * 没有页面在看就明确失败，绝不假装打开成功（那样模型会接着讲用户根本没看到的东西）。
 *
 * 桥只在网页会话里用 `-e <this file>` 挂它。凭据来自 spawn 时的 env：
 * PI_WEB_LOOPBACK = 本机回环 origin，PI_WEB_LOOPBACK_TOKEN = 这个子进程专用的 token。
 *
 * stdout 属于 RPC 协议：日志只能走 console.error。
 */

const textResult = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

interface OpenReply {
  ok: boolean;
  path?: string;
  name?: string;
  reason?: string;
  text?: string;
}

async function postOpen(filePath: string): Promise<OpenReply> {
  const base = process.env.PI_WEB_LOOPBACK;
  const token = process.env.PI_WEB_LOOPBACK_TOKEN;
  if (!base || !token) throw new Error("网页预览通道未配置（缺 PI_WEB_LOOPBACK / PI_WEB_LOOPBACK_TOKEN）");
  const res = await fetch(`${base}/api/preview/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, path: filePath }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    return {
      ok: false,
      reason: String(body?.reason ?? body?.error ?? `http-${res.status}`),
      text: String(body?.text ?? ""),
    };
  }
  return body as OpenReply;
}

const openPreviewTool = {
  name: "open_preview",
  label: "在网页里打开文件",
  description:
    "在用户正在看的网页客户端里，用预览面板打开一个文件（文档、图片、表格、代码都行），标题就是文件名。用户要看的、或者你要给他指出来的文件，用它比贴路径更直接。注意：只有用户此刻正打开着这个会话时才能打开；返回 ok:false / no-page 就说明没有页面在看，此时不要当成打开了 —— 把路径写出来告诉用户即可。",
  promptSnippet: "open_preview(path) → 让网页的预览面板打开这个文件（没有页面在看这个会话时会失败）",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "要打开的文件路径：相对路径按会话的工作目录解析，也可以给绝对路径" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(_id: string, params: any) {
    const target = String(params?.path ?? "").trim();
    if (!target) return textResult("没有给路径，没打开任何东西。", { ok: false, reason: "path" });
    let reply: OpenReply;
    try {
      reply = await postOpen(target);
    } catch (err: any) {
      return textResult(`没打开：${String(err?.message ?? err)}`, { ok: false, reason: "channel" });
    }
    if (reply.ok) {
      return textResult(`已在网页里打开「${reply.name ?? target}」。`, { ok: true, path: reply.path, name: reply.name });
    }
    if (reply.reason === "no-page") {
      return textResult(`没有打开：用户现在没有在看这个会话（网页那边没有打开的页面）。把路径告诉用户，等他打开会话后再试。`, { ok: false, reason: "no-page" });
    }
    return textResult(`没有打开（${reply.reason ?? "unknown"}）${reply.text ? `：${reply.text}` : "。"}`, { ok: false, reason: reply.reason });
  },
};

export default function openPreview(pi: any): void {
  pi.registerTool(openPreviewTool);
  pi.on("session_start", async () => {
    console.error("[open-preview] active");
  });
}
