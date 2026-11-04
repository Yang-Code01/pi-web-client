/**
 * How long a session's pi process is kept, and how much memory all of them may take together (D120).
 * Same shape as `budget.json`: one small file in the bridge's state dir, read whenever a rule needs
 * it — not pi's `settings.json`, because what to keep running is the bridge's decision, not pi's.
 *
 * The `PI_WEB_*` overrides are test seams, not a user knob: they squeeze the 30-minute rules into
 * seconds so the behaviour can be asserted in a test. The bridge strips `PI_WEB_*` before it spawns
 * pi (`rpc.ts`), so they never reach a child.
 */
import { readJson, statePath } from "./paths.ts";

export interface Lifecycle {
  /** A settled session that has seen no pi event for this long sleeps (#76). */
  idleMs: number;
  /** After the watchdog's abort, how long pi gets to settle before the process is ended (#81). */
  abortGraceMs: number;
  /** Every live pi together above this many resident bytes, the longest-idle ones sleep (#79). */
  maxBytes: number;
}

/** Defaults from D120; all of them are "可改". */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_ABORT_GRACE_MS = 60 * 1000;
export const DEFAULT_MAX_BYTES = 2_684_354_560; // 2.5 GB

/**
 * How long a pi that was just started or just woken is off limits to the watermark (#79). Not a
 * setting: a wake-up that gets reaped straight away only wakes up again, so the floor only has to
 * be long enough for the message that woke it to arrive. Injectable for the same reason as the tick
 * — a real 60 s costs a real minute.
 */
export const CAP_PROTECT_MS = 60 * 1000;

function positive(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** The protection window, squeezed for tests exactly like the tick and the thresholds above. */
export function capProtectMs(): number {
  return positive(process.env.PI_WEB_CAP_PROTECT_MS) ?? CAP_PROTECT_MS;
}

/**
 * How often the lifecycle rules get to look, i.e. the bridge's long-standing 60 s GC tick (D120: no
 * second timer). Injectable for the same reason as `idleMs`: a test that sits out three real ticks
 * spends three minutes proving something about seconds.
 */
export function gcTickMs(): number {
  return positive(process.env.PI_WEB_GC_TICK_MS) ?? 60_000;
}

export function lifecycle(): Lifecycle {
  const file = readJson<{ idleMs?: unknown; maxBytes?: unknown }>(statePath("lifecycle.json"), {});
  return {
    // Environment first: a test must win over whatever the state dir happens to hold.
    idleMs: positive(process.env.PI_WEB_IDLE_MS) ?? positive(file?.idleMs) ?? DEFAULT_IDLE_MS,
    abortGraceMs: positive(process.env.PI_WEB_ABORT_GRACE_MS) ?? DEFAULT_ABORT_GRACE_MS,
    maxBytes: positive(process.env.PI_WEB_MAX_BYTES) ?? positive(file?.maxBytes) ?? DEFAULT_MAX_BYTES,
  };
}
