/**
 * 后台子代理（D170 / D171）：会话自己已经 settle，派出去的 runner 还在跑。
 *
 * pi 只在 `tool_execution_end` 的 `details` 里承认一次「有这么个 run」：
 *
 *   acp_delegate   {kind:"delegate", runId, agent, task}
 *   subagent       {mode, runId, asyncDir}       + args {agent, task}
 *
 * **建卡要过三道闸**（D171 的教训：只靠结果文本判「刚开跑」会把读文档的 sed 当成派活）：
 * 工具是这两者之一、有结构性开始信号（`kind:"delegate"` / `asyncDir`）、`runId` 像真的
 * （`del_*` / `call_*` / UUID —— 文档里的示例值 `…` 不算）。agent/task 优先取 `details`，
 * 其次取 `args`（模型写的那一份原话），最后才是 runner 文本里的固定写法。
 *
 * 完成信号有两条：acp 是 runner 注入回会话的那条消息（`noteText()`，从 steering 或
 * `message_start` 进来）；pi-subagents 读 `<asyncDir>/status.json` 的 `state`（`prune()` 里，
 * 30 秒一次）。都没有的 run 在 `SILENT_DEAD_MS` 后判死。
 *
 * 读盘只碰白名单里的两处根（`%TEMP%` 下的 `acp-delegate` 与 `pi-subagents-*`），且只读尾巴
 * （见 `tail()`）。
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** runner 的痕迹目录（acp_delegate 把 `<runId>.activity` / `.out` / `.session.jsonl` 都写在这里）。 */
const ACP_DIR = join(tmpdir(), "acp-delegate");
const TASK_LINE = /^Task:[ 	]*(.+)$/m;
const LIVE_LOG = /Live activity is streaming to `([^`]+)`/;
/** pi-subagents 的 async 目录：`<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/`。 */
const SUBAGENTS_TMP = join(tmpdir(), "pi-subagents-");
/**
 * 只有这两个工具会「派一个后台任务」。别的工具结果里出现同样的句子（读文档、看日志、
 * `grep` 到 D170 自己那段说明）不算 —— D171 的幽灵任务就是这么造出来的。
 */
const DISPATCH = new Set(["acp_delegate", "subagent"]);
/** 真的 runId 长这样：`del_…`（acp）、UUID / `call_…`（pi-subagents）。`…` 这种示例值不算。 */
const ID_OK = /^(del_[A-Za-z0-9_]+|call_[A-Za-z0-9_]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** 一个还在跑（或刚跑完）的后台任务。 */
export interface BgRun {
  id: string;
  /** 谁起的是两种实现：痕迹和完成通知都不一样。 */
  source: "acp" | "subagents";
  agent: string;
  /** 派出去的原话（`details.task`；没有就从结果文本的 `Task:` 行取）。点开看详情时显示这一句。 */
  task: string;
  startedAt: number;
  state: "running" | "done" | "failed";
  endedAt?: number;
  /** runner 自己的活动记录。只记落在 `%TEMP%\acp-delegate\` 或 `%TEMP%\pi-subagents-*\` 里的
   * （也只读那里，见 `readLog`）。 */
  logPath?: string;
  /** 跑完的最终答复（acp 是同目录的 `.out`，pi-subagents 是 `subagent-log-<id>.md`）。 */
  outPath?: string;
  /** pi-subagents 的 async 目录：`status.json` 在它底下，判活/判死读它（不出桥）。 */
  dir?: string;
}

/** 会话快照 / `SessionState.bg` 里那一小块：前端只画「N 个 · 谁 · 从什么时候」。 */
export interface BgView {
  /** 还在跑的。0 = 只剩「刚跑完、还能点开看」的那几条。 */
  n: number;
  agent?: string;
  /** 最早那条还在跑的什么时候开始（`n > 0` 时给）。 */
  since?: number;
  /** 刚跑完、还没被扫掉、点开还能看最终输出的条数。 */
  recent?: number;
  /** 最近一条跑完的时刻，它一共跑了多久（`recent > 0` 时给）。 */
  finishedAt?: number;
  lastMs?: number;
}

/** 线上形状（`bg.list` 的 `runs[]`）：绝对路径不出桥，只告诉前端「有没有可看的」。 */
export interface BgRunView {
  id: string;
  source: "acp" | "subagents";
  agent: string;
  task: string;
  startedAt: number;
  state: "running" | "done" | "failed";
  endedAt?: number;
  hasLog: boolean;
  hasOut: boolean;
}

/** 一个从没报过完成、也没再被 `details` 提过的 run 判死的期限。给得很宽：真跑几小时的任务
 * 不该被界面判失败，而 kill 掉的 run 迟早会被会话关闭或桥重启带走。
 */
const SILENT_DEAD_MS = 6 * 60 * 60 * 1000;
/** 跑完的 run 留一阵子：提示条要从「运行中」翻成「点开看结果」，用户也得有时间真的去点。 */
const KEEP_DONE_MS = 10 * 60 * 1000;
const SWEEP_MS = 30 * 1000;

/** 结束类措辞。完成通知、`acp_delegate_wait` 回执、取消回执都落在这里面。 */
const ENDED = /\b(completed|FAILED|cancelled|canceled|finished)\b|\bexit \d+\b/i;
const FAILED = /\bFAILED\b|\bfailed\b|cancelled|canceled/i;
const RUN_ID = /runId\s*`([^`\s]+)`/g;
/**
 * 只认 runner 自己的两种写法：`Delegated to **worker** (runId …)`、`Async: researcher [id]`。
 * 以前这里有「任意 `**加粗**` 就当人名」的分支，于是文档里的小标题 `**问题：**` 会被读成 agent
 * （D171 现场：卡片头写着「问题：」）。猜错的代价比空着大 —— 空着前端写「子代理」。
 */
const AGENT = /Delegated to\s+(?:\*\*)?([\w.-]+)|Async:\s*([\w.-]+)\s*\[/;

function firstRunId(text: string): string | null {
  RUN_ID.lastIndex = 0;
  const m = RUN_ID.exec(text);
  return m ? m[1] : null;
}

/**
 * 文件尾（最多 `limit` 字）。只允许 `ACP_DIR` 底下 —— 路径是从工具结果里拾来的，读前再卡一次。
 *
 * 只读尾巴：`.activity` 能长到几 MB，而详情页 1.5 秒轮询一次；整文件读会把单线程的桥（所有会话）
 * 一起卡住。字节上限按 UTF-8 最坏情况放宽到 `limit * 4`，再按行首对齐、按字截断。
 */
function readable(abs: string): boolean {
  return abs.startsWith(ACP_DIR + sep) || abs.startsWith(SUBAGENTS_TMP);
}

/** pi-subagents 的 `status.json` 里读一个字符串字段（文件小、只在开卡/滴答时读一次）。 */
function statusField(dir: string, key: string): string | undefined {
  const file = resolve(join(dir, "status.json"));
  if (!file.startsWith(SUBAGENTS_TMP)) return undefined;
  try {
    const obj = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const v = obj?.[key];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 文件尾（最多 `limit` 字）。只允许 `ACP_DIR` 与 `%TEMP%\pi-subagents-*\` 底下 ——
 * 路径是从工具结果里拾来的，读前再卡一次。
 *
 * 只读尾巴：`.activity` / `output-0.log` 都能长到几 MB，而详情页 1.5 秒轮询一次；整文件读会把
 * 单线程的桥（所有会话）一起卡住。字节上限按 UTF-8 最坏情况放宽到 `limit * 4`，再按行首对齐、按字截断。
 */
function tail(file: string, limit: number): string | undefined {
  const abs = resolve(file);
  if (!readable(abs)) return undefined;
  let fd: number | null = null;
  try {
    fd = openSync(abs, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - limit * 4);
    const buf = Buffer.alloc(size - start);
    if (buf.length) readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      // 从半个字 / 半行开始：丢掉第一行残片，前面补一个省略号。
      const nl = text.indexOf("\n");
      text = `…\n${nl >= 0 ? text.slice(nl + 1) : ""}`;
    }
    return text.length > limit ? `…\n${text.slice(-limit)}` : text;
  } catch {
    // 还没写出来 / 已经被删：详情里少一段，不当错误报。
    return undefined;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关不掉也只是少一段。
      }
    }
  }
}

/**
 * 一个会话的后台任务表。变化时只喊 `onChange`，喊不喊、多久喊一次由调用方决定 ——
 * 这里不碰 ws，也不认识 `SessionState`。
 */
export class BgRuns {
  private readonly runs = new Map<string, BgRun>();
  private sweep: NodeJS.Timeout | null = null;

  constructor(private readonly onChange: () => void) {}

  /**
   * 工具结束。`details` 是 pi 转述的 runner 字段；老版本或别的工具可能没有，
   * 那时退回结果文本里的 `` runId `…` ``（`acp_delegate` 的结果一定会写一个）。
   */
  noteToolEnd(tool: string, details: unknown, text: string, args?: unknown): void {
    const d = (details && typeof details === "object" ? details : {}) as Record<string, unknown>;
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const id = typeof d.runId === "string" && d.runId ? d.runId : firstRunId(text);
    if (!id) return;
    // `acp_delegate_wait` / `_cancel` / 取消回执：同一个 runId 的结束信号，不是新任务。
    if (this.runs.has(id)) {
      if (ENDED.test(text) && !/Running in the background/.test(text)) this.end(id, FAILED.test(text) ? "failed" : "done");
      return;
    }
    // 只有派活的工具才可能开一条新任务：一次 `sed` 出来的文档里也有 `Running in the background`，
    // 而那句文档正是 D170 写的示例 —— 文本特征不能当「刚开跑」的判据（D171）。
    if (!DISPATCH.has(tool)) return;
    const looksStart = d.kind === "delegate" || typeof d.asyncDir === "string";
    if (!looksStart || !ID_OK.test(id)) return;
    const source: "acp" | "subagents" = d.kind === "delegate" || tool === "acp_delegate" ? "acp" : "subagents";
    // agent / task 优先取结构化字段：details 是 runner 转述的，args 是模型写的那一份
    // （pi-subagents 落盘时把任务原文打成 `[prompt redacted]`，只有 args 里还是原话）。
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
    const fromText = AGENT.exec(text);
    const agent = str(d.agent) ?? str(a.agent) ?? fromText?.[1] ?? fromText?.[2] ?? "";
    const task = str(d.task) ?? str(a.task) ?? (source === "acp" ? TASK_LINE.exec(text)?.[1] : undefined) ?? "";
    const run: BgRun = { id, source, agent: agent.trim(), task: task.trim(), startedAt: Date.now(), state: "running" };
    const live = LIVE_LOG.exec(text)?.[1];
    if (source === "acp") {
      run.logPath = live ?? join(ACP_DIR, `${id}.activity`);
      run.outPath = join(ACP_DIR, `${id}.out`);
    } else {
      // pi-subagents 的 asyncDir 布局是公开契约（docs/observability.md「Async run artifacts」）：
      // `status.json` 的 `outputFile` 就是实时过程记录，`subagent-log-<id>.md` 是完成态摘要。
      const dir = str(d.asyncDir);
      if (dir) {
        run.dir = dir;
        const out = statusField(dir, "outputFile");
        if (out) run.logPath = out;
        run.outPath = join(dir, `subagent-log-${id}.md`);
      }
    }
    this.runs.set(id, run);
    this.arm();
    this.onChange();
  }

  /**
   * 进入会话的文本：完成 / 失败通知、取消回执。只在「这个 runId 我们已经认识」时才动手，
   * 所以误判的代价最多是把一条还在跑的提示提前收掉，不会凭空造出任务。
   */
  noteText(text: string): void {
    if (!text || !this.runs.size || !ENDED.test(text)) return;
    let touched = false;
    RUN_ID.lastIndex = 0;
    for (const m of text.matchAll(RUN_ID)) {
      const run = this.runs.get(m[1]);
      if (!run || run.state !== "running") continue;
      run.state = FAILED.test(text) ? "failed" : "done";
      run.endedAt = Date.now();
      touched = true;
    }
    if (touched) this.onChange();
  }

  /** 还在跑的（判死的已经不在表里）。 */
  active(): BgRun[] {
    return [...this.runs.values()].filter((r) => r.state === "running");
  }

  /** 全部（含刚跑完的），给「看详情」的弹层用：按开始时间从早到晚。 */
  list(): BgRunView[] {
    return [...this.runs.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((r) => ({
        id: r.id,
        source: r.source,
        agent: r.agent,
        task: r.task,
        startedAt: r.startedAt,
        state: r.state,
        ...(r.endedAt ? { endedAt: r.endedAt } : {}),
        hasLog: Boolean(r.logPath),
        hasOut: Boolean(r.outPath),
      }));
  }

  get(id: string): BgRun | undefined {
    return this.runs.get(id);
  }

  /**
   * 一个 run 的痕迹：活动记录尾 + 跑完的最终答复。只读 `%TEMP%\acp-delegate\` 里的文件 ——
   * 路径是从 pi 的工具结果里拾来的（那也是一段可能被写邪的文本），所以读前再校验一次落点，
   * 不让一次注入就变成任意文件读取。文件还没写出来、被删了、超过上限，都只是少一段内容。
   */
  readLog(id: string, limit = 8000): { run?: BgRun; log?: string; out?: string } {
    const run = this.runs.get(id);
    if (!run) return {};
    const view: { run?: BgRun; log?: string; out?: string } = { run };
    if (run.logPath) view.log = tail(run.logPath, limit);
    if (run.outPath) view.out = tail(run.outPath, limit);
    return view;
  }

  view(): BgView | undefined {
    const act = this.active();
    const done = [...this.runs.values()].filter((r) => r.state !== "running");
    if (!act.length && !done.length) return undefined;
    const view: BgView = { n: act.length };
    if (act.length) {
      // 提示条说「从什么时候开始」：取最早那条，免得后来的新手把钟拨回去。
      const first = act.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
      if (first.agent) view.agent = first.agent;
      view.since = first.startedAt;
    }
    if (done.length) {
      // 跑完就收掉提示条的话，「最终输出」只有弹层恰好开着才看得到（D170 评审）。留一档：
      // 提示条翻成「已结束 · 点开看结果」，「继续」同时恢复正常。
      const last = done.reduce((a, b) => ((a.endedAt ?? a.startedAt) >= (b.endedAt ?? b.startedAt) ? a : b));
      const end = last.endedAt ?? last.startedAt;
      view.recent = done.length;
      view.finishedAt = end;
      view.lastMs = Math.max(0, end - last.startedAt);
    }
    return view;
  }

  /** 会话关闭：表和定时器一起收掉，别让 30 秒一跳的滴答挂着已死的对象。 */
  reset(): void {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    if (this.runs.size) {
      this.runs.clear();
      this.onChange();
    }
  }

  private end(id: string, state: "done" | "failed"): void {
    const run = this.runs.get(id);
    if (!run || run.state !== "running") return;
    run.state = state;
    run.endedAt = Date.now();
    this.arm();
    this.onChange();
  }

  private arm(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => this.prune(), SWEEP_MS);
    // 后台任务表不该是桥退不出去的原因（同 D133 的 unref 定时器）。
    this.sweep.unref?.();
  }

  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, run] of this.runs) {
      if (run.state === "running") {
        // pi-subagents 有权威状态：`status.json.state`（running/completed/failed/stopped）。
        // 它的完成通知写的是 `Async: researcher [id]`，桥的 `RUN_ID` 认不出来，所以读这一眼。
        if (run.source === "subagents" && run.dir) {
          const st = statusField(run.dir, "state");
          if (st === "completed") {
            this.end(id, "done");
            continue;
          }
          if (st === "failed" || st === "stopped" || st === "cancelled" || st === "timeout") {
            this.end(id, "failed");
            continue;
          }
        }
        if (now - run.startedAt < SILENT_DEAD_MS) continue;
        run.state = "failed";
        run.endedAt = now;
        changed = true;
      } else if (now - (run.endedAt ?? run.startedAt) > KEEP_DONE_MS) {
        this.runs.delete(id);
        changed = true;
      }
    }
    if (!this.runs.size && this.sweep) {
      clearInterval(this.sweep);
      this.sweep = null;
    }
    if (changed) this.onChange();
  }
}
