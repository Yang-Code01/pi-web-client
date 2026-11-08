/**
 * D170: 后台子代理的判定全在 `BgRuns` 里 —— 工具结果里认一次 runId 算「开始」，完成通知（桥从
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

// ---------------------------------------------------------------- 两条路都认（只认派活工具 + 真 id）

const SUB_A = "11111111-2222-3333-4444-555555555555";
const SUB_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// D172: 光靠文本（没有 details）不再算「刚开跑」——一次 sed 出来的文档里也有这些句子。
runs.noteToolEnd("subagent", undefined, `Started async subagent (runId \`${SUB_A}\`).\nRunning in the background at \`/tmp/x\`.`);
assert.equal(runs.view()?.n, 0, "只有文本、没有 details：一律不当成开跑");

// pi-subagents 的真实形状：details 给 runId + asyncDir，agent/task 在 args 里（落盘那份被 redact 了）。
const asyncDir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ state: "running", outputFile: join(asyncDir, "output-0.log") }));
writeFileSync(join(asyncDir, "output-0.log"), "step 1\nstep 2\n");
runs.noteToolEnd("subagent", { mode: "single", runId: SUB_B, asyncDir }, `Run fan-out: 1/64 used, 63 remaining\nAsync: researcher [${SUB_B}]`, { agent: "researcher", task: "查一下卡片为什么空" });
assert.equal(runs.view()?.n, 1, "asyncDir 那条要认");
assert.equal(runs.view()?.agent, "researcher");
const sub = runs.list().find((r) => r.id === SUB_B);
assert.equal(sub?.task, "查一下卡片为什么空", "任务原文从 args 拿");
assert.equal(sub?.hasLog, true, "pi-subagents 的过程记录 = status.json 的 outputFile");
assert.equal(runs.readLog(SUB_B).log, "step 1\nstep 2\n", "读的就是那份 output-0.log");
// 权威状态到了就算结束，不必等 6 小时的 SILENT_DEAD。
writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ state: "complete", outputFile: join(asyncDir, "output-0.log") }));
runs.prune();
assert.equal(runs.list().find((r) => r.id === SUB_B)?.state, "done", "status.json 说 complete（真值，不是 completed）就收工");
assert.equal(runs.view()?.n, 0);

// D172 现场：读 D170 文档的 bash 结果里同时有 `**问题：**` / `runId `…`` / `Running in the background`。
const D170_TEXT = [
  "## D170 后台子代理：会话 settle 了也要说明白（无票，用户报的）",
  "",
  "**问题：** 让 pi 派一个后台子代理之后，界面立刻变回「空闲」。",
  "",
  "**决定：** 只有「刚开跑」的结果才算开一条（有 `asyncDir` / 文本带 `Running in the background`）。",
  "结束信号只有 `[acp_delegate completed] … (runId `…`)` 这一条。",
].join("\n");
const ghost = new BgRuns(() => {});
ghost.noteToolEnd("bash", { exitCode: 0 }, D170_TEXT);
assert.equal(ghost.view(), undefined, "读文档打印出这些句子不算派活（D172 的「问题：」卡片）");
assert.equal(ghost.list().length, 0);

// 示例值 `…`、`sub_1` 不是 runId：details 给了也不认。
const bad = new BgRuns(() => {});
bad.noteToolEnd("subagent", { runId: "…", asyncDir }, "x");
bad.noteToolEnd("subagent", { runId: "sub_1", asyncDir }, "x");
assert.equal(bad.view(), undefined, "id 不像 runId 就不开卡");

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
many.noteToolEnd("acp_delegate", { kind: "delegate", runId: "del_a", agent: "planner" }, acpStart("del_a", "planner"));
const firstSince = many.view()?.since ?? 0;
many.noteToolEnd("acp_delegate", { kind: "delegate", runId: "del_b", agent: "worker" }, acpStart("del_b", "worker"));
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
const wireDir = mkdtempSync(join(tmpdir(), "pi-subagents-wire-"));
writeFileSync(join(wireDir, "status.json"), JSON.stringify({ state: "running", outputFile: join(wireDir, "output-0.log") }));
const WIRE_ID = "00000000-1111-2222-3333-444444444444";
wire.noteToolEnd("subagent", { runId: WIRE_ID, asyncDir: wireDir }, `Async: worker [${WIRE_ID}]`, { agent: "worker", task: "t" });
const two = wire.list().find((r) => r.id === WIRE_ID);
assert.equal(two.hasLog, true, "pi-subagents 的过程记录 = status.json 的 outputFile");


// D172: 派活那一刻 status.json 可能还没落盘（实测晚 ~1.4 s）。过程记录要在 prune 里补回来，
// 否则 hasLog 永久 false，卡片一直说「桥还没接上」。
const late = mkdtempSync(join(tmpdir(), "pi-subagents-late-"));
const LATE_ID = "99999999-8888-7777-6666-555555555555";
const lateRuns = new BgRuns(() => {});
lateRuns.noteToolEnd("subagent", { runId: LATE_ID, asyncDir: late }, `Async: worker [${LATE_ID}]`, { agent: "worker", task: "t" });
assert.equal(lateRuns.list()[0]?.hasLog, false, "status.json 还没写出来：先如实说没有");
writeFileSync(join(late, "status.json"), JSON.stringify({ state: "complete", outputFile: join(late, "output-0.log") }));
writeFileSync(join(late, "output-0.log"), "late line\n");
lateRuns.prune();
assert.equal(lateRuns.list()[0]?.hasLog, true, "下一次滴答把 outputFile 补回来");
assert.equal(lateRuns.list()[0]?.state, "done");
assert.equal(lateRuns.readLog(LATE_ID).log, "late line\n");

// ---------------------------------------------------------------- workflow（D184）

/**
 * `subagent({workflow:"parallel", args:{tasks:[…]}})` 的真形状（fixture 抄自
 * `%TEMP%\pi-subagents-user-yqm\async-subagent-runs\653a4f33-f664-40b6-a2a0-02e0fbf224ef\`）：
 * details 没有 agent / task，status.json 没有 outputFile，过程记录只写在 events.jsonl 里。
 */
const WF_ID = "653a4f33-f664-40b6-a2a0-02e0fbf224ef";
const wfDir = mkdtempSync(join(tmpdir(), "pi-subagents-wf-"));
const wfDetails = {
  mode: "workflow",
  runId: WF_ID,
  asyncId: WF_ID,
  asyncDir: wfDir,
  workflow: "parallel",
  workflowChildren: { children: [{ childId: "task-1", state: "queued", agent: "researcher", sessionName: "researcher: 查一下南京今天的天气" }] },
  results: [],
};
const wfArgs = { workflow: "parallel", args: { tasks: [{ agent: "researcher", task: "查一下南京今天的天气" }, { agent: "researcher", task: "查一下上海今天的天气" }] } };
const wf = new BgRuns(() => {});
wf.noteToolEnd("subagent", wfDetails, `Async workflow [${WF_ID}]`, wfArgs);
assert.equal(wf.list().length, 1, "workflow 也是派活，要开卡");
assert.equal(wf.list()[0]?.agent, "researcher", "agent 从 args.args.tasks[] 取，不是空的");
assert.equal(wf.list()[0]?.task, "1. 查一下南京今天的天气\n2. 查一下上海今天的天气", "任务原文逐条列出来，不是「（任务原文没传到桥）」");
assert.equal(wf.list()[0]?.hasLog, false, "events.jsonl 还没写：不撒谎");

// 过程记录 = events.jsonl（workflow 的 status.json 里根本没有 outputFile）。
const bigOut = "X".repeat(20_000);
const evLines = [
  { ts: 1794100503079, type: "subagent.workflow.started", runId: WF_ID },
  { ts: 1794100504551, type: "subagent.child-status", childId: "task-1", status: "started", agent: "researcher", asyncDir: wfDir, label: "查一下南京…" },
  { ts: 1794100503079, type: "subagent.workflow.trace", trace: [{ operation: "run", key: "task-1", state: "started", agent: "researcher" }] },
  { ts: 1794100562494, type: "subagent.workflow.child_settled", childKey: "task-1", outcome: "completed", result: { output: bigOut } },
  { ts: 1794100587610, type: "subagent.workflow.completed", state: "complete" },
].map((e) => JSON.stringify(e));
writeFileSync(join(wfDir, "events.jsonl"), `${evLines.join("\n")}\n`);
wf.prune();
assert.equal(wf.list()[0]?.hasLog, true, "events.jsonl 一落盘，下一次滴答就把过程记录补上");
const timeline = wf.readLog(WF_ID).log ?? "";
assert.match(timeline, /workflow started/, "骨架事件在");
assert.match(timeline, /task-1 researcher started/);
assert.match(timeline, /task-1 completed/);
assert.equal(timeline.includes("XXXX"), false, "整份孩子答复（child_settled 的 result）不往页面上甩");
assert.equal(timeline.includes("operation"), false, "trace 累积快照跳过，免得每行都重复一遍");
assert.equal(timeline.length <= 8000, true, "投影后仍然受限");

// status.json 落盘：state=complete 收工，最终答复从 workflow.value.children[] 现拼。
writeFileSync(
  join(wfDir, "status.json"),
  JSON.stringify({
    mode: "workflow",
    state: "complete",
    workflow: {
      value: {
        children: [
          { key: "task-1", agent: "researcher", ok: true, output: "南京：小雨 15.9℃" },
          { key: "task-2", agent: "researcher", ok: true, output: "上海：晴 21℃" },
        ],
      },
    },
  }),
);
wf.prune();
assert.equal(wf.list()[0]?.state, "done");
assert.equal(wf.list()[0]?.hasOut, true, "跑完就有最终输出（没有文件，现拼）");
const wfOut = wf.readLog(WF_ID).out ?? "";
assert.match(wfOut, /## task-1 · researcher\n南京：小雨 15\.9℃/);
assert.match(wfOut, /## task-2 · researcher\n上海：晴 21℃/);

// 脚本式 workflow（没有 args.tasks）：agent 和任务前缀只能来自 details.workflowChildren。
const WF2 = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
const scriptDir = mkdtempSync(join(tmpdir(), "pi-subagents-script-"));
const scriptRuns = new BgRuns(() => {});
scriptRuns.noteToolEnd(
  "subagent",
  { mode: "workflow", runId: WF2, asyncDir: scriptDir, workflowChildren: { children: [{ childId: "a", agent: "planner", sessionName: "planner: 拆一下这个需求" }] } },
  `Async workflow [${WF2}]`,
  { workflow: true },
);
assert.equal(scriptRuns.list()[0]?.agent, "planner", "脚本式：agent 从 workflowChildren 取");
assert.equal(scriptRuns.list()[0]?.task, "拆一下这个需求", "sessionName 去掉 `planner: ` 前缀");

// 看详情的那一刻 events.jsonl 才刚写出来：readLog 自己抬手，不必等 30 秒滴答（弹层 1.5 秒一轮）。
writeFileSync(join(scriptDir, "events.jsonl"), `${JSON.stringify({ ts: 1, type: "subagent.workflow.started", runId: WF2 })}\n`);
assert.match(scriptRuns.readLog(WF2).log ?? "", /workflow started/, "readLog 不靠 prune 也能接上过程记录");
assert.equal(scriptRuns.list()[0]?.hasLog, true, "抬手之后 hasLog 也跟着真了");

// 派活那刻孩子清单还是空的（脚本式 workflow 边跑边建）：agent / task 从 workflow-receipt.json 补。
const WF3 = "cccccccc-1111-2222-3333-dddddddddddd";
const lateWfDir = mkdtempSync(join(tmpdir(), "pi-subagents-latewf-"));
const backfillRuns = new BgRuns(() => {});
backfillRuns.noteToolEnd("subagent", { mode: "workflow", runId: WF3, asyncDir: lateWfDir }, `Async workflow [${WF3}]`, { workflow: true });
assert.equal(backfillRuns.list()[0]?.agent, "", "清单空的：先空着");
assert.equal(backfillRuns.list()[0]?.task, "", "清单空的：先空着");
writeFileSync(
  join(lateWfDir, "workflow-receipt.json"),
  JSON.stringify({
    workflowRunId: WF3,
    workflowChildren: {
      children: [
        { childId: "task-1", agent: "planner", sessionName: "planner: 先读一遍 README" },
        { childId: "task-2", agent: "planner", sessionName: "planner: 再拆成小任务" },
      ],
    },
  }),
);
backfillRuns.prune();
assert.equal(backfillRuns.list()[0]?.agent, "planner", "receipt 里的 agent 补回来（不是空的「子代理」）");
assert.equal(backfillRuns.list()[0]?.task, "1. 先读一遍 README\n2. 再拆成小任务", "receipt 里的 sessionName 补回任务原文");

// 单 run / parallel：`??` 只在空位补，已有值一字不改（D184 决定 5）。
const PL_ID = "eeeeeeee-1111-2222-3333-ffffffffffff";
const parallelRuns = new BgRuns(() => {});
parallelRuns.noteToolEnd(
  "subagent",
  { mode: "parallel", runId: PL_ID, asyncDir: mkdtempSync(join(tmpdir(), "pi-subagents-par-")) },
  `Async parallel [${PL_ID}]`,
  { tasks: [{ agent: "worker", task: "甲" }, { agent: "worker", task: "乙" }] },
);
assert.equal(parallelRuns.list()[0]?.task, "1. 甲\n2. 乙", "parallel 没给 task 时也逐条列，而不是空着");

// ---------------------------------------------------------------- 读痕迹

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

