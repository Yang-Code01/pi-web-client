/**
 * 「规矩」（D164 延伸）：复盘那一轮里模型写在回答末尾的一句做法，回来落在账本旁边。
 *
 * 前后端各存一份结构，但真正的权威是桥端的文件（`bridge/src/rules.ts`）：
 * 前端只负责三件事 —— 认出模型写的那一行、把它交给桥、把桥回包的规矩画出来。
 *
 * 认的时候只认行里的标记，不管它被包在代码块、列表还是引用里：
 * 模型有三种写法都很自然（`[pi-web:rule] …`、`- [pi-web:rule] …`、围栏里一行），
 * 要求它只能有一种写法，就是在赌模型的格式服从度，赌输了这条规矩就悄悄丢了。
 */

import { tr } from "./i18n/index.ts";

export interface RuleRec {
  /** 与账本同一个归并键 `tool|code|sig`。 */
  key: string;
  tool: string;
  code: string;
  sig: string;
  rule: string;
  at: string;
}

export interface RuleBook {
  version: 1;
  ws: string;
  rules: RuleRec[];
  /** 会话 id → 上次复盘时的失败条数（口径同账本 `sessions[sid].n`）。 */
  reviewed: Record<string, { at: string; n: number }>;
}

/** 模型回写规矩的那一行要带的标记。与桥端 `lessons.ts` 的 `REVIEW_MARK` 是一对。 */
export const RULE_MARK = "[pi-web:rule]";

/** 规矩最长留多少字：桥端 200，前端收得更紧，长得像一段话的多半不是「一句能照做的规矩」。 */
const MAX_RULE = 100;
const MAX_KEY = 120;

/**
 * 只剥**成对**的强调 / 代码标记（`**一句**`、`_一句_`、`` `一句` ``），单个 `*` 一律不动。
 *
 * 早先的写法是 `/^[*_`\s]+|[*_`\s]+$/`，它会把结尾的单个 `*` 当粗体符号吃掉 ——
 * `npm run test:*` 存进去就成了 `npm run test:`，一条能照做的规矩被改成了跑不通的命令。
 */
function stripMarks(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 3; i += 1) {
    const m = s.match(/^(\*\*|__|`|\*|_)([\s\S]+)\1$/);
    if (!m) break;
    const inner = m[2].trim();
    if (!inner) break;
    s = inner;
  }
  // 粗体从标记前面就开了（`**[pi-web:rule] … :: 一句**`）：只剩一个收尾符号时也得剥，
  // 但只在句子里没有同种符号的情况下动手 —— `**/*.ts` 这种通配符要留住。
  for (const mark of ["**", "__", "`"]) {
    while (s.endsWith(mark)) {
      const head = s.slice(0, -mark.length).trim();
      if (!head || head.includes(mark)) break;
      s = head;
    }
  }
  return s;
}

/**
 * 从一段 assistant 正文里挑出所有规矩行 → `{key, rule}`。
 *
 * 只认「标记 + 键 + `::` + 一句话」；键必须带 `|`（`tool|code|sig`），
 * 提示词里那条格式示例（`[pi-web:rule] <键> :: …`）会因此被跳过 —— 键以 `<` 开头的都是示例。
 */
export function parseRules(text: string): { key: string; rule: string }[] {
  const out: { key: string; rule: string }[] = [];
  const seen = new Set<string>();
  for (const raw of String(text ?? "").split("\n")) {
    const at = raw.indexOf(RULE_MARK);
    if (at < 0) continue;
    const rest = raw.slice(at + RULE_MARK.length).trim();
    const sep = rest.indexOf("::");
    if (sep < 0) continue;
    const key = cleanKey(rest.slice(0, sep));
    const rule = stripMarks(rest.slice(sep + 2))
      .replace(/\s+/g, " ")
      .slice(0, MAX_RULE);
    if (!key || !rule) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, rule });
  }
  return out;
}

function cleanKey(raw: string): string {
  const key = raw
    .replace(/^[-*>\s]+/, "")
    .replace(/^[`"']+|[`"']+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_KEY);
  if (!key.includes("|")) return "";
  if (key.startsWith("<") || key === "键") return ""; // 提示词里的格式示例
  return key;
}

/** 一条规矩拆成「工具 / 分类 / 形状」三段 —— 只是为了让界面上认得出它挂在哪一类，权威仍是键。 */
export function ruleParts(key: string): { tool: string; code: string; sig: string } {
  const [tool = "", code = "", ...rest] = String(key ?? "").split("|");
  return { tool, code, sig: rest.join("|") };
}

/** 规矩的一句话：`工具 · 形状 —— 那句做法`（和桥端带进提示词的写法同一个形状）。 */
export function ruleLine(r: RuleRec): string {
  const tool = r.tool || ruleParts(r.key).tool || tr("工具");
  const sig = r.sig || ruleParts(r.key).sig || tr("（形状不明）");
  return `${tool} · ${sig} —— ${r.rule}`;
}

/** 这一类写没写过规矩（面板与菜单里都要问）。 */
export function ruleFor(book: RuleBook | null, key: string): RuleRec | null {
  return book?.rules.find((r) => r.key === key) ?? null;
}
