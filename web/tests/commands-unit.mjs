/**
 * `/` 菜单的过滤（#25，D152）：名字优先、命名空间看尾巴、描述只兜底。
 *
 * 只测纯函数那一层；输入框里真的弹出哪几行由浏览器探针 `probes/slash-filter.mjs` 把关
 * （按 D152「验证」一节列的四条查询逐条断言）。
 *
 * Run: node --experimental-transform-types web/tests/commands-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { filterCommands } from "../src/commands.ts";

const cmd = (name, desc = "", tag = "技能") => ({ insert: `/${name} `, label: `/${name}`, desc, tag });
const labels = (items) => items.map((x) => x.label);

// 用户报障时的那一屏（2026-11-06，输入 `/hand`）。
const skills = [
  cmd("skill:anatomy", "Build crafted, highly detailed, interactive isometric SVG figures…"),
  cmd("skill:claude-handoff", "Hand the current conversation off to a fresh background agent that picks up the work immediately."),
  cmd("skill:full-output-enforcement", "Overrides default LLM truncation behavior. It handles token-limit splits cleanly."),
  cmd("skill:handoff", "Compact the current conversation into a handoff document for another agent to pick up."),
  cmd("skill:postman-mcp-server", "Use when working through Postman MCP tools to handle MCP limitations."),
  cmd("skill:webhook-testing", "Capture, forward to localhost, replay, and validate webhook deliveries."),
  cmd("new", "开新会话", "内建"),
  cmd("compact", "压缩上下文", "内建"),
];

test("/hand 只留名字里带 hand 的技能，且顺序是 handoff → claude-handoff", () => {
  assert.deepEqual(labels(filterCommands(skills, "hand")), ["/skill:handoff", "/skill:claude-handoff"]);
});

test("敲到命名空间也不影响：/skill:hand 与 /hand 等价", () => {
  assert.deepEqual(filterCommands(skills, "skill:hand"), filterCommands(skills, "hand"));
  assert.deepEqual(labels(filterCommands(skills, "skill:hand")), ["/skill:handoff", "/skill:claude-handoff"]);
});

test("只敲命名空间照旧列出全部技能：/skill 与 /skill: 都是六个，顺序不变", () => {
  const all = skills.slice(0, 6);
  assert.deepEqual(filterCommands(skills, "skill"), all);
  assert.deepEqual(filterCommands(skills, "skill:"), all);
});

test("命名空间不参与子串匹配：/kill 不因为 skill: 前缀就全中", () => {
  assert.deepEqual(filterCommands(skills, "kill"), []); // 六个技能的尾巴里都没有 kill
  assert.deepEqual(labels(filterCommands([cmd("skill:foo-skills"), cmd("skill:anatomy")], "kill")), ["/skill:foo-skills"]); // 尾巴真含 kill 才中
  assert.deepEqual(filterCommands(skills, "kill:"), []);
});

test("尾巴里的词做前缀：/hand 命中 claude-handoff，/claude 也一样", () => {
  assert.deepEqual(labels(filterCommands(skills, "claude")), ["/skill:claude-handoff"]);
});

test("尾巴切词认 - _ . 和空白", () => {
  const dotted = [cmd("skill:foo_bar"), cmd("skill:foo.bar"), cmd("skill:foo bar"), cmd("skill:foohand")];
  for (const q of ["bar"]) assert.deepEqual(labels(filterCommands(dotted, q)), ["/skill:foo_bar", "/skill:foo.bar", "/skill:foo bar"]);
  assert.deepEqual(labels(filterCommands(dotted, "hand")), ["/skill:foohand"]); // 包含档，排在词前缀之后
});

test("多冒号命名空间只看第一段：mcp:tool:read 敲 /tool 也认", () => {
  const mcp = [cmd("mcp:tool:read", "读一个文件的工具"), cmd("skill:anatomy")];
  assert.deepEqual(labels(filterCommands(mcp, "tool")), ["/mcp:tool:read"]);
  assert.deepEqual(labels(filterCommands(mcp, "mcp:tool")), ["/mcp:tool:read"]);
});

test("描述只在名字一个都没命中时才用，且至少三个字符", () => {
  const only = [cmd("skill:handoff", "Compact the current conversation into a handoff document.")];
  assert.deepEqual(filterCommands(only, "document"), only);
  assert.deepEqual(filterCommands(only, "co"), []); // 两个字符不翻描述（"Compact" / "conversation" 都中）
});

test("描述兜底也剥命名空间：/skill:document 找的是 document，不是 skill:document", () => {
  const only = [cmd("skill:handoff", "Compact the current conversation into a handoff document.")];
  assert.deepEqual(filterCommands(only, "skill:document"), only);
  assert.deepEqual(filterCommands(only, "skill:co"), []); // 剥完只剩两个字符，仍不看描述
});

test("整名命中排在最前：/new 不再被名字里含 new 的东西压住", () => {
  assert.deepEqual(labels(filterCommands([cmd("renew"), cmd("new", "", "内建")], "new")), ["/new", "/renew"]);
});

test("同一档按原始顺序，不重排", () => {
  const same = [cmd("skill:foo-bar"), cmd("skill:baz-bar"), cmd("skill:qux-bar")];
  assert.deepEqual(labels(filterCommands(same, "bar")), ["/skill:foo-bar", "/skill:baz-bar", "/skill:qux-bar"]);
});

test("空输入给前 40 条，名字命中多于 40 也截到 40", () => {
  const many = Array.from({ length: 60 }, (_, i) => cmd(`c${i}`));
  assert.equal(filterCommands(many, "").length, 40);
  assert.deepEqual(labels(filterCommands(many, "")), labels(many.slice(0, 40)));
  const all = Array.from({ length: 45 }, (_, i) => cmd(`skill:c${i}`));
  assert.equal(filterCommands(all, "c").length, 40);
});

test("大小写不敏感", () => {
  assert.deepEqual(filterCommands(skills, "HAND"), filterCommands(skills, "hand"));
});
