/**
 * `web/src/pastefly.ts` 的三条契约（D446）：缓动曲线必须跟 `mac-base.css` 一致、没有匹配的
 * 请求就别动手、模块在 node 里 import 不炸（它被 `app.ts` 直接引用，探针与单测都在非浏览器
 * 环境里碰过它）。
 *
 * WAAPI 的 `easing` 不认 `var(--mac-spring)`，只能把曲线抄成字面量 —— 抄了就会漂，所以这里拿
 * 样式表对一遍：`mac-base.css` 里改了曲线、`pastefly.ts` 没跟上，这条就红。
 *
 * Run: node --experimental-strip-types --test web/tests/pastefly-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPRING, badgeLanded, flyImagesToBadge } from "../src/pastefly.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, "..", "src", "mac-base.css"), "utf8");

/** 取 `--name: value;` 里的 value（值本身没有分号，够用）。 */
const cssVar = (name) => {
  const hit = CSS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return hit ? hit[1].trim() : "";
};

test("SPRING 跟 --mac-spring 是同一条曲线", () => {
  assert.equal(cssVar("mac-spring"), SPRING);
});

test("node 里 import 安全（模块没有在做顶层碰 DOM）", () => {
  assert.equal(typeof globalThis.matchMedia, "undefined");
  assert.equal(typeof flyImagesToBadge, "function");
});

test("源列表为空：连 host 都不问（贴图之外没人该被拖进来）", async () => {
  let asked = 0;
  await flyImagesToBadge([], { badge: null, origin: null, host: () => (asked++, null), scale: () => 1 });
  assert.equal(asked, 0);
});

test("prefers-reduced-motion：两个入口都不动手", async () => {
  globalThis.matchMedia = () => ({ matches: true });
  let touched = 0;
  const badge = {
    classList: { add: () => touched++, remove: () => touched++ },
    animate: () => touched++,
  };
  badgeLanded(badge);
  await flyImagesToBadge(["data:image/png;base64,AA"], {
    badge,
    origin: null,
    host: () => (touched++, null),
    scale: () => 1,
  });
  assert.equal(touched, 0);
  delete globalThis.matchMedia;
});
