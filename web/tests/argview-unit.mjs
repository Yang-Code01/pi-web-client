/**
 * 「参数」对话框里工具参数怎么拆（`web/src/argview.ts`，D458）。
 *
 * 走的都是真实会话里见过的形状：bash 的 command 带 heredoc、write 的 content 跟着 path、
 * edit 的 edits[]{oldText,newText}、ask_user_question 那种嵌套对象、以及从转录里读回来的
 * 「参数是一段 JSON 字符串」。钉住的是「正文按真换行、短字段变事实、没有长字段才退回 JSON」。
 *
 * Run: node --experimental-strip-types --test web/tests/argview-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { toolArgsView } from "../src/argview.ts";
import { tr } from "../src/i18n/index.ts";

const command = ["cd /tmp && python3 - <<'PY'", "import pathlib", "    t = p.read_text()", "PY", "npm run typecheck"].join("\n");

test("bash：command 按真换行铺开、上色成 bash，别的字段进事实胶囊", () => {
  const view = toolArgsView({ command, cwd: "/tmp", timeout: 60000 });
  assert.equal(view.blocks.length, 1);
  assert.equal(view.blocks[0].label, tr("命令"));
  assert.equal(view.blocks[0].grammar, "bash");
  // 原文一个字节都不改：换行是真换行，缩进还在，「复制」拿到的必须是这条命令。
  assert.equal(view.blocks[0].text, command);
  assert.deepEqual(view.facts, [
    { key: "cwd", value: "/tmp" },
    { key: "timeout", value: "60000" },
  ]);
});

test("参数是一段 JSON 字符串（旧转录里就是这样）也先解析再拆", () => {
  const view = toolArgsView(JSON.stringify({ command, description: "跑一遍" }));
  assert.equal(view.blocks[0].grammar, "bash");
  assert.equal(view.blocks[0].text, command);
  assert.ok(!view.blocks[0].text.includes("\\n"), "字面的 \\n 不该留在正文里");
  assert.deepEqual(view.facts.map((fact) => fact.key), ["description"]);
});

test("write：content 按 path 猜语言，path 变成事实而不是正文", () => {
  const view = toolArgsView({ path: "web/src/app.ts", content: `export const answer = 42;${"\n".repeat(3)}` });
  assert.deepEqual(view.blocks.map((block) => [block.label, block.grammar]), [[tr("内容"), "typescript"]]);
  assert.deepEqual(view.facts, [{ key: "path", value: "web/src/app.ts" }]);
});

test("edit：edits 排成 diff（删的在前、加的在后），不是原样 JSON", () => {
  const view = toolArgsView({ path: "a.txt", edits: [{ oldText: "old", newText: "new" }] });
  assert.equal(view.blocks.length, 1);
  assert.equal(view.blocks[0].grammar, "diff");
  assert.equal(view.blocks[0].text, "- old\n+ new");
  assert.equal(view.blocks[0].label, tr("改动"));
  assert.deepEqual(view.facts, [{ key: "path", value: "a.txt" }]);
});

test("edit 旁边还有一个长字段：两块都留下来，不再二选一", () => {
  const view = toolArgsView({ path: "a.ts", summary: "s".repeat(80), edits: [{ oldText: "old", newText: "new" }] });
  assert.deepEqual(view.blocks.map((block) => [block.label, block.grammar]), [
    ["summary", null],
    [tr("改动"), "diff"],
  ]);
  assert.deepEqual(view.facts, [{ key: "path", value: "a.ts" }]);
});

test("edit：多段改动每段单独一块，标题带序号", () => {
  const view = toolArgsView({ path: "a.txt", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] });
  assert.deepEqual(view.blocks.map((block) => block.label), [tr("改动 {p1}", { p1: 1 }), tr("改动 {p1}", { p1: 2 })]);
});

test("嵌套对象里没有长文本（ask 的短问题）：整份两格缩进的 JSON", () => {
  const args = { questions: [{ id: "q1", header: "选哪个", prompt: "要不要合并", options: [{ value: "a", label: "A" }] }] };
  const view = toolArgsView(args);
  assert.equal(view.blocks.length, 1);
  assert.equal(view.blocks[0].grammar, "json");
  assert.equal(view.blocks[0].label, tr("参数"));
  assert.equal(view.blocks[0].text, JSON.stringify(args, null, 2));
  assert.deepEqual(view.facts, []);
});

test("嵌套的长文本（questions[0].prompt）单独成块，结构里只留省略号", () => {
  const prompt = `第一行\n${"很长的提问 ".repeat(40)}`;
  const args = { questions: [{ id: "q1", header: "选哪个", prompt, options: [{ value: "a", label: "A" }] }] };
  const view = toolArgsView(args);
  // 第一块是结构提纲（prompt 换成了 …），第二块是那条长文本本体（真换行，不是字面 \n）。
  assert.deepEqual(view.blocks.map((block) => block.label), [tr("参数"), "questions[0].prompt"]);
  assert.ok(view.blocks[0].text.includes('"prompt": "…"'), view.blocks[0].text);
  assert.equal(view.blocks[1].text, prompt);
  assert.ok(!view.blocks[1].text.includes("\\n"));
  assert.equal(view.blocks[1].grammar, undefined);
  assert.deepEqual(view.facts, []);
});

test("数组里的长文本也按 items[0].content 这种路径挑出来", () => {
  const view = toolArgsView({ changes: [{ path: "a.ts", content: "x".repeat(200) }] });
  assert.deepEqual(view.blocks.map((block) => block.label), [tr("参数"), "changes[0].content"]);
});

test("不是 command / content 的长字段：用自己的键当标题，不上色", () => {
  const view = toolArgsView({ query: "x".repeat(80) });
  assert.deepEqual(view.blocks.map((block) => [block.label, block.grammar]), [["query", null]]);
});

test("纯文本参数（不是 JSON）原样一块", () => {
  const view = toolArgsView("git status --short");
  assert.deepEqual(view.blocks.map((block) => block.text), ["git status --short"]);
  assert.equal(view.facts.length, 0);
});

test("事实胶囊里的对象压成一行；超长的截断", () => {
  // 字符串超过 60 字本来就该进正文块，所以真正需要截断的是「对象化开之后太长」的那些。
  const view = toolArgsView({ command, meta: { a: 1, b: 2 }, note: { text: "y".repeat(400) } });
  const facts = Object.fromEntries(view.facts.map((fact) => [fact.key, fact.value]));
  assert.equal(facts.meta, '{"a":1,"b":2}');
  assert.equal(facts.note.length, 161);
  assert.ok(facts.note.endsWith("…"));
});
