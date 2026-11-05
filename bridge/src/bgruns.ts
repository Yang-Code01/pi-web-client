/**
 * Background sub-agent runs, as seen from outside the pi child.
 *
 * pi itself starts these runners and then lets go of them: the child keeps running, but the bridge
 * only learns that *a* run exists from the tool result's `details` — `{kind:"delegate", runId}` for
 * billion-context's `acp_delegate`, `{runId, asyncDir}` for pi-subagents' `subagent`. Everything
 * after that is read from the runners' own artifacts, which is the only honest source:
 *
 *   acp_delegate   <%TEMP%>\acp-delegate\<runId>.activity   (text, appended per tool call)
 *                  %USERPROFILE%\.pi\acp.log               (logfmt; `event=done` is the only exit)
 *   pi-subagents   <%TEMP%>\pi-subagents-*\async-subagent-runs\<runId>\status.json
 *
 * Why not derive it from the session file instead: a toolResult records `status:"running"` and never
 * rewrites it, so the file cannot say whether a run is still alive. See D133.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

export type BgRunState = "queued" | "running" | "done" | "failed";

export interface BgRun {
  id: string;
  /** Which implementation started it — the two have different artifacts and different honesty. */
  source: "acp" | "subagents";
  agent: string;
  task: string;
  state: BgRunState;
  startedAt: number;
  endedAt?: number;
  /** Last sign of life (activity file mtime, or status.json's `lastUpdate`). */
  lastAt: number;
  /** One line from the run's own trail, shown under the task in the card. */
  line?: string;
  /** How many tool calls the runner has logged — the honest "is it doing anything" number. */
  steps?: number;
  /** The run's own trail; the card previews it. */
  logPath?: string;
}

/** A run that has been quiet this long and never said it finished is dead (kill leaves no trace). */
const ACP_SILENT_DEAD_MS = 60 * 60 * 1000;
/** Finished runs stay on screen this long so the card turns into its result instead of vanishing. */
const KEEP_DONE_MS = 10 * 60 * 1000;
const TICK_MS = 1200;
const TAIL_BYTES = 8 * 1024;

/* ------------------------------------------------------------------ acp.log */

/**
 * `event=done runId=… code=0` is the only completion signal acp_delegate leaves. The log is shared
 * by every session and by every pi process on the box, so one cursor serves them all.
 */
const acpDone = new Map<string, number>();
let acpCursor: { file: string; offset: number } | null = null;

function pollAcpLog(): void {
  const file = join(homedir(), ".pi", "acp.log");
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (!acpCursor || acpCursor.file !== file) {
    // First read only looks at the tail: the log grows forever and old runs are not our business.
    acpCursor = { file, offset: Math.max(0, size - 128 * 1024) };
  }
  if (size < acpCursor.offset) acpCursor.offset = 0;
  if (size === acpCursor.offset) return;
  const len = size - acpCursor.offset;
  const buf = Buffer.allocUnsafe(len);
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    readSync(fd, buf, 0, len, acpCursor.offset);
  } catch {
    return;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  acpCursor.offset = size;
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.includes("event=done") || !line.includes("runId=")) continue;
    const id = /runId=(\S+)/.exec(line)?.[1];
    if (!id) continue;
    const code = / code=(-?\d+)/.exec(line)?.[1];
    acpDone.set(id, code ? Number(code) : 0);
    // One entry per finished run, forever, is a slow leak on a bridge that lives for weeks.
    if (acpDone.size > 500) acpDone.delete(acpDone.keys().next().value as string);
  }
}

/* -------------------------------------------------------------- artifacts */

function tailText(file: string, bytes = TAIL_BYTES): string | null {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return null;
  }
  const start = Math.max(0, size - bytes);
  const len = size - start;
  if (!len) return "";
  const buf = Buffer.allocUnsafe(len);
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    readSync(fd, buf, 0, len, start);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return buf.toString("utf8");
}

/** `[tool] bash npm test` → `bash · npm test`; everything else is the runner's prose, trimmed. */
function readAcpLine(file: string): { line?: string; lastAt: number; steps: number } | null {
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const text = tailText(file);
  if (text === null) return null;
  const lines = text.split("\n").filter((l) => l.trim());
  let steps = 0;
  let line: string | undefined;
  // Prefer a tool line: a run's last prose line is as likely to be a stray number as anything useful.
  for (let i = lines.length - 1; i >= 0 && line === undefined; i -= 1) {
    const tool = /^\[tool\] (\S+) ?(.*)$/.exec(lines[i]);
    if (tool) line = tool[2] ? `${tool[1]} · ${tool[2].slice(0, 90)}` : tool[1];
  }
  for (let i = lines.length - 1; i >= 0 && line === undefined; i -= 1) {
    const one = lines[i];
    if (one.startsWith("[tool]") || one.startsWith("[done]")) continue;
    line = one.trim().slice(0, 90);
  }
  // Counting `[tool]` lines means reading the whole file; only the visible tail is worth it.
  if (text.length < TAIL_BYTES - 1) steps = (text.match(/^\[tool\] /gm) ?? []).length;
  return { line, lastAt: Math.round(mtime), steps };
}

interface SubStatus {
  state?: string;
  pid?: number;
  agent?: string;
  task?: string;
  startedAt?: number;
  endedAt?: number;
  lastUpdate?: number;
  line?: string;
  steps?: number;
}

function readSubStatus(dir: string): SubStatus | null {
  const file = join(dir, "status.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let s: any;
  try {
    s = JSON.parse(raw);
  } catch {
    return null;
  }
  const step = Array.isArray(s?.steps) ? s.steps[0] : null;
  const recent = Array.isArray(step?.recentTools) ? step.recentTools[step.recentTools.length - 1] : null;
  return {
    state: typeof s?.state === "string" ? s.state : undefined,
    pid: typeof s?.pid === "number" ? s.pid : undefined,
    agent: typeof step?.agent === "string" ? step.agent : undefined,
    // `sessionName` reads "worker: 把这份规格实现出来"; the part after the colon is the task itself.
    task: typeof step?.sessionName === "string" ? step.sessionName.replace(/^[^:]*:\s*/, "") : undefined,
    startedAt: typeof s?.startedAt === "number" ? s.startedAt : undefined,
    endedAt: typeof s?.endedAt === "number" ? s.endedAt : undefined,
    lastUpdate: typeof s?.lastUpdate === "number" ? s.lastUpdate : undefined,
    line: recent ? `${recent.tool ?? "tool"} · ${String(recent.args ?? "").slice(0, 90)}` : undefined,
    steps: typeof s?.toolCount === "number" ? s.toolCount : undefined,
  };
}

function alive(pid: number | undefined): boolean | null {
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM" ? true : false;
  }
}

const SUB_STATE: Record<string, BgRunState> = {
  queued: "queued",
  running: "running",
  complete: "done",
  partial: "done",
  failed: "failed",
  stopped: "failed",
  rejected: "failed",
  paused: "failed",
};

/* ---------------------------------------------------------------- tracker */

/** Per-session registry. Owns one timer and only while something is actually on screen. */
export class BgRuns {
  private readonly runs = new Map<string, { run: BgRun; dir?: string }>();
  private timer: NodeJS.Timeout | null = null;
  private last = "";

  constructor(private readonly onChange: (runs: BgRun[]) => void) {}

  /**
   * `details` is the tool result's `details` field — the only place pi tells us a runner exists.
   * Unknown shapes are ignored: an extension inventing a new field is not our failure.
   */
  note(details: any): void {
    if (!details || typeof details !== "object") return;
    if (details.kind === "delegate" && typeof details.runId === "string") {
      this.track({
        id: details.runId,
        source: "acp",
        agent: String(details.agent ?? "agent"),
        task: String(details.task ?? "").slice(0, 160),
        state: "running",
        startedAt: Date.now(),
        lastAt: Date.now(),
        logPath: join(tmpdir(), "acp-delegate", `${details.runId}.activity`),
      });
      return;
    }
    if (typeof details.asyncDir === "string" && typeof details.runId === "string") {
      this.track(
        {
          id: details.runId,
          source: "subagents",
          agent: "agent",
          task: "",
          state: "running",
          startedAt: Date.now(),
          lastAt: Date.now(),
          logPath: join(details.asyncDir, "events.jsonl"),
        },
        details.asyncDir,
      );
    }
  }

  private track(run: BgRun, dir?: string): void {
    this.runs.set(run.id, { run, dir });
    this.arm();
    this.flush(true);
  }

  list(): BgRun[] {
    return [...this.runs.values()].map((r) => r.run).sort((a, b) => a.startedAt - b.startedAt);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  private flush(force = false): void {
    const key = JSON.stringify(this.list());
    if (!force && key === this.last) return;
    this.last = key;
    this.onChange(this.list());
  }

  private tick(): void {
    pollAcpLog();
    const now = Date.now();
    for (const [id, entry] of [...this.runs]) {
      const run = entry.run;
      if (run.state !== "running" && run.state !== "queued") {
        // Keep the finished card around until the completion notification has had time to land.
        if (now - (run.endedAt ?? now) > KEEP_DONE_MS) this.runs.delete(id);
        continue;
      }
      if (run.source === "acp") {
        const seen = readAcpLine(join(tmpdir(), "acp-delegate", `${id}.activity`));
        if (seen) {
          if (seen.line) run.line = seen.line;
          if (seen.steps) run.steps = seen.steps;
          run.lastAt = Math.max(run.lastAt, seen.lastAt);
        }
        const code = acpDone.get(id);
        if (code !== undefined) {
          run.state = code === 0 ? "done" : "failed";
          run.endedAt = now;
        } else if (now - run.lastAt > ACP_SILENT_DEAD_MS) {
          // Killed runs never write `event=done`; silence is the only evidence left.
          this.runs.delete(id);
        }
      } else {
        const st = entry.dir ? readSubStatus(entry.dir) : null;
        if (st) {
          if (st.agent) run.agent = st.agent;
          if (st.task) run.task = st.task;
          if (st.startedAt) run.startedAt = st.startedAt;
          if (st.line) run.line = st.line;
          if (typeof st.steps === "number") run.steps = st.steps;
          run.lastAt = Math.max(run.lastAt, st.lastUpdate ?? run.lastAt);
          const mapped = st.state ? SUB_STATE[st.state] : undefined;
          if (mapped === "done") {
            run.state = "done";
            run.endedAt = st.endedAt ?? now;
          } else if (mapped === "failed") {
            run.state = "failed";
            run.endedAt = st.endedAt ?? now;
          } else if (mapped === "queued") {
            run.state = "queued";
          } else if (mapped === "running" && alive(st.pid) === false) {
            // A `running` status whose pid is gone will never be rewritten; the reconciler that
            // pi-subagents runs on read is not on disk for us to wait for.
            run.state = "failed";
            run.endedAt = now;
          }
        }
      }
    }
    if (!this.runs.size) this.stop();
    this.flush();
  }
}

/** `<runId>.activity` of a finished run, used by the card's "看过程" button. */
export function acpActivityPath(runId: string): string {
  return join(tmpdir(), "acp-delegate", basename(`${runId}.activity`));
}

export function acpOutPath(runId: string): string {
  return join(tmpdir(), "acp-delegate", basename(`${runId}.out`));
}
