/**
 * 提问兜底 —— 模型在正文里问用户、却没调用 `ask_user_question` 时，停下前把它拉回来重问一次。
 *
 * 起因：会话 `455ac52c`（「回复时间」）第 12 轮，模型加载了 grilling 技能，按技能的
 * `❓ Q1 + ➡️ 建议` 格式在正文里一次问了三个问题，整轮没有调用提问工具；用户第 13 轮追问
 * 才补上表单。技能给的是「问什么」的格式，不该决定「怎么呈现」；而项目里的提示词只是软建议，
 * 长回合里管不住。所以照 #357 `plan-nudge.ts` 的路子，在 pi 的 `agent_before_settle`
 * （停下前最后一个能动手的点）补一条只给模型看的消息（`display:false`），请求续跑一次。
 *
 * 为什么挂在这里而不是改提示词：
 * - 提示词靠模型自觉，这次已经证明会被已加载 skill 的显式格式盖过去；
 * - 不新增用户回合 —— 轮次编号、会话树、「需要你」/完成提示音都不受影响；
 * - 桥只认 `agent_settled` 为空闲，续跑在同一段「运行中」里，页面不闪；
 * - 用户按了中断，pi 自己会丢掉续跑请求（outcome 也不是 completed）。
 *
 * 开关：全局 settings.json 的 `web.askNudge`（设置 → 工具与脚本），**默认开**——
 * 这是兜底，不是可选装饰，只有显式写 `false` 才关。每次停下现读，改了不用重启会话。
 * 文件路径由桥经 `PI_WEB_SETTINGS_FILE` 给（桥对 agentDir 的认定为准）。
 *
 * 触发条件（全部满足）：
 * - 开关开、本次运行正常结束、还能续跑；
 * - 会话末尾是一条 assistant 的正文（不是工具结果），本轮自最后一条用户消息之后没调过提问工具；
 * - 正文里有「在问用户」的结构（❓Q1、行首 Q1、或结尾带第二人称的选择问句）；
 * - 这段问句之前没提醒过（按问句摘要去重，重启也不重复），且本会话提醒次数 < MAX_NUDGES。
 *
 * 第二道兜底（`tool_call`，同一个开关）：问卷题干 / 选项里写了「详情在回复里」「见上文」这类引用，
 * 而这次调用所在的助手消息正文几乎为空时，拦下这次调用，让模型先把详情写进正文再问。
 * 起因：会话 `ae79148b`（上下文面板查 bug）第 74 条助手消息只有 thinking + ask_user_question，
 * 题干说「5 个确认的 bug（详情在回复里）」，5 个 bug 却只出现在思考里，用户在页面上一个字也看不到。
 * 同一题干只拦一次：第二次还这样就放行，别把模型卡死在循环里。
 *
 * stdout 属于 RPC 协议：日志只能走 console.error。
 */
import fs from "node:fs";

export const NUDGE_TYPE = "pi-web-ask-nudge";
/** 同一段问句只提醒一次；整个会话最多两次 —— 第二次还不动就放过，别把会话卡在续跑里。 */
export const MAX_NUDGES = 2;
export const SETTING_KEY = "web.askNudge";
/** 与 bridge/ext/approval-gate.ts 的 ASK_TOOLS 一致；旧名字也要认（历史会话 / 旧扩展）。 */
const ASK_TOOLS = /^(question|questionnaire|ask_user_question|ask_user)$/;

export interface PendingQuestion {
  /** 模型最后那条回复的正文。 */
  text: string;
  /** 命中的问句附近，用来给提醒引用，也用来算去重摘要。 */
  snippet: string;
  hash: string;
}

function textOf(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("\n")
    .trim();
}

/** 代码块 / 行内代码里的问号多半是代码或引用，不算在问用户。 */
export function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .trim();
}

const YOU = /[你您]/;
/** 只有「在请用户做选择 / 拿信息」时才触发；修辞问句（「这不就是…吗」）没有第二人称就不算。 */
const CHOICE =
  /要不要|是否|哪种|哪一|哪个|选哪|还是|选一|选个|可以吗|行吗|好吗|需不需要|有没有|怎么|如何|什么时候|多少/;

function snippetAt(text: string, index: number): string {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + 240);
  return text.slice(start, end).trim();
}

/**
 * 判断回复正文是不是「在正文里提问」。命中的话返回问句附近的一段，没命中返回 null。
 *
 * 只认三种结构，宁可漏一次也不误伤正常总结：
 * 1. `❓` 标记（grilling 技能的格式），后面 400 字里有 Q 编号或问号；
 * 2. 行首 `Q1` / `Q2`（可带 markdown 前缀），这一段里有问号；
 * 3. 结尾 600 字里有问号，问号前 120 字里有「你/您」，且结尾含选择词。
 */
export function looksLikeTextQuestion(raw: string): string | null {
  const text = stripCode(raw);
  if (!text) return null;

  const marker = text.indexOf("❓");
  if (marker >= 0) {
    const rest = text.slice(marker, marker + 400);
    if (/Q\s*\d/i.test(rest) || /[?？]/.test(rest)) return snippetAt(text, marker);
  }

  const numbered = text.match(/(?:^|\n)[ \t>*#-]*Q\s*\d+\b/i);
  if (numbered && numbered.index !== undefined) {
    const rest = text.slice(numbered.index, numbered.index + 400);
    if (/[?？]/.test(rest)) return snippetAt(text, numbered.index);
  }

  const tailStart = Math.max(0, text.length - 600);
  const tail = text.slice(tailStart);
  const mark = Math.max(tail.lastIndexOf("？"), tail.lastIndexOf("?"));
  if (mark < 0) return null;
  const around = tail.slice(Math.max(0, mark - 120), mark + 1);
  // 「要不要我把…？」没有第二人称，但同样是在请用户拍板。
  const asksUser = YOU.test(around) || /(要不要|需不需要|用不用|要不要帮)[^。！？]{0,12}我/.test(around);
  if (!asksUser || !CHOICE.test(tail)) return null;
  return snippetAt(text, tailStart + mark);
}

/** 稳定、短、不依赖 crypto 的摘要：同一段问句在重启后仍能对上。 */
export function hashOf(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/**
 * 会话末尾是否停在一段「正文提问」上。
 * 末尾不是 assistant 正文（比如刚跑完工具、或者已经被用户插话）就返回 null。
 */
export function pendingQuestion(branch: any[]): PendingQuestion | null {
  let end = -1;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    if (branch[i]?.type === "message") {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const message = branch[end].message;
  if (message?.role !== "assistant") return null;
  const text = textOf(message);
  if (!text) return null;

  // 本轮（最后一条用户消息之后）已经问过表单，就不算漏。
  let start = 0;
  for (let i = end - 1; i >= 0; i -= 1) {
    if (branch[i]?.type === "message" && branch[i].message?.role === "user") {
      start = i + 1;
      break;
    }
  }
  for (let i = start; i < branch.length; i += 1) {
    const msg = branch[i]?.type === "message" ? branch[i].message : null;
    if (!msg) continue;
    if (msg.role === "toolResult" && ASK_TOOLS.test(String(msg.toolName ?? ""))) return null;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const asked = msg.content.some(
        (part: any) => (part?.type === "toolCall" || part?.type === "tool_use") && ASK_TOOLS.test(String(part.name ?? "")),
      );
      if (asked) return null;
    }
  }

  const snippet = looksLikeTextQuestion(text);
  if (!snippet) return null;
  return { text, snippet, hash: hashOf(snippet) };
}

export function nudgedHashes(branch: any[]): Set<string> {
  const hashes = new Set<string>();
  for (const entry of branch) {
    if (entry?.type !== "custom_message" || entry.customType !== NUDGE_TYPE) continue;
    const hash = entry?.details?.hash;
    if (typeof hash === "string") hashes.add(hash);
  }
  return hashes;
}

export function nudgeCount(branch: any[]): number {
  return branch.filter((entry) => entry?.type === "custom_message" && entry.customType === NUDGE_TYPE).length;
}

/** 给模型的那段话。只要它把同一批问题搬进表单，不许借机接着干活、不许用正文再问一遍。 */
export function nudgeText(hit: PendingQuestion): string {
  return [
    "[网页客户端 · 提问方式核对，用户看不到这条]",
    "你刚才在正文里向用户提问了，但没有调用 `ask_user_question`。原文节选：",
    `「${hit.snippet.replace(/\s+/g, " ").slice(0, 300)}」`,
    "现在只做一件事：把这些问题的**同一批内容**搬进 `ask_user_question` 再问一遍——",
    "- 题干可以多段、可以带分支，整段放进 `question`；",
    "- 每题 2–4 个选项放进 `options`，短标签放 `label`，分支说明放 `description`；",
    "- 你的推荐答案放第一个选项，`label` 末尾加「（推荐）」；",
    "- 用户还能自己输入，所以不要加「其他」选项。",
    "不要重复解释，不要接着干活，不要再用正文问一遍。",
  ].join("\n");
}

export function nudgeEnabled(file = process.env.PI_WEB_SETTINGS_FILE): boolean {
  if (!file) return true;
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    return json?.web?.askNudge !== false;
  } catch {
    // 读不到 / 坏 JSON：兜底照常开。打不开设置不该让这条规矩静默失效。
    return true;
  }
}

// ---- 第二道兜底：问卷引用了「正文里的详情」，正文却是空的 ----

export const DETAIL_GUARD_MARK = "[网页客户端 · 问卷引用核对]";
/** 题干 / 选项里指向「正文」的说法。只认明确指向回复正文的，「详见文档」之类不算。 */
const DETAIL_REF =
  /详情(?:在|见)|(?:见|看)(?:上文|上面|前文|正文|回复|下文|下面)|如上(?:所述)?|上面(?:列|说|提|写)|上述|(?:回复|正文|上文)(?:里|中)|\b(?:see|details?)\s+(?:above|below)|\bas (?:listed|described|shown) above/i;
/** 当前这条助手消息正文少于这个字数，就算「没写详情」。 */
export const DETAIL_MIN_CHARS = 40;
/** 本轮（最后一条用户消息之后）所有助手正文加起来到这个数，就当详情写在了前一步里。 */
export const DETAIL_TURN_CHARS = 200;

function askTexts(input: any): string[] {
  const out: string[] = [];
  const walk = (v: any, depth: number) => {
    if (depth > 6 || v == null) return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "preview") walk(x, depth + 1);
  };
  walk(input, 0);
  return out;
}

/** 问卷文本里命中的引用说法；没有返回 null。 */
export function detailReference(input: any): string | null {
  for (const t of askTexts(input)) {
    const m = t.match(DETAIL_REF);
    if (m) return t.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 80).trim();
  }
  return null;
}

function visibleLength(message: any): number {
  return stripCode(textOf(message)).replace(/\s+/g, "").length;
}

/**
 * 这次提问是否「引用了正文却没写正文」。命中返回给模型的拦截理由，否则 null。
 * `branch` 要包含这次调用所在的助手消息（pi 在 `tool_call` 前保证同步到这一条）。
 */
export function danglingDetail(input: any, toolCallId: string | undefined, branch: any[]): string | null {
  const ref = detailReference(input);
  if (!ref) return null;

  let start = 0;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    if (branch[i]?.type === "message" && branch[i].message?.role === "user") {
      start = i + 1;
      break;
    }
  }
  let current: any = null;
  let turnChars = 0;
  const hash = hashOf(ref);
  for (let i = start; i < branch.length; i += 1) {
    const msg = branch[i]?.type === "message" ? branch[i].message : null;
    if (!msg) continue;
    if (msg.role === "assistant") {
      turnChars += visibleLength(msg);
      if (Array.isArray(msg.content) && msg.content.some((p: any) => p?.type === "toolCall" && p.id === toolCallId)) current = msg;
    }
    // 同一段引用已经拦过一次：放行。
    if (msg.role === "toolResult" && ASK_TOOLS.test(String(msg.toolName ?? "")) && textOf(msg).includes(`${DETAIL_GUARD_MARK}#${hash}`)) {
      return null;
    }
  }
  // 找不到所在消息（极少见）时退回看最后一条助手消息。
  if (!current) {
    for (let i = branch.length - 1; i >= start; i -= 1) {
      const msg = branch[i]?.type === "message" ? branch[i].message : null;
      if (msg?.role === "assistant") {
        current = msg;
        break;
      }
    }
  }
  if (visibleLength(current) >= DETAIL_MIN_CHARS || turnChars >= DETAIL_TURN_CHARS) return null;

  return [
    `${DETAIL_GUARD_MARK}#${hash} 这次提问没有发出去，用户还没看到问卷。`,
    `问卷里写了「${ref.replace(/\s+/g, " ")}」，但你的回复正文几乎是空的：思考（thinking）用户看不到，详情只在那里等于没写。`,
    "先在正文里把要用户依据的内容写出来（例如查出的问题清单、各自的现象和原因），再用同样的问卷调用一次 `ask_user_question`。",
    "或者把详情直接写进 `question` 题干里，不要再说「详情在回复里」。",
  ].join("\n");
}

export default function askNudge(pi: any): void {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!ASK_TOOLS.test(String(event?.toolName ?? ""))) return;
    if (!nudgeEnabled()) return;
    let branch: any[];
    try {
      branch = ctx.sessionManager.getBranch();
    } catch (err) {
      console.error("[ask-nudge] 读不到会话分支：", err);
      return;
    }
    const reason = danglingDetail(event.input, event.toolCallId, branch);
    if (!reason) return;
    console.error("[ask-nudge] 问卷引用了正文详情但正文为空 → 拦下这次提问");
    return { block: true, reason };
  });

  pi.on("agent_before_settle", async (event: any, ctx: any) => {
    if (event?.outcome !== "completed" || event?.context?.canContinue === false) return;
    if (!nudgeEnabled()) return;
    let branch: any[];
    try {
      branch = ctx.sessionManager.getBranch();
    } catch (err) {
      console.error("[ask-nudge] 读不到会话分支：", err);
      return;
    }
    if (nudgeCount(branch) >= MAX_NUDGES) return;
    const hit = pendingQuestion(branch);
    if (!hit || nudgedHashes(branch).has(hit.hash)) return;
    console.error(`[ask-nudge] 正文提问未走表单 → 续跑一次（${hit.hash}）`);
    return {
      entries: [
        ...(event.entries ?? []),
        {
          type: "custom_message",
          customType: NUDGE_TYPE,
          content: nudgeText(hit),
          display: false,
          details: { hash: hit.hash },
        },
      ],
      continue: true,
    };
  });
}
