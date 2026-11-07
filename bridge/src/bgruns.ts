/**
 * 后台子代理（D169）：会话自己已经 settle，派出去的 runner 还在跑。
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
 * 为什么不读盘（D133 那套 `.activity` / `status.json`）：这一版只要「还在不在跑、跑了多久」，
 * 卡片上的步数、最后一行、看过程都还没做。等那套搬过来时，`BgRun` 往外多带字段就行，
 * 判定「结束」仍以这里为准（它比 stat 更早、更省）。
 */

/** 一个还在跑（或刚跑完）的后台任务。 */
export interface BgRun {
  id: string;
  /** 谁起的是两种实现：痕迹和完成通知都不一样。 */
  source: "acp" | "subagents";
  agent: string;
  startedAt: number;
  state: "running" | "done" | "failed";
  endedAt?: number;
}

/** 会话快照 / `SessionState.bg` 里那一小块：前端只画「N 个 · 谁 · 从什么时候」。 */
export interface BgView {
  n: number;
  agent?: string;
  since: number;
}

/**
 * 一个从没报过完成、也没再被 `details` 提过的 run 判死的期限。给得很宽：真跑几小时的任务
 * 不该被界面判失败，而 kill 掉的 run 迟早会被会话关闭或桥重启带走。
 */
const SILENT_DEAD_MS = 6 * 60 * 60 * 1000;
/** 跑完的 run 留一小会儿，免得「完成」和「会话被唤醒」之间那一帧里提示条闪一下。 */
const KEEP_DONE_MS = 2 * 60 * 1000;
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
    const agent = typeof d.agent === "string" ? d.agent : (AGENT.exec(text)?.[1] ?? AGENT.exec(text)?.[2] ?? "");
    this.runs.set(id, {
      id,
      source: d.kind === "delegate" || tool === "acp_delegate" ? "acp" : "subagents",
      agent: agent.trim(),
      startedAt: Date.now(),
      state: "running",
    });
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

  view(): BgView | undefined {
    const act = this.active();
    if (!act.length) return undefined;
    // 提示条说「从什么时候开始」：取最早那条，免得后来的新手把钟拨回去。
    const first = act.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
    return { n: act.length, ...(first.agent ? { agent: first.agent } : {}), since: first.startedAt };
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
