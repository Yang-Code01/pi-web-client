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
  /** `pi mcp list` reported these server entries as broken (bad config), so they are not in `mcp`. */
  mcpErrors: string[];
  /** pi's own note on the run, e.g. “this project's .pi/mcp.json is ignored, the project is not trusted”. */
  mcpNote: string | null;
  updates: number;
  checkedAt: number;
  /** `pi mcp list` has answered, so `mcp` below is the real list (not just “still running”). */
  mcpReady: boolean;
  /** npm / PyPI / git answered for every row: `latest` and `update` are final, not “not asked yet”. */
  versionsChecked: boolean;
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

/**
 * Everything installed, pushed in stages so the page can paint while the slow parts run (D81
 * follow-up): `pi list` + the extensions folders first (local, a few seconds), then `pi mcp list`
 * (it connects every enabled server), then the versions (npm / PyPI / `git ls-remote`, which over a
 * dead network take up to the 20 s request timeout each). `emit` gets a complete snapshot after
 * every stage; `check` asks the registries for newer versions at all.
 */
export async function inventory(cliPath: string, cwd: string | null, check: boolean, emit?: (inv: Inventory) => void): Promise<Inventory> {
  const checkedAt = Date.now();
  const list = await cli(cliPath, { op: "pkg.list", cwd: cwd ?? undefined });
  const rows = Array.isArray(list.data) ? (list.data as { scope: "user" | "project"; source: string; path: string | null }[]) : [];
  const inv: Inventory = { packages: await inspectPackages(rows, false), extensions: looseExtensions(cwd), mcp: [], mcpError: null, mcpErrors: [], mcpNote: null, updates: 0, checkedAt, mcpReady: false, versionsChecked: false };
  const countUpdates = () => inv.packages.filter((p) => p.update).length + inv.mcp.filter((m) => m.version.update).length;
  const snapshot = () => {
    inv.updates = countUpdates();
    emit?.(structuredClone(inv));
  };
  snapshot();

  // What each server runs, kept for the version stage (the mcp stage itself stays off the network).
  const commands = new Map<string, { command?: string; args?: string[] }>();
  const mcpStage = (async () => {
    const mcpList = await cli(cliPath, { op: "mcp.list", cwd: cwd ?? undefined });
    const servers = Array.isArray((mcpList.data as any)?.servers) ? ((mcpList.data as any).servers as any[]) : [];
    inv.mcpErrors = Array.isArray((mcpList.data as any)?.errors) ? ((mcpList.data as any).errors as unknown[]).map(String) : [];
    inv.mcpNote = typeof (mcpList.data as any)?.note === "string" ? String((mcpList.data as any).note) : null;
    inv.mcp = servers.map((s) => {
      const entry = s.source ? mcpEntry(String(s.source), String(s.name)) : null;
      commands.set(String(s.name), { command: entry?.command as string | undefined, args: entry?.args as string[] | undefined });
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
        // A pinned version is known without asking npm / PyPI; the version stage fills in `latest`.
        version: { ...mcpPackageOf(entry?.command as string | undefined, entry?.args as string[] | undefined), latest: null, update: false },
      } satisfies InstalledMcp;
    });
    inv.mcpError = mcpList.data ? null : mcpList.output.trim().slice(-500) || null;
    inv.mcpReady = true;
    snapshot();
  })().catch((err: any) => {
    inv.mcpError = String(err?.message ?? err);
    inv.mcpReady = true;
    snapshot();
  });

  const versionStage = (async () => {
    if (!check) return;
    // The MCP rows carry the versions: without this wait they are read while `inv.mcp` is still [] on
    // any machine where `pi list` beats `pi mcp list` (a fresh agent dir: always), and the pin versions
    // are silently never checked. The stage itself never rejects (it catches into `mcpError`).
    await mcpStage;
    inv.packages = await inspectPackages(rows, true).catch(() => inv.packages);
    const bumped = await Promise.all(
      inv.mcp.map(async (m) => {
        const c = commands.get(m.name);
        return { ...m, version: await mcpVersion(c?.command, c?.args, true) };
      }),
    );
    inv.mcp = bumped;
    inv.versionsChecked = true;
    snapshot();
  })();

  await Promise.allSettled([mcpStage, versionStage]);
  inv.updates = countUpdates();
  if (check) writeJson(statePath("market", "updates.json"), { at: inv.checkedAt, count: inv.updates, cwd });
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
