/**
 * The four tools pi sees over MCP (D167). Descriptions are part of the interface: the model has to
 * know that ids are opaque, that names are resolved by exact match, and that a send to somebody
 * else will block on a human clicking a dialog.
 */
import type { McpTool } from "../mcp.ts";
import type { TeamsService } from "./service.ts";

/**
 * 一条消息塞进上下文的上限。长消息（转发的大段日志、邮件正文）不截断会直接吃掉几千 token，
 * 而模型这一段通常只需要知道「说了什么」；截断处留原长，需要全文时让人去网页看。
 */
const MAX_MSG_CHARS = 1500;

export function teamsTools(service: TeamsService): McpTool[] {
  return [
    {
      name: "teams_chats",
      title: "列出 Teams 最近会话",
      description:
        "列出你自己的 Teams 最近会话（网页版登录态），最近的在前。返回每条的 id、标题、类型（self/chat/meeting/channel）。" +
        "「与你自己的聊天」的 id 是 48:notes，可以随便发；其他会话发消息前会要求人工确认。",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "返回几条，默认 20，最多 50" } },
        additionalProperties: false,
      },
      run: async (args) => {
        const limit = num(args.limit, 20);
        const chats = await service.chats(limit);
        return { value: { chats } };
      },
    },
    {
      name: "teams_read",
      title: "读 Teams 会话消息",
      description:
        "读一个会话的最近消息，从旧到新。chat 可以是 teams_chats 返回的 id，也可以直接写会话标题（必须唯一命中）。" +
        "系统消息（入群、通话记录）会被过滤掉。",
      inputSchema: {
        type: "object",
        properties: {
          chat: { type: "string", description: "会话 id（如 48:notes 或 19:...@thread.v2）或会话标题" },
          limit: { type: "number", description: "返回几条，默认 20，最多 100" },
        },
        required: ["chat"],
        additionalProperties: false,
      },
      run: async (args) => {
        const chat = str(args.chat);
        if (!chat) throw new Error("缺少 chat");
        const limit = num(args.limit, 20);
        const out = await service.messages(chat, limit);
        const messages = out.messages.map((m) =>
          m.text.length > MAX_MSG_CHARS ? { ...m, text: `${m.text.slice(0, MAX_MSG_CHARS)}…（截断，原文 ${m.text.length} 字）` } : m,
        );
        return { value: { chat: out.chat, messages } };
      },
    },
    {
      name: "teams_find",
      title: "找 Teams 联系人 / 会话",
      description:
        "按姓名或邮箱找人（公司通讯录），也会退回到你已有的会话标题里找。只返回候选，不会发消息。" +
        "拿到唯一候选后再用 teams_send 发；候选多于一人时接口会报错并列出候选，不要自己挑一个猜。",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "姓名、邮箱或会话标题的一部分" } },
        required: ["query"],
        additionalProperties: false,
      },
      run: async (args) => {
        const query = str(args.query);
        if (!query) throw new Error("缺少 query");
        return { value: { people: await service.people(query) } };
      },
    },
    {
      name: "teams_send",
      title: "发 Teams 消息",
      description:
        "把一段纯文本发到 Teams 会话。chat 省略时发给设置里的通知目标（默认「与你自己的聊天」）。" +
        "发往任何不是你自己聊天的会话，都会在 pi 网页上弹确认框等人点「发送」：没人确认、页面没开或超时，一律不发，" +
        "返回 TEAMS_NOT_CONFIRMED。收到这个错误不要重试同一条内容，先告诉用户去网页点确认，或改用 48:notes。",
      inputSchema: {
        type: "object",
        properties: {
          chat: { type: "string", description: "会话 id 或唯一命中的会话/联系人名；省略 = 设置里的通知目标" },
          text: { type: "string", description: "纯文本，换行会保留，单条最多 8000 字符" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      run: async (args) => {
        const text = str(args.text);
        const chat = str(args.chat) || undefined;
        const sent = await service.send(chat, text);
        return { value: { ok: true, chat: sent.chat, id: sent.id, time: sent.time } };
      },
    },
  ];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
