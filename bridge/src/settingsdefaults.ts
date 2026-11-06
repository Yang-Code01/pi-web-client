/**
 * pi's own setting defaults, read from the installed package instead of copied into our source.
 *
 * `schemas/settings.schema.json` ships with pi and carries `default` on every leaf it pins down, so
 * the settings form can say 「（默认：medium）」 and keep saying the truth after pi changes one. A few
 * settings have no schema default because pi decides them at runtime (`defaultProvider`, `shellPath`,
 * `enabledModels`) or keeps a documented value the schema leaves open (`defaultThinkingLevel`,
 * `defaultTools`, the two timeouts, `npmCommand`); those come from `FALLBACK` below, transcribed from
 * pi's `docs/settings.md`.
 *
 * Shape: dotted keys, exactly like the form's `key` (`compaction.reserveTokens`), because that is
 * what the page looks up. Unknown/missing schema → fallback only, never a throw: a wrong default
 * label is a blemish, a crash in `settings.get` is a broken panel.
 */
import fs from "node:fs";
import path from "node:path";
import { piPackageDir } from "./pimods.ts";

export type SettingDefaults = Record<string, unknown>;

/** Documented defaults the shipped JSON Schema does not state (pi docs/settings.md). */
const FALLBACK: SettingDefaults = {
  defaultThinkingLevel: "medium",
  defaultTools: ["read", "bash", "edit", "write"],
  httpIdleTimeoutMs: 300000,
  websocketConnectTimeoutMs: 15000,
  npmCommand: ["npm"],
  // Provider retries are off by default; the schema leaves the value open because 0 means "off".
  "retry.provider.maxRetries": 0,
};

const cache = new Map<string, SettingDefaults>();

function walk(node: unknown, prefix: string, out: SettingDefaults): void {
  if (!node || typeof node !== "object") return;
  const props = (node as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return;
  for (const [key, child] of Object.entries(props as Record<string, unknown>)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && "default" in child) {
      out[dotted] = (child as { default?: unknown }).default;
    }
    walk(child, dotted, out);
  }
}

/**
 * Dotted `key → default` for one pi install; cached because the package does not change under us.
 * `cli` is the bridge's resolved pi binary (`resolvePi()` never returns null), and the package root is
 * derived from it — no path of our own, so a user on an older pi just gets `FALLBACK`.
 */
export function settingDefaults(cli: string): SettingDefaults {
  const pkg = piPackageDir(cli);
  const hit = cache.get(pkg);
  if (hit) return hit;
  const fromSchema: SettingDefaults = {};
  try {
    const file = path.join(pkg, "schemas", "settings.schema.json");
    walk(JSON.parse(fs.readFileSync(file, "utf8")), "", fromSchema);
  } catch {
    /* older pi without the schema: FALLBACK still answers for every key the form asks about */
  }
  // Schema wins where both speak: pi's own file is the authority, the table only fills gaps.
  const merged: SettingDefaults = { ...FALLBACK, ...fromSchema };
  cache.set(pkg, merged);
  return merged;
}
