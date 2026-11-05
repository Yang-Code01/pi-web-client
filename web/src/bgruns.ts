/**
 * The background sub-agent strip at the foot of the transcript.
 *
 * Why it is not a tool card: these runs outlive the turn that started them. A tool card belongs to
 * the ops module of one turn and is closed by the next one (`closeOps`), while a delegate started
 * three messages ago can still be working — moving it into the transcript would make it vanish
 * exactly when the user starts talking again. So it hangs off the transcript's tail instead, and a
 * finished run stays there for a few minutes: the notification pi injects lands underneath, and the
 * card next to it is what makes that notification legible (D133).
 */
import { fmtTime, tr } from "./i18n/index.ts";
import type { BgRun } from "./types.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function elapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return tr("{p1}秒", { p1: secs });
  return tr("{p1}分{p2}秒", { p1: Math.floor(secs / 60), p2: String(secs % 60).padStart(2, "0") });
}

interface Card {
  node: HTMLElement;
  dot: HTMLElement;
  task: HTMLElement;
  time: HTMLElement;
  line: HTMLElement | null;
  acts: HTMLElement;
  run: BgRun;
}

export class BgRunsView {
  readonly el: HTMLElement;
  private readonly cards = new Map<string, Card>();
  private timer = 0;

  constructor(private readonly onOpen: (path: string) => void) {
    this.el = el("div", "runs");
  }

  /** Cheap enough to call on every tick: only touched nodes are rewritten. */
  set(runs: BgRun[]): void {
    const seen = new Set<string>();
    for (const run of runs) {
      seen.add(run.id);
      const card = this.cards.get(run.id) ?? this.create(run);
      card.run = run;
      this.paint(card);
    }
    for (const [id, card] of [...this.cards]) {
      if (seen.has(id)) continue;
      card.node.remove();
      this.cards.delete(id);
    }
    // Newest at the bottom, the way the transcript reads.
    const order = [...runs].sort((a, b) => a.startedAt - b.startedAt);
    order.forEach((run, i) => {
      const card = this.cards.get(run.id);
      if (card && this.el.children[i] !== card.node) this.el.insertBefore(card.node, this.el.children[i] ?? null);
    });
    this.arm();
  }

  private arm(): void {
    const busy = [...this.cards.values()].some((c) => c.run.state === "running" || c.run.state === "queued");
    if (!busy) {
      if (this.timer) window.clearInterval(this.timer);
      this.timer = 0;
      return;
    }
    if (this.timer) return;
    // The bridge pushes on change, and "still running at 2:14" is a change it cannot see.
    this.timer = window.setInterval(() => {
      for (const card of this.cards.values()) this.paintTime(card);
    }, 1000);
  }

  private create(run: BgRun): Card {
    const node = el("div", "run-card");
    node.dataset.id = run.id;
    const head = el("div", "run-head");
    const dot = el("span", "run-dot");
    const agent = el("span", "run-agent", run.agent);
    const task = el("span", "run-task");
    const time = el("span", "run-time");
    head.append(dot, agent, task, time);
    const line = el("div", "run-line");
    const acts = el("div", "run-acts");
    node.append(head, line, acts);
    this.el.append(node);
    const card: Card = { node, dot, task, time, line, acts, run };
    this.cards.set(run.id, card);
    return card;
  }

  private paint(card: Card): void {
    const { run, node } = card;
    node.dataset.state = run.state;
    node.title = run.task || run.agent;
    card.task.textContent = run.task || tr("后台任务");
    card.task.classList.toggle("muted", !run.task);

    const line = card.line;
    if (line) {
      line.replaceChildren();
      if (run.state === "running" || run.state === "queued") {
        line.append(el("span", "run-tool", run.line ?? (run.state === "queued" ? tr("排队中") : tr("刚启动"))));
        if (run.steps) line.append(el("span", "run-steps", tr(" · {p1} 次调用", { p1: run.steps })));
      } else if (run.state === "done") {
        const took = run.endedAt ? elapsed(run.endedAt - run.startedAt) : "";
        line.append(el("span", "run-ok", tr("完成")), el("span", "run-dim", took ? ` · ${took}` : ""));
        if (run.line) line.append(el("span", "run-dim", ` · ${run.line}`));
      } else {
        line.append(el("span", "run-bad", tr("结束（失败）")));
        if (run.line) line.append(el("span", "run-dim", ` · ${run.line}`));
      }
    }

    card.acts.replaceChildren();
    if (run.logPath) {
      const open = el("button", "run-act", tr("看过程"));
      open.type = "button";
      open.onclick = () => this.onOpen(String(run.logPath));
      card.acts.append(open);
    }
    card.acts.hidden = !card.acts.childElementCount;
    this.paintTime(card);
  }

  private paintTime(card: Card): void {
    const { run } = card;
    if (run.state === "done" || run.state === "failed") {
      card.time.textContent = run.endedAt ? fmtTime(run.endedAt) : "";
      return;
    }
    card.time.textContent = elapsed(Date.now() - run.startedAt);
    card.dot.classList.toggle("idle", Date.now() - run.lastAt > 3 * 60 * 1000);
  }
}
