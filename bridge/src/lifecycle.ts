/**
 * How long a session's pi process is kept, and how much memory all of them may take together (D120).
 * Same shape as `budget.json`: one small file in the bridge's state dir, read whenever a rule needs
 * it — not pi's `settings.json`, because what to keep running is the bridge's decision, not pi's.
 *
 * The `PI_WEB_*` overrides are test seams, not a user knob: they squeeze the two-hour rules into
 * seconds so the behaviour can be asserted in a test. The bridge strips `PI_WEB_*` before it spawns
 * pi (`rpc.ts`), so they never reach a child.
 */
import { readJson, statePath, writeJson } from "./paths.ts";

export interface Lifecycle {
  /** A settled session that has seen no pi event for this long sleeps (#76). */
  idleMs: number;
  /**
   * The same rule for 随手问 (#86): it is disabled by default so the conversation stays warm until
   * the user ends it. A positive value in `lifecycle.json` or the env seam restores auto-sleep.
   */
  scratchIdleMs: number;
  /** After the watchdog's abort, how long pi gets to settle before the process is ended (#81). */
  abortGraceMs: number;
  /**
   * D420：归档之后多久释放会话（睡掉 pi，并把它从桥里拿掉）。0 = 关闭这条规则，归档只改列表。
   * 有意与 `idleMs` 不同：这是「归档 = 我不用了」的承诺，给 0 留一个出口，而空闲休眠的 0 会
   * 被 `positive()` 当成错误输入挡掉（那一个 0 会让每个会话立刻被收走）。
   */
  archiveIdleMs: number;
  /** Total resident bytes of all our pi processes before the longest-idle ones sleep (#79). */
  watermarkBytes: number;
}

/**
 * Defaults from D120 §5, numbers raised by D372; all are "可改".
 * `DEFAULT_IDLE_MS` is one value serving three rules (D120 §8): idle sleep, the watchdog's stuck-run
 * judgement, and approval/question expiry when nobody is in front of a page.
 */
export const DEFAULT_IDLE_MS = 120 * 60 * 1000;
/** 随手问 (#86): 0 disables auto-sleep; users may opt back in with a positive threshold. */
export const DEFAULT_SCRATCH_IDLE_MS = 0;
export const DEFAULT_ABORT_GRACE_MS = 60 * 1000;
/** D420: 归档后五分钟释放；用户可在「回收阈值」里改，0 关掉这条规则。 */
export const DEFAULT_ARCHIVE_IDLE_MS = 5 * 60 * 1000;
export const DEFAULT_WATERMARK_BYTES = 5 * 1024 ** 3;

/**
 * How long a pi that was just started or just woken is off limits to the watermark (#79). Not a
 * setting: a wake-up that gets reaped straight away only wakes up again, so the floor only has to
 * be long enough for the message that woke it to arrive. Injectable for the same reason as the tick
 * — a real 60 s costs a real minute.
 */
export const CAP_PROTECT_MS = 60 * 1000;

/**
 * What the panel may read and write: the 「可改」 thresholds of D120 §5 plus D420's archive release.
 * `abortGraceMs` is not in here on purpose — it is the watchdog's test seam, and the page has no
 * business with it.
 */
export type LifecycleThresholds = Pick<Lifecycle, "idleMs" | "archiveIdleMs" | "watermarkBytes">;

/** A threshold, or null when it is not one: `true` is not 1 ms, and 0 would mean "reap at once". */
function positive(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** A zero scratch threshold explicitly means never auto-sleep. */
function nonNegative(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
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
  const file = readJson<{ idleMs?: unknown; scratchIdleMs?: unknown; watermarkBytes?: unknown; archiveIdleMs?: unknown }>(
    statePath("lifecycle.json"),
    {},
  );
  return {
    // Environment first: a test must win over whatever the state dir happens to hold.
    idleMs: positive(process.env.PI_WEB_IDLE_MS) ?? positive(file?.idleMs) ?? DEFAULT_IDLE_MS,
    scratchIdleMs: nonNegative(process.env.PI_WEB_SCRATCH_IDLE_MS) ?? nonNegative(file?.scratchIdleMs) ?? DEFAULT_SCRATCH_IDLE_MS,
    abortGraceMs: positive(process.env.PI_WEB_ABORT_GRACE_MS) ?? DEFAULT_ABORT_GRACE_MS,
    archiveIdleMs: nonNegative(process.env.PI_WEB_ARCHIVE_IDLE_MS) ?? nonNegative(file?.archiveIdleMs) ?? DEFAULT_ARCHIVE_IDLE_MS,
    watermarkBytes: positive(process.env.PI_WEB_WATERMARK_BYTES) ?? positive(file?.watermarkBytes) ?? DEFAULT_WATERMARK_BYTES,
  };
}

/** What the panel may change; every field is optional and every field is 「可改」 (D120 §5, D420). */
export interface LifecyclePatch {
  idleMs?: unknown;
  archiveIdleMs?: unknown;
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
  const archiveIdleMs = nonNegative(patch.archiveIdleMs);
  const watermarkBytes = positive(patch.watermarkBytes);
  // `undefined` is "the patch says nothing about this field"; anything else is a value to judge.
  if (patch.idleMs !== undefined && idleMs === null) return null;
  if (patch.archiveIdleMs !== undefined && archiveIdleMs === null) return null;
  if (patch.watermarkBytes !== undefined && watermarkBytes === null) return null;
  if (idleMs === null && archiveIdleMs === null && watermarkBytes === null) return null;
  const file = statePath("lifecycle.json");
  const current = readJson<Record<string, unknown>>(file, {});
  const next: Record<string, unknown> = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  if (idleMs !== null) next.idleMs = idleMs;
  if (archiveIdleMs !== null) next.archiveIdleMs = archiveIdleMs;
  if (watermarkBytes !== null) next.watermarkBytes = watermarkBytes;
  try {
    writeJson(file, next);
  } catch {
    /* an unwritable state dir only costs persistence, the same as budget.json */
  }
  return lifecycle();
}
