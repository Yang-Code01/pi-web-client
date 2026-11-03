/**
 * The 扩展 manager's operations (D81): inventory with update checks, the badge count, enable /
 * disable of extensions and MCP servers, MCP version bumps, store installs. Package installs,
 * removals and updates still go through pi's CLI (picli.ts); this file decides *what* to run.
 */
import fs from "node:fs";
import path from "node:path";
import { agentDir, readJson, statePath, writeJson } from "./paths.ts";
import { runPiCli } from "./picli.ts";
import { readSettings, writeSettings } from "./pisettings.ts";
import { editMcpEntry, inspectPackages, looseExtensions, mcpEntry, mcpPackageOf, mcpVersion, type InstalledExtension, type InstalledPackage, type McpVersionInfo } from "./market.ts";

export interface InstalledMcp {
  name: string;
  scope: string;
  source: string;
  enabled: boolean;
  exposure: string | null;
  transport: string | null;
  state: string | null;
  tools: string[];
  error: string | null;
  version: McpVersionInfo;
}

export interface Inventory {
  packages: InstalledPackage[];
  extensions: InstalledExtension[];
  mcp: InstalledMcp[];
  mcpError: string | null;
  updates: number;
  checkedAt: number;
}

async function cli(cliPath: string, req: Record<string, unknown>): Promise<{ code: number | null; data: unknown; output: string }> {
  return runPiCli(cliPath, req, () => {}).done;
}

/** The mcp.json files pi reads for this cwd (global, and the project's when there is a cwd). */
export function mcpFiles(cwd: string | null): string[] {
  const files = [path.join(agentDir(), "mcp.json")];
  if (cwd) files.push(path.join(cwd, ".pi", "mcp.json"));
  return files.filter((f) => fs.existsSync(f));
}

/** Only these files may be edited through the page: pi's global mcp.json or some project's. */
export function assertMcpFile(file: string): string {
  const abs = path.resolve(file);
  const ok = abs === path.resolve(agentDir(), "mcp.json") || (path.basename(abs) === "mcp.json" && path.basename(path.dirname(abs)) === ".pi");
  if (!ok || !fs.existsSync(abs)) throw new Error(`不是 pi 的 mcp.json：${file}`);
  return abs;
}

/** Everything installed, with versions; `check` asks npm / PyPI / git for newer ones. */
export async function inventory(cliPath: string, cwd: string | null, check: boolean): Promise<Inventory> {
  const [list, mcpList] = await Promise.all([cli(cliPath, { op: "pkg.list", cwd: cwd ?? undefined }), cli(cliPath, { op: "mcp.list", cwd: cwd ?? undefined })]);
  const rows = Array.isArray(list.data) ? (list.data as { scope: "user" | "project"; source: string; path: string | null }[]) : [];
  const packages = await inspectPackages(rows, check);
  const servers = Array.isArray((mcpList.data as any)?.servers) ? ((mcpList.data as any).servers as any[]) : [];
  const mcp: InstalledMcp[] = await Promise.all(
    servers.map(async (s) => {
      const entry = s.source ? mcpEntry(String(s.source), String(s.name)) : null;
      return {
        name: String(s.name),
        scope: String(s.scope ?? ""),
        source: String(s.source ?? ""),
        enabled: s.enabled !== false,
        exposure: s.exposure ?? null,
        transport: s.transport ?? null,
        state: s.state ?? null,
        tools: Array.isArray(s.tools) ? s.tools.map(String) : [],
        error: s.error ? String(s.error) : null,
        version: await mcpVersion(entry?.command as string | undefined, entry?.args as string[] | undefined, check),
      };
    }),
  );
  const updates = packages.filter((p) => p.update).length + mcp.filter((m) => m.version.update).length;
  const inv: Inventory = { packages, extensions: looseExtensions(cwd), mcp, mcpError: mcpList.data ? null : mcpList.output.trim().slice(-500) || null, updates, checkedAt: Date.now() };
  if (check) writeJson(statePath("market", "updates.json"), { at: inv.checkedAt, count: updates, cwd });
  return inv;
}

/**
 * The badge number: cached for 6 hours. Cheap path — packages from `pi list` and MCP versions
 * from mcp.json, without connecting to any MCP server.
 */
export async function updateCount(cliPath: string, cwd: string | null, force = false): Promise<number> {
  const cache = readJson<{ at?: number; count?: number; cwd?: string | null } | null>(statePath("market", "updates.json"), null);
  if (!force && cache?.at && Date.now() - cache.at < 6 * 3600_000 && (cache.cwd ?? null) === cwd) return cache.count ?? 0;
  const list = await cli(cliPath, { op: "pkg.list", cwd: cwd ?? undefined });
  const rows = Array.isArray(list.data) ? (list.data as { scope: "user" | "project"; source: string; path: string | null }[]) : [];
  const packages = await inspectPackages(rows, true);
  let count = packages.filter((p) => p.update).length;
  for (const file of mcpFiles(cwd)) {
    const servers = readJson<{ mcpServers?: Record<string, { command?: string; args?: string[] } | undefined> }>(file, {}).mcpServers ?? {};
    for (const s of Object.values(servers)) {
      if ((await mcpVersion(s?.command, s?.args, true)).update) count++;
    }
  }
  writeJson(statePath("market", "updates.json"), { at: Date.now(), count, cwd });
  return count;
}

/**
 * Enable / disable an extension the way `pi config` records it: `-builtin:x` / `-<path>` entries
 * in the settings `extensions` list of the scope that owns it (built-ins: global).
 */
export async function toggleExtension(cliPath: string, ext: { id: string; scope: "user" | "project" | "builtin"; how: string }, enable: boolean, cwd: string | null): Promise<void> {
  const scope = ext.scope === "project" ? "project" : "global";
  const view = await readSettings(cliPath, scope, scope === "project" ? cwd : null);
  if (view.error) throw new Error(view.error);
  const base = scope === "project" && cwd ? path.join(cwd, ".pi") : agentDir();
  const list = Array.isArray(view.json?.extensions) ? (view.json!.extensions as unknown[]).map(String) : [];
  const same = (entry: string, id: string) => {
    const plain = entry.replace(/^[+-]/, "");
    if (id.startsWith("builtin:")) return plain === id;
    if (plain.startsWith("builtin:") || /^(npm:|git:|https?:)/.test(plain)) return false;
    return path.resolve(base, plain) === path.resolve(id);
  };
  let next = list.filter((e) => !same(e, ext.id));
  if (ext.id.startsWith("builtin:") || ext.how === "discovered") {
    if (!enable) next.push(`-${ext.id}`);
  } else {
    // Listed in settings: enabled = the plain path, disabled = its exclusion.
    next.push(enable ? ext.id : `-${ext.id}`);
  }
  if (JSON.stringify(next) === JSON.stringify(list)) return;
  await writeSettings(cliPath, scope, scope === "project" ? cwd : null, { patch: { extensions: next.length ? next : null } });
}

export function toggleMcp(file: string, name: string, enabled: boolean): void {
  editMcpEntry(assertMcpFile(file), name, (entry) => {
    if (enabled) delete entry.enabled;
    else entry.enabled = false;
  });
}

/** Move a pinned npx / uvx / docker server to `version` in its own mcp.json entry. */
export function bumpMcp(file: string, name: string, version: string): void {
  if (!/^[\w.+-]+$/.test(version)) throw new Error("版本号不合法");
  editMcpEntry(assertMcpFile(file), name, (entry) => {
    const args = Array.isArray(entry.args) ? (entry.args as unknown[]).map(String) : [];
    const p = mcpPackageOf(entry.command as string | undefined, args);
    if (!p.identifier || !p.version) throw new Error("这个服务没有固定版本，不需要更新");
    const from = p.registry === "npm" ? `${p.identifier}@${p.version}` : p.registry === "pypi" ? `${p.identifier}==${p.version}` : `${p.identifier}:${p.version}`;
    const to = p.registry === "npm" ? `${p.identifier}@${version}` : p.registry === "pypi" ? `${p.identifier}==${version}` : `${p.identifier}:${version}`;
    const at = args.indexOf(from);
    if (at < 0) throw new Error(`在参数里找不到 ${from}`);
    args[at] = to;
    entry.args = args;
  });
}

// ------------------------------------------------------------------ web UI preferences

export interface UiPrefs {
  /** The 扩展 button under the composer (D81): on unless turned off in settings. */
  showExtButton: boolean;
}

export function readUiPrefs(): UiPrefs {
  const raw = readJson<Partial<UiPrefs>>(statePath("ui.json"), {});
  return { showExtButton: raw.showExtButton !== false };
}

export function writeUiPrefs(patch: Partial<UiPrefs>): UiPrefs {
  const next = { ...readUiPrefs(), ...patch };
  writeJson(statePath("ui.json"), next);
  return next;
}
