/**
 * MCP 市场的纯函数单测：类型归类、star 排序、精确匹配优先。
 *
 *   node --experimental-strip-types web/tests/mcpmarket-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mcpKinds, rankMcpSearch, sortMcp } from "../src/mcpmarket.ts";

const item = (name, extra = {}) => ({
  name,
  title: name,
  description: "",
  version: "1.0.0",
  repo: null,
  stars: 0,
  options: [],
  ...extra,
});
const opt = (kind, identifier = "pkg") => ({ kind, label: kind, identifier, version: null, transport: "stdio", env: [], headers: [], args: [] });

test("mcpKinds：一台服务可以同时有多种安装方式，去重保序", () => {
  const server = item("demo", { options: [opt("npm"), opt("remote"), opt("npm")] });
  assert.deepEqual(mcpKinds(server), ["npm", "remote"]);
});

test("sortMcp：默认 star 降序，同 star 按标题", () => {
  const list = [item("b", { stars: 10 }), item("a", { stars: 10 }), item("c", { stars: 30 })];
  assert.deepEqual(sortMcp(list, "stars", "desc").map((x) => x.name), ["c", "a", "b"]);
  assert.deepEqual(sortMcp(list, "name", "asc").map((x) => x.name), ["a", "b", "c"]);
});

test("rankMcpSearch：查询时精确名字 / 标题先于大 star 的模糊结果", () => {
  const list = [item("other", { stars: 90000 }), item("exa", { stars: 100, title: "Exa" }), item("@scope/exa", { stars: 50 })];
  assert.deepEqual(rankMcpSearch(list, "exa", "stars", "desc").map((x) => x.name), ["exa", "@scope/exa", "other"]);
});
