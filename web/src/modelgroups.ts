import type { ModelInfo } from "./types.ts";

/** One provider's slice of the model catalog, as the pickers show it. */
export interface ModelGroup {
  provider: string;
  models: ModelInfo[];
}

const RECENT_KEY = "pi.models.recent";
/** How many recently used models the pickers keep (newest first). */
export const RECENT_MAX = 5;

type ModelRef = { provider: string; id: string };

function readRecent(): ModelRef[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is ModelRef => !!x && typeof x.provider === "string" && typeof x.id === "string");
  } catch {
    return [];
  }
}

/**
 * Remembers a model the user switched to (or away from) so pickers can offer it under
 * 「最近使用」. Newest first, de-duplicated by provider/id, capped at {@link RECENT_MAX};
 * kept per browser in localStorage.
 */
export function rememberRecentModel(provider: string | undefined, id: string | undefined): void {
  if (!provider || !id) return;
  const list = [{ provider, id }, ...readRecent().filter((r) => !(r.provider === provider && r.id === id))].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private mode: the recent group just stays empty */
  }
}

/** Recently used models that are still in the catalog, newest first; `exclude` (the pinned one) is left out. */
export function recentModels(models: ModelInfo[], exclude?: ModelInfo | null): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const r of readRecent()) {
    const m = models.find((x) => x.provider === r.provider && x.id === r.id);
    if (m && m !== exclude && !out.includes(m)) out.push(m);
  }
  return out;
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
): { pinned: ModelInfo | null; recent: ModelInfo[]; groups: ModelGroup[] } {
  const pinned =
    (current?.id && models.find((m) => m.id === current.id && (!current.provider || m.provider === current.provider))) || null;
  const groups = new Map<string, ModelInfo[]>();
  for (const m of models) {
    if (m === pinned) continue;
    const list = groups.get(m.provider);
    if (list) list.push(m);
    else groups.set(m.provider, [m]);
  }
  // 最近使用的也照样留在各自的来源组里：这一组是快捷入口，不是搬家。
  return { pinned, recent: recentModels(models, pinned), groups: [...groups].map(([provider, list]) => ({ provider, models: list })) };
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
