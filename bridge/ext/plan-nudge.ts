/**
 * #346 计划收尾核对 —— 模型停下前，计划明显没跟上就让它补一次 `todo`。
 *
 * 起因：执行面板的计划只有 `todo` 快照一个数据源。2026-11-11 的会话里 claude-opus-5.5 带着
 * PLAN_HINT（D229）仍然在 update 第 2 项之后又调了 82 次工具、停了 6 次，计划一次没动，
 * 面板一直停在「1/4 · 第 2 步」。提示词管不住长回合，所以在 pi 的 `agent_before_settle`
 * （停下前最后一个能动手的点）补一条只给模型看的消息（`display:false`），请求续跑一次。
 *
 * 为什么挂在这里而不是让桥补发一条用户消息：
 * - 不新增用户回合 —— 轮次编号、会话树、「需要你」/完成提示音都不受影响；
 * - 桥只认 `agent_settled` 为空闲，续跑在同一段「运行中」里，页面不闪；
 * - 用户按了中断，pi 自己会丢掉续跑请求（outcome 也不是 completed）。
 *
 * 开关：全局 settings.json 的 `web.planNudge`（设置 → 工具与脚本），**默认关**。每次停下都现读，
 * 改了不用重启会话。文件路径由桥经 `PI_WEB_SETTINGS_FILE` 给（桥对 agentDir 的认定为准）。
 *
 * 触发条件（全部满足）：开关开；本次运行正常结束；计划里还有没关的项；上次计划更新后又调用了
 * 至少 NUDGE_MIN_TOOLS 次别的工具；这份计划快照之后还没提醒过（提醒记在会话里，重启也不重复）。
 *
 * stdout 属于 RPC 协议：日志只能走 console.error。
 */
import fs from "node:fs";

export const NUDGE_TYPE = "pi-web-plan-nudge";
/** 与页面「计划可能过期」的门槛一致（web/src/exec-view.ts 的 PLAN_STALE_TOOLS）。 */
export const NUDGE_MIN_TOOLS = 5;
export const SETTING_KEY = "web.planNudge";

interface Task {
  id: number;
  subject: string;
  status: string;
}

export interface NudgePlan {
  open: Task[];
  sinceUpdate: number;
}

function tasksOf(details: unknown): Task[] | null {
  const tasks = (details as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) return null;
  return tasks.filter((t) => t && typeof t === "object") as Task[];
}

/**
 * 沿当前分支回放：最后一份计划快照、它之后有几次别的工具结果、之后有没有提醒过。
 * 与桥的 `bridge/src/execplan.ts` 同一套口径（toolResult 的 todo + `rpiv-todo-state` 自定义条目）。
 * 返回 null = 不该提醒（没计划 / 计划都关了 / 已经提醒过这份快照）。
 */
export function stalePlan(branch: any[]): NudgePlan | null {
  let tasks: Task[] | null = null;
  let since = 0;
  let nudged = false;
  for (const entry of branch) {
    if (entry?.type === "custom" && entry.customType === "rpiv-todo-state") {
      const next = tasksOf(entry.data);
      if (next) {
        tasks = next;
        since = 0;
        nudged = false;
      }
      continue;
    }
    if (entry?.type === "custom_message" && entry.customType === NUDGE_TYPE) {
      nudged = true;
      continue;
    }
    const msg = entry?.type === "message" ? entry.message : null;
    if (msg?.role !== "toolResult") continue;
    if (msg.toolName === "todo") {
      const next = tasksOf(msg.details);
      if (next) {
        tasks = next;
        since = 0;
        nudged = false;
      }
    } else if (tasks) {
      since += 1;
    }
  }
  if (!tasks || nudged) return null;
  const open = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  if (!open.length) return null;
  return { open, sinceUpdate: since };
}

/** 给模型的那段话。只要它对齐计划，不许借机接着干活、不许为了交差乱打勾。 */
export function nudgeText(plan: NudgePlan): string {
  const lines = plan.open.map((t) => `- #${t.id} ${t.subject}（${t.status === "in_progress" ? "进行中" : "待做"}）`);
  return [
    "[网页客户端 · 计划收尾核对，用户看不到这条]",
    `执行面板上的计划还有 ${plan.open.length} 项没关闭，而你上次更新计划之后又调用了 ${plan.sinceUpdate} 次工具：`,
    ...lines,
    "现在只做一件事：调用 `todo` 让计划和**已经发生的事实**一致——确实做完的标 completed，不再需要的 delete，整份计划作废就 clear。",
    "没做完的（包括正在等用户回复、等后台任务的）保持原状，不要为了关掉它而打勾。",
    "不要接着做计划里的其他工作，不要重复上一条回复。处理完只回一句「计划已同步」；计划本来就准确就什么都不调用，回「计划无需更新」。",
  ].join("\n");
}

export function nudgeEnabled(file = process.env.PI_WEB_SETTINGS_FILE): boolean {
  if (!file) return false;
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    return json?.web?.planNudge === true;
  } catch {
    // 读不到 / 坏 JSON：按默认关处理。打不开设置不该让模型多跑一轮。
    return false;
  }
}

export default function planNudge(pi: any): void {
  pi.on("agent_before_settle", async (event: any, ctx: any) => {
    if (event?.outcome !== "completed" || event?.context?.canContinue === false) return;
    if (!nudgeEnabled()) return;
    let branch: any[];
    try {
      branch = ctx.sessionManager.getBranch();
    } catch (err) {
      console.error("[plan-nudge] 读不到会话分支：", err);
      return;
    }
    const plan = stalePlan(branch);
    if (!plan || plan.sinceUpdate < NUDGE_MIN_TOOLS) return;
    console.error(`[plan-nudge] 计划 ${plan.open.length} 项未关，之后 ${plan.sinceUpdate} 次工具未更新 → 续跑一次`);
    return {
      entries: [
        ...(event.entries ?? []),
        { type: "custom_message", customType: NUDGE_TYPE, content: nudgeText(plan), display: false },
      ],
      continue: true,
    };
  });
}
