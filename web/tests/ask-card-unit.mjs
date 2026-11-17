/**
 * 网页问答卡（`.qa-card`）从工具参数 / 结果文本里还原答案：`askQuestions` + `parseAskResult` 的纯函数层。
 *
 * 三套文案都得认（`ask_user_question` 的现在 + 旧 `question` / `questionnaire` 的历史会话），
 * 因为 `web/src/chat.ts` 的 `buildAsk` 对它们共用同一条渲染路径。
 *
 * Run: node --experimental-strip-types web/tests/ask-card-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { askQuestions, askTurnLabel, parseAskResult } from "../src/ask-result.ts";

const ask = (prompt, header = "Q1") => ({ label: header, prompt, options: [] });

test("新工具（ask_user_question）：按问题原文配对答案，自己写的也算答了", () => {
  const questions = [ask("把日志级别调成哪个？")];
  const text = 'User has answered your questions: "把日志级别调成哪个？"="右边（全量输出）". You can now continue with the user\'s answers in mind.';
  assert.deepEqual(parseAskResult(text, questions), ["右边（全量输出）"]);
});

test("新工具：答案顺序和问题顺序不一致也按原文配对，不按位置", () => {
  const questions = [ask("第一个", "A"), ask("第二个", "B")];
  const text = 'User has answered your questions: "第二个"="二", "第一个"="一". You can now continue.';
  assert.deepEqual(parseAskResult(text, questions), ["一", "二"]);
});

test("新工具：答案里的转义引号还原成引号", () => {
  const questions = [ask("怎么命名？")];
  const text = 'User has answered your questions: "怎么命名？"="叫 \\"x\\" 吧". You can now continue.';
  assert.deepEqual(parseAskResult(text, questions), ['叫 "x" 吧']);
});

test("新工具：取消就是一句 declined，每题都是没答", () => {
  const questions = [ask("一", "A"), ask("二", "B")];
  assert.deepEqual(parseAskResult("User declined to answer questions", questions), [null, null]);
});

test("旧单题（question）：User selected 去掉序号，User wrote 标成自己写", () => {
  const questions = [ask("要哪个？")];
  assert.deepEqual(parseAskResult("User selected: 2. 右边", questions), ["右边"]);
  assert.deepEqual(parseAskResult("User wrote: 随便写点", questions), ["（自己写）随便写点"]);
});

test("旧问卷（questionnaire）：每题一行，标签对得上，没答的留空", () => {
  const questions = [ask("风格？", "Q1"), ask("配色？", "Q2")];
  const text = "Q1: user selected: 1. 商务\nQ2: user wrote: 还没想好";
  assert.deepEqual(parseAskResult(text, questions), ["商务", "（自己写）还没想好"]);
  assert.deepEqual(parseAskResult("Q2: user selected: 3. 深色", questions), [null, "深色"]);
});

test("结果还是空的时候（工具在跑）什么都不猜", () => {
  assert.deepEqual(parseAskResult("", [ask("一"), ask("二")]), [null, null]);
  assert.deepEqual(parseAskResult("还在跑", [ask("一")]), [null]);
});

test("askQuestions：新工具的 questions[] 用 header 当标签、question 当正文", () => {
  const args = { questions: [{ header: "日志", question: "调到哪个级别？", options: [{ label: "左边" }, { label: "右边" }] }] };
  const [q, ...rest] = askQuestions(args);
  assert.equal(rest.length, 0);
  assert.deepEqual([q.label, q.prompt, q.options.length], ["日志", "调到哪个级别？", 2]);
});

test("askQuestions：旧单题的平铺参数也归一成一条；空参数不炸", () => {
  const [q] = askQuestions({ question: "要哪个？", options: ["左", "右"] });
  assert.deepEqual([q.label, q.prompt, q.options.length], ["Q1", "要哪个？", 2]);
  assert.deepEqual(askQuestions(undefined), []);
  assert.deepEqual(askQuestions({}), []);
});

test("askQuestions：title 给刻度带用 —— header 优先，没有 header 就是题面", () => {
  assert.equal(askQuestions({ questions: [{ header: "日志", question: "调到哪个级别？" }] })[0].title, "日志");
  assert.equal(askQuestions({ question: "要哪个？", options: [] })[0].title, "要哪个？");
});

test("askTurnLabel：一份问卷一行字，多题补「等 N 题」，单题不补", () => {
  assert.equal(askTurnLabel("日志", 1), "问卷概况：日志");
  assert.equal(askTurnLabel("日志", 3), "问卷概况：日志 · 等 3 题");
  // 没有 header 时桥给的 title 就是题面；题面也没有就只剩「问卷概况」。
  assert.equal(askTurnLabel("", 1), "问卷概况");
  assert.equal(askTurnLabel("", 4), "问卷概况 · 等 4 题");
});

test("askTurnLabel：折成一行，标题最多 80 字（79 字 + …）", () => {
  assert.equal(askTurnLabel("  第一行\n 第二行  ", 1), "问卷概况：第一行 第二行");
  const long = "x".repeat(200);
  assert.equal(askTurnLabel(long, 1), `问卷概况：${"x".repeat(79)}…`);
});
