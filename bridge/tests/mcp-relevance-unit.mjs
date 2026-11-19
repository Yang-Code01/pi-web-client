/**
 * MCP 搜索相关度单测：全名 / 反向域名能搜到，io.github 前缀不算命中，精确名字先于高 star。
 *
 *   node --experimental-strip-types bridge/tests/mcp-relevance-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mcpRelevance, rankMcpHits } from "../src/market.ts";
const m = (name, extra = {}) => ({ name, title: "", description: "", version: "1", repo: null, stars: 0, options: [], ...extra });
test("relevance", () => {
  assert.ok(mcpRelevance(m("com.newrelic/mcp-server"), "newrelic") > 0);
  assert.ok(mcpRelevance(m("io.github.Harusame64/desktop-touch-mcp"), "desktop-touch") > 0);
  assert.equal(mcpRelevance(m("io.github.foo/bar"), "github"), 0);
  assert.equal(mcpRelevance(m("io.github.foo/bar"), "bar"), 5);
  const r = rankMcpHits([m("a/x-bar", { stars: 100 }), m("z/bar")], "bar");
  assert.equal(r[0].name, "z/bar");
});
