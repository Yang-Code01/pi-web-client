/**
 * 「规矩」的落盘与它进提示词的样子（D164 延伸）。
 *
 * 这一层管的不是「提醒模型有个毛病」，而是「下次照着做」：一句能被执行的规矩，
 * 挂在账本同一套归并键上。测的重点是三件事 —— 同键覆盖、删掉就是真删、
 * 带进提示词时只收账本里还没修的那几条，且尾部一定要给模型「怎么回写」的格式。
 *
 *   node --experimental-transform-types bridge/tests/rules-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteRule, markReviewed, readRules, ruleFor, setRule } from "../src/rules.ts";
import { REVIEW_MARK, reviewPrompt, ruleText, lessonText } from "../src/lessons.ts";

process.env.PI_WEB_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-rules-"));

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

const WS = "F:/pi-web-client";
const KEY = "bash|path|cd <path>";

const entry = (over = {}) => ({
  key: KEY,
  tool: "bash",
  code: "path",
  sig: "cd <path>",
  count: 5,
  first: "2026-11-01T00:00:00Z",
  last: "2026-11-07T00:00:00Z",
  why: "仓库名拼错：clinet / client",
  causes: ["仓库名拼错"],
  fix: "从 git rev-parse --show-toplevel 取路径",
  fixedAt: null,
  ignoredAt: null,
  occ: [],
  ...over,
});
const ledger = (entries = [entry()]) => ({ version: 1, ws: WS, label: "", entries, sessions: {} });

// ---------------------------------------------------------------- 落盘

check("空工作区读出来是一本空账，不是 null", () => {
  const book = readRules("F:/nowhere");
  assert.equal(book.version, 1);
  assert.deepEqual(book.rules, []);
  assert.deepEqual(book.reviewed, {});
});

check("写一条再读回来：键、正文、工具与形状都在", () => {
  setRule({ ws: WS, key: KEY, rule: "先 test -d 再 cd，别靠猜" });
  const r = ruleFor(readRules(WS), KEY);
  assert.equal(r.rule, "先 test -d 再 cd，别靠猜");
  assert.equal(r.tool, "bash");
  assert.equal(r.code, "path");
  assert.equal(r.sig, "cd <path>");
});

check("同一个键再写就是覆盖，不会长出第二行", () => {
  setRule({ ws: WS, key: KEY, rule: "先用 test -d 验目录存在" });
  const book = readRules(WS);
  assert.equal(book.rules.length, 1);
  assert.equal(book.rules[0].rule, "先用 test -d 验目录存在");
});

check("正文首尾空白被收掉，空正文拒收", () => {
  setRule({ ws: WS, key: KEY, rule: "  先 test -d 再 cd  " });
  assert.equal(ruleFor(readRules(WS), KEY).rule, "先 test -d 再 cd");
  assert.throws(() => setRule({ ws: WS, key: KEY, rule: "   " }), /规矩|空/);
  assert.throws(() => setRule({ ws: WS, key: "", rule: "x" }), /键|key/i);
});

check("键缺 tool/code 时从键里兜底，提示词那一行才有形状可认", () => {
  setRule({ ws: WS, key: "bash|path|tail <file>", rule: "读日志前先 ls 一遍" });
  const r = ruleFor(readRules(WS), "bash|path|tail <file>");
  assert.equal(r.tool, "bash");
  assert.equal(r.code, "path");
  assert.equal(r.sig, "tail <file>");
});

check("删掉就是真删；删不存在的键要报出来，别静默成功", () => {
  deleteRule(WS, "bash|path|tail <file>");
  assert.equal(ruleFor(readRules(WS), "bash|path|tail <file>"), null);
  assert.throws(() => deleteRule(WS, "bash|path|tail <file>"), /不在了|没有/);
});

check("复盘记数按会话存，重记覆盖", () => {
  markReviewed(WS, "s1", 4);
  markReviewed(WS, "s1", 6);
  const book = readRules(WS);
  assert.equal(book.reviewed.s1.n, 6);
  assert.ok(book.reviewed.s1.at);
});

check("文件坏了不该让桥崩：读出来退成空账", () => {
  const dir = path.join(process.env.PI_WEB_STATE, "rules");
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  fs.writeFileSync(file, "{ 这不是 JSON");
  const book = readRules(WS);
  assert.equal(book.version, 1);
  assert.deepEqual(book.rules, []);
  setRule({ ws: WS, key: KEY, rule: "先 test -d 再 cd" });
});

// ---------------------------------------------------------------- 进提示词

check("没规矩时 lessonText 与老行为一致（只有老毛病）", () => {
  const text = lessonText(ledger(), null);
  assert.match(text, /老毛病|失败/);
  assert.doesNotMatch(text, /规矩/);
});

check("有规矩时附在后面，一条一行，带形状", () => {
  const text = lessonText(ledger(), readRules(WS));
  assert.match(text, /先 test -d 再 cd/);
  assert.match(text, /cd <path>/);
});

check("账本里已修/已忽略的类，规矩不再带进提示词", () => {
  const fixed = ledger([entry({ fixedAt: "2026-11-07T01:00:00Z" })]);
  assert.doesNotMatch(lessonText(fixed, readRules(WS)), /先 test -d 再 cd/);
});

check("规矩最多 3 条，单条截到 70 字", () => {
  const many = { version: 1, ws: WS, reviewed: {}, rules: [] };
  for (let i = 0; i < 6; i += 1) {
    many.rules.push({ key: `bash|path|sig${i}`, tool: "bash", code: "path", sig: `sig${i}`, rule: `第${i}条` + "啊".repeat(90), at: "2026-11-07T00:00:00Z" });
  }
  const text = ruleText(many, ledger([]));
  const lines = text.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 3);
  assert.ok(lines[0].length < 70 + 40, `单行太长：${lines[0].length}`);
});

check("复盘提示词：首行是机器标记，带账本视角与回写格式", () => {
  const text = reviewPrompt({
    ledger: ledger(),
    book: readRules(WS),
    classes: [{ key: KEY, tool: "bash", code: "path", sig: "cd <path>", n: 3 }],
    failures: 5,
  });
  assert.ok(text.startsWith(REVIEW_MARK), "首行必须是标记，前端靠它认出这一轮");
  assert.match(text, /cd <path>/);
  assert.match(text, /3 次/);
  assert.match(text, /账本累计 5 次/);
  assert.match(text, /仓库名拼错/);
  assert.match(text, /\[pi-web:rule\]/);
  assert.match(text, /先 test -d 再 cd/, "上一轮的规矩要带上，让它先对一遍");
  assert.match(text, /只能一句|一句/);
});

check("没有类时复盘提示词也说得清（不产出一段空话）", () => {
  const text = reviewPrompt({ ledger: ledger([]), book: null, classes: [], failures: 0 });
  assert.ok(text.startsWith(REVIEW_MARK));
  assert.ok(text.length > 40);
});

fs.rmSync(process.env.PI_WEB_STATE, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
