/**
 * 热部署面板上的「会话 N 个在跑」怎么数。
 *
 * 这一条是给壳/脑分层收尾的：换脑之后新脑里的会话是 adopt 出来的，跑没跑由壳的 turnActive 恢复。
 * 旧算法数的是「磁盘列表里标着 running 的条目」，壳模式下一个都数不到（用户看到「会话 0 个在跑」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { countRunning } from "../src/runningcount.ts";

const s = (live, running) => ({ live, state: { running } });

test("只数有活进程、且这一轮没结束的", () => {
  assert.equal(
    countRunning([s(true, true), s(true, false), s(false, true), s(false, false)]),
    1,
  );
});

test("没有活进程的条目一律不算 —— 磁盘上标的 running 是展示用的", () => {
  assert.equal(countRunning([s(false, true), s(false, true)]), 0);
});

test("空列表是 0，不是 NaN", () => {
  assert.equal(countRunning([]), 0);
});

test("adopt 回来的会话同样算数（壳里还跑着的那个）", () => {
  // adopt 之后 live=true、running 来自壳的 turnActive
  assert.equal(countRunning([s(true, true), s(true, true)]), 2);
});
