import type { ModelInfo } from "./types.ts";

/** One provider's slice of the model catalog, as the pickers show it. */
export interface ModelGroup {
  provider: string;
  models: ModelInfo[];
}

/**
 * Splits the catalog for a picker: the in-use model pinned on top (it follows every switch,
 * since callers re-render from the live value), the rest grouped by provider. Providers keep
 * the catalog's first-seen order and so do models inside a provider; the pinned one is not
 * repeated in its group. `provider` narrows the match when the caller knows it.
 */
export function groupModels(models: ModelInfo[], current?: { id?: string; provider?: string }): { pinned: ModelInfo | null; groups: ModelGroup[] } {
  const pinned =
    (current?.id && models.find((m) => m.id === current.id && (!current.provider || m.provider === current.provider))) || null;
  const groups = new Map<string, ModelInfo[]>();
  for (const m of models) {
    if (m === pinned) continue;
    const list = groups.get(m.provider);
    if (list) list.push(m);
    else groups.set(m.provider, [m]);
  }
  return { pinned, groups: [...groups].map(([provider, list]) => ({ provider, models: list })) };
}

/** Fills a `<select>` with the grouped catalog: pinned first, then one `<optgroup>` per provider. */
export function appendModelOptions(
  select: HTMLSelectElement,
  models: ModelInfo[],
  current: { id?: string; provider?: string } | undefined,
  label: (m: ModelInfo) => string,
  pinnedLabel: string,
): void {
  const { pinned, groups } = groupModels(models, current);
  const value = (m: ModelInfo) => `${m.provider}/${m.id}`;
  if (pinned) {
    const g = document.createElement("optgroup");
    g.label = pinnedLabel;
    g.append(new Option(label(pinned), value(pinned)));
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

/**
 * One foldable provider section: a clickable head and a body to put the rows in. Groups start
 * folded (a long catalog is the reason for grouping); which ones the user opened is remembered
 * across pickers and reloads. The pinned section is never folded.
 */
export function modelGroupSection(title: string, count: number, opts: { pinned?: boolean; key?: string } = {}): { node: HTMLElement; body: HTMLElement } {
  const node = document.createElement("div");
  node.className = `model-group${opts.pinned ? " pinned" : ""}`;
  const head = document.createElement("button");
  head.type = "button";
  head.className = `model-group-head${opts.pinned ? " pinned" : ""}`;
  const body = document.createElement("div");
  body.className = "model-group-body";
  const key = opts.key ?? title;
  const paint = (open: boolean): void => {
    node.classList.toggle("folded", !open);
    head.textContent = `${opts.pinned ? "" : open ? "▾ " : "▸ "}${title} · ${count}`;
    head.setAttribute("aria-expanded", String(open));
  };
  paint(opts.pinned || openSet().has(key));
  if (!opts.pinned) {
    head.onclick = (ev) => {
      ev.stopPropagation();
      const set = openSet();
      const open = !set.has(key);
      if (open) set.add(key);
      else set.delete(key);
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...set]));
      } catch {
        /* private mode: fold state just won't stick */
      }
      paint(open);
    };
  }
  node.append(head, body);
  return { node, body };
}
