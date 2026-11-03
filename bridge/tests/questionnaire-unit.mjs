/**
 * D90: an `ask_user_question` questionnaire becomes one web ask; the rpc walker's one-by-one
 * dialogs are answered from it. No model, no child: drive Session's event/dialog handlers directly.
 *
 *   node --experimental-transform-types bridge/tests/questionnaire-unit.mjs
 */
import assert from "node:assert/strict";
import { Session } from "../src/sessions.ts";
import { matchDialog, parseQuestionnaire, replyFor } from "../src/questionnaire.ts";

const args = {
  questions: [
    {
      header: "方案",
      question: "问卷用哪种修法？",
      options: [
        { label: "桥里合并 (Recommended)", description: "不改包" },
        { label: "改 npm 包", description: "会被覆盖" },
      ],
    },
    { header: "范围", question: "开关管哪些？", multiSelect: true, options: [{ label: "推送", description: "a" }, { label: "微信", description: "b" }, { label: "邮件", description: "c" }] },
    { question: "还有补充吗？", options: [{ label: "没有", description: "x" }, { label: "有", description: "y" }] },
  ],
};
const line = (o, i) => `${i + 1}. ${o.label} — ${o.description}`;
const selectReq = (id, qi, header = true) => {
  const q = args.questions[qi];
  return {
    id,
    method: "select",
    title: `${header && q.header ? `[${q.header}] ` : ""}${q.question}`,
    options: [...q.options.map(line), `${q.options.length + 1}. Type something.`],
  };
};

// pure helpers ------------------------------------------------------------
const parsed = parseQuestionnaire(args);
assert.equal(parsed.length, 3);
assert.equal(parsed[1].multiSelect, true);
assert.equal(parseQuestionnaire({ questions: JSON.stringify(args.questions) }).length, 3, "double-encoded args decode");
assert.equal(parseQuestionnaire({}), null);
assert.equal(matchDialog(parsed, "[方案] 问卷用哪种修法？\n\n--- preview ---", new Set()).id, "q1");
assert.equal(matchDialog(parsed, "[方案] 问卷用哪种修法？", new Set(["q1"])), null, "taken questions are not matched again");
assert.equal(replyFor(parsed[1], { id: "q2", value: "", label: "", picks: [1, 3], text: "还有短信" }, "input", []), "1,3; 还有短信");
assert.equal(replyFor(parsed[1], { id: "q2", value: "", label: "", picks: [], text: "都不要" }, "input", []), "都不要");
assert.equal(replyFor(parsed[0], { id: "q1", value: "x", label: "x", index: 2 }, "select", ["a", "b"]), "b");
assert.equal(replyFor(parsed[0], { id: "q1", value: "自己写", label: "自己写", wasCustom: true }, "select", ["a"]), "自己写");
assert.equal(replyFor(parsed[0], { id: "q1", value: "x", label: "x", index: 1 }, "input", []), null, "kind mismatch → ask on its own");

// session flow ------------------------------------------------------------
const session = new Session("pi", null, { id: "questionnaire-unit" });
const responses = [];
session.rpc = { alive: true, uiRespond: (r) => responses.push(r) };
const ws = [];
const pushed = [];
session.on("ws", (p) => ws.push(p));
session.on("ask", (ask) => pushed.push(ask));
const tick = () => new Promise((r) => setTimeout(r, 0));

session.onPiEvent({ type: "tool_execution_start", toolCallId: "call1", toolName: "ask_user_question", args });
assert.equal(pushed.length, 1, "one notification for the whole questionnaire");
const ask = ws.find((p) => p.type === "ask.add").ask;
assert.equal(ask.questions.length, 3);
assert.equal(ask.questions[1].multiSelect, true);
assert.equal(ask.questions[0].key, undefined, "matching key stays in the bridge");

// The walker's first dialog arrives before the user has answered: it waits.
session.onUiRequest(selectReq("ui1", 0));
await tick();
assert.equal(responses.length, 0);
assert.equal(pushed.length, 1, "the dialog does not ask (or notify) on its own");

session.answerAsk(ask.id, [
  { id: "q1", value: "改 npm 包", label: "改 npm 包" },
  { id: "q2", value: "", label: "", picks: [2, 1, 9], text: "" },
  { id: "q3", value: "再加一点", label: "再加一点", wasCustom: true },
]);
await tick();
assert.deepEqual(responses.shift(), { id: "ui1", value: line(args.questions[0].options[1], 1) });

session.onUiRequest({ id: "ui2", method: "input", title: "[范围] 开关管哪些？\n\n1. 推送 — a\n\nEnter the numbers", placeholder: "1,3" });
await tick();
assert.deepEqual(responses.shift(), { id: "ui2", value: "1,2" }, "out-of-range picks are dropped, the rest sorted");

session.onUiRequest(selectReq("ui3", 2));
await tick();
assert.deepEqual(responses.shift(), { id: "ui3", value: "再加一点" });

session.onPiEvent({ type: "tool_execution_end", toolCallId: "call1", result: { content: [] } });
assert.equal(session.asks.size, 0);

// Cancelled questionnaire: the waiting dialog is cancelled, the tool end clears up.
ws.length = 0;
session.onPiEvent({ type: "tool_execution_start", toolCallId: "call2", toolName: "ask_user_question", args });
const ask2 = ws.find((p) => p.type === "ask.add").ask;
session.onUiRequest(selectReq("ui4", 0));
session.cancelAsk(ask2.id);
await tick();
assert.deepEqual(responses.shift(), { id: "ui4", cancelled: true });
session.onPiEvent({ type: "tool_execution_end", toolCallId: "call2", result: { content: [] } });

// A dialog nobody recognises is still asked on its own.
ws.length = 0;
session.onUiRequest({ id: "ui5", method: "select", title: "别的扩展的问题", options: ["a", "b"] });
const solo = ws.find((p) => p.type === "ask.add");
assert.ok(solo, "unmatched dialog falls back to a single-question ask");
assert.equal(solo.ask.questions[0].prompt, "别的扩展的问题");

console.log("questionnaire-unit ok");
process.exit(0);
