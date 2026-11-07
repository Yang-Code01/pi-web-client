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
assert.equal(runs.view()?.n, 0, "完成通知一进来，「还在跑」就得清零（提示条不再拦着「继续」）");
assert.equal(runs.view()?.recent, 1, "但刚跑完的还留着：提示条翻成「点开看结果」，最终输出才有地方点");
assert.equal(typeof runs.view()?.finishedAt, "number");
assert.equal(typeof runs.view()?.lastMs, "number");
assert.equal(runs.active().length, 0, "跑完的不算 active");
assert.equal(runs.list()[0]?.state, "done");
assert.equal(runs.list()[0]?.hasOut, true, "acp 的最终输出在 <runId>.out");

runs.noteToolEnd("acp_delegate", { kind: "delegate", runId: "del_y", agent: "worker" }, acpStart("del_y", "worker"));
runs.noteText("[acp_delegate FAILED ⚠️] **worker** (runId `del_y`, exit 1)\nboom");
assert.equal(runs.view()?.n, 0, "失败也算结束：不能一直说「运行中」");
assert.equal(runs.view()?.recent, 2, "失败的那条同样留着给人看，卡片上写「失败」");

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
assert.equal(runs.view(), undefined, "会话关掉：在跑的、刚跑完的、定时器一起收");
assert.equal(changes > 0, true, "每次变化都要喊一声，否则界面收不到");

// ---------------------------------------------------------------- 线上形状

const wire = new BgRuns(() => {});
wire.noteToolEnd("acp_delegate", { kind: "delegate", runId: "del_w", agent: "researcher", task: "look at the files" }, acpStart("del_w", "researcher"));
const one = wire.list()[0];
assert.equal(one.hasLog, true, "acp 的过程记录在 <runId>.activity");
assert.equal(one.hasOut, true);
assert.equal(one.task, "look at the files", "派活原话要能传到弹层");
assert.equal("logPath" in one, false, "绝对路径不出桥");
wire.noteToolEnd("subagent", { runId: "sub_w", asyncDir: "/tmp/z" }, "Started (runId `sub_w`).");
const two = wire.list().find((r) => r.id === "sub_w");
assert.equal(two.hasLog, false, "pi-subagents 没有可读的过程记录：卡片上直说，不装成「还没有」");

// ---------------------------------------------------------------- 读痕迹

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const acpDir = join(tmpdir(), "acp-delegate");
mkdirSync(acpDir, { recursive: true });
const logFile = join(acpDir, "del_read.activity");
writeFileSync(logFile, "line-1\nline-2\nline-3\n");
assert.equal(wire.readLog("del_read").log, undefined, "没认过的 runId 什么都不给");
wire.noteToolEnd("acp_delegate", { kind: "delegate", runId: "del_read", agent: "worker" }, `Delegated to **worker** (runId \`del_read\`).\nRunning in the background.\nLive activity is streaming to \`${logFile}\`.`);
assert.equal(wire.readLog("del_read").log, "line-1\nline-2\nline-3\n", "过程记录按 LIVE_LOG 给的路径读");
writeFileSync(logFile, `${"x".repeat(40_000)}\nTAIL-MARK\n`);
const long = wire.readLog("del_read", 1000).log ?? "";
assert.equal(long.endsWith("TAIL-MARK\n"), true, "长文件只读尾巴，末尾还在");
assert.equal(long.length < 1100, true, "截断到 limit 附近，不是整文件");
assert.equal(wire.readLog("del_read", 1000).out, undefined, "最终输出还没写出来就少一段，不当错误");
writeFileSync(join(acpDir, "del_read.out"), "the answer\n");
assert.equal(wire.readLog("del_read").out, "the answer\n");

// 路径校验：`..` 拼出去的一律不读。
const outside = join(acpDir, "..", "pi-web-client-d169-secret.txt");
writeFileSync(outside, "secret");
wire.noteToolEnd("acp_delegate", { kind: "delegate", runId: "del_evil", agent: "x" }, `Delegated to **x** (runId \`del_evil\`).\nLive activity is streaming to \`${outside}\`.`);
assert.equal(wire.readLog("del_evil").log, undefined, "ACP_DIR 之外的文件一个字节都不许读");
rmSync(logFile, { force: true });
rmSync(join(acpDir, "del_read.out"), { force: true });
rmSync(outside, { force: true });

console.log("bgruns-unit: ok");

