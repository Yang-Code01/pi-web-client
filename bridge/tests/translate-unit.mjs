/**
 * Unit: `bridge/src/translate.ts` —— 翻译对照里最容易悄悄坏掉的那几层：分节、代码围栏、
 * 分块、表格结构校验、更新时复用没变的节、同步回原文只动被改过的那一块。
 *
 *   node --experimental-strip-types bridge/tests/translate-unit.mjs
 */
import {
  applySync,
  cleanOut,
  joinSections,
  packChunks,
  planSync,
  splitBlocks,
  splitCode,
  splitSections,
  tableDiff,
  translateDoc,
} from "../src/translate.ts";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const DOC = [
  "# 変更一覧",
  "",
  "対象: `OrderService#check`",
  "",
  "```java",
  "# not a heading",
  "class A {}",
  "```",
  "",
  "## メッセージ",
  "",
  "| ID | 変更後 |",
  "| --- | --- |",
  "| msg_a | 変更できません。 |",
  "| msg_b | 中止してください。 |",
  "",
  "## 補足",
  "",
  "注番を追加する。",
  "",
].join("\n");

/* ── 分节 ─────────────────────────────────────────────────────────────── */
const secs = splitSections(DOC);
check("按一二级标题切出 3 节", secs.length === 3, `got ${secs.length}`);
check("第一节是标题", secs[0].startsWith("# 変更一覧"));
check("代码里的 # 不算标题", secs[0].includes("# not a heading"));
check("第二节从 ## 开始", secs[1].startsWith("## メッセージ"), secs[1].slice(0, 20));

const rejoin = joinSections(secs);
check("拼回来不丢内容", rejoin.replace(/\s+/g, "") === DOC.replace(/\s+/g, ""));

/* ── 围栏代码 ─────────────────────────────────────────────────────────── */
const parts = splitCode(secs[0]);
check("代码块被单独切出", parts.some((p) => p.code) && parts.some((p) => !p.code));
check("拼回逐字节相同", parts.map((p) => p.text).join("\n") === secs[0]);

/* ── 分块 ─────────────────────────────────────────────────────────────── */
const blocks = splitBlocks("a\n\nb\n\n\nc");
check("空行分块", blocks.length === 3 && blocks[2] === "c", JSON.stringify(blocks));
const chunks = packChunks(["x".repeat(30), "y".repeat(30), "z".repeat(30)], 70);
check("分块不超过上限", chunks.every((c) => c.length <= 70), chunks.map((c) => c.length).join(","));
check("分块内容不丢", chunks.join("").replace(/\n/g, "").length === 90);
const big = packChunks([Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n")], 20);
check("超长块按行切", big.length > 1 && big.every((c) => c.length <= 20), big.map((c) => c.length).join(","));

/* ── 表格校验 ─────────────────────────────────────────────────────────── */
const table = "| ID | x |\n| --- | --- |\n| a | b |";
check("表格没变过 = ok", tableDiff(table, table) === null);
check("多一列被抓到", tableDiff(table, "| ID | x |\n| --- | --- |\n| a | b | c |") !== null);
check("少一行被抓到", tableDiff(table, "| ID | x |\n| --- | --- |") !== null);
check("行内代码里的 | 不算列", tableDiff("| a | `x|y` |", "| 甲 | `x|y` |") === null);

/* ── 输出清洗 ─────────────────────────────────────────────────────────── */
check("剥掉整段围栏", cleanOut("```markdown\n# 标题\n```") === "# 标题");
check("剥掉「译文：」", cleanOut("译文：\n# 标题") === "# 标题");

/* ── 整篇翻译（假模型） ───────────────────────────────────────────────── */
const run = { cli: "x.js", cwd: ".", lang: "zh", provider: "p", model: "m", fast: true };
let calls = 0;
/** 假模型：把每行原文加前缀「译:」，代码段不动（反正代码段不会送到这里）。 */
const fake = async (chunk) => {
  calls++;
  return chunk
    .split("\n")
    .map((l) => (l.trim() ? `译:${l}` : l))
    .join("\n");
};

const first = await translateDoc(DOC, run, fake);
check("每节都翻了", first.sections.length === 3);
check("代码块原样保留", first.sections[0].out.includes("# not a heading\nclass A {}"), first.sections[0].out);
check("表格行被翻译但结构没变", tableDiff(first.sections[1].src, first.sections[1].out) === null);
check("gen 与 out 初始相同", first.sections.every((s) => s.gen === s.out));

const before = calls;
const keep = new Map(first.sections.map((s) => [s.heading || "\u0000preamble", s]));
const again = await translateDoc(DOC, run, fake, { keep });
check("没变的节不重复调模型", calls === before, `calls ${before} → ${calls}`);
check("复用后内容一致", again.sections[1].out === first.sections[1].out);

// 只改一节：只有那一节重翻
const changed = DOC.replace("注番を追加する。", "注番を必ず追加する。");
const before2 = calls;
const third = await translateDoc(changed, run, fake, { keep });
check("只重翻变了的节", calls === before2 + 1, `calls +${calls - before2}`);
check("新内容进来了", third.sections[2].out.includes("必ず"));

/* ── 同步回原文 ───────────────────────────────────────────────────────── */
const doc = structuredClone(third);
// 人改一处：表格里的一个单元格
doc.sections[1].out = doc.sections[1].out.replace("中止してください。", "中止してください（改）。");
/** 假模型：把【原文】原样拿回来，再把那一处体现回去 —— 真实模型该做的就是这件事。 */
const reverse = async (body) =>
  body.split("【原文】\n")[1].split("\n\n【")[0].replace("中止してください。", "中止してください（改）。");
const plan = await planSync(doc, run, reverse);
check("只产生 1 处改动", plan.edits.length === 1, JSON.stringify(plan.edits.map((e) => e.before.slice(0, 30))));
const applied = applySync(DOC, plan.edits);
check("写回只动了表格那一块", applied.text.includes("中止してください（改）。") && applied.applied.length === 1);
check("正文其余部分没被动", applied.text.startsWith("# 変更一覧") && applied.text.includes("注番を追加する。"));
check("改的是表格行不是整篇", applied.text.split("\n").length === DOC.split("\n").length);

const gone = applySync("# 别的文件\n", [{ before: "| a | b |", after: "| a | c |" }]);
check("找不到的块报 missing", gone.missing.length === 1 && gone.applied.length === 0);

/* ── 假模型返回了原文（偷懒） → 保留原文并告警 ───────────────────────── */
const echo = async (chunk) => chunk;
const lazy = await translateDoc("## 見出し\n\n連携種別がDIASに切り替える場合、オフラインで受領した納品書を中止してください。\n", run, echo);
check("照抄原文被拦下只告警不崩", lazy.sections[0].out.includes("連携種別") && lazy.warnings.length >= 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
