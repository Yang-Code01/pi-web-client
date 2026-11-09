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
