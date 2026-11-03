/**
 * pi's settings.json and project trust, read and written the way pi does it (#26, #21).
 *
 * - settings: global `<agentDir>/settings.json`, project `<cwd>/.pi/settings.json`. Writes go through
 *   pi's own `FileSettingsStorage.withLock` (proper-lockfile, the same lock a running pi takes), and
 *   only the fields the page changed are touched: everything else in the file stays as it was.
 * - trust: pi's `ProjectTrustStore` (`<agentDir>/trust.json`) and `getProjectTrustOptions`, so the
 *   choices are exactly the ones `/trust` offers in the terminal. RPC mode cannot show pi's trust
 *   prompt (docs/security.md), so a saved decision is the only way the web's pi loads a project's
 *   `.pi` resources.
 */
import fs from "node:fs";
import path from "node:path";
import { agentDir, readJson } from "./paths.ts";
import { piModule, piPackageDir } from "./pimods.ts";

export type SettingsScope = "global" | "project";

export interface SettingsView {
  scope: SettingsScope;
  cwd: string | null;
  path: string;
  exists: boolean;
  raw: string;
  json: Record<string, unknown> | null;
  error: string | null;
  /** Project scope: pi refuses to write project settings of an untrusted project. */
  writable: boolean;
}

function settingsPath(scope: SettingsScope, cwd: string | null): string {
  if (scope === "global") return path.join(agentDir(), "settings.json");
  if (!cwd) throw new Error("项目设置需要一个工作目录");
  return path.join(path.resolve(cwd), ".pi", "settings.json");
}

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Parse a settings file body; a syntax error or a non-object top level becomes a readable error. */
function parseObject(text: string, what: string): Obj {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (err) {
    throw new Error(`${what}不是合法的 JSON：${(err as Error).message}`);
  }
  if (!isObj(parsed)) throw new Error(`${what}的顶层必须是对象`);
  return parsed;
}

export async function readSettings(cli: string, scope: SettingsScope, cwd: string | null): Promise<SettingsView> {
  const file = settingsPath(scope, cwd);
  const exists = fs.existsSync(file);
  const raw = exists ? fs.readFileSync(file, "utf8") : "";
  let json: Obj | null = null;
  let error: string | null = null;
  try {
    json = raw.trim() ? parseObject(raw, "settings.json ") : {};
  } catch (err) {
    error = (err as Error).message;
  }
  const writable = scope === "global" || (cwd ? (await trustInfo(cli, cwd)).effective : false);
  return { scope, cwd, path: file, exists, raw, json, error, writable };
}

/** `a.b` → nested; `null` deletes the key (and an emptied parent object). */
export function applyPatch(base: Obj, patch: Obj): Obj {
  const out: Obj = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.split(".").filter(Boolean);
    if (!parts.length || parts.some((p) => p === "__proto__" || p === "constructor" || p === "prototype")) continue;
    const remove = value === null || value === undefined;
    // Walk to the holder of the last key, creating objects on the way only when setting.
    const chain: Obj[] = [out];
    let node: Obj | null = out;
    for (const part of parts.slice(0, -1)) {
      const next: unknown = node[part];
      if (!isObj(next)) {
        if (remove) {
          node = null;
          break;
        }
        node[part] = {};
      }
      node = node[part] as Obj;
      chain.push(node);
    }
    if (!node) continue;
    const last = parts[parts.length - 1];
    if (remove) delete node[last];
    else node[last] = value;
    // Do not leave `"compaction": {}` behind after clearing its only key.
    if (remove) {
      for (let i = chain.length - 1; i > 0; i--) {
        if (Object.keys(chain[i]).length) break;
        delete chain[i - 1][parts[i - 1]];
      }
    }
  }
  return out;
}

/**
 * Write settings under pi's lock. Either `patch` (field → value, null = remove) merged onto what is
 * on disk *at write time*, or `raw` (the whole file from the JSON editor, validated first).
 */
export async function writeSettings(
  cli: string,
  scope: SettingsScope,
  cwd: string | null,
  change: { patch?: Record<string, unknown>; raw?: string },
): Promise<SettingsView> {
  if (scope === "project") {
    if (!cwd) throw new Error("项目设置需要一个工作目录");
    if (!(await trustInfo(cli, cwd)).effective) throw new Error("这个项目没有被信任：pi 不会读它的 .pi/settings.json，也拒绝写它。先在「项目信任」里信任它。");
  }
  const replacement = typeof change.raw === "string" ? parseObject(change.raw, "编辑的内容") : null;
  const { FileSettingsStorage } = await piModule(cli, "core/settings-manager.js");
  const storage = new FileSettingsStorage(cwd ?? process.cwd(), agentDir());
  storage.withLock(scope, (current: string | undefined) => {
    if (replacement) return `${JSON.stringify(replacement, null, 2)}\n`;
    const base = current && current.trim() ? parseObject(current, "磁盘上的 settings.json（先用 JSON 编辑修好它）") : {};
    return `${JSON.stringify(applyPatch(base, change.patch ?? {}), null, 2)}\n`;
  });
  return readSettings(cli, scope, cwd);
}

// ------------------------------------------------------------------ project trust (#21)

export interface TrustInfo {
  cwd: string;
  /** The folder has `.pi` settings / extensions / skills… that only load when trusted. */
  needed: boolean;
  /** Saved decision that applies (closest folder up), or null. */
  saved: { path: string; decision: boolean } | null;
  /** Global `defaultProjectTrust`; RPC cannot ask, so "ask" behaves like "never". */
  fallback: "ask" | "always" | "never";
  /** What the web's pi will do right now. */
  effective: boolean;
  /** Exactly what the terminal's /trust offers here. */
  options: { label: string; trusted: boolean }[];
}

export async function trustInfo(cli: string, cwd: string): Promise<TrustInfo> {
  const mod = await piModule(cli, "core/trust-manager.js");
  const store = new mod.ProjectTrustStore(agentDir());
  const needed = Boolean(mod.hasTrustRequiringProjectResources(cwd));
  const entry = store.getEntry(cwd) as { path: string; decision: boolean } | null;
  const raw = readJson<{ defaultProjectTrust?: unknown }>(path.join(agentDir(), "settings.json"), {}).defaultProjectTrust;
  const fallback = raw === "always" || raw === "never" ? raw : "ask";
  const effective = entry ? entry.decision : fallback === "always";
  const options = (mod.getProjectTrustOptions(cwd) as { label: string; trusted: boolean }[]).map((o) => ({ label: o.label, trusted: o.trusted }));
  return { cwd, needed, saved: entry, fallback, effective, options };
}

/** Apply option `index` of getProjectTrustOptions(cwd), as /trust would. */
export async function setTrust(cli: string, cwd: string, index: number): Promise<TrustInfo> {
  const mod = await piModule(cli, "core/trust-manager.js");
  const options = mod.getProjectTrustOptions(cwd) as { updates: { path: string; decision: boolean | null }[] }[];
  const picked = options[index];
  if (!picked) throw new Error("没有这个信任选项");
  new mod.ProjectTrustStore(agentDir()).setMany(picked.updates);
  return trustInfo(cli, cwd);
}

/** The changelog shipped in the pi package (for `/changelog`), newest first, capped. */
export function changelog(cli: string, maxBytes = 60_000): string {
  const file = path.join(piPackageDir(cli), "CHANGELOG.md");
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n\n…（更早的版本略）` : text;
  } catch {
    return "";
  }
}
