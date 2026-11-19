/**
 * The 扩展 manager's operations (D81): inventory with update checks, the badge count, enable /
 * disable of extensions and MCP servers, MCP version bumps, store installs. Package installs,
 * removals and updates still go through pi's CLI (picli.ts); this file decides *what* to run.
 */
import fs from "node:fs";
import path from "node:path";
import { agentDir, readJson, statePath, writeJson } from "./paths.ts";
import { disableEntry, disabledEntry, enableEntry, findEntry, loadedByList, settingsScopeFor, type PackageEntry } from "./pkgs.ts";
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
  /** Servers configured for the pi-mcp-adapter extension only (read-only on the page). */
  mcpAdapter: AdapterMcp[];
  updates: number;
  checkedAt: number;
  /** `pi mcp list` has answered, so `mcp` below is the real list (not just “still running”). */
  mcpReady: boolean;
  /** `pi list` answered: until then `packages` is empty because it is not known yet, not because nothing is installed. */
  packagesReady: boolean;
  /** Package versions are checked (`latest` / `update` final for `packages`); MCP may still be going. */
  packagesChecked?: boolean;
  /** npm / PyPI / git answered for every row: `latest` and `update` are final, not “not asked yet”. */
  versionsChecked: boolean;
}

async function cli(cliPath: string, req: Record<string, unknown>): Promise<{ code: number | null; data: unknown; output: string }> {
  return runPiCli(cliPath, req, () => {}).done;
}

/** Both `packages` lists (global, and the project's when there is a cwd) — unreadable ones become null. */
async function packageSettings(cliPath: string, cwd: string | null): Promise<{ global: any; project: any }> {
  const read = async (scope: "global" | "project") => {
    try {
      return (await readSettings(cliPath, scope, scope === "project" ? cwd : null)).json;
    } catch {
      return null;
    }
  };
  const [globalSettings, projectSettings] = await Promise.all([read("global"), cwd ? read("project") : null]);
  return { global: globalSettings, project: projectSettings };
}

/**
 * 停用 / 启用 one package without uninstalling it (#469): rewrite its entry in that scope's
 * `packages` — `autoload: false` off, the user's own filters back on. Nothing else in settings moves.
 */
export async function togglePackage(cliPath: string, target: { scope: "user" | "project"; source: string }, enable: boolean, cwd: string | null): Promise<void> {
  const scope = settingsScopeFor(target.scope);
  const view = await readSettings(cliPath, scope, scope === "project" ? cwd : null);
  if (view.error) throw new Error(view.error);
  const list = Array.isArray(view.json?.packages) ? [...(view.json!.packages as unknown[])] : [];
  const index = findEntry(list, target.source);
  if (index === -1) throw new Error(`${scope === "project" ? "项目" : "全局"} settings.json 的 packages 里没有 ${target.source}`);
  const current = list[index] as PackageEntry;
  const next = enable ? enableEntry(current) : disableEntry(current);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  list[index] = next;
  await writeSettings(cliPath, scope, scope === "project" ? cwd : null, { patch: { packages: list } });
}

/** The mcp.json files pi reads for this cwd (global, and the project's when there is a cwd). */
export function mcpFiles(cwd: string | null): string[] {
  const files = [path.join(agentDir(), "mcp.json")];
  if (cwd) files.push(path.join(cwd, ".pi", "mcp.json"));
  return files.filter((f) => fs.existsSync(f));
}

/** What an mcp.json entry runs, one line: the URL, or the command and its arguments. */
function transportOf(entry: Record<string, unknown> | undefined): string | null {
  if (!entry) return null;
  if (typeof entry.url === "string") return entry.url;
  if (typeof entry.command !== "string") return null;
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  return [entry.command, ...args].join(" ");
}

function serversIn(file: string): [string, Record<string, unknown>][] {
  const json = readJson<Record<string, unknown>>(file, {});
  const servers = (json.mcpServers ?? json["mcp-servers"]) as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.entries(servers).filter((e): e is [string, Record<string, unknown>] => Boolean(e[1]) && typeof e[1] === "object");
}

/**
 * The servers pi will list, read straight from its mcp.json files — no connection, so the page can
 * show every row at once while `pi mcp list` connects them in the background. A later file wins a
 * name (the project's `.pi/mcp.json` replaces the global entry, as in pi). `state` is "connecting" until
 * pi answers; a disabled entry is already final.
 */
export function configuredMcp(cwd: string | null): InstalledMcp[] {
  const byName = new Map<string, InstalledMcp>();
  for (const file of mcpFiles(cwd)) {
    const scope = path.resolve(file) === path.resolve(agentDir(), "mcp.json") ? "global" : "project";
    for (const [name, entry] of serversIn(file)) {
      const enabled = entry.enabled !== false && entry.disabled !== true;
      byName.set(name, {
        name,
        scope,
        source: file,
        enabled,
        exposure: typeof entry.exposure === "string" ? entry.exposure : null,
        transport: transportOf(entry),
        state: enabled ? "connecting" : "disabled",
        tools: [],
        error: null,
        version: { ...mcpPackageOf(entry.command as string | undefined, entry.args as string[] | undefined), latest: null, update: false },
      });
    }
  }
  return [...byName.values()];
}

export interface AdapterMcp {
  name: string;
  file: string;
  transport: string | null;
  enabled: boolean;
}

/**
 * Servers only the pi-mcp-adapter extension knows about (its own config files, see its
 * docs/configuration.md): pi's `pi mcp list` never sees them, so the 已安装 page used to look as if
 * they were not installed at all. Listed read-only; names pi already lists are left out.
 */
export function adapterMcp(cwd: string | null, known: Set<string>): AdapterMcp[] {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const files = [
    home && path.join(home, ".config", "mcp", "mcp.json"),
    home && path.join(home, ".agents", "mcp.json"),
    home && path.join(home, ".agents", "mcp", "mcp.json"),
    path.join(agentDir(), "mcp-adapter.json"),
    cwd && path.join(cwd, ".mcp.json"),
    cwd && path.join(cwd, ".pi", "mcp-adapter.json"),
  ].filter((f): f is string => Boolean(f) && fs.existsSync(f as string));
  const byName = new Map<string, AdapterMcp>();
  for (const file of files) {
    for (const [name, entry] of serversIn(file)) {
      const prev = byName.get(name);
      const transport = transportOf(entry) ?? prev?.transport ?? null;
      // Later files override field by field; a `disabled` flag alone (the adapter's own toggle) keeps the transport.
      byName.set(name, { name, file: transportOf(entry) ? file : (prev?.file ?? file), transport, enabled: entry.disabled === true ? false : entry.disabled === false ? true : (prev?.enabled ?? true) });
    }
  }
  return [...byName.values()].filter((m) => !known.has(m.name) && m.transport);
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
  // MCP rows come straight from mcp.json, so they are on screen before `pi list` (seconds) and long
  // before `pi mcp list` (connects every server) answers; both CLI calls run side by side.
  const inv: Inventory = { packages: [], extensions: looseExtensions(cwd), mcp: configuredMcp(cwd), mcpError: null, mcpErrors: [], mcpNote: null, mcpAdapter: [], updates: 0, checkedAt, mcpReady: false, packagesReady: false, versionsChecked: false };
  inv.mcpAdapter = adapterMcp(cwd, new Set(inv.mcp.map((m) => m.name)));
  const countUpdates = () => inv.packages.filter((p) => p.update).length + inv.mcp.filter((m) => m.version.update).length;
  const snapshot = () => {
    inv.updates = countUpdates();
    emit?.(structuredClone(inv));
  };
  snapshot();
  const mcpListing = cli(cliPath, { op: "mcp.list", cwd: cwd ?? undefined });
  mcpListing.catch(() => {});
  const list = await cli(cliPath, { op: "pkg.list", cwd: cwd ?? undefined });
  const rows = Array.isArray(list.data) ? (list.data as { scope: "user" | "project"; source: string; path: string | null }[]) : [];
  // 停用 lives in settings, not in `pi list`: read both scopes once and hang the state on the rows, so
  // the row knows whether the package loads at all (#469).
  const settings = await packageSettings(cliPath, cwd);
  const userList = settings.global?.packages;
  const projectList = settings.project?.packages;
  const entryOf = (scope: "user" | "project", source: string) => {
    const holder = scope === "project" ? projectList : userList;
    const index = findEntry(holder, source);
    return index === -1 ? null : (holder as unknown[])[index];
  };
  const marked = rows.map((r) => {
    const disabled = disabledEntry(entryOf(r.scope, r.source));
    // The other scope can keep it loading (see `loadedByList`). `pi list` collapses a project entry
    // into the user row, so this flag is the only place that distinction can show on screen.
    const other = r.scope === "project" ? userList : projectList;
    return { ...r, disabled, alsoEnabled: disabled && loadedByList(other, r.source) };
  });
  inv.packages = await inspectPackages(marked, false);
  inv.packagesReady = true;
  snapshot();

  // What each server runs, kept for the version stage (the mcp stage itself stays off the network).
  const commands = new Map<string, { command?: string; args?: string[] }>();
  const mcpStage = (async () => {
    const mcpList = await mcpListing;
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
        // What the user wrote (`npx -y …`), not the resolved `node.exe …\_npx\…` path pi prints: it is
        // what the row showed while connecting, and the one they recognise.
        transport: transportOf((entry as Record<string, unknown> | null) ?? undefined) ?? s.transport ?? null,
        state: s.state ?? null,
        tools: Array.isArray(s.tools) ? s.tools.map(String) : [],
        error: s.error ? String(s.error) : null,
        // A pinned version is known without asking npm / PyPI; the version stage fills in `latest`.
        version: { ...mcpPackageOf(entry?.command as string | undefined, entry?.args as string[] | undefined), latest: null, update: false },
      } satisfies InstalledMcp;
    });
    inv.mcpError = mcpList.data ? null : mcpList.output.trim().slice(-500) || null;
    if (!mcpList.data) {
      // pi did not answer: keep the rows from mcp.json (it says what is configured), just stop claiming
      // they are connecting.
      inv.mcp = configuredMcp(cwd).map((m) => ({ ...m, state: m.enabled ? null : "disabled" }));
    }
    inv.mcpAdapter = adapterMcp(cwd, new Set(inv.mcp.map((m) => m.name)));
    inv.mcpReady = true;
    snapshot();
  })().catch((err: any) => {
    inv.mcpError = String(err?.message ?? err);
    inv.mcp = inv.mcp.map((m) => (m.state === "connecting" ? { ...m, state: null } : m));
    inv.mcpReady = true;
    snapshot();
  });

  const versionStage = (async () => {
    if (!check) return;
    // Package versions do not depend on the MCP rows, and `pi mcp list` connects to every server
    // (minutes, 180 s timeout): start the packages first so the wait below does not serialize them.
    const pkgStage = inspectPackages(marked, true)
      .catch(() => inv.packages)
      .then((packages) => {
        // On screen as soon as npm answers: the packages do not wait for `pi mcp list` below.
        inv.packages = packages;
        inv.packagesChecked = true;
        snapshot();
        return packages;
      });
    // The MCP rows carry the versions: without this wait they are read while `inv.mcp` is still [] on
    // any machine where `pi list` beats `pi mcp list` (a fresh agent dir: always), and the pin versions
    // are silently never checked. The stage itself never rejects (it catches into `mcpError`).
    await mcpStage;
    inv.packages = await pkgStage;
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

/**
 * 顶栏 9 颗、输入框下沿 5 颗（#281 / #288 / D321 加了文件搜索）。写进 `ui.json` 的是这些稳定 id，不是文案。
 * 页面那份「哪颗该画」的纯函数在 `web/src/chrome.ts`，两边白名单要一致。
 */
export const CHROME_IDS = ["artifacts", "terminal", "files", "notes", "peer", "scratch", "jira", "mail", "filesearch", "skills", "context", "ext", "attach", "model"] as const;
export type ChromeId = (typeof CHROME_IDS)[number];
/** 三态：键缺失 = 默认行为，false = 隐藏，true = 显式显示（窄屏也显示）。 */
export type ChromeState = Partial<Record<ChromeId, boolean>>;

export interface UiPrefs {
  /** The 扩展 button under the composer (D81): on unless turned off in settings. */
  showExtButton: boolean;
  /** #288：按钮可见性。`showExtButton` 是它的派生值（`chrome.ext !== false`），不落盘。 */
  chrome: ChromeState;
}

/** `ui.set` 的一份补丁：只认白名单 id；`null` / `undefined` 表示删键（回到默认行为）。 */
export interface UiPatch {
  chrome?: Record<string, unknown>;
  showExtButton?: boolean;
}

/** 文件里那份 `chrome` 只留白名单里的布尔值，脏数据不进内存。 */
function pickChrome(value: unknown): ChromeState {
  const out: ChromeState = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const id of CHROME_IDS) {
    const choice = (value as Record<string, unknown>)[id];
    if (typeof choice === "boolean") out[id] = choice;
  }
  return out;
}

export function readUiPrefs(): UiPrefs {
  const raw = readJson<Record<string, unknown>>(statePath("ui.json"), {});
  // 旧文件（只有 showExtButton）迁移一次：关掉的扩展按钮变成 chrome.ext = false。
  // 新字典一旦出现（哪怕是 `{}`），旧字段就完全不再是数据源。
  const chrome = Object.prototype.hasOwnProperty.call(raw, "chrome")
    ? pickChrome(raw.chrome)
    : raw.showExtButton === false
      ? { ext: false }
      : {};
  return { showExtButton: chrome.ext !== false, chrome };
}

/**
 * 读-合并-整份写。只写 `chrome`：`showExtButton` 是派生值，落盘会让旧值像僵尸一样被读回来。
 */
export function writeUiPrefs(patch: UiPatch): UiPrefs {
  const chrome: ChromeState = { ...readUiPrefs().chrome };
  if (typeof patch.showExtButton === "boolean") chrome.ext = patch.showExtButton;
  if (patch.chrome) {
    for (const id of CHROME_IDS) {
      if (!Object.prototype.hasOwnProperty.call(patch.chrome, id)) continue;
      const choice = patch.chrome[id];
      if (choice === undefined || choice === null) delete chrome[id];
      else if (typeof choice === "boolean") chrome[id] = choice;
    }
  }
  writeJson(statePath("ui.json"), { chrome });
  return { showExtButton: chrome.ext !== false, chrome };
}
