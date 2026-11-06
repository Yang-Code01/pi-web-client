/**
 * `/` 菜单的过滤（#25）：名字优先、命名空间看尾巴、描述只兜底。
 *
 * 只测纯函数那一层；输入框里真的弹出哪几行由浏览器探针（`probes/skill-palette.mjs` 的同类脚本）把关。
 *
 * Run: node --experimental-transform-types web/tests/commands-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { filterCommands } from "../src/commands.ts";

const cmd = (name, desc = "", tag = "技能") => ({ insert: `/${name} `, label: `/${name}`, desc, tag });

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

test("/hand 只留名字里带 hand 的技能，描述里的 handle/handles 不再凑数", () => {
  const got = filterCommands(skills, "hand");
  assert.deepEqual(got, [
    // 尾巴正好以 hand 开头 → 比「尾巴里某个词以 hand 开头」更靠前
    skills[3],
    skills[1],
  ]);
});

test("敲到命名空间也不影响：/skill:hand 一样只看冒号后面那段", () => {
  assert.deepEqual(filterCommands(skills, "skill:hand"), [skills[3], skills[1]]);
});

test("尾巴里的词做前缀：/hand 命中 claude-handoff，/claude 也一样", () => {
  assert.deepEqual(filterCommands(skills, "claude"), [skills[1]]);
});

test("描述只在名字一个都没命中时才用，且至少三个字符", () => {
  const only = [cmd("skill:handoff", "Compact the current conversation into a handoff document.")];
  assert.deepEqual(filterCommands(only, "document"), only);
  assert.deepEqual(filterCommands(only, "co"), []); // 两个字符不翻描述（"Compact" / "conversation" 都中）
});

test("整名命中排在最前：/new 不再被名字里含 new 的东西压住", () => {
  const got = filterCommands([cmd("renew"), cmd("new", "", "内建")], "new");
  assert.deepEqual(got.map((x) => x.label), ["/new", "/renew"]);
});

test("空输入照旧给前 40 条", () => {
  const many = Array.from({ length: 60 }, (_, i) => cmd(`c${i}`));
  assert.equal(filterCommands(many, "").length, 40);
  assert.deepEqual(filterCommands(many, "  ").length, 40);
});

test("大小写不敏感，前后空格不算输入", () => {
  assert.deepEqual(filterCommands(skills, "  HAND "), [skills[3], skills[1]]);
});
