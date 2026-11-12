/**
 * 问答卡（`web/src/chat.ts` 的 `.qa-card`）从工具参数和结果文本里还原「问了什么、答了什么」。
 *
 * 结果文本是提问工具写给人看的一句话，没有结构化字段，所以只能按文案认 —— 而且得同时认三套，
 * 因为历史会话（旧工具名）和现在的会话都会走同一个 `buildAsk`：
 *
 * - `ask_user_question`（现在的 `@juicesharp/rpiv-ask-user-question`）：
 *   `User has answered your questions: "问题1"="答案1", "问题2"="答案2". You can now continue…`
 *   取消是 `User declined to answer questions`；参数里每题是 `{header, question, options}`。
 * - 旧 `question`：`User selected: 2. 左边` / `User wrote: …`，参数是 `{question, options}`。
 * - 旧 `questionnaire`：每题一行 `Q1: user selected: 2. 左边` / `Q1: user wrote: …`。
 */
import { tr } from "./i18n/index.ts";

export interface AskQuestion {
  /** 卡片左侧的标签：新工具是 `header`，旧问卷是 `label`，都没有就 `Qn`。 */
  label: string;
  prompt: string;
  options: unknown[];
}

/** 把一次提问的参数归一成同一形状：新工具是 `questions[]`，旧 `question` 是平铺的单个问题。 */
export function askQuestions(args: unknown): AskQuestion[] {
  const a = (args ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(a.questions) ? (a.questions as any[]) : [];
  const list = raw.length ? raw : a.question !== undefined || a.options !== undefined ? [a] : [];
  return list.map((q, i) => ({
    label: String(q?.header ?? q?.label ?? `Q${i + 1}`),
    prompt: String(q?.question ?? q?.prompt ?? ""),
    options: Array.isArray(q?.options) ? q.options : [],
  }));
}

/** 结果里 `"问题"="答案"` 的成对文本（键和值都可以带转义引号）。 */
const PAIR = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g;

function unquote(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_m, c: string) => ({ '"': '"', "\\": "\\", n: "\n", r: "\r", t: "\t" })[c] ?? c);
}

/**
 * 每题一个答案（`null` = 这题没答）。顺序与 `questions` 对齐。
 *
 * 解析顺序：新文案 → 旧问卷的「标签行」→ 旧单题的裸行。新文案按问题原文配对（不是按位置），
 * 所以模型把答案顺序写反了也能对上；配不上的按下标填。
 */
export function parseAskResult(text: string, questions: AskQuestion[]): (string | null)[] {
  const out: (string | null)[] = questions.map(() => null);
  const body = String(text ?? "");
  if (!body.trim() || !questions.length) return out;

  const answered = /User has answered your questions:\s*([\s\S]*?)(?:\.\s*You can now continue|$)/.exec(body);
  if (answered) {
    const pairs = [...answered[1].matchAll(PAIR)].map((m) => [unquote(m[1]), unquote(m[2])] as const);
    const used = new Set<number>();
    for (const [ask, answer] of pairs) {
      const want = ask.trim();
      let idx = questions.findIndex((q, i) => !used.has(i) && q.prompt.trim() === want);
      if (idx < 0) idx = questions.findIndex((_q, i) => !used.has(i));
      if (idx < 0) continue;
      used.add(idx);
      out[idx] = answer;
    }
    return out;
  }
  if (/User declined to answer questions/i.test(body)) return out;

  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // 旧问卷：`<标签>: user selected: 2. 左边` / `<标签>: user wrote: …`
  questions.forEach((q, i) => {
    const line = lines.find((l) => l.startsWith(`${q.label}: `));
    if (!line) return;
    const rest = line.slice(q.label.length + 2);
    const wrote = rest.match(/^user wrote:\s*(.*)$/i);
    const selected = rest.match(/^user selected:\s*\d+\.\s*(.*)$/i);
    if (wrote) out[i] = tr("（自己写）{p1}", { p1: wrote[1] });
    else if (selected) out[i] = selected[1];
  });
  if (out.some(Boolean)) return out;

  // 旧单题：裸的 `User selected: 2. 左边` / `User wrote: …`
  const wrote = lines.find((l) => l.startsWith("User wrote: "));
  const selected = lines.find((l) => l.startsWith("User selected: "));
  if (wrote) out[0] = tr("（自己写）{p1}", { p1: wrote.slice("User wrote: ".length) });
  else if (selected) out[0] = selected.replace(/^User selected: \d+\.\s*/, "");
  return out;
}
