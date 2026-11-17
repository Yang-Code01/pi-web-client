/**
 * 上下文浏览器里 system 段的可读化：把 pi 写进 prompt 的 XML 分节拆成「技能目录」与正文。
 *
 * 纯字符串处理，不碰 DOM —— 渲染在 `context-panel.ts`，测试在 `web/tests/context-unit.mjs`。
 *
 * 两类输入：
 * - `sec:skills`：整段 `<skills>…<available_skills><skill>…` （**按 XML 转义过的**，界面上要解码）
 * - `sec:rules` / `sec:docs` / `sec:project_context` …：`<tag>` 包一层，里面是原样的 Markdown
 */

export interface SkillEntry {
  name: string;
  description: string;
  location: string;
}

export interface SkillCatalog {
  /** `<available_skills>` 之前那段说明（"The following skills provide…"），没有就是空串。 */
  intro: string;
  skills: SkillEntry[];
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** pi 把技能描述按 XML 转义写进 prompt（`&quot;`、`&apos;`、`&amp;`）；界面要显示解码后的原文。 */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole: string, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[lower] ?? whole;
  });
}

const OUTER_TAG = /^<([a-z_][\w-]*)(\s[^>]*)?>/i;

/** 取 `<tag>…</tag>` 里的第一段内容（技能条目里 name / description / location 各一次）。 */
function tagBody(block: string, tag: string): string {
  const open = block.indexOf(`<${tag}>`);
  if (open < 0) return "";
  const start = open + tag.length + 2;
  const end = block.indexOf(`</${tag}>`, start);
  return end < 0 ? "" : block.slice(start, end);
}

/** `<skills>…</skills>` → 说明 + 技能条目。没写 location 的条目照样收（顺序保持 prompt 里的顺序）。 */
export function ctxSkillCatalog(xml: string): SkillCatalog {
  const src = xml ?? "";
  const introAt = src.indexOf("<available_skills>");
  // 开头那行 `<skills>` 是分节标记，不是说明文字。
  const intro = introAt > 0 ? decodeEntities(src.slice(0, introAt).replace(OUTER_TAG, "")).trim() : "";
  const skills: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const match of src.matchAll(/<skill>([\s\S]*?)<\/skill>/g)) {
    const block = match[1] ?? "";
    const name = decodeEntities(tagBody(block, "name")).trim();
    // 同名技能可能同时来自多个目录（插件 + 用户目录）；prompt 里是两条，这里留两条但去掉完全重复的。
    const description = decodeEntities(tagBody(block, "description")).trim();
    const location = decodeEntities(tagBody(block, "location")).trim();
    if (!name) continue;
    const key = `${name}\n${location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    skills.push({ name, description, location });
  }
  return { intro, skills };
}

/** `<rules>…</rules>` 这层包裹只是 prompt 的分节标记：去掉它，留下正文。 */
export function ctxUnwrapSection(src: string): { tag: string; text: string } {
  const text = (src ?? "").replace(/\r\n?/g, "\n").trim();
  const open = OUTER_TAG.exec(text);
  if (!open) return { tag: "", text };
  const tag = (open[1] ?? "").toLowerCase();
  const tail = `</${tag}>`;
  if (!text.toLowerCase().endsWith(tail)) return { tag: "", text };
  return { tag, text: text.slice(open[0].length, text.length - tail.length).trim() };
}

const INSTRUCTIONS = /<project_instructions(?:\s+path="([^"]*)")?\s*>([\s\S]*?)<\/project_instructions>/gi;

/**
 * 注入段 → Markdown。
 *
 * `project_context` 里按文件分了 `<project_instructions path="…">` 几块：给每块补一条粗体路径当分界，
 * 让 AGENTS.md 的几份文件在界面上各成一段，而不是糊成一坨。用粗体而不是标题，免得跟文件自带的
 * `##` / `###` 抢层级。
 */
export function ctxSectionMarkdown(src: string): string {
  const { text } = ctxUnwrapSection(src);
  return text
    .replace(INSTRUCTIONS, (_whole: string, path: string | undefined, body: string) => {
      const inner = body.trim();
      return path ? `\n\n**${path}**\n\n${inner}\n\n` : `\n\n${inner}\n\n`;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
