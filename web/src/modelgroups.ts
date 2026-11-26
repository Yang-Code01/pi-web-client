import type { ModelInfo } from "./types.ts";

/** One provider's slice of the model catalog, as the pickers show it. */
export interface ModelGroup {
  provider: string;
  models: ModelInfo[];
}

const RECENT_KEY = "pi.models.recent";
/**
 * The review panel's own recents (D423). Chat and review keep separate lists so the review
 * picker can show their union without leaking review-only picks into the chat pickers.
 */
const REVIEW_RECENT_KEY = "pi.models.reviewRecent";
/** How many recently used models **each list** keeps (newest first). */
export const RECENT_MAX = 5;

/** `t` = when it was last used (ms). Entries written before D423 have none and sort last. */
type ModelRef = { provider: string; id: string; t?: number };

function readList(key: string): ModelRef[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is ModelRef => !!x && typeof x.provider === "string" && typeof x.id === "string");
  } catch {
    return [];
  }
}

function rememberInto(key: string, provider: string | undefined, id: string | undefined): void {
  if (!provider || !id) return;
  const list = [{ provider, id, t: Date.now() }, ...readList(key).filter((r) => !(r.provider === provider && r.id === id))].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* private mode: the recent group just stays empty */
  }
}

/**
 * Remembers a model the user switched to (or away from) so pickers can offer it under
 * 「最近使用」. Newest first, de-duplicated by provider/id, capped at {@link RECENT_MAX};
 * kept per browser in localStorage. Chat pickers read this list only.
 */
export function rememberRecentModel(provider: string | undefined, id: string | undefined): void {
  rememberInto(RECENT_KEY, provider, id);
}

/** The review panel's 「最近使用」 writer: a model it picked (or actually ran a review with). */
export function rememberReviewModel(provider: string | undefined, id: string | undefined): void {
  rememberInto(REVIEW_RECENT_KEY, provider, id);
}

/** Maps refs onto the live catalog: drops models no longer offered and the `exclude` (pinned) one. */
function toModels(refs: ModelRef[], models: ModelInfo[], exclude?: ModelInfo | null): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const r of refs) {
    const m = models.find((x) => x.provider === r.provider && x.id === r.id);
    if (m && m !== exclude && !out.includes(m)) out.push(m);
  }
  return out;
}

/** Recently used models that are still in the catalog, newest first; `exclude` (the pinned one) is left out. */
export function recentModels(models: ModelInfo[], exclude?: ModelInfo | null): ModelInfo[] {
  return toModels(readList(RECENT_KEY), models, exclude);
}

/**
 * The chat list and the review list as one list (D423): newest `t` first, one entry per
 * provider/id, **not** re-capped — each list already holds at most {@link RECENT_MAX}, so a
 * chat-heavy history cannot push a model the user just picked for reviews out of the group.
 */
export function mergedRecentModels(models: ModelInfo[], exclude?: ModelInfo | null): ModelInfo[] {
  const byKey = new Map<string, ModelRef>();
  for (const r of [...readList(RECENT_KEY), ...readList(REVIEW_RECENT_KEY)]) {
    const key = `${r.provider}/${r.id}`;
    const prev = byKey.get(key);
    if (!prev || (r.t ?? 0) > (prev.t ?? 0)) byKey.set(key, r);
  }
  return toModels([...byKey.values()].sort((a, b) => (b.t ?? 0) - (a.t ?? 0)), models, exclude);
}

/**
 * Splits the catalog for a picker: the in-use model pinned on top (it follows every switch,
 * since callers re-render from the live value), the rest grouped by provider. Providers keep
 * the catalog's first-seen order and so do models inside a provider; the pinned one is not
 * repeated in its group. `provider` narrows the match when the caller knows it.
 */
export function groupModels(
  models: ModelInfo[],
  current?: { id?: string; provider?: string },
  /** `mergedRecent`: the review panel wants chat + review recents merged (D423); everyone else keeps chat only. */
  opts?: { mergedRecent?: boolean },
): { pinned: ModelInfo | null; recent: ModelInfo[]; groups: ModelGroup[] } {
  const pinned =
    (current?.id && models.find((m) => m.id === current.id && (!current.provider || m.provider === current.provider))) || null;
  // 最近使用的也照样留在各自的来源组里：这一组是快捷入口，不是搬家。
  const recent = opts?.mergedRecent ? mergedRecentModels(models, pinned) : recentModels(models, pinned);
  return { pinned, recent, groups: groupByProvider(models.filter((m) => m !== pinned)) };
}

/**
 * The catalog split by provider, in first-seen order, models in catalog order. No pinning and
 * no recents — 「全部模型」 wants the plain shape, and `groupModels` builds on this too.
 */
export function groupByProvider(models: ModelInfo[]): ModelGroup[] {
  const groups = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const list = groups.get(m.provider);
    if (list) list.push(m);
    else groups.set(m.provider, [m]);
  }
  return [...groups].map(([provider, list]) => ({ provider, models: list }));
}

/** Fills a `<select>` with the grouped catalog: pinned first, then recent (when `recentLabel` is given), then one `<optgroup>` per provider. */
export function appendModelOptions(
  select: HTMLSelectElement,
  models: ModelInfo[],
  current: { id?: string; provider?: string } | undefined,
  label: (m: ModelInfo) => string,
  pinnedLabel: string,
  recentLabel?: string,
): void {
  const { pinned, recent, groups } = groupModels(models, current);
  const value = (m: ModelInfo) => `${m.provider}/${m.id}`;
  if (pinned) {
    const g = document.createElement("optgroup");
    g.label = pinnedLabel;
    g.append(new Option(label(pinned), value(pinned)));
    select.append(g);
  }
  if (recentLabel && recent.length) {
    const g = document.createElement("optgroup");
    g.label = recentLabel;
    for (const m of recent) g.append(new Option(label(m), value(m)));
    select.append(g);
  }
  for (const group of groups) {
    const g = document.createElement("optgroup");
    g.label = group.provider;
    for (const m of group.models) g.append(new Option(label(m), value(m)));
    select.append(g);
  }
}

const OPEN_KEY = "pi.modelGroups.open";

function openSet(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Whether the provider group `key` was left open by this browser (fold state is shared by all pickers). */
export function isModelGroupOpen(key: string): boolean {
  return openSet().has(key);
}

/** Remember whether `key` is open; private mode just means the choice won't stick. */
export function setModelGroupOpen(key: string, open: boolean): void {
  const set = openSet();
  if (open) set.add(key);
  else set.delete(key);
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...set]));
  } catch {
    /* private mode: fold state won't stick */
  }
}

/**
 * One foldable provider section: a clickable head and a body to put the rows in. Groups start
 * folded (a long catalog is the reason for grouping); which ones the user opened is remembered
 * across pickers and reloads. The pinned section (and a `fixed` one, like 最近使用) is never folded.
 */
export function modelGroupSection(
  title: string,
  count: number,
  opts: { pinned?: boolean; fixed?: boolean; key?: string } = {},
): { node: HTMLElement; body: HTMLElement } {
  const fixed = !!(opts.pinned || opts.fixed);
  const node = document.createElement("div");
  node.className = `model-group${opts.pinned ? " pinned" : ""}${opts.fixed ? " fixed" : ""}`;
  const head = document.createElement("button");
  head.type = "button";
  head.className = `model-group-head${opts.pinned ? " pinned" : ""}${opts.fixed ? " fixed" : ""}`;
  const body = document.createElement("div");
  body.className = "model-group-body";
  const key = opts.key ?? title;
  const paint = (open: boolean): void => {
    node.classList.toggle("folded", !open);
    head.textContent = `${fixed ? "" : open ? "▾ " : "▸ "}${title} · ${count}`;
    head.setAttribute("aria-expanded", String(open));
  };
  paint(fixed || isModelGroupOpen(key));
  if (!fixed) {
    head.onclick = (ev) => {
      ev.stopPropagation();
      const open = !isModelGroupOpen(key);
      setModelGroupOpen(key, open);
      paint(open);
    };
  }
  node.append(head, body);
  return { node, body };
}
