import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeMap, mergeSlowSegments } from "../lib/timeline.mjs";

test("no slow segments is the identity map", () => {
  const map = buildTimeMap([]);
  assert.equal(map.map(0), 0);
  assert.equal(map.map(7.25), 7.25);
  assert.equal(map.finalDuration(7.25), 7.25);
});

test("one slow segment stretches only the marked range", () => {
  const map = buildTimeMap([{ start: 10, end: 12, slow: 0.5 }]);
  assert.equal(map.map(9), 9);
  assert.equal(map.map(10), 10);
  assert.equal(map.map(11), 12);
  assert.equal(map.map(12), 14);
  assert.equal(map.map(13), 15);
  assert.equal(map.finalDuration(12), 14);
});

test("multiple disjoint slow segments accumulate their extra time", () => {
  const map = buildTimeMap([
    { start: 2, end: 4, slow: 0.5 },
    { start: 8, end: 9, slow: 0.25 },
  ]);
  assert.equal(map.map(1), 1);
  assert.equal(map.map(3), 4);
  assert.equal(map.map(5), 7);
  assert.equal(map.map(8.5), 12);
  assert.equal(map.map(9), 14);
  assert.equal(map.map(10), 15);
});

test("mapping is monotonic and clamps negative input", () => {
  const map = buildTimeMap([
    { start: 1, end: 2, slow: 0.25 },
    { start: 5, end: 6, slow: 0.5 },
  ]);
  assert.equal(map.map(-3), 0);
  let last = -1;
  for (let t = 0; t <= 10; t += 0.01) {
    const v = map.map(t);
    assert.ok(v >= last - 1e-9, `map(${t}) went backwards`);
    last = v;
  }
});

test("inverse returns the raw time for a final time", () => {
  const map = buildTimeMap([
    { start: 2, end: 4, slow: 0.5 },
    { start: 8, end: 9, slow: 0.25 },
  ]);
  assert.equal(map.inverse(0), 0);
  assert.equal(map.inverse(7), 5);
  assert.equal(map.inverse(10), 8);
  assert.equal(map.inverse(12), 8.5);
  assert.equal(map.inverse(14), 9);
  assert.equal(map.inverse(15), 10);
});

test("mergeSlowSegments uses defaults and clamps to the video", () => {
  const segments = mergeSlowSegments(
    [
      { t: 9.5, lead: 2, tail: 2 },
      { t: 0.5, lead: 2, tail: 0.4 },
    ],
    10,
  );
  assert.deepEqual(segments, [
    { start: 0, end: 0.9, slow: 0.25 },
    { start: 7.5, end: 10, slow: 0.25 },
  ]);
});

test("mergeSlowSegments merges overlaps and keeps the slowest speed", () => {
  const segments = mergeSlowSegments(
    [
      { t: 2, lead: 1, tail: 1, slow: 0.5 },
      { t: 3, lead: 1, tail: 1, slow: 0.2 },
      { t: 8, lead: 0.5, tail: 0.5, slow: 0.4 },
    ],
    10,
  );
  assert.deepEqual(segments, [
    { start: 1, end: 4, slow: 0.2 },
    { start: 7.5, end: 8.5, slow: 0.4 },
  ]);
});

test("mergeSlowSegments rejects unusable moments", () => {
  assert.deepEqual(mergeSlowSegments([{ t: Number.NaN }, { t: -1, lead: 0, tail: 0 }], 10), []);
  assert.deepEqual(mergeSlowSegments([{ t: 20, lead: 1, tail: 1 }], 10), []);
});
