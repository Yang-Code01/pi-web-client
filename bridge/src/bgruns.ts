/**
 * 后台子代理（D170）：会话自己已经 settle，派出去的 runner 还在跑。
 *
 * pi 只在 `tool_execution_end` 的 `details` 里承认一次「有这么个 run」：
 *
 *   acp_delegate   {kind:"delegate", runId, agent, task}
 *   subagent       {runId, asyncDir}
 *
 * 之后唯一的完成信号是 runner 自己注入回会话的那条消息
 * （`[acp_delegate completed] … (runId `…`)`、`[acp_delegate FAILED ⚠️] …`），它既可能作为
 * steering 排进队列，也可能直接把空闲会话唤醒 —— 两头都从 `noteText()` 进来。
 *
 * 为什么不拿盘上的东西判定成败：`AgentRun` 的 `details.status` 永远停在 `running`，`.activity`
 * 的 mtime 也区分不了「写完最后一行」与「卡住」，只有 runner 自己注入回来的那条通知算数。
 * 读盘只用于 D170 的看详情（`readLog()`），不参与状态机。
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** runner 的痕迹目录（acp_delegate 把 `<runId>.activity` / `.out` / `.session.jsonl` 都写在这里）。 */
const ACP_DIR = join(tmpdir(), "acp-delegate");
const TASK_LINE = /^Task:[ 	]*(.+)$/m;
const LIVE_LOG = /Live activity is streaming to `([^`]+)`/;

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
  /** runner 自己的活动记录。只有落在 `%TEMP%\acp-delegate\` 里的才记（也只读那里，见 `readLog`）。 */
  logPath?: string;
  /** 跑完的最终答复（同目录的 `.out`）。 */
  outPath?: string;
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
const AGENT = /(?:\*\*([^*`\n]+)\*\*)|(?:Delegated to\s+([\w.-]+))/;

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
function tail(file: string, limit: number): string | undefined {
  const abs = resolve(file);
  if (!abs.startsWith(ACP_DIR + sep)) return undefined;
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
  noteToolEnd(tool: string, details: unknown, text: string): void {
    const d = (details && typeof details === "object" ? details : {}) as Record<string, unknown>;
    const id = typeof d.runId === "string" && d.runId ? d.runId : firstRunId(text);
    if (!id) return;
    // `acp_delegate_wait` / `_cancel` / 取消回执：同一个 runId 的结束信号，不是新任务。
    if (this.runs.has(id)) {
      if (ENDED.test(text) && !/Running in the background/.test(text)) this.end(id, FAILED.test(text) ? "failed" : "done");
      return;
    }
    // 只认「这是刚开跑的那个工具」：别的工具结果里恰好带个 runId（比如把 wait 的调用示例抄进结果）
    // 不该凭空造出一个任务。三种写法任一成立即为开始（见文件头的两种 runner）。
    const looksStart = d.kind === "delegate" || typeof d.asyncDir === "string" || /Running in the background/i.test(text);
    if (!looksStart) return;
    const source: "acp" | "subagents" = d.kind === "delegate" || tool === "acp_delegate" ? "acp" : "subagents";
    const agent = typeof d.agent === "string" ? d.agent : (AGENT.exec(text)?.[1] ?? AGENT.exec(text)?.[2] ?? "");
    const task = typeof d.task === "string" ? d.task : (TASK_LINE.exec(text)?.[1] ?? "");
    // 痕迹目录只认 acp_delegate 自己那个：路径要么是它，要么是它写进结果的同一路径（校验见 `readLog`）。
    // pi-subagents 只给 asyncDir，目录布局没有公开约定 —— 它没有可读的过程记录，卡片上直说（`hasLog`）。
    const live = LIVE_LOG.exec(text)?.[1];
    const logPath = live ?? (source === "acp" ? join(ACP_DIR, `${id}.activity`) : undefined);
    const run: BgRun = { id, source, agent: agent.trim(), task: task.trim(), startedAt: Date.now(), state: "running" };
    if (logPath) run.logPath = logPath;
    if (source === "acp") run.outPath = join(ACP_DIR, `${id}.out`);
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
