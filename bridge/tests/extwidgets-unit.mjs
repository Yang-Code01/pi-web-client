/**
 * 扩展小部件里的协议载荷（pi-subagents 的 `PI_SUBAGENT_ASYNC_JSON:{…}`）必须认出来，
 * 否则页面上就是输入框上方一坨被 400 字截断的原始 JSON（用户截图报过）。
 *
 *   node --experimental-transform-types bridge/tests/extwidgets-unit.mjs
 */
import assert from "node:assert/strict";
import { isProtocolWidgetLines } from "../src/extwidgets.ts";

// ---------------------------------------------------------------- 要丢的
assert.equal(isProtocolWidgetLines(['PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot"}']), true, "async 快照");
assert.equal(isProtocolWidgetLines(['PI_SUBAGENT_INSPECT_JSON:{"kind":"pi-subagents.inspect-reply"}']), true, "inspect 回复");
assert.equal(isProtocolWidgetLines(["   PI_SUBAGENT_ASYNC_JSON:{}"]), true, "前面有缩进也认");

// 真形状：桥把整行截到 400 字，前缀照样在最前面；载荷只有一行，但也别依赖「只有一行」。
const truncated = `PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","version":1,"generatedAt":1794079369825,"caps":{"maxRuns":20},"runs":[{"id":"dd81c02e-0409-4dc1-b236-9ae96a00cada","kind":"subagent","label":"researcher","state":"running","startedAt":179`;
assert.equal(isProtocolWidgetLines([truncated]), true, "截断后仍然认");
assert.equal(isProtocolWidgetLines(["", truncated]), true, "不在第一行也认");

// ---------------------------------------------------------------- 要留的
assert.equal(isProtocolWidgetLines(["TODO", "- a", "- b"]), false, "普通 widget 透传");
assert.equal(isProtocolWidgetLines(["below line"]), false, "脚注透传");
assert.equal(isProtocolWidgetLines([]), false, "空 widget 不是载荷");
assert.equal(isProtocolWidgetLines(['{"kind":"pi-subagents.async-status-snapshot"}']), false, "没有哨兵前缀的裸 JSON 不猜");
assert.equal(isProtocolWidgetLines(["PI_SUBAGENT_ASYNC:", "PI_SUBAGENT_INSPECT"]), false, "光有名字没冒号不算");

console.log("extwidgets-unit: 11 checks ok");
