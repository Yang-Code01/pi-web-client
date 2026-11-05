/**
 * How long a session's pi process is kept, and how much memory all of them may take together (D120).
 * Same shape as `budget.json`: one small file in the bridge's state dir, read whenever a rule needs
 * it — not pi's `settings.json`, because what to keep running is the bridge's decision, not pi's.
 *
 * The `PI_WEB_*` overrides are test seams, not a user knob: they squeeze the 30-minute rules into
 * seconds so the behaviour can be asserted in a test. The bridge strips `PI_WEB_*` before it spawns
 * pi (`rpc.ts`), so they never reach a child.
 */
import { readJson, statePath, writeJson } from "./paths.ts";

export interface Lifecycle {
  /** A settled session that has seen no pi event for this long sleeps (#76). */
  idleMs: number;
  /**
   * The same rule for 随手问 (#86): it is the longest-lived thing in the bridge on purpose — the
   * whole point of it is to still be warm when a thought strikes, so it must outlast an ordinary
   * session. Not in the panel (yet): D120's two 「可改」 thresholds keep their meaning, and this one
   * is set through `lifecycle.json` or the env seam.
   */
  scratchIdleMs: number;
  /** After the watchdog's abort, how long pi gets to settle before the process is ended (#81). */
  abortGraceMs: number;
  /** Total resident bytes of all our pi processes before the longest-idle ones sleep (#79). */
  watermarkBytes: number;
}

/** Defaults from D120; all are "可改". */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
/** 随手问 (#86): longer than an ordinary session on purpose — it exists to still be warm later. */
export const DEFAULT_SCRATCH_IDLE_MS = 60 * 60 * 1000;
export const DEFAULT_ABORT_GRACE_MS = 60 * 1000;
export const DEFAULT_WATERMARK_BYTES = 2.5 * 1024 ** 3;

/**
 * How long a pi that was just started or just woken is off limits to the watermark (#79). Not a
 * setting: a wake-up that gets reaped straight away only wakes up again, so the floor only has to
 * be long enough for the message that woke it to arrive. Injectable for the same reason as the tick
 * — a real 60 s costs a real minute.
 */
export const CAP_PROTECT_MS = 60 * 1000;

/**
 * What the panel may read and write: the two 「可改」 thresholds of D120 §5. `abortGraceMs` is not in
 * here on purpose — it is the watchdog's test seam, and the page has no business with it.
 */
export type LifecycleThresholds = Pick<Lifecycle, "idleMs" | "watermarkBytes">;

/** A threshold, or null when it is not one: `true` is not 1 ms, and 0 would mean "reap at once". */
function positive(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
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
  const file = readJson<{ idleMs?: unknown; scratchIdleMs?: unknown; watermarkBytes?: unknown }>(statePath("lifecycle.json"), {});
  return {
    // Environment first: a test must win over whatever the state dir happens to hold.
    idleMs: positive(process.env.PI_WEB_IDLE_MS) ?? positive(file?.idleMs) ?? DEFAULT_IDLE_MS,
    scratchIdleMs: positive(process.env.PI_WEB_SCRATCH_IDLE_MS) ?? positive(file?.scratchIdleMs) ?? DEFAULT_SCRATCH_IDLE_MS,
    abortGraceMs: positive(process.env.PI_WEB_ABORT_GRACE_MS) ?? DEFAULT_ABORT_GRACE_MS,
    watermarkBytes: positive(process.env.PI_WEB_WATERMARK_BYTES) ?? positive(file?.watermarkBytes) ?? DEFAULT_WATERMARK_BYTES,
  };
}

/** What the panel may change; both fields are optional and both are "可改" (D120 §5). */
export interface LifecyclePatch {
  idleMs?: unknown;
  watermarkBytes?: unknown;
}

/**
 * Merge a panel edit into `lifecycle.json`, keeping whatever was there before. All or nothing: the
 * panel prints 「已保存」 whenever this returns non-null, so a patch that *names* a field and gets it
 * wrong is refused whole (`null`, nothing written, both old values still in force) — saving the good
 * half quietly would tell the user something untrue about the bad half.
 *
 * Nothing is cached: the next `lifecycle()` call (i.e. the next GC tick) already reads the new value,
 * which is what makes "改完不用重启桥" true for the idle threshold.
 */
export function writeLifecycle(patch: LifecyclePatch): Lifecycle | null {
  const idleMs = positive(patch.idleMs);
  const watermarkBytes = positive(patch.watermarkBytes);
  // `undefined` is "the patch says nothing about this field"; anything else is a value to judge.
  if (patch.idleMs !== undefined && idleMs === null) return null;
  if (patch.watermarkBytes !== undefined && watermarkBytes === null) return null;
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
