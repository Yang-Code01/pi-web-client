/**
 * How long a session's pi process is kept (D120). Same shape as `budget.json`: one small file in the
 * bridge's state dir, read whenever a rule needs it — not pi's `settings.json`, because what to keep
 * running is the bridge's decision, not pi's.
 *
 * The `PI_WEB_*` overrides are test seams, not a user knob: they squeeze the 30-minute rules into
 * seconds so the behaviour can be asserted in a test. The bridge strips `PI_WEB_*` before it spawns
 * pi (`rpc.ts`), so they never reach a child.
 */
import { readJson, statePath, writeJson } from "./paths.ts";

export interface Lifecycle {
  /** A settled session that has seen no pi event for this long sleeps (#76). */
  idleMs: number;
  /** After the watchdog's abort, how long pi gets to settle before the process is ended (#81). */
  abortGraceMs: number;
  /** Total resident bytes of all our pi processes before the longest-idle ones sleep (#79). */
  watermarkBytes: number;
}

/** Defaults from D120; all are "可改". */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_ABORT_GRACE_MS = 60 * 1000;
export const DEFAULT_WATERMARK_BYTES = 2.5 * 1024 ** 3;

/** A threshold, or null when it is not one: `true` is not 1 ms, and 0 would mean "reap at once". */
function positive(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
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
  const file = readJson<{ idleMs?: unknown; watermarkBytes?: unknown }>(statePath("lifecycle.json"), {});
  return {
    // Environment first: a test must win over whatever the state dir happens to hold.
    idleMs: positive(process.env.PI_WEB_IDLE_MS) ?? positive(file?.idleMs) ?? DEFAULT_IDLE_MS,
    abortGraceMs: positive(process.env.PI_WEB_ABORT_GRACE_MS) ?? DEFAULT_ABORT_GRACE_MS,
    watermarkBytes: positive(file?.watermarkBytes) ?? DEFAULT_WATERMARK_BYTES,
  };
}

/** What the panel may change; both fields are optional and both are "可改" (D120 §5). */
export interface LifecyclePatch {
  idleMs?: unknown;
  watermarkBytes?: unknown;
}

/**
 * Merge a panel edit into `lifecycle.json`, keeping whatever was there before. A field that is not a
 * positive number is dropped rather than guessed at, and `null` comes back when nothing survived so
 * the caller can say so — dropping a bad edit must never leave a half-written file behind.
 *
 * Nothing is cached: the next `lifecycle()` call (i.e. the next GC tick) already reads the new value,
 * which is what makes "改完不用重启桥" true for the idle threshold.
 */
export function writeLifecycle(patch: LifecyclePatch): Lifecycle | null {
  const idleMs = positive(patch.idleMs);
  const watermarkBytes = positive(patch.watermarkBytes);
  if (idleMs === null && watermarkBytes === null) return null;
  const file = statePath("lifecycle.json");
  const current = readJson<Record<string, unknown>>(file, {});
  const next: Record<string, unknown> = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  if (idleMs !== null) next.idleMs = idleMs;
  if (watermarkBytes !== null) next.watermarkBytes = watermarkBytes;
  try {
    writeJson(file, next);
  } catch {
    /* an unwritable state dir only costs persistence, the same as budget.json */
  }
  return lifecycle();
}
