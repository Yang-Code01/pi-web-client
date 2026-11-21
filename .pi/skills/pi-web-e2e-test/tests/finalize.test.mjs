import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildStepCues, mergeCases, verdict, caseStatus, sideSpecPath } from "../lib/finalize.mjs";

const identityMap = { map: (t) => t };

test("buildStepCues: one cue per step, ending before the next step", () => {
  const steps = [
    { t: 0, title: "打开菜单", say: "点菜单", audioDuration: 1 },
    { t: 2, title: "选择名称", say: "选名称", audioDuration: 1 }
  ];
  const cues = buildStepCues(steps, identityMap, 6);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 1.95);
  assert.equal(cues[0].text, "打开菜单 — 点菜单");
  assert.equal(cues[1].start, 2);
  assert.equal(cues[1].end, 5.95);
});

test("buildStepCues: title and say are not duplicated", () => {
  const cues = buildStepCues(
    [{ t: 0, title: "同一条", say: "同一条", audioDuration: 1 }],
    identityMap,
    4
  );
  assert.equal(cues[0].text, "同一条");
});

test("buildStepCues: skips steps past the end and handles no steps", () => {
  assert.deepEqual(buildStepCues([], identityMap, 4), []);
  assert.deepEqual(
    buildStepCues([{ t: 5, title: "late", audioDuration: 1 }], identityMap, 4),
    []
  );
});

test("buildStepCues: uses the final time map for slow segments", () => {
  const timeMap = {
    map: (t) => {
      if (t <= 1) return t;
      if (t <= 2) return 1 + (t - 1) * 2;
      return 3 + (t - 2);
    }
  };
  const cues = buildStepCues(
    [
      { t: 1.5, title: "现象", say: "看这里", audioDuration: 1 },
      { t: 3, title: "结束", audioDuration: 1 }
    ],
    timeMap,
    5
  );
  assert.equal(cues[0].start, 2);
  assert.equal(cues[0].end, 3.95);
  assert.equal(cues[1].start, 4);
  assert.equal(cues[1].end, 4.95);
});

test("verdict: covers all comparison outcomes", () => {
  assert.equal(verdict(null, null), "missing");
  assert.equal(verdict(null, { status: "pass" }), "missing-before");
  assert.equal(verdict({ status: "pass" }, null), "missing-after");
  assert.equal(verdict({ status: "pass" }, { status: "pass" }), "pass");
  assert.equal(verdict({ status: "fail" }, { status: "pass" }), "fixed");
  assert.equal(verdict({ status: "pass" }, { status: "fail" }), "regressed");
  assert.equal(verdict({ status: "fail" }, { status: "fail" }), "both-fail");
});

test("caseStatus: error wins over fail, failed assertion counts as fail", () => {
  assert.equal(caseStatus({ cases: [], asserts: [] }), "pass");
  assert.equal(caseStatus({ cases: [{ status: "fail" }], asserts: [] }), "fail");
  assert.equal(caseStatus({ cases: [{ status: "error" }], asserts: [] }), "error");
  assert.equal(caseStatus({ cases: [], asserts: [{ pass: false }] }), "fail");
  assert.equal(caseStatus({ error: "boom", cases: [], asserts: [] }), "error");
});

test("mergeCases: pairs before/after by id and keeps step metadata", () => {
  const before = {
    side: "before",
    cases: [
      {
        id: "b",
        title: "B",
        status: "fail",
        tFinalStart: 2,
        tFinalEnd: 4,
        steps: [{ title: "b1", tFinal: 2 }],
        asserts: [{ desc: "x", pass: false }],
        errors: []
      },
      {
        id: "a",
        title: "A",
        status: "pass",
        tFinalStart: 0,
        tFinalEnd: 2,
        steps: [],
        asserts: [],
        errors: []
      }
    ]
  };
  const after = {
    side: "after",
    cases: [
      {
        id: "a",
        title: "A",
        status: "pass",
        tFinalStart: 0,
        tFinalEnd: 2,
        steps: [],
        asserts: [],
        errors: []
      },
      {
        id: "b",
        title: "B",
        status: "pass",
        tFinalStart: 2,
        tFinalEnd: 4,
        steps: [{ title: "b1", tFinal: 2 }],
        asserts: [],
        errors: []
      }
    ]
  };
  const merged = mergeCases([before, after]);
  assert.deepEqual(
    merged.map((item) => [item.id, item.verdict]),
    [
      ["a", "pass"],
      ["b", "fixed"]
    ]
  );
  assert.equal(merged[1].before.steps[0].title, "b1");
  assert.equal(merged[1].after.status, "pass");
  assert.equal(merged[1].before.duration, 2);
});

test("mergeCases: missing side is represented, not dropped", () => {
  const merged = mergeCases([
    { side: "after", cases: [{ id: "new", status: "pass", tFinalStart: 0, tFinalEnd: 2 }] }
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].verdict, "missing-before");
  assert.equal(merged[0].before, null);
});

test("sideSpecPath: raw spec lives at the run root, not in raw/", () => {
  assert.equal(sideSpecPath("C:/out", "after"), path.join("C:/out", "raw-spec-after.json"));
});
