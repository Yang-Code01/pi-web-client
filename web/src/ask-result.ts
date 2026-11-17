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
  /** 刻度带上说的那句：`header` 优先，没有就用题面（旧单题的题面在 `question` 里）。 */
  title: string;
  prompt: string;
  options: unknown[];
}

/** 刻度带上问卷标题的长度上限，与 `turnLabel` 和桥的 `TURN_TEXT_MAX` 对齐。 */
const ASK_TITLE_MAX = 80;

/**
 * 一条问卷在刻度带上的一行字：`问卷概况：第一题 · 等 N 题`。
 *
 * 一份问卷（包括多题）只占一格，所以只取第一题开头那几个字；多题时补一句题数，单题不补。
 * 桥下发的 ghost 索引里文字已经截到 80 字，这里再折一次是为了**实时**那种还没经过桥的手；
 * 两边的结果必须一样，否则同一份问卷载入前后会显示成两句。
 */
export function askTurnLabel(title: string, questions: number): string {
  const one = String(title ?? "").replace(/\s+/g, " ").trim();
  const brief = one.length > ASK_TITLE_MAX ? `${one.slice(0, ASK_TITLE_MAX - 1)}…` : one;
  const n = Number(questions) > 0 ? Math.floor(Number(questions)) : 0;
  if (!brief) return n > 1 ? tr("问卷概况 · 等 {p1} 题", { p1: n }) : tr("问卷概况");
  if (n > 1) return tr("问卷概况：{p1} · 等 {p2} 题", { p1: brief, p2: n });
  return tr("问卷概况：{p1}", { p1: brief });
}

/** 把一次提问的参数归一成同一形状：新工具是 `questions[]`，旧 `question` 是平铺的单个问题。 */
export function askQuestions(args: unknown): AskQuestion[] {
  const a = (args ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(a.questions) ? (a.questions as any[]) : [];
  const list = raw.length ? raw : a.question !== undefined || a.options !== undefined ? [a] : [];
  return list.map((q, i) => {
    const header = String(q?.header ?? q?.label ?? "").trim();
    const prompt = String(q?.question ?? q?.prompt ?? "");
    return {
      label: header || `Q${i + 1}`,
      title: header || prompt,
      prompt,
      options: Array.isArray(q?.options) ? q.options : [],
    };
  });
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
