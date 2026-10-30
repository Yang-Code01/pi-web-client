/**
 * Ask-user registry, no HTTP and no model: build a Session and drive ask/answer directly.
 * The HTTP face of this feature (loopback-only, token-only, no tunnel) is asserted in ask-guard.mjs.
 *
 *   node --experimental-transform-types bridge/tests/ask-unit.mjs
 */
import assert from "node:assert/strict";
import { Session } from "../src/sessions.ts";

const twoQuestions = [
  {
    id: "q1",
    label: "Q1",
    prompt: "选哪个",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    allowOther: true,
  },
  { id: "q2", label: "Q2", prompt: "写一句", options: [{ value: "x", label: "X" }], allowOther: true },
];

const stuck = { id: "q1", label: "Q1", prompt: "只能选", options: [{ value: "a", label: "A" }], allowOther: false };

const session = new Session("pi", null, { id: "ask-unit" });
const seen = [];
session.on("ws", (payload) => seen.push(payload));

// 1. pending --------------------------------------------------------------
const handle = session.ask(twoQuestions, "questionnaire");
assert.equal(seen.at(-1).type, "ask.add");
assert.equal(seen.at(-1).ask.id, handle.id);
assert.equal(seen.at(-1).tool, "questionnaire");
assert.equal(seen.at(-1).ask.resolve, undefined, "the promise must not leak onto the wire");
assert.equal(session.state.asks, 1);
const snap = session.snapshot();
assert.equal(snap.asks.length, 1);
assert.equal(snap.asks[0].questions.length, 2);

// 2. a partial answer is refused, not half-applied ------------------------
session.answerAsk(handle.id, [{ id: "q1", value: "b", label: "B" }]);
assert.equal(session.asks.size, 1, "still waiting");
assert.equal(seen.at(-1).type, "notice");
assert.equal(seen.at(-1).level, "warn");

// 3. free text across two questions settles it ---------------------------
session.answerAsk(handle.id, [
  { id: "q1", value: "b", label: "B" },
  { id: "q2", value: "自定义", label: "自定义" },
]);
const out = await handle.outcome;
assert.equal(out.cancelled, false);
assert.deepEqual(out.answers[0], { id: "q1", value: "b", label: "B", wasCustom: false, index: 2 });
assert.equal(out.answers[1].wasCustom, true, "allowOther makes free text legitimate");
assert.equal(session.asks.size, 0);
assert.equal(seen.at(-1).type, "ask.remove");
assert.equal(seen.at(-1).status, "answered");

// 4. allowOther:false refuses a value nobody offered ---------------------
const picky = session.ask([stuck], "question");
session.answerAsk(picky.id, [{ id: "q1", value: "zzz", label: "zzz" }]);
assert.equal(session.asks.size, 1, "unoffered value and no allowOther → still waiting");
assert.equal(seen.at(-1).type, "notice");

// 5. cancel ---------------------------------------------------------------
session.cancelAsk(picky.id, "test");
const cancelled = await picky.outcome;
assert.equal(cancelled.cancelled, true);
assert.equal(cancelled.answers, null);
assert.equal(session.asks.size, 0);
assert.equal(session.state.asks, 0);
assert.equal(seen.at(-1).type, "ask.remove");
assert.equal(seen.at(-1).status, "cancelled");

// 6. abort cancels everything in flight ----------------------------------
const third = session.ask(twoQuestions, "question");
assert.equal(session.state.asks, 1);
session.abort();
assert.equal((await third.outcome).cancelled, true);
assert.equal(session.asks.size, 0);
assert.equal(session.state.asks, 0);

console.log("ask-unit: ok");
