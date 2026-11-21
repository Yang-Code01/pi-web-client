import test from "node:test";
import assert from "node:assert/strict";
import { buildVtt, formatVttTime, sliceCues } from "../lib/vtt.mjs";

test("formats VTT timestamps with milliseconds", () => {
  assert.equal(formatVttTime(0), "00:00:00.000");
  assert.equal(formatVttTime(1.2345), "00:00:01.234");
  assert.equal(formatVttTime(3661.5), "01:01:01.500");
  assert.equal(formatVttTime(-3), "00:00:00.000");
});

test("builds a WEBVTT file with one cue per step", () => {
  const vtt = buildVtt(
    [
      { start: 1, end: 3.5, text: "第一步" },
      { start: 3.5, end: 6, text: "第二步" },
    ],
    10,
  );
  assert.equal(
    vtt,
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n第一步\n\n00:00:03.500 --> 00:00:06.000\n第二步\n",
  );
});

test("clamps cues to the final video and drops empty ones", () => {
  const vtt = buildVtt(
    [
      { start: -2, end: 1, text: "负时间" },
      { start: 9, end: 20, text: "超出结尾" },
      { start: 4, end: 4, text: "空的" },
      { start: 5, end: 6, text: "   " },
    ],
    10,
  );
  assert.equal(vtt, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n负时间\n\n00:00:09.000 --> 00:00:10.000\n超出结尾\n");
});

test("sanitizes cue text so VTT parsing cannot break", () => {
  const vtt = buildVtt([{ start: 0, end: 2, text: "a --> b\n第二行\r\n第三行" }], 2);
  assert.equal(vtt, "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\na → b 第二行 第三行\n");
});

test("sorts cues by start time", () => {
  const vtt = buildVtt(
    [
      { start: 5, end: 6, text: "后" },
      { start: 1, end: 2, text: "前" },
    ],
    10,
  );
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.000\n前/);
  assert.match(vtt, /00:00:05\.000 --> 00:00:06\.000\n后/);
});

test("slices cues for a per-case clip and rebases them to zero", () => {
  const cues = [
    { start: 10, end: 14, text: "第一段" },
    { start: 15, end: 19, text: "第二段" },
    { start: 20, end: 24, text: "第三段" },
  ];
  assert.deepEqual(sliceCues(cues, 12, 18), [
    { start: 0, end: 2, text: "第一段" },
    { start: 3, end: 6, text: "第二段" },
  ]);
});
