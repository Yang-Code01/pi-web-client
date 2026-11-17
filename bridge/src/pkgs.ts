/**
 * The `packages` entries of settings.json, in the one form the 扩展 manager has to read and write
 * them (#469): what a package-level 停用 is, and how to put the user's own filters back on 启用.
 *
 * `"npm:x"` = load the package as it declares itself. `{ source, skills: ["+a"] }` = the same, with a
 * filter that narrows which resources load (docs/packages.md). `autoload: false` with no patterns
 * left loads nothing at all — pi's own delta form, and exactly what 停用 writes; 启用 strips it again
 * and collapses back to the plain string once no filter is left, which is what `pi config` does too.
 */
export type PackageEntry = string | PackageObject;

export interface PackageObject {
  source: string;
  autoload?: boolean;
  [field: string]: unknown;
}

/** Which resource types a package filter can narrow (pi's RESOURCE_TYPES). */
export const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;

/** The source an entry points at, or null for something that is not a package entry. */
export function entrySource(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim() || null;
  if (entry && typeof entry === "object") {
    const source = (entry as { source?: unknown }).source;
    if (typeof source === "string") return source.trim() || null;
  }
  return null;
}

/** `autoload: false` = the entry loads no resources (a project delta over the global entry, or 停用). */
export function disabledEntry(entry: unknown): boolean {
  return Boolean(entry && typeof entry === "object" && (entry as PackageObject).autoload === false);
}

/** Does this entry narrow what loads, without turning the package off altogether? */
export function filteredEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  return RESOURCE_KEYS.some((key) => Array.isArray((entry as PackageObject)[key]));
}

/**
 * 停用: keep everything the user wrote — their filters are what 启用 has to give back — and only add
 * `autoload: false`, the one field that makes pi load nothing from it.
 */
export function disableEntry(entry: PackageEntry): PackageObject {
  const kept: Record<string, unknown> = {};
  if (typeof entry === "string") kept.source = entry;
  else for (const [key, value] of Object.entries(entry)) if (key !== "autoload") kept[key] = value;
  return { ...kept, autoload: false } as PackageObject;
}

/**
 * 启用: drop `autoload`, drop the lists that are now empty, and go back to the plain string when the
 * source is all that is left — otherwise the entry would stay "filtered" forever with nothing in it.
 */
export function enableEntry(entry: PackageEntry): PackageEntry {
  if (typeof entry === "string") return entry;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "autoload") continue;
    if ((RESOURCE_KEYS as readonly string[]).includes(key) && Array.isArray(value) && value.length === 0) continue;
    kept[key] = value;
  }
  const source = typeof kept.source === "string" ? kept.source : "";
  return Object.keys(kept).length === 1 ? source : (kept as PackageObject);
}

/** Index of the entry for `source` in a settings `packages` list (-1 when it is not configured there). */
export function findEntry(list: unknown, source: string): number {
  if (!Array.isArray(list)) return -1;
  return list.findIndex((entry) => entrySource(entry) === source.trim());
}

/**
 * Is `source` loaded by this list — present, and not 停用 itself? Callers ask about the *other* scope's
 * list: a project entry replaces the global one, so a 停用的 project entry still loads while the global
 * one says nothing, and a 停用的 global entry still loads while the project's own entry is on (#469).
 */
export function loadedByList(list: unknown, source: string): boolean {
  const index = findEntry(list, source);
  if (index === -1) return false;
  return !disabledEntry((list as unknown[])[index]);
}

/** `user` rows live in the global settings file, `project` rows in the project's own. */
export function settingsScopeFor(scope: unknown): "global" | "project" {
  return scope === "project" ? "project" : "global";
}
