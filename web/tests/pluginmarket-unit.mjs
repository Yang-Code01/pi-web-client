/**
 * 插件市场的纯函数单测：分类、排序、筛选、瀑布流分列、数字缩写。
 *
 *   node --experimental-strip-types web/tests/pluginmarket-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  categoriesOf,
  distributeColumns,
  filterPackages,
  formatCount,
  masonryColumns,
  rankSearchResults,
  sortPackages,
} from "../src/pluginmarket.ts";

const pkg = (name, extra = {}) => ({
  name,
  version: "1.0.0",
  description: "",
  monthly: 0,
  weekly: 0,
  link: `https://www.npmjs.com/package/${name}`,
  publisher: null,
  ...extra,
});

test("formatCount：dshmarket 的 k / m 缩写", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1_000), "1k");
  assert.equal(formatCount(3_257), "3.3k");
  assert.equal(formatCount(3_257_300), "3.3m");
  assert.equal(formatCount(Number.NaN), "0");
});

test("categoriesOf：作者标签优先，只取第一个命中；没有标签落『其他』", () => {
  assert.deepEqual(categoriesOf(pkg("billion-context", { keywords: ["context", "compression"] })), ["context"]);
  assert.deepEqual(categoriesOf(pkg("pi-mcp-adapter", { keywords: ["mcp", "llm"] })), ["tools"]);
  assert.deepEqual(categoriesOf(pkg("plain-plugin")), ["other"]);
  assert.deepEqual(categoriesOf(pkg("x", { keywords: ["mcp", "workflow", "theme"] })), ["tools"]);
});

test("sortPackages：下载量 / 收录时间 / 名称，升降序", () => {
  const list = [
    pkg("b", { monthly: 10, published: 200 }),
    pkg("a", { monthly: 30, published: 100 }),
    pkg("c", { monthly: 20, published: 300 }),
  ];
  assert.deepEqual(sortPackages(list, "downloads", "desc").map((p) => p.name), ["a", "c", "b"]);
  assert.deepEqual(sortPackages(list, "downloads", "asc").map((p) => p.name), ["b", "c", "a"]);
  assert.deepEqual(sortPackages(list, "published", "desc").map((p) => p.name), ["c", "b", "a"]);
  assert.deepEqual(sortPackages(list, "name", "asc").map((p) => p.name), ["a", "b", "c"]);
});

test("rankSearchResults：精确名字永远排第一，再看前缀，再按选择排序", () => {
  const list = [
    pkg("pi-mcp-adapter", { monthly: 2_100_000 }),
    pkg("pi-web-access", { monthly: 1_400_000 }),
    pkg("pi-web-accessory", { monthly: 900_000 }),
    pkg("@scope/pi-web-access", { monthly: 100 }),
  ];
  assert.deepEqual(rankSearchResults(list, "pi-web-access", "downloads", "desc").map((p) => p.name), [
    "pi-web-access",
    "@scope/pi-web-access",
    "pi-web-accessory",
    "pi-mcp-adapter",
  ]);
});

test("rankSearchResults：名字撞上的冷门包排在「描述里碰巧有这个词」的热门包前面", () => {
  // 以前只有 exact / prefix / 其余三桶，其余桶内按下载量排 —— 一个刚发的 xlsx 包永远追不过
  // 描述里写了一句 xlsx 的明星包，于是「搜不到冷门包」。
  const list = [
    pkg("pi-excel-godmode", { monthly: 2_300_000, description: "Excel / xlsx / csv 读写、公式与图表" }),
    pkg("pi-xlsx", { monthly: 3 }),
    pkg("whatever", { monthly: 900_000 }),
  ];
  assert.deepEqual(rankSearchResults(list, "xlsx", "downloads", "desc").map((p) => p.name), ["pi-xlsx", "pi-excel-godmode", "whatever"]);
});

test("rankSearchResults：描述与关键词命中单列一档，仍在无关项之前", () => {
  const list = [
    pkg("a", { monthly: 500, description: "" }),
    pkg("b", { monthly: 100, keywords: ["sheet"] }),
    pkg("c", { monthly: 900, description: "sheet 处理" }),
  ];
  assert.deepEqual(rankSearchResults(list, "sheet", "downloads", "desc").map((p) => p.name), ["c", "b", "a"]);
});

test("rankSearchResults：档内仍然尊重用户选的排序", () => {
  const list = [pkg("xlsx-a", { monthly: 10 }), pkg("xlsx-b", { monthly: 20 })];
  assert.deepEqual(rankSearchResults(list, "xlsx", "downloads", "asc").map((p) => p.name), ["xlsx-a", "xlsx-b"]);
  assert.deepEqual(rankSearchResults(list, "xlsx", "name", "desc").map((p) => p.name), ["xlsx-b", "xlsx-a"]);
});

test("filterPackages：分类与只看已安装", () => {
  const list = [
    pkg("ctx", { keywords: ["context"] }),
    pkg("mcp", { keywords: ["mcp"] }),
    pkg("both", { keywords: ["context", "mcp"] }),
  ];
  assert.deepEqual(filterPackages(list, "tools", false, new Set()).map((p) => p.name), ["mcp"]);
  assert.deepEqual(filterPackages(list, "all", false, new Set(), new Set(["mcp"])).map((p) => p.name), ["ctx", "both"]);
  assert.deepEqual(filterPackages(list, "all", true, new Set(["ctx", "both"])).map((p) => p.name), ["ctx", "both"]);
});

test("distributeColumns：交替分列，保持从左到右的阅读顺序", () => {
  assert.deepEqual(distributeColumns([1, 2, 3, 4, 5, 6, 7], 3), [
    [1, 4, 7],
    [2, 5],
    [3, 6],
  ]);
  assert.deepEqual(distributeColumns([1, 2, 3], 1), [[1, 2, 3]]);
});

test("masonryColumns：dshmarket 的列数公式", () => {
  assert.equal(masonryColumns(680), 1);
  assert.equal(masonryColumns(700), 2);
  assert.equal(masonryColumns(860), 3);
  assert.equal(masonryColumns(960), 3);
});
