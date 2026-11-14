/**
 * Unit: `bridge/src/translate.ts` —— 翻译对照里最容易悄悄坏掉的那几层：分节、代码围栏、
 * 分块、表格结构校验、更新时复用没变的节、同步回原文只动被改过的那一块。
 *
 *   node --experimental-strip-types bridge/tests/translate-unit.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applySync,
  cleanOut,
  joinSections,
  packChunks,
  planSync,
  reverseBlock,
  splitBlocks,
  splitCode,
  splitSections,
  tableDiff,
  translateDoc,
} from "../src/translate.ts";
import { TranslateJobs } from "../src/translatejob.ts";
import { piChildEnv } from "../src/paths.ts";

// 翻译任务会往状态目录写缓存：指到临时目录，绝不碰用户真实的翻译缓存。
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tr-unit-"));
process.env.PI_WEB_STATE = STATE;

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
/** 假模型：把每行原文加前缀「译:」，代码段不动（反正代码段不会送到这里）。
 *  表格行不能在行首加前缀 —— 桥按「行首是不是 |」数表格行，加了就成了一张没有表格的译文
 *  （tableDiff 判不合格 → 节标 failed → 缓存不复用，后面复用用例会假失败）。标记落在单元格尾巴上。 */
const fake = async (chunk) => {
  calls++;
  return chunk
    .split("\n")
    .map((l) => {
      if (!l.trim()) return l;
      if (/^\s*\|/.test(l)) {
        const cells = l.split("|");
        return cells
          .map((cell, i) =>
            i === 0 || i === cells.length - 1 || !cell.trim() || /^[\s:-]+$/.test(cell) ? cell : `${cell.trimEnd()} 译`,
          )
          .join("|");
      }
      return `译:${l}`;
    })
    .join("\n");
};

const first = await translateDoc(DOC, run, fake);
check("每节都翻了", first.sections.length === 3);
check("代码块原样保留", first.sections[0].out.includes("# not a heading\nclass A {}"), first.sections[0].out);
check(
  "围栏前后空行原样留住（代码块不粘到上一段）",
  splitBlocks(first.sections[0].out).length === splitBlocks(first.sections[0].src).length,
  `${splitBlocks(first.sections[0].src).length} → ${splitBlocks(first.sections[0].out).length}`,
);
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
check("只产生 1 处改动", plan.edits.length === 1, `${JSON.stringify(plan.edits.map((e) => e.before.slice(0, 30)))} warnings=${JSON.stringify(plan.warnings)}`);
const applied = applySync(DOC, plan.edits);
check("写回只动了表格那一块", applied.text.includes("中止してください（改）。") && applied.applied.length === 1);

/* ── 反向写回的语言护栏 ───────────────────────────────────────────────── */
// 真事：日文文档的译文标题被改成中文，写回时模型把中文标题整行抄进了原文。
const pair = { src: "注番を追加する。", gen: "追加注号。", out: "追加注号，务必。" };
let tries = 0;
const copyBack = async () => {
  tries++;
  return "追加注号，务必。";
};
let blocked = "";
try {
  await reverseBlock(pair, run, copyBack);
} catch (e) {
  blocked = e.message;
}
check("把改后的译文抄回去会被拦下", /抄/.test(blocked), blocked);
check("内容不合格才重试（问两次）", tries === 2, `tries ${tries}`);

const noKana = async () => {
  tries++;
  // 跟改后的译文不一样（躲开「照抄」那条），但就是没假名：中文写进日文原文。
  return "务必追加。";
};
tries = 0;
blocked = "";
try {
  await reverseBlock(pair, run, noKana);
} catch (e) {
  blocked = e.message;
}
check("原文是日文时，写回不许几乎没有假名", /日文/.test(blocked), blocked);

tries = 0;
const flaky = async () => (++tries === 1 ? "追加注号，务必。" : "注番を必ず追加する。");
const folded = await reverseBlock(pair, run, flaky);
check("第一次不合格会带着理由再问一次", tries === 2 && folded.includes("注番を必ず"), `${tries} ${folded}`);

// 真事：标题早先被写成了中文，之后每次改标题都把中文再写回去一遍（源里的标题已经脏了，
// 单块的假名检查就失效了）。整篇是日文时标题必须写回日文——顺带把脏标题修好。
const dirtyHead = { src: "# 我在学习日语", gen: "# 我在学习日语", out: "# 我是徐藤恩的父亲", docJa: true };
const alwaysZh = async () => "# 我是徐藤恩的父亲";
tries = 0;
blocked = "";
try {
  await reverseBlock(dirtyHead, run, alwaysZh);
} catch (e) {
  blocked = e.message;
}
check("日文稿件里的中文标题写回会被拦下", /日文/.test(blocked), blocked);
tries = 0;
const zhThenJa = async () => (++tries === 1 ? "# 我是徐藤恩的父亲" : "# 私は徐藤恩の父です");
const jpHead = await reverseBlock(dirtyHead, run, zhThenJa);
check("重问一次就拿到日文标题", jpHead.includes("私") && tries === 2, `${tries} ${jpHead}`);
check("正文其余部分没被动", applied.text.startsWith("# 変更一覧") && applied.text.includes("注番を追加する。"));
check("改的是表格行不是整篇", applied.text.split("\n").length === DOC.split("\n").length);

const gone = applySync("# 别的文件\n", [{ before: "| a | b |", after: "| a | c |" }]);
check("找不到的块报 missing", gone.missing.length === 1 && gone.applied.length === 0);

/* ── 假模型返回了原文（偷懒） → 保留原文并告警 ───────────────────────── */
const echo = async (chunk) => chunk;
const lazy = await translateDoc("## 見出し\n\n連携種別がDIASに切り替える場合、オフラインで受領した納品書を中止してください。\n", run, echo);
check("照抄原文被拦下只告警不崩", lazy.sections[0].out.includes("連携種別") && lazy.warnings.length >= 0);

/* ── 模型调用失败：绝不把「原文」当「译文」摆成翻完了 ──────────────── */
const boom = async () => {
  throw new Error("pi 退出码 1：Connection error.");
};
const jpOne = "## 見出し\n\n注番を追加する。\n";
const dead = await translateDoc(jpOne, run, boom);
check("调用失败时保留原文", dead.sections[0].out === dead.sections[0].src, dead.sections[0].out.slice(0, 30));
check("调用失败时这节标 failed", dead.sections[0].failed === true);
check("调用失败时 failures 带原始原因", dead.failures.length === 1 && /Connection error/.test(dead.failures[0]), JSON.stringify(dead.failures));
check("调用失败也算告警", dead.warnings.some((w) => /Connection error/.test(w)), JSON.stringify(dead.warnings));

// 一篇里只挂了一节：失败的那节标 failed、保留原文，翻好的那节照常出译文、不算失败。
const jpTwo = "## A\n\n注番を追加する。\n\n## B\n\n納品書を中止してください。\n";
const halfDead = async (c) => {
  if (c.includes("注番")) throw new Error("pi 退出码 1：Connection error.");
  return fake(c);
};
const partial = await translateDoc(jpTwo, run, halfDead);
check("部分失败：一共两节", partial.sections.length === 2);
check("部分失败：只给失败节标 failed", partial.sections[0].failed === true && !partial.sections[1].failed);
check("部分失败：失败节保留原文", partial.sections[0].out === partial.sections[0].src);
check("部分失败：成功节是真译文", partial.sections[1].out !== partial.sections[1].src);
check("部分失败：failures 只记挂掉的那块", partial.failures.length === 1 && /Connection error/.test(partial.failures[0]), JSON.stringify(partial.failures));

// 旧坏缓存（out === src、没有 failed 字段，就是用户截图里那份）点「更新」必须真重翻。
const badKeep = new Map(dead.sections.map((s) => [s.heading || "\u0000preamble", s]));
const beforeBad = calls;
const refetched = await translateDoc(jpOne, run, fake, { keep: badKeep });
check("坏缓存 out===src 不被复用", calls > beforeBad, `calls +${calls - beforeBad}`);
check("重翻后不再是原文", refetched.sections[0].out !== refetched.sections[0].src);
check("重翻成功后不标 failed", !refetched.sections[0].failed);

// 失败节人已经接手改好译文：以人写的为准，别在「更新」时再让机器覆盖掉。
const handFixed = new Map(dead.sections.map((s) => [s.heading || "\u0000preamble", { ...s, out: "追加注号。" }]));
const beforeFixed = calls;
const keptFixed = await translateDoc(jpOne, run, fake, { keep: handFixed });
check("手改过的失败节不再重翻", calls === beforeFixed, `calls +${calls - beforeFixed}`);
check("手改过的失败节保留人写的内容", keptFixed.sections[0].out === "追加注号。", keptFixed.sections[0].out);

// 失败任务的状态要是 error，页面才不会写「翻完了」。
const jobs = new TranslateJobs();
const jv = jobs.start({
  text: jpOne,
  abs: path.join(STATE, "doc.md"),
  rel: "doc.md",
  lang: "zh",
  run,
  runner: boom,
});
let jview = jobs.get(jv.id);
for (let i = 0; i < 200 && jview?.status === "running"; i++) {
  await new Promise((r) => setTimeout(r, 5));
  jview = jobs.get(jv.id);
}
check("翻译任务失败标 error 不是 done", jview?.status === "error", jview?.status);
check("error 里能看到原始原因", /Connection error/.test(jview?.error ?? ""), jview?.error);

// pi 子进程要绕过本机代理访问 loopback 网关（环境变量层面的防御）。
const savedUpper = process.env.NO_PROXY;
const savedLower = process.env.no_proxy;
delete process.env.NO_PROXY;
delete process.env.no_proxy;
const childEnv = piChildEnv();
check(
  "pi 子进程 NO_PROXY 含 loopback",
  ["127.0.0.1", "localhost", "::1"].every((h) => (childEnv.NO_PROXY ?? "").includes(h) && (childEnv.no_proxy ?? "").includes(h)),
  childEnv.NO_PROXY,
);
if (savedUpper === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = savedUpper;
if (savedLower === undefined) delete process.env.no_proxy; else process.env.no_proxy = savedLower;
fs.rmSync(STATE, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
