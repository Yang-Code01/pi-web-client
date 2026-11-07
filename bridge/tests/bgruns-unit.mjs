/**
 * D169: 后台子代理的判定全在 `BgRuns` 里 —— 工具结果里认一次 runId 算「开始」，完成通知（桥从
 * `queue_update` 或 `message_start` 喂进来）算「结束」。这里用 pi 真发过的文本原样喂进去：
 * 一条都认不出来，界面上就还是「页面闲着、继续随便点」。
 *
 *   node --experimental-transform-types bridge/tests/bgruns-unit.mjs
 */
import assert from "node:assert/strict";
import { BgRuns } from "../src/bgruns.ts";

let changes = 0;
const runs = new BgRuns(() => {
  changes += 1;
});

/** acp_delegate 的结果文本（真事件流里的形态，见 .scratch/sniff/events-*.jsonl）。 */
const acpStart = (id, agent) =>
  `Delegated to **${agent}** (runId \`${id}\`).\nTask: look at the files\nRunning in the background at \`F:\\pi-web-client\`.\nLive activity is streaming to \`C:\\Temp\\${id}.activity\`.\nCall acp_delegate_wait({ runId: "${id}" }) to block until it finishes.`;

// ---------------------------------------------------------------- 开始

runs.noteToolEnd("acp_delegate", { kind: "delegate", runId: "del_x", agent: "researcher", task: "look" }, acpStart("del_x", "researcher"));
assert.equal(runs.view()?.n, 1, "派出去就该有一条在跑");
assert.equal(runs.view()?.agent, "researcher");
assert.equal(typeof runs.view()?.since, "number");

// 同一个 runId 再来一次（wait / cancel / 状态查询）不该变成两条。
runs.noteToolEnd("acp_delegate_wait", { runId: "del_x" }, "…");
assert.equal(runs.view()?.n, 1);

// ---------------------------------------------------------------- 结束

runs.noteText("[acp_delegate completed] **researcher** (runId `del_x`, exit 0)\nusage summary …");
assert.equal(runs.view(), undefined, "完成通知一进来就得收掉提示条");
assert.equal(runs.active().length, 0, "跑完的不算 active");

runs.noteToolEnd("acp_delegate", { kind: "delegate", runId: "del_y", agent: "worker" }, acpStart("del_y", "worker"));
runs.noteText("[acp_delegate FAILED ⚠️] **worker** (runId `del_y`, exit 1)\nboom");
assert.equal(runs.view(), undefined, "失败也算结束：不能一直说「运行中」");

// ---------------------------------------------------------------- 两条路都认

// 没有 details 时靠文本里的 runId（pi-subagents 走 key 名 `asyncDir`，但可能是老桥/别的工具）。
runs.noteToolEnd("subagent", undefined, "Started async subagent (runId `sub_1`).\nRunning in the background at `/tmp/x`.");
assert.equal(runs.view()?.n, 1);
assert.equal(runs.view()?.agent, undefined, "没写 agent 就只有数量（字段干脆不出现）");
runs.noteToolEnd("subagent", { runId: "sub_2", asyncDir: "/tmp/y" }, "Started (runId `sub_2`).\nRunning in the background at `/tmp/y`.");
assert.equal(runs.view()?.n, 2, "asyncDir 那条也要认");
runs.noteText("finished (runId `sub_2`)");
assert.equal(runs.view()?.n, 1);

// 不带 runId 的结束文本不该动到别人。
const before = JSON.stringify(runs.view());
runs.noteText("completed without any id at all");
assert.equal(JSON.stringify(runs.view()), before);

// 结果里恰好带个 runId、但不是「刚开跑」（比如把 wait 的调用示例抄进结果）：不许造幽灵任务。
const fresh = new BgRuns(() => {});
fresh.noteToolEnd("acp_delegate_wait", {}, 'acp_delegate_wait({ runId: "nope" })');
assert.equal(fresh.view(), undefined);

// 老版本 / 别的工具只会给一段文本：没有 runId 就什么也不记。
fresh.noteToolEnd("bash", undefined, "ok");
assert.equal(fresh.view(), undefined);

// ---------------------------------------------------------------- 摘要

const many = new BgRuns(() => {});
many.noteToolEnd("acp_delegate", { kind: "delegate", runId: "a", agent: "planner" }, acpStart("a", "planner"));
const firstSince = many.view()?.since ?? 0;
many.noteToolEnd("acp_delegate", { kind: "delegate", runId: "b", agent: "worker" }, acpStart("b", "worker"));
assert.equal(many.view()?.n, 2);
assert.equal(many.view()?.since, firstSince, "since 取最早那条：后来的新手不能把钟拨回去");
assert.equal(many.view()?.agent, "planner", "agent 跟着最早的走");

// reset：会话关掉时表和定时器一起收掉。
runs.reset();
assert.equal(runs.view(), undefined);
assert.equal(changes > 0, true, "每次变化都要喊一声，否则界面收不到");
