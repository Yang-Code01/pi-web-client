/**
 * 帧词表的页面一半，外加「哪一帧到了、页面上要重画什么」这张表。
 *
 * 词表本身（`ServerFrameType` / `ClientFrameType` / 9 个载荷接口 / 构造器 / `FRAMES_CAP`）住在
 * `bridge/src/frames.ts`：桥要 import 它来构造函数，页面要 import 它来认帧，所以它得待在一个不
 * import 任何东西的叶子里。下面第一行是转发 —— 页面别处一律从 `./frames.ts` 引，不要直接摸
 * `../../bridge/` 的路径。
 *
 * 表为什么长这样：`onMessage()` 里每个臂干两件事 —— 改几个字段，再记住该重画什么（那一串
 * `this.renderApprovals(); this.renderQueue(); …`）。后一件事在 9 个臂里是稳定的、可测的；
 * 搬到这里以后，「这一帧改了什么」与「这一帧该重画什么」都成了纯函数的事实，不必开浏览器
 * 就能断言。剩下 119 个臂原样留在 switch 里，一片一片搬。
 */
export * from "../../bridge/src/frames.ts";

import type { TypedServerFrame } from "../../bridge/src/frames.ts";
import type { TabEvent } from "./ask-tab.ts";
import { copilotFromFrame, type CopilotView } from "./copilot.ts";
import type { CtxLine, CtxPolicy } from "./context.ts";
import type { ExecPhase } from "./exec-view.ts";
import { tr } from "./i18n/index.ts";
import { applyPending } from "./pending.ts";
import type { ApprovalRequest, AskAnswer, AskRequest, SessionState } from "./types.ts";

/**
 * 一帧到了之后要重画的东西。键是稳定的字符串（单测断言的就是它们），值怎么画由 App 决定 ——
 * 词表不碰 DOM，也不认识 `el()`。
 *
 * 一个帧可以要好几项，顺序就是今天的调用顺序（`paintContextIfOpen()` 必须在 `fillModelChip()`
 * 之后：它画的是模型条下面那块面板）。`pi.status` 的 5 个无条件重画这一片先保留原样，收窄它是
 * 后续单独一篇（会牵动 rail / 顶栏的刷新时机）。
 */
export type RedrawKey =
  | "approvals"
  | "asks"
  | "queue"
  | "tabs"
  | "sessions"
  | "hint"
  | "nowchip"
  | "roundstats"
  | "modelchip"
  | "context"
  | "top"
  | "continue"
  | "retell"
  | "failcta"
  | "placeholder";

/**
 * 表能碰的 App 状态。字段名与类型必须与 `web/src/app.ts` 里的 `private` 字段一致 ——
 * `web/tests/frames-unit.mjs` 有一条源码守卫盯着这件事（App 把它们保持 private，这张表靠唯一
 * 一处 `this as unknown as FrameView` 拿到）。
 *
 * 三个方法成员不是新造的抽象：它们是 App 上现成的纯状态变更（`applyQueueTabEvent` 只改
 * `tabMemory` / `queueTab`，`setExecPhase` 只改阶段与流缓冲，`execTabLive` 是个谓词），搬进 interface
 * 只是为了让表能调它们而不必把整个 App 传进来。
 */
export interface FrameView {
  currentId: string | null;
  session: SessionState | null;
  sessions: SessionState[];
  approvals: ApprovalRequest[];
  asks: AskRequest[];
  askDrafts: Map<string, { active: number; drafts: Map<string, AskAnswer> }>;
  askLost: { id: string; title: string; reason: string; lines: string[] } | null;
  lastAnsweredAsk: string | null;
  askFolded: boolean;
  askAutoFolded: boolean;
  askDockMuted: boolean;
  usage: { contextTokens: number | null; contextWindow: number | null };
  stats: {
    tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | null;
    cost: number | null;
  };
  policy: CtxPolicy | null;
  copilot: CopilotView | null;
  ctxLogs: Map<string, CtxLine[]>;
  rate: number;
  turnAt: number | null;
  runSince: number | null;
  activity: string;
  stepCount: number;
  execStreamChars: number;
  execStreamText: string;
  execTabLive(): boolean;
  setExecPhase(phase: ExecPhase): void;
  applyQueueTabEvent(event: TabEvent): void;
}

/**
 * 帧到了：就地改 `view` 上的字段，返回要重画的东西（空数组 = 这一帧跟当前会话无关，什么都不画）。
 *
 * `now` 是 performance 时钟，只有 `usage` 的速率用得上它（单测里传固定值就能算死）。`runSince` 仍是
 * 壁钟 —— 它显示的是「这轮几点开始的」，跟时长不是一回事。
 */
export function applyFrame(view: FrameView, frame: TypedServerFrame, now: number = performance.now()): RedrawKey[] {
  switch (frame.type) {
    case "usage": {
      if (frame.sessionId !== view.currentId) return [];
      // 原 settleRate()：拿这一轮的 output token / 秒数算实时速率，没有起始时刻就不算。
      const out = Number(frame.usage?.output ?? 0);
      if (!out || view.turnAt == null) return [];
      const secs = Math.max(0.3, (now - view.turnAt) / 1000);
      view.rate = out / secs;
      view.turnAt = null;
      return ["modelchip"];
    }

    case "stats": {
      if (frame.sessionId !== view.currentId) return [];
      // `policy` 缺席表示「这一帧没带」，与「带了个 null」不是一回事：前者保留原值。
      if ("policy" in frame) view.policy = (frame.policy as CtxPolicy | null) ?? null;
      view.stats = {
        tokens: frame.tokens && typeof frame.tokens === "object" ? frame.tokens : null,
        cost: typeof frame.cost === "number" ? frame.cost : null,
      };
      view.usage = {
        contextTokens: typeof frame.context?.tokens === "number" ? frame.context.tokens : null,
        contextWindow: typeof frame.context?.contextWindow === "number" ? frame.context.contextWindow : view.usage.contextWindow,
      };
      const out: RedrawKey[] = ["roundstats", "modelchip"];
      if (view.execTabLive()) out.push("queue");
      out.push("context");
      return out;
    }

    case "copilot": {
      if (frame.sessionId !== view.currentId) return [];
      view.copilot = copilotFromFrame(frame);
      const out: RedrawKey[] = ["roundstats", "modelchip"];
      if (view.execTabLive()) out.push("queue");
      return out;
    }

    case "ctxlog": {
      // #384：组成日志增量。非当前会话的也存（切换会话时面板要画全量），只重画打开着的面板。
      if (typeof frame.sessionId !== "string") return [];
      const arr = Array.isArray(frame.lines) ? (frame.lines as CtxLine[]) : [];
      const cur = view.ctxLogs.get(frame.sessionId) ?? [];
      const next = frame.full ? arr : [...cur, ...arr.filter((l) => l && typeof l.seq === "number")];
      view.ctxLogs.set(frame.sessionId, next);
      return frame.sessionId === view.currentId ? ["context"] : [];
    }

    case "pi.status": {
      if (view.session && view.session.id === frame.sessionId) view.session = { ...view.session, running: frame.running };
      const out: RedrawKey[] = [];
      if (frame.sessionId === view.currentId) {
        if (frame.running) {
          view.runSince = Date.now();
          view.setExecPhase("waiting");
          view.execStreamChars = 0;
          view.execStreamText = "";
          view.activity = tr("思考中");
          // Q-024: the hover card says "本轮第 N 次工具调用", so N is per run and starts over here.
          view.stepCount = 0;
        } else {
          view.setExecPhase("idle");
          view.activity = "";
        }
        out.push("hint");
        // 跑着 ↔ 空闲是「继续」按钮亮/灰的翻转点（D159）。
        out.push("continue", "retell");
        // 任务结束才问「要不要把这一轮的错误记下来」（D164）。
        out.push("failcta", "placeholder");
      }
      if (!frame.running) view.turnAt = null;
      out.push("top", "sessions", "queue", "tabs", "modelchip");
      return out;
    }

    case "approval.add": {
      // D156：当前会话也照加 —— 列表里的计数和本地队列是两份账，只给「不在看的会话」加会让
      // 切过去再答的批准永远减不掉；卡片是否重画也跟着这条走。
      applyPending(view.sessions, String(frame.sessionId ?? ""), "approvals", 1);
      if (frame.sessionId === view.currentId) {
        view.approvals = [...view.approvals, frame.approval as ApprovalRequest];
        view.applyQueueTabEvent({ type: "approvals", count: view.approvals.length });
      }
      return ["approvals", "queue", "tabs", "hint", "sessions"];
    }

    case "approval.remove": {
      view.approvals = view.approvals.filter((a) => a.id !== frame.id);
      if (frame.sessionId === view.currentId) view.applyQueueTabEvent({ type: "approvals", count: view.approvals.length });
      // 和 approval.add 对称：不管这条批准是不是当前会话的，都得减回去，否则卡片上永远「待确认」。
      applyPending(view.sessions, String(frame.sessionId ?? ""), "approvals", -1);
      return ["hint", "approvals", "queue", "tabs", "sessions"];
    }

    case "ask.add": {
      const ask = frame.ask as AskRequest | undefined;
      if (!ask) return [];
      // 提问记在 asks 上（不是 approvals），当前会话也记 —— 见 D156。
      applyPending(view.sessions, String(frame.sessionId ?? ""), "asks", 1);
      if (frame.sessionId !== view.currentId) return ["sessions"];
      view.asks = [...view.asks.filter((a) => a.id !== ask.id), ask];
      view.applyQueueTabEvent({ type: "asks", count: view.asks.length, arrived: true });
      view.askFolded = false;
      view.askAutoFolded = false;
      // 新的这一份是新的「这一次」：上一道题时用户收起过右栏，不该连带着压下这一道。
      view.askDockMuted = false;
      return ["asks", "queue", "tabs", "sessions", "nowchip"];
    }

    case "ask.remove": {
      // The bridge tells us why an ask disappeared. Dropping the id silently is how answers used
      // to vanish: the panel closed, the drafts died with it, and nothing on screen said so.
      const gone = view.asks.find((a) => a.id === frame.id);
      const mine = frame.sessionId === view.currentId;
      view.asks = view.asks.filter((a) => a.id !== frame.id);
      if (mine) view.applyQueueTabEvent({ type: "asks", count: view.asks.length, arrived: false });
      // 答完 / 被取消都走这条：计数必须跟着回落（D156）。
      applyPending(view.sessions, String(frame.sessionId ?? ""), "asks", -1);
      if (gone && mine && gone.id !== view.lastAnsweredAsk) keepLostAsk(view, gone, String(frame.reason ?? tr("问卷已关闭")));
      if (gone && mine) view.lastAnsweredAsk = null;
      return ["asks", "queue", "tabs", "sessions"];
    }

    default:
      // 词表里还有 119 个帧没搬进这张表：它们照旧落回 onMessage() 的 switch。
      return [];
  }
}

/**
 * Remember a questionnaire that disappeared while it still had answers in it, so the user can see
 * it happened and get the text back. Filled answers are also persisted (see saveAskDrafts).
 */
function keepLostAsk(view: FrameView, ask: AskRequest, reason: string): void {
  const st = view.askDrafts.get(ask.id);
  const lines = ask.questions
    .map((q) => {
      const a = st?.drafts.get(q.id);
      return a ? `${q.prompt}\n→ ${a.label ?? a.value}` : null;
    })
    .filter((x): x is string => x !== null);
  if (!lines.length) return; // nothing was filled in: losing it costs the user nothing
  const title = ask.questions.length === 1 ? ask.questions[0].prompt : tr("{p1} 题的问卷", { p1: ask.questions.length });
  view.askLost = { id: ask.id, title: title.slice(0, 80), reason, lines };
}
