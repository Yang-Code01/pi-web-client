import test from "node:test";
import assert from "node:assert/strict";
import {
  compactionEnabledFrom,
  contextFromSettings,
  decideContext,
  effectiveLine,
  parsePercent,
  resolveContext,
  validateContext,
  PI_RESERVE_TOKENS,
  SAFETY_MARGIN_TOKENS,
} from "../src/context-policy.ts";

const layers = (session = {}, project = {}, global = {}) => ({ session, project, global });

test("parsePercent: numbers, numeric strings, junk", () => {
  assert.equal(parsePercent(70), 70);
  assert.equal(parsePercent("70"), 70);
  assert.equal(parsePercent(70.4), 70);
  assert.equal(parsePercent(70.6), 71);
  assert.equal(parsePercent(""), null);
  assert.equal(parsePercent(null), null);
  assert.equal(parsePercent(undefined), null);
  assert.equal(parsePercent("abc"), null);
  assert.equal(parsePercent(NaN), null);
});

test("contextFromSettings: reads the web.* keys only", () => {
  const json = { web: { autoCompactPercent: "82", autoHandoffEnabled: true, autoHandoffPercent: 88 }, compaction: { enabled: false } };
  assert.deepEqual(contextFromSettings(json), { autoCompactPercent: 82, autoHandoffEnabled: true, autoHandoffPercent: 88 });
  assert.deepEqual(contextFromSettings({ web: { autoHandoffEnabled: "yes" } }), {});
  assert.deepEqual(contextFromSettings(null), {});
  assert.equal(compactionEnabledFrom(json), false);
  assert.equal(compactionEnabledFrom({}), null);
});

test("resolveContext: session > project > global, then defaults", () => {
  const p = resolveContext(
    layers({ autoCompactPercent: 60 }, { autoCompactPercent: 74, autoHandoffEnabled: true, autoHandoffPercent: 82 }, { autoCompactPercent: 90 }),
  );
  assert.equal(p.compactPercent, 60);
  assert.equal(p.compactFrom, "session");
  assert.equal(p.handoffOn, true);
  assert.equal(p.handoffFrom, "project");
  assert.equal(p.handoffPercent, 82);

  const d = resolveContext(layers());
  assert.equal(d.compactPercent, 70);
  assert.equal(d.compactFrom, "default");
  assert.equal(d.compactOn, true);
  assert.equal(d.handoffOn, false);
  assert.equal(d.handoffPercent, null);

  // null/undefined mean "follow", not "zero".
  assert.equal(resolveContext(layers({ autoCompactPercent: null }, { autoCompactPercent: 65 })).compactPercent, 65);
});

test("effectiveLine: clamped below pi's own compaction line", () => {
  const big = effectiveLine(70, 200_000);
  assert.deepEqual(big, { line: 140_000, percent: 70, clamped: false });

  // 32K window: 70% would be 22,400 but pi compacts at 15,616 — the bridge must stay below.
  const small = effectiveLine(70, 32_000);
  assert.equal(small.line, 32_000 - PI_RESERVE_TOKENS - SAFETY_MARGIN_TOKENS);
  assert.equal(small.clamped, true);
  assert.ok(small.percent > 0 && small.percent < 70);

  // 1M window, top of the range: still far below the cap.
  assert.deepEqual(effectiveLine(90, 1_000_000), { line: 900_000, percent: 90, clamped: false });
  // Unknown window: no line at all, rather than a guess.
  assert.equal(effectiveLine(70, null), null);
  assert.equal(effectiveLine(70, 0), null);
});

test("decideContext: handoff wins and suppresses compaction", () => {
  const both = resolveContext(layers({ autoCompactPercent: 60, autoHandoffEnabled: true, autoHandoffPercent: 80 }));
  assert.equal(decideContext({ used: 100_000, window: 200_000, policy: both }).action, "none");
  assert.equal(decideContext({ used: 120_000, window: 200_000, policy: both }).action, "none");
  const hand = decideContext({ used: 160_000, window: 200_000, policy: both });
  assert.equal(hand.action, "handoff");
  assert.equal(hand.line, 160_000);

  // Handoff on but no percentage: not armed, so it must not silently disable compaction either.
  const empty = resolveContext(layers({ autoHandoffEnabled: true }));
  assert.equal(decideContext({ used: 130_000, window: 200_000, policy: empty }).action, "none");
  assert.equal(decideContext({ used: 145_000, window: 200_000, policy: empty }).action, "compact");

  // Handoff off: compaction fires at its own line.
  const compact = resolveContext(layers({ autoCompactPercent: 60 }));
  assert.equal(decideContext({ used: 119_000, window: 200_000, policy: compact }).action, "none");
  assert.equal(decideContext({ used: 120_000, window: 200_000, policy: compact }).action, "compact");

  // pi's own switch off turns the bridge's off too.
  const off = resolveContext(layers({ autoCompactPercent: 60 }), false);
  assert.equal(decideContext({ used: 199_000, window: 200_000, policy: off }).action, "none");

  // No measurement yet.
  assert.equal(decideContext({ used: null, window: 200_000, policy: compact }).action, "none");
  assert.equal(decideContext({ used: 0, window: 200_000, policy: compact }).action, "none");
});

test("decideContext: the small-window clamp applies to the handoff line too", () => {
  const policy = resolveContext(layers({ autoHandoffEnabled: true, autoHandoffPercent: 80 }));
  const d = decideContext({ used: 14_000, window: 32_000, policy });
  assert.equal(d.action, "handoff");
  assert.equal(d.clamped, true);
  assert.equal(d.line, 32_000 - PI_RESERVE_TOKENS - SAFETY_MARGIN_TOKENS);
});

test("validateContext: range, equal, and the five-point gap", () => {
  assert.equal(validateContext(resolveContext(layers({ autoCompactPercent: 70 }))), null);
  assert.deepEqual(validateContext(resolveContext(layers({ autoCompactPercent: 2 }))), { code: "range", field: "compact" });
  assert.deepEqual(validateContext(resolveContext(layers({ autoCompactPercent: 95 }))), { code: "range", field: "compact" });
  assert.deepEqual(validateContext(resolveContext(layers({ autoHandoffEnabled: true, autoHandoffPercent: 3 }))), {
    code: "range",
    field: "handoff",
  });
  assert.deepEqual(validateContext(resolveContext(layers({ autoCompactPercent: 80, autoHandoffEnabled: true, autoHandoffPercent: 80 }))), {
    code: "equal",
  });
  assert.deepEqual(validateContext(resolveContext(layers({ autoCompactPercent: 70, autoHandoffEnabled: true, autoHandoffPercent: 74 }))), {
    code: "gap",
  });
  // Exactly five points is allowed.
  assert.equal(validateContext(resolveContext(layers({ autoCompactPercent: 70, autoHandoffEnabled: true, autoHandoffPercent: 75 }))), null);
  // A session override colliding with the project's value is still caught (validation runs on the resolved values).
  assert.deepEqual(
    validateContext(resolveContext(layers({ autoCompactPercent: 82 }, { autoCompactPercent: 70, autoHandoffEnabled: true, autoHandoffPercent: 80 }))),
    { code: "gap" },
  );
  // Handoff off: its percentage does not have to stay away from the compaction line.
  assert.equal(validateContext(resolveContext(layers({ autoCompactPercent: 80, autoHandoffPercent: 80 }))), null);
});
