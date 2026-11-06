/**
 * 四套壳（#98）：壳与壳之间只差「哪几块拼在一起」，拼法是一张纯表（`shellParts`）——
 * 渲染层读表，不再到处 `if (id === "b")`。竖列（C）与色点条（D）共用 `railModel()`。
 *
 * 浏览器里「真的画出来了 / 切完还在 / 收起态看得见当前会话」由 `probes/workspace-shells.mjs` 把关。
 *
 * Run: node --experimental-transform-types web/tests/shells-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shellParts, railLabel, railModel } from "../src/shells.ts";
import { LAYOUT_IDS } from "../src/layout.ts";

test("每一套壳都有拼法，且互不相同", () => {
  const seen = new Set();
  for (const id of LAYOUT_IDS) {
    const parts = shellParts(id);
    assert.equal(typeof parts, "object");
    for (const key of ["tabsRow", "sessionRow", "chipTop", "chipOpensOverlay", "rail", "strip"]) {
      assert.equal(typeof parts[key], "boolean", `${id}.${key} 要是布尔值`);
    }
    seen.add(JSON.stringify(parts));
  }
  assert.equal(seen.size, LAYOUT_IDS.length, "四套壳不能有重复的拼法");
});

test("A 两行制：两条横栏、那颗在行 2（不当按钮）", () => {
  assert.deepEqual(shellParts("a"), {
    tabsRow: true,
    sessionRow: true,
    chipTop: false,
    chipOpensOverlay: false,
    rail: false,
    strip: false,
  });
});

test("B 一行制：两条横栏都收掉，那颗进顶栏且点开就是工作区浮层", () => {
  const parts = shellParts("b");
  assert.equal(parts.tabsRow, false);
  assert.equal(parts.sessionRow, false);
  assert.equal(parts.chipTop, true);
  assert.equal(parts.chipOpensOverlay, true);
  assert.equal(parts.rail, false);
  assert.equal(parts.strip, false);
});

test("C 工作区竖列：那颗在顶栏 + 最左常驻竖列", () => {
  const parts = shellParts("c");
  assert.equal(parts.rail, true);
  assert.equal(parts.chipTop, true);
  assert.equal(parts.tabsRow || parts.sessionRow, false, "C 不再占两条横栏");
  assert.equal(parts.strip, false);
});

test("D 树 + 图标条：树照旧，收起时缩成色点条", () => {
  const parts = shellParts("d");
  assert.equal(parts.strip, true);
  assert.equal(parts.rail, false);
  assert.equal(parts.chipTop, true);
  assert.equal(parts.tabsRow || parts.sessionRow, false);
});

test("不认识的 id 回 A：跟 layout.ts 同一条兜底", () => {
  assert.deepEqual(shellParts("z"), shellParts("a"));
});

test("两字头：竖列只有 48px，全名放不下；空名字要有占位", () => {
  assert.equal(railLabel("客户 01 号的后台系统"), "客户");
  assert.equal(railLabel("pi-web-client"), "pi");
  assert.equal(railLabel(" 后台 "), "后台");
  assert.equal(railLabel("单"), "单");
  assert.equal(railLabel(""), "··");
  // 代理对不能劈开（emoji / 生僻字都按字算，不按 UTF-16 码元算）
  assert.equal(railLabel("🚀🚀 发射"), "🚀🚀");
});

test("railModel：组 → 竖列/色点条的一行（计数、待处理、当前、两字头）", () => {
  const groups = [
    { id: "f:/a", name: "客户 01 号的后台系统", color: "#5ad", sessions: [{}, {}, {}], pending: 0 },
    { id: "f:/b", name: "客户 02 号的后台系统", color: "#a5d", sessions: [{}], pending: 2 },
  ];
  const rows = railModel(groups, "f:/b");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: "f:/a",
    label: "客户",
    name: "客户 01 号的后台系统",
    color: "#5ad",
    count: 3,
    pending: 0,
    current: false,
  });
  assert.equal(rows[1].current, true);
  assert.equal(rows[1].pending, 2);
  assert.equal(railModel(groups, null).every((r) => !r.current), true, "没当前会话时一颗都不高亮");
  assert.deepEqual(railModel([], "f:/a"), []);
});
