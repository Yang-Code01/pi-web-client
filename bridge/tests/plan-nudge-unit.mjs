/**
 * Unit: `bridge/ext/plan-nudge.ts`（#346）—— 停下前核对计划。
 *
 * 断言：开关默认关（缺文件 / 坏 JSON / 没这个键都算关）；没计划、计划都关了、工具数不到门槛、
 * 这份快照之后已经提醒过、运行被中断，都不续跑；条件都满足时追加一条 display:false 的
 * custom_message 并 continue:true，且保留前面处理器的 entries。顺带测桥的 `sinceUpdate` 回放。
 *
 *   node --experimental-transform-types bridge/tests/plan-nudge-unit.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import planNudge, { NUDGE_TYPE, nudgeEnabled, nudgeText, stalePlan } from "../ext/plan-nudge.ts";
import { planReplayFromEntries, planFromToolResult } from "../src/execplan.ts";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

let n = 0;
const id = () => `e${++n}`;
const user = () => ({ type: "message", id: id(), message: { role: "user", content: "go" } });
const tasks = (...statuses) => statuses.map((status, i) => ({ id: i + 1, subject: `step ${i + 1}`, status }));
const todo = (...statuses) => ({ type: "message", id: id(), message: { role: "toolResult", toolName: "todo", toolCallId: id(), details: { action: "update", tasks: tasks(...statuses) } } });
const bash = () => ({ type: "message", id: id(), message: { role: "toolResult", toolName: "bash", toolCallId: id(), details: {} } });
const nudged = () => ({ type: "custom_message", id: id(), customType: NUDGE_TYPE, content: "x", display: false });
const bashes = (k) => Array.from({ length: k }, bash);

// ---- stalePlan
check("没有计划 → null", stalePlan([user(), ...bashes(9)]) === null);
check("计划全关 → null", stalePlan([user(), todo("completed", "deleted"), ...bashes(9)]) === null);
{
  const p = stalePlan([user(), todo("completed", "in_progress", "pending"), ...bashes(7)]);
  check("开着的项与计数", p?.open.length === 2 && p?.sinceUpdate === 7, JSON.stringify(p));
}
check("todo 之后计数归零", stalePlan([user(), todo("in_progress"), ...bashes(7), todo("in_progress", "pending")])?.sinceUpdate === 0);
check("这份快照之后提醒过 → null", stalePlan([user(), todo("in_progress"), ...bashes(7), nudged(), bash()]) === null);
check("提醒后又 update 过 → 重新计数", stalePlan([user(), todo("in_progress"), ...bashes(7), nudged(), todo("completed", "in_progress"), ...bashes(2)])?.sinceUpdate === 2);
check("rpiv-todo-state 自定义条目也算快照", stalePlan([user(), ...bashes(3), { type: "custom", customType: "rpiv-todo-state", data: { tasks: tasks("in_progress") } }, ...bashes(5)])?.sinceUpdate === 5);
check("提醒文案列出未关项", /#2 step 2（待做）/.test(nudgeText({ open: tasks("in_progress", "pending"), sinceUpdate: 6 })));

// ---- nudgeEnabled
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-nudge-"));
const file = path.join(dir, "settings.json");
check("没有文件 → 关", nudgeEnabled(file) === false);
check("没给路径 → 关", nudgeEnabled("") === false);
fs.writeFileSync(file, "{ broken");
check("坏 JSON → 关", nudgeEnabled(file) === false);
fs.writeFileSync(file, JSON.stringify({ web: { defaultPermission: "ask" } }));
check("没有这个键 → 关", nudgeEnabled(file) === false);
fs.writeFileSync(file, JSON.stringify({ web: { planNudge: "true" } }));
check("字符串 true 不算开", nudgeEnabled(file) === false);
fs.writeFileSync(file, JSON.stringify({ web: { planNudge: true } }));
check("web.planNudge=true → 开", nudgeEnabled(file) === true);

// ---- handler
const handlers = {};
planNudge({ on: (ev, fn) => (handlers[ev] = fn) });
const settle = handlers.agent_before_settle;
check("注册了 agent_before_settle", typeof settle === "function");
const stale = [user(), todo("completed", "in_progress", "pending"), ...bashes(6)];
const ctx = (branch) => ({ sessionManager: { getBranch: () => branch } });
const prior = { type: "custom", customType: "other", data: 1 };
const ev = (over = {}) => ({ outcome: "completed", entries: [prior], continue: false, context: { canContinue: true }, ...over });

process.env.PI_WEB_SETTINGS_FILE = file;
{
  const r = await settle(ev(), ctx(stale));
  const added = r?.entries?.at(-1);
  check("条件满足 → continue:true", r?.continue === true);
  check("追加 display:false 的提醒", added?.type === "custom_message" && added.customType === NUDGE_TYPE && added.display === false);
  check("保留前面处理器的 entries", r?.entries?.[0] === prior && r.entries.length === 2);
}
check("中断的运行不续跑", (await settle(ev({ outcome: "aborted" }), ctx(stale))) === undefined);
check("出错的运行不续跑", (await settle(ev({ outcome: "error" }), ctx(stale))) === undefined);
check("不能续跑时不续跑", (await settle(ev({ context: { canContinue: false } }), ctx(stale))) === undefined);
check("不到 5 次工具不续跑", (await settle(ev(), ctx([user(), todo("in_progress"), ...bashes(4)]))) === undefined);
check("提醒过一次不再续跑", (await settle(ev(), ctx([...stale, nudged()]))) === undefined);
check("读不到分支不抛", (await settle(ev(), { sessionManager: { getBranch: () => { throw new Error("x"); } } })) === undefined);
fs.writeFileSync(file, JSON.stringify({ web: { planNudge: false } }));
check("开关关 → 不续跑", (await settle(ev(), ctx(stale))) === undefined);
delete process.env.PI_WEB_SETTINGS_FILE;
check("没有设置路径 → 不续跑", (await settle(ev(), ctx(stale))) === undefined);

// ---- bridge: sinceUpdate
{
  const branch = [user(), todo("in_progress", "pending"), ...bashes(3)].map((e, i, all) => ({ ...e, parentId: i ? all[i - 1].id : null }));
  const { plan } = planReplayFromEntries(branch);
  check("回放：todo 之后 3 次工具", plan?.sinceUpdate === 3, JSON.stringify(plan?.sinceUpdate));
  const live = planFromToolResult(plan, "bash", {}, null);
  check("实时：别的工具 +1", live?.sinceUpdate === 4);
  const reset = planFromToolResult(live, "todo", { action: "update", tasks: tasks("completed", "in_progress") }, null);
  check("实时：todo 之后归零", !reset?.sinceUpdate);
  check("没有计划时不凭空造一个", planFromToolResult(null, "bash", {}, null) === null);
}

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
