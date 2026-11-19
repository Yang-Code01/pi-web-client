/**
 * ctxlog 旧文件的撞号修复（bridge/src/ctxlog-seq.ts）。
 *
 * Run: node --test bridge/tests/ctxlog-seq-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renumberCtxLog } from "../src/ctxlog-seq.ts";

test("单调的日志原样返回（同一个数组）", () => {
  const lines = [{ seq: 1, kind: "request", turn: 1 }, { seq: 2, kind: "usage", atSeq: 1 }];
  assert.equal(renumberCtxLog(lines), lines);
});

test("seq 回退：后一段整体平移到前一段之后，atSeq 与 turn 一起移", () => {
  const lines = [
    { seq: 1, kind: "request", turn: 1, step: 1 },
    { seq: 2, kind: "usage", atSeq: 1 },
    { seq: 3, kind: "request", turn: 2, step: 1 },
    { seq: 4, kind: "event", event: "inject", atSeq: 0 },
    // 旧扩展在 session_start 清零后接着往同一文件写：
    { seq: 1, kind: "event", event: "model", atSeq: 0 },
    { seq: 2, kind: "request", turn: 1, step: 1 },
    { seq: 3, kind: "usage", atSeq: 2 },
    // 再重启一次：
    { seq: 1, kind: "request", turn: 1, step: 1 },
    { seq: 2, kind: "usage", atSeq: 1 },
  ];
  const out = renumberCtxLog(lines);
  assert.deepEqual(out.map((l) => l.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(new Set(out.map((l) => l.seq)).size, out.length, "不再撞号");
  assert.equal(out[4].atSeq, 0, "atSeq = 0（还没有请求）不平移");
  assert.equal(out[6].atSeq, out[5].seq, "usage 仍挂在自己那次请求上");
  assert.equal(out[8].atSeq, out[7].seq);
  assert.deepEqual(out.filter((l) => l.kind === "request").map((l) => l.turn), [1, 2, 3, 4], "轮次接着数");
  assert.equal(lines[5].seq, 2, "不改输入对象");
});
