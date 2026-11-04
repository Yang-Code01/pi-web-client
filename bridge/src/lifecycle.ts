/**
 * How long a session's pi process is kept (D120). Same shape as `budget.json`: one small file in the
 * bridge's state dir, read whenever a rule needs it — not pi's `settings.json`, because what to keep
 * running is the bridge's decision, not pi's.
 *
 * The `PI_WEB_*` overrides are test seams, not a user knob: they squeeze the 30-minute rules into
 * seconds so the behaviour can be asserted in a test. The bridge strips `PI_WEB_*` before it spawns
 * pi (`rpc.ts`), so they never reach a child.
 */
import { readJson, statePath } from "./paths.ts";

export interface Lifecycle {
  /** A settled session that has seen no pi event for this long sleeps (#76). */
  idleMs: number;
  /** After the watchdog's abort, how long pi gets to settle before the process is ended (#77). */
  abortGraceMs: number;
}

/** Defaults from D120; both are "可改". */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_ABORT_GRACE_MS = 60 * 1000;

function positive(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function lifecycle(): Lifecycle {
  const file = readJson<{ idleMs?: unknown }>(statePath("lifecycle.json"), {});
  return {
    // Environment first: a test must win over whatever the state dir happens to hold.
    idleMs: positive(process.env.PI_WEB_IDLE_MS) ?? positive(file?.idleMs) ?? DEFAULT_IDLE_MS,
    abortGraceMs: positive(process.env.PI_WEB_ABORT_GRACE_MS) ?? DEFAULT_ABORT_GRACE_MS,
  };
}
