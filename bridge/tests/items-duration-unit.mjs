/**
 * 历史回放要带着工具耗时。
 *
 * 实时事件里有 `durationMs`（bridge 在 `tool_execution_end` 上收到），但从会话文件重放时
 * `toolResult` 上也有这个字段，而 `entriesToItems` 以前只抄了 result / isError / status。
 * 结果是：刷新页面之后，执行栏的耗时和浏览器面板的「执行了多长时间」全变 0.0 秒。
 *
 * Run: node --experimental-strip-types bridge/tests/items-duration-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { entriesToItems } from "../src/items.ts";

const call = (id, name, args) => ({
  id: `e-${id}`,
  type: "message",
  timestamp: "2026-11-18T10:00:00.000Z",
  message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});

const result = (id, text, extra = {}) => ({
  id: `r-${id}`,
  type: "message",
  timestamp: "2026-11-18T10:00:10.000Z",
  message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError: false, ...extra },
});

test("toolResult 上的 durationMs 落到 item 上", () => {
  const items = entriesToItems([call("c1", "bash", { command: "node x.mjs" }), result("c1", "ok", { durationMs: 31_881 })]);
  const tool = items.find((item) => item.kind === "tool");
  assert.equal(tool.durationMs, 31_881);
  assert.equal(tool.status, "ok");
});

test("没有 durationMs 的老记录不会凭空多出耗时", () => {
  const items = entriesToItems([call("c2", "bash", { command: "ls" }), result("c2", "ok")]);
  const tool = items.find((item) => item.kind === "tool");
  assert.equal(tool.durationMs, undefined);
});
