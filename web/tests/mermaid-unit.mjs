/**
 * Mermaid 的判定那一层（D227）：哪些围栏算图、模式值怎么校验。
 *
 * 只测纯函数 —— 真画图要 DOM 和 mermaid 本体，由 `probes/mermaid-render.mjs` 在真浏览器里把关。
 *
 *   node --experimental-transform-types web/tests/mermaid-unit.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isMermaidFence, mermaidMode, setMermaidMode } from "../src/mermaid.ts";

test("判据和 pi 一样：取标签第一个词、忽略大小写", () => {
  for (const label of ["mermaid", "Mermaid", "MERMAID", " mermaid ", "mermaid title=flow", "mermaid\t{theme}"]) {
    assert.equal(isMermaidFence(label), true, label);
  }
  for (const label of ["", "  ", null, undefined, "mermaidish", "js", "mmd", "mermaidx title"]) {
    assert.equal(isMermaidFence(label), false, String(label));
  }
});

test("模式：off / final / streaming 认，别的一律回落到 pi 的出厂值", () => {
  setMermaidMode("off");
  assert.equal(mermaidMode(), "off");
  setMermaidMode("final");
  assert.equal(mermaidMode(), "final");
  setMermaidMode("streaming");
  assert.equal(mermaidMode(), "streaming");
  setMermaidMode(" OFF ");
  assert.equal(mermaidMode(), "off");
  for (const bad of [undefined, null, "", "yes", 1, {}, []]) {
    setMermaidMode(bad);
    assert.equal(mermaidMode(), "streaming", JSON.stringify(bad));
  }
});
