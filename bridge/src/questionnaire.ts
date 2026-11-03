/**
 * D90: `ask_user_question` 在 rpc 下逐题弹 select / input（rpiv-ask-user-question 的
 * rpc-fallback.ts），网页只能一题一题答、答了回不去，每题还各推一次通知。
 *
 * 桥在 `tool_execution_start` 就拿得到整份问卷（工具参数）。这里把它变成一份多题 ask，
 * 用户在网页上一次填完（可来回改）；之后陆续到来的逐题对话框由桥按标题认题、按答案回填。
 * 认不出来的对话框照旧单独问 —— 回填失败的代价只是退回原来的逐题模式。
 *
 * 回填格式跟着 rpc-fallback.ts 走：
 * - 单选（select）：选项发对话框里那一行原文（`N. label — desc`），自己写的发原文；
 * - 多选（input）：`1,3` 加可选的 `; 自己写的`。
 */
import type { AskAnswer, AskQuestion } from "./sessions.ts";

export interface QuestionnaireQuestion extends AskQuestion {
  /** 对话框标题去掉空白后的前缀：`[header] question`。 */
  key: string;
}

/** 工具参数 → 网页问卷；形状不对就返回 null（调用方退回逐题模式）。 */
export function parseQuestionnaire(args: unknown): QuestionnaireQuestion[] | null {
  const raw = asList(asRecord(args)?.questions);
  if (!raw?.length) return null;
  const out: QuestionnaireQuestion[] = [];
  for (const [i, item] of raw.entries()) {
    const q = asRecord(item);
    const prompt = typeof q?.question === "string" ? q.question.trim() : "";
    const options = asList(q?.options);
    if (!q || !prompt || !options) return null;
    const header = typeof q.header === "string" && q.header.trim() ? q.header.trim() : "";
    out.push({
      id: `q${i + 1}`,
      label: header || `Q${i + 1}`,
      prompt,
      options: options.flatMap((item) => {
        const o = asRecord(item);
        if (typeof o?.label !== "string" || !o.label.trim()) return [];
        return [{ value: o.label, label: o.label, ...(typeof o.description === "string" && o.description ? { description: o.description } : {}) }];
      }),
      allowOther: true,
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      key: squash(`${header ? `[${header}] ` : ""}${prompt}`),
    });
  }
  return out;
}

/** 这个对话框是哪一题：标题（去空白）以题目前缀开头。`taken` 里的题不再认。 */
export function matchDialog(questions: QuestionnaireQuestion[], title: string, taken: Set<string>): QuestionnaireQuestion | null {
  const key = squash(title);
  // 先认长的：一题的前缀可能是另一题的前缀（同一 header 下题目以相同文字开头）。
  const sorted = questions.filter((q) => !taken.has(q.id)).sort((a, b) => b.key.length - a.key.length);
  return sorted.find((q) => key.startsWith(q.key)) ?? null;
}

/** 按对话框类型生成回填值；类型对不上（例如单选题来了 input）返回 null。 */
export function replyFor(q: QuestionnaireQuestion, answer: AskAnswer, method: string, lines: string[]): string | null {
  if (q.multiSelect) {
    if (method !== "input") return null;
    const picks = (answer.picks ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= q.options.length);
    const text = (answer.text ?? "").trim();
    if (picks.length) return text ? `${picks.join(",")}; ${text}` : picks.join(",");
    return text;
  }
  if (method !== "select") return null;
  if (!answer.wasCustom && answer.index && answer.index >= 1 && answer.index <= q.options.length) {
    return lines[answer.index - 1] ?? String(answer.index);
  }
  return String(answer.value);
}

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

type Fields = Record<string, unknown>;

/**
 * 有的模型把嵌套结构编码成 JSON 字符串（rpiv 的 prepareQuestionArguments 也这么解），
 * 所以对象 / 数组位置上的字符串先试着解一次。
 */
function asRecord(value: unknown): Fields | null {
  const v = typeof value === "string" ? parseJson(value) : value;
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Fields) : null;
}

function asList(value: unknown): unknown[] | null {
  const v = typeof value === "string" ? parseJson(value) : value;
  return Array.isArray(v) ? v : null;
}

function parseJson(text: string): object | null {
  try {
    const v: object | null = JSON.parse(text);
    return typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
