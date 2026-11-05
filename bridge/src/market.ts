/**
 * The 扩展 manager's data (see docs/DECISIONS.md D81): what is installed, what is newer, and the two
 * stores — pi packages on npm (keyword `pi-package`, the same set as the pi.dev gallery, ranked by
 * monthly downloads) and the official MCP Registry (ranked by the GitHub stars of each entry's repo).
 *
 * Network goes through pi's `httpProxy` setting, then HTTPS_PROXY / HTTP_PROXY, like pi itself.
 * Nothing here installs anything: installs, removals and updates run through pi's own CLI
 * (picli.ts); enable / disable edit pi's settings.json (pisettings.ts) or the server's mcp.json.
 */
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { agentDir, ensureDir, readJson, statePath, writeJson } from "./paths.ts";

// ------------------------------------------------------------------ HTTP (proxy aware)

function proxyUrl(): URL | null {
  const fromSettings = readJson<{ httpProxy?: unknown }>(path.join(agentDir(), "settings.json"), {}).httpProxy;
  const raw = (typeof fromSettings === "string" && fromSettings) || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  try {
    return raw ? new URL(raw) : null;
  } catch {
    return null;
  }
}

/** One HTTPS request, tunnelled through the proxy with CONNECT when there is one. */
export function requestRaw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<{ status: number; body: Buffer }> {
  const target = new URL(url);
  const proxy = proxyUrl();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const headers: Record<string, string> = { "user-agent": "pi-web-client", accept: "application/json", ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-length"] = String(Buffer.byteLength(opts.body));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`请求超时：${target.host}`)), timeoutMs);
    const done = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
      });
      res.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    };
    const fail = (e: Error) => {
      clearTimeout(timer);
      reject(e);
    };
    const send = (socket?: import("node:net").Socket) => {
      const req = https.request(
        { host: target.hostname, port: target.port || 443, path: `${target.pathname}${target.search}`, method: opts.method ?? "GET", headers, ...(socket ? { socket, agent: false, servername: target.hostname } : {}) },
        done,
      );
      req.on("error", fail);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    };
    if (!proxy) return send();
    const auth = proxy.username ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } : {};
    const connect = http.request({ host: proxy.hostname, port: proxy.port || 80, method: "CONNECT", path: `${target.hostname}:${target.port || 443}`, headers: { host: `${target.hostname}:${target.port || 443}`, ...auth } });
    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return fail(new Error(`代理拒绝连接 ${target.host}（${res.statusCode}）`));
      send(socket);
    });
    connect.on("error", fail);
    connect.end();
  });
}

/** The same request, as text (JSON, markdown, SKILL.md …). */
export async function request(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<{ status: number; text: string }> {
  const res = await requestRaw(url, opts);
  return { status: res.status, text: res.body.toString("utf8") };
}

async function getJson<T = any>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await request(url, { headers });
  if (res.status < 200 || res.status >= 300) throw new Error(`${new URL(url).host} 返回 ${res.status}`);
  return JSON.parse(res.text) as T;
}

/** A JSON GET for other modules (the 技能商店 resolves repos the same proxy-aware way). */
export async function fetchJson<T = any>(url: string, headers?: Record<string, string>): Promise<T> {
  return getJson<T>(url, headers);
}

// ------------------------------------------------------------------ small caches

const memo = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn().catch((err) => {
    memo.delete(key);
    throw err;
  });
  memo.set(key, { at: Date.now(), value });
  return value;
}

export function npmLatest(name: string): Promise<string | null> {
  return cached(`npm:${name}`, 30 * 60_000, async () => {
    const data = await getJson<{ version?: string }>(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`);
    return data.version ?? null;
  });
}

export function pypiLatest(name: string): Promise<string | null> {
  return cached(`pypi:${name}`, 30 * 60_000, async () => {
    const data = await getJson<{ info?: { version?: string } }>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    return data.info?.version ?? null;
  });
}

/** Numeric-aware a > b for x.y.z(-pre). Unknown shapes compare as strings. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x > y;
    return String(x) > String(y);
  }
  return false;
}

// ------------------------------------------------------------------ installed inventory

export interface InstalledPackage {
  kind: "package";
  scope: "user" | "project";
  source: string;
  path: string | null;
  name: string | null;
  version: string | null;
  /** npm: npm name; git: repo URL; local: null. */
  origin: "npm" | "git" | "local";
  pinned: boolean;
  latest: string | null;
  update: boolean;
  checkError?: string;
}

export interface InstalledExtension {
  kind: "extension";
  /** builtin:mcp … or an absolute path. */
  id: string;
  label: string;
  scope: "user" | "project" | "builtin";
  /** Discovered in an extensions/ folder, or listed in settings, or built in. */
  how: "builtin" | "discovered" | "listed";
  enabled: boolean;
}

export const BUILTINS = [
  { id: "builtin:mcp", label: "MCP 支持" },
  { id: "builtin:codemode", label: "codemode（脚本里调工具）" },
  { id: "builtin:tool-search", label: "tool_search（按需加载工具）" },
  { id: "builtin:llama.cpp", label: "llama.cpp 路由（/llama）" },
];

function settingsList(file: string, key: "extensions"): string[] {
  const v = readJson<Record<string, unknown>>(file, {})[key];
  return Array.isArray(v) ? v.map(String) : [];
}

function listDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || /\.(ts|js|mjs|cjs)$/.test(d.name))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/**
 * Extensions that are not part of a package: pi's built-ins, files / folders under
 * `<agentDir>/extensions` and `<cwd>/.pi/extensions`, and paths listed in settings `extensions`.
 * A `-<entry>` in settings means disabled (pi's exact-exclusion syntax).
 */
export function looseExtensions(cwd: string | null): InstalledExtension[] {
  const out: InstalledExtension[] = [];
  const scopes: { scope: "user" | "project"; settings: string; base: string; dir: string }[] = [{ scope: "user", settings: path.join(agentDir(), "settings.json"), base: agentDir(), dir: path.join(agentDir(), "extensions") }];
  if (cwd) scopes.push({ scope: "project", settings: path.join(cwd, ".pi", "settings.json"), base: path.join(cwd, ".pi"), dir: path.join(cwd, ".pi", "extensions") });
  const globalList = settingsList(scopes[0].settings, "extensions");
  const projectList = cwd ? settingsList(scopes[1].settings, "extensions") : [];
  for (const b of BUILTINS) {
    const off = [...globalList, ...projectList].includes(`-${b.id}`) && !projectList.includes(`+${b.id}`);
    out.push({ kind: "extension", id: b.id, label: b.label, scope: "builtin", how: "builtin", enabled: !off });
  }
  for (const s of scopes) {
    const list = settingsList(s.settings, "extensions");
    const resolve = (p: string) => path.resolve(s.base, p.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || "~"));
    const disabled = new Set(list.filter((e) => e.startsWith("-") && !e.startsWith("-builtin:")).map((e) => resolve(e.slice(1))));
    const seen = new Set<string>();
    for (const file of listDir(s.dir)) {
      seen.add(file);
      out.push({ kind: "extension", id: file, label: path.basename(file), scope: s.scope, how: "discovered", enabled: !disabled.has(file) });
    }
    for (const e of list) {
      if (e.startsWith("builtin:") || e.startsWith("-builtin:") || e.startsWith("+builtin:") || e.startsWith("!")) continue;
      const plain = e.replace(/^[+-]/, "");
      if (/^(npm:|git:|https?:)/.test(plain)) continue;
      const abs = resolve(plain);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ kind: "extension", id: abs, label: path.basename(abs), scope: s.scope, how: "listed", enabled: !e.startsWith("-") });
    }
  }
  return out;
}

function parseSource(source: string): { origin: "npm" | "git" | "local"; name: string | null; pinned: boolean; url: string | null; ref: string | null } {
  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    const at = spec.lastIndexOf("@");
    const name = at > 0 ? spec.slice(0, at) : spec;
    return { origin: "npm", name, pinned: at > 0, url: null, ref: null };
  }
  const git = /^(?:git:|https?:\/\/|ssh:\/\/)(.+?)(?:@([\w./-]+))?$/.exec(source);
  if (git && !/^[A-Za-z]:\\/.test(source)) {
    const raw = source.startsWith("git:") ? source.slice(4) : source;
    const ref = /@([\w./-]+)$/.test(raw) && !raw.startsWith("git@") ? raw.slice(raw.lastIndexOf("@") + 1) : null;
    const repo = ref ? raw.slice(0, raw.lastIndexOf("@")) : raw;
    const url = /^(https?|ssh):\/\//.test(repo) || repo.startsWith("git@") ? repo : `https://${repo}`;
    return { origin: "git", name: repo, pinned: Boolean(ref), url, ref };
  }
  return { origin: "local", name: null, pinned: true, url: null, ref: null };
}

function gitHead(dir: string): Promise<string | null> {
  return new Promise((resolve) => execFile("git", ["-C", dir, "rev-parse", "HEAD"], { windowsHide: true, timeout: 10_000 }, (err, out) => resolve(err ? null : String(out).trim() || null)));
}
function gitRemoteHead(url: string): Promise<string | null> {
  return new Promise((resolve) => execFile("git", ["ls-remote", url, "HEAD"], { windowsHide: true, timeout: 20_000 }, (err, out) => resolve(err ? null : String(out).split(/\s/)[0] || null)));
}

/** `pi list` rows → installed packages with versions and, unless `offline`, whether a newer one exists. */
export async function inspectPackages(rows: { scope: "user" | "project"; source: string; path: string | null }[], check: boolean): Promise<InstalledPackage[]> {
  return Promise.all(
    rows.map(async (r) => {
      const src = parseSource(r.source);
      const pkg = r.path ? readJson<{ name?: string; version?: string }>(path.join(r.path, "package.json"), {}) : {};
      const item: InstalledPackage = {
        kind: "package",
        scope: r.scope,
        source: r.source,
        path: r.path,
        name: pkg.name ?? src.name,
        version: pkg.version ?? null,
        origin: src.origin,
        pinned: src.pinned,
        latest: null,
        update: false,
      };
      if (!check || src.pinned) return item;
      try {
        if (src.origin === "npm" && item.name) {
          item.latest = await npmLatest(item.name);
          item.update = Boolean(item.latest && item.version && newer(item.latest, item.version));
        } else if (src.origin === "git" && src.url && r.path) {
          const [local, remote] = await Promise.all([gitHead(r.path), gitRemoteHead(src.url)]);
          if (local && remote) {
            item.version = item.version ? `${item.version} (${local.slice(0, 7)})` : local.slice(0, 7);
            item.latest = remote.slice(0, 7);
            item.update = local !== remote;
          }
        }
      } catch (err) {
        item.checkError = (err as Error).message;
      }
      return item;
    }),
  );
}

// ------------------------------------------------------------------ MCP servers from mcp.json

export interface McpVersionInfo {
  /** npm / pypi / oci and the package as written in mcp.json. */
  registry: "npm" | "pypi" | "oci" | null;
  identifier: string | null;
  version: string | null;
  latest: string | null;
  update: boolean;
}

/** From a server's command + args, which package (and pinned version) it runs. */
export function mcpPackageOf(command: string | undefined, args: string[] | undefined): Omit<McpVersionInfo, "latest" | "update"> {
  const base = path.basename(String(command ?? "")).replace(/\.(cmd|exe)$/i, "").toLowerCase();
  const a = (args ?? []).map(String);
  if (base === "npx") {
    const spec = a.find((x) => !x.startsWith("-"));
    if (!spec) return { registry: "npm", identifier: null, version: null };
    const at = spec.lastIndexOf("@");
    return at > 0 ? { registry: "npm", identifier: spec.slice(0, at), version: spec.slice(at + 1) } : { registry: "npm", identifier: spec, version: null };
  }
  if (base === "uvx") {
    const spec = a.find((x) => !x.startsWith("-"));
    if (!spec) return { registry: "pypi", identifier: null, version: null };
    const m = /^([\w.-]+)(?:==([\w.]+))?$/.exec(spec);
    return { registry: "pypi", identifier: m ? m[1] : spec, version: m?.[2] ?? null };
  }
  if (base === "docker") {
    const img = [...a].reverse().find((x, i, arr) => !x.startsWith("-") && !(arr[i + 1] ?? "").match(/^-(e|v|p|-env|-name)$/));
    if (!img) return { registry: "oci", identifier: null, version: null };
    const colon = img.lastIndexOf(":");
    return colon > img.lastIndexOf("/") ? { registry: "oci", identifier: img.slice(0, colon), version: img.slice(colon + 1) } : { registry: "oci", identifier: img, version: null };
  }
  return { registry: null, identifier: null, version: null };
}

/** Pinned npm / PyPI servers: is there a newer release? (OCI tags and unpinned specs are not checked.) */
export async function mcpVersion(command: string | undefined, args: string[] | undefined, check: boolean): Promise<McpVersionInfo> {
  const p = mcpPackageOf(command, args);
  const info: McpVersionInfo = { ...p, latest: null, update: false };
  if (!check || !p.identifier || !p.version || p.version === "latest") return info;
  try {
    if (p.registry === "npm") info.latest = await npmLatest(p.identifier);
    else if (p.registry === "pypi") info.latest = await pypiLatest(p.identifier);
    info.update = Boolean(info.latest && newer(info.latest, p.version));
  } catch {
    /* no answer: no update shown */
  }
  return info;
}

/** Read one server's raw entry from the mcp.json pi reported as its source. */
export function mcpEntry(file: string, name: string): Record<string, unknown> | null {
  const data = readJson<{ mcpServers?: Record<string, Record<string, unknown>> }>(file, {});
  return data.mcpServers?.[name] ?? null;
}

/** Edit one server in its mcp.json (enable / disable, version bump); everything else is kept. */
export function editMcpEntry(file: string, name: string, edit: (entry: Record<string, unknown>) => void): void {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}";
  const data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as { mcpServers?: Record<string, Record<string, unknown>> };
  const entry = data.mcpServers?.[name];
  if (!entry) throw new Error(`${file} 里没有 ${name}`);
  edit(entry);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ extension store (npm)

export interface StorePackage {
  name: string;
  version: string;
  description: string;
  monthly: number;
  weekly: number;
  link: string;
  publisher: string | null;
}

function toStore(o: any): StorePackage {
  const p = o.package ?? {};
  return {
    name: String(p.name),
    version: String(p.version ?? ""),
    description: String(p.description ?? ""),
    monthly: Number(o.downloads?.monthly ?? 0),
    weekly: Number(o.downloads?.weekly ?? 0),
    link: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
    publisher: p.publisher?.username ?? null,
  };
}

/** Ranked by monthly downloads. Without a query: the top of everything with `pi-package`. */
export function searchPackages(query: string, limit: number): Promise<StorePackage[]> {
  const q = query.trim();
  return cached(`store:${q}`, 10 * 60_000, async () => {
    const text = encodeURIComponent(`keywords:pi-package${q ? ` ${q}` : ""}`);
    // Ask npm to weigh popularity so the 250 it returns are the popular ones, then rank by downloads.
    const data = await getJson<{ objects?: any[] }>(`https://registry.npmjs.org/-/v1/search?text=${text}&size=250&popularity=1.0&quality=0.0&maintenance=0.0`);
    return (data.objects ?? []).map(toStore).sort((a, b) => b.monthly - a.monthly);
  }).then((list) => list.slice(0, limit));
}

// ------------------------------------------------------------------ MCP store (official registry)

export interface McpField {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  default: string | null;
  /** Header value template ("Bearer {token}"), when the registry gives one. */
  template?: string | null;
}

export interface McpInstallOption {
  kind: "npm" | "pypi" | "oci" | "remote";
  label: string;
  identifier: string;
  version: string | null;
  /** remote */
  url?: string;
  transport: string;
  env: McpField[];
  headers: McpField[];
  args: string[];
  /** npx / uvx / docker missing on this machine, or a transport pi does not speak. */
  unavailable?: string;
}

export interface StoreMcp {
  name: string;
  title: string;
  description: string;
  version: string;
  repo: string | null;
  stars: number;
  options: McpInstallOption[];
}

const INDEX_FILE = () => statePath("market", "mcp-index.json");
const INDEX_TTL = 24 * 3600_000;

function argValues(list: any[] | undefined): string[] {
  const out: string[] = [];
  for (const a of list ?? []) {
    const v = a?.value ?? a?.default ?? null;
    if (a?.type === "named" && a?.name) {
      out.push(String(a.name));
      if (v !== null && v !== undefined) out.push(String(v));
    } else if (v !== null && v !== undefined) out.push(String(v));
  }
  return out;
}

function fields(list: any[] | undefined): McpField[] {
  return (list ?? [])
    .filter((f) => f?.name)
    .map((f) => ({ name: String(f.name), description: String(f.description ?? ""), required: Boolean(f.isRequired), secret: Boolean(f.isSecret), default: f.default ?? null, template: typeof f.value === "string" ? f.value : null }));
}

function normalize(entry: any): StoreMcp | null {
  const s = entry?.server;
  const meta = entry?._meta?.["io.modelcontextprotocol.registry/official"];
  if (!s?.name || (meta && (meta.status !== "active" || meta.isLatest === false))) return null;
  const options: McpInstallOption[] = [];
  for (const p of s.packages ?? []) {
    const kind = p.registryType === "npm" ? "npm" : p.registryType === "pypi" ? "pypi" : p.registryType === "oci" ? "oci" : null;
    if (!kind || !p.identifier) continue;
    if (p.transport?.type && p.transport.type !== "stdio") continue;
    options.push({
      kind,
      label: kind === "npm" ? "npx（npm 包）" : kind === "pypi" ? "uvx（PyPI 包）" : "Docker 镜像",
      identifier: String(p.identifier),
      version: p.version ? String(p.version) : null,
      transport: "stdio",
      env: fields(p.environmentVariables),
      headers: [],
      args: [...argValues(p.runtimeArguments), "\u0000", ...argValues(p.packageArguments)],
    });
  }
  for (const r of s.remotes ?? []) {
    if (!r?.url) continue;
    options.push({
      kind: "remote",
      label: r.type === "sse" ? "远程（SSE）" : "远程 HTTP",
      identifier: String(r.url),
      version: null,
      url: String(r.url),
      transport: String(r.type ?? "streamable-http"),
      env: [],
      headers: fields(r.headers),
      args: [],
      ...(r.type === "sse" ? { unavailable: "pi 不支持旧的 SSE 传输" } : {}),
    });
  }
  if (!options.length) return null;
  const repo = typeof s.repository?.url === "string" && /github\.com\//.test(s.repository.url) ? s.repository.url.replace(/\.git$/, "") : null;
  return { name: String(s.name), title: String(s.title ?? s.name.split("/").pop()), description: String(s.description ?? ""), version: String(s.version ?? ""), repo, stars: 0, options };
}

let building: Promise<{ at: number; items: StoreMcp[]; starsComplete: boolean }> | null = null;

/** Every active latest registry entry, with GitHub stars; rebuilt once a day in the background. */
export function mcpIndex(force = false): Promise<{ at: number; items: StoreMcp[]; starsComplete: boolean; building?: boolean }> {
  const disk = readJson<{ at?: number; items?: StoreMcp[]; starsComplete?: boolean } | null>(INDEX_FILE(), null);
  const fresh = disk?.at && Date.now() - disk.at < INDEX_TTL && Array.isArray(disk.items);
  if (fresh && !force) return Promise.resolve({ at: disk!.at!, items: disk!.items!, starsComplete: Boolean(disk!.starsComplete) });
  if (!building) {
    building = buildIndex()
      .then((idx) => {
        ensureDir(path.dirname(INDEX_FILE()));
        writeJson(INDEX_FILE(), idx);
        return idx;
      })
      .finally(() => {
        building = null;
      });
  }
  // A stale index is still useful while the new one builds.
  if (disk?.items && !force) return Promise.resolve({ at: disk.at ?? 0, items: disk.items, starsComplete: Boolean(disk.starsComplete), building: true });
  return building;
}

async function buildIndex(): Promise<{ at: number; items: StoreMcp[]; starsComplete: boolean }> {
  const items = new Map<string, StoreMcp>();
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const url = `https://registry.modelcontextprotocol.io/v0/servers?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data: any = await getJson(url);
    for (const e of data.servers ?? []) {
      const n = normalize(e);
      if (n) items.set(n.name, n);
    }
    cursor = data.metadata?.nextCursor ?? null;
    if (!cursor || !(data.servers ?? []).length) break;
  }
  const list = [...items.values()];
  const starsComplete = await fillStars(list);
  return { at: Date.now(), items: list, starsComplete };
}

/** A GitHub token when the machine has one (env or `gh auth token`); null = anonymous (60/h). */
export function ghToken(): string | null {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)!;
  try {
    const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

/** Stars per repo: GraphQL in batches with a token, else anonymous REST for as many as allowed. */
async function fillStars(list: StoreMcp[]): Promise<boolean> {
  const repos = [...new Set(list.map((x) => x.repo).filter((x): x is string => Boolean(x)))];
  const stars = new Map<string, number>();
  const key = (url: string) => {
    const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(url);
    return m ? { owner: m[1], name: m[2].replace(/\.git$/, "") } : null;
  };
  const token = ghToken();
  let complete = true;
  if (token) {
    for (let i = 0; i < repos.length; i += 80) {
      const batch = repos.slice(i, i + 80).map(key);
      const parts = batch.map((r, j) => (r ? `r${j}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) { stargazerCount }` : "")).filter(Boolean);
      try {
        const res = await request("https://api.github.com/graphql", { method: "POST", headers: { authorization: `bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query: `{ ${parts.join("\n")} }` }), timeoutMs: 30_000 });
        const data = JSON.parse(res.text)?.data ?? {};
        batch.forEach((_, j) => {
          const n = data[`r${j}`]?.stargazerCount;
          if (typeof n === "number") stars.set(repos[i + j], n);
        });
      } catch {
        complete = false;
      }
    }
  } else {
    complete = false;
    // Anonymous: 60 requests an hour. Spend at most 50 of them.
    for (const url of repos.slice(0, 50)) {
      const r = key(url);
      if (!r) continue;
      try {
        const data = await getJson<{ stargazers_count?: number }>(`https://api.github.com/repos/${r.owner}/${r.name}`);
        if (typeof data.stargazers_count === "number") stars.set(url, data.stargazers_count);
      } catch {
        break; // rate limited
      }
    }
  }
  for (const item of list) item.stars = item.repo ? (stars.get(item.repo) ?? 0) : 0;
  return complete;
}

/** Which runners exist here: npx, uvx, docker. */
export function runners(): Promise<{ npx: boolean; uvx: boolean; docker: boolean }> {
  const has = (cmd: string) => {
    try {
      const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { windowsHide: true, timeout: 5000 });
      return r.status === 0;
    } catch {
      return false;
    }
  };
  return cached("runners", 10 * 60_000, async () => ({ npx: has("npx"), uvx: has("uvx"), docker: has("docker") }));
}

/** Registry search without the index (first run, while the index is being built): no stars. */
async function liveSearch(query: string, limit: number): Promise<StoreMcp[]> {
  const data: any = await getJson(`https://registry.modelcontextprotocol.io/v0/servers?limit=100${query.trim() ? `&search=${encodeURIComponent(query.trim())}` : ""}`);
  return (data.servers ?? []).map(normalize).filter((x: StoreMcp | null): x is StoreMcp => Boolean(x)).slice(0, limit);
}

export async function searchMcp(query: string, limit: number): Promise<{ items: StoreMcp[]; at: number; starsComplete: boolean; building: boolean; hasToken: boolean }> {
  const disk = readJson<{ at?: number } | null>(INDEX_FILE(), null);
  let items: StoreMcp[];
  let at = 0;
  let starsComplete = false;
  let isBuilding = false;
  if (!disk?.at) {
    // First run: building the ranked index takes a couple of minutes — answer from the registry now.
    void mcpIndex().catch(() => {});
    items = await liveSearch(query, limit);
    isBuilding = true;
  } else {
    const idx = await mcpIndex();
    const q = query.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    // The namespace (io.github.someone/…) would make "github" match half the registry: match the short name.
    const hit = (m: StoreMcp) => terms.every((t) => (m.name.split("/").pop() ?? "").toLowerCase().includes(t) || m.title.toLowerCase().includes(t) || m.description.toLowerCase().includes(t));
    items = (q ? idx.items.filter(hit) : idx.items).slice().sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name)).slice(0, limit);
    at = idx.at;
    starsComplete = idx.starsComplete;
    isBuilding = Boolean(idx.building);
  }
  const run = await runners();
  const marked = items.map((m) => ({
    ...m,
    options: m.options.map((o) =>
      o.unavailable
        ? o
        : o.kind === "pypi" && !run.uvx
          ? { ...o, unavailable: "需要先安装 uv（uvx）：https://docs.astral.sh/uv/getting-started/installation/" }
          : o.kind === "oci" && !run.docker
            ? { ...o, unavailable: "需要先安装 Docker：https://docs.docker.com/get-docker/" }
            : o.kind === "npm" && !run.npx
              ? { ...o, unavailable: "需要 npx（随 Node.js 安装）" }
              : o,
    ),
  }));
  return { items: marked, at, starsComplete, building: isBuilding, hasToken: Boolean(ghToken()) };
}

/**
 * Turn a store pick + the user's form into a `pi mcp add` request (picli.ts). Secret values are
 * never written: they become `${VAR}` references the user sets in their environment (D81).
 */
export function mcpAddRequest(opt: McpInstallOption, form: { name: string; values: Record<string, string>; local?: boolean; exposure?: string; description?: string }): { req: Record<string, unknown>; vars: string[] } {
  const vars: string[] = [];
  const upper = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  const env: string[] = [];
  for (const f of opt.env) {
    const v = form.values[`env:${f.name}`];
    if (f.secret) {
      vars.push(f.name);
      env.push(`${f.name}=\${${f.name}}`);
    } else if (v && v.trim()) env.push(`${f.name}=${v.trim()}`);
    else if (f.required) throw new Error(`缺少必填项 ${f.name}`);
  }
  const headers: string[] = [];
  for (const h of opt.headers) {
    const v = form.values[`header:${h.name}`];
    if (h.secret) {
      const name = upper(`${form.name}_${h.name}`);
      vars.push(name);
      // "Bearer {token}" keeps its shape; a bare secret header becomes the whole variable.
      const value = h.template && /\{[^}]+\}/.test(h.template) ? h.template.replace(/\{[^}]+\}/g, `\${${name}}`) : `\${${name}}`;
      headers.push(`${h.name}=${value}`);
    } else if (v && v.trim()) headers.push(`${h.name}=${v.trim()}`);
    else if (h.template && !/\{[^}]+\}/.test(h.template)) headers.push(`${h.name}=${h.template}`);
    else if (h.required) throw new Error(`缺少必填项 ${h.name}`);
  }
  const base = { op: "mcp.add", name: form.name, local: form.local === true, exposure: form.exposure || undefined, description: form.description || undefined, env, headers };
  const sep = opt.args.indexOf("\u0000");
  const runtimeArgs = sep >= 0 ? opt.args.slice(0, sep) : [];
  const packageArgs = sep >= 0 ? opt.args.slice(sep + 1) : opt.args;
  if (opt.kind === "remote") return { req: { ...base, url: opt.url }, vars };
  if (opt.kind === "npm") return { req: { ...base, command: "npx", args: ["-y", ...runtimeArgs, opt.version ? `${opt.identifier}@${opt.version}` : opt.identifier, ...packageArgs] }, vars };
  if (opt.kind === "pypi") return { req: { ...base, command: "uvx", args: [...runtimeArgs, opt.version ? `${opt.identifier}==${opt.version}` : opt.identifier, ...packageArgs] }, vars };
  const envFlags = opt.env.flatMap((f) => (f.secret || form.values[`env:${f.name}`]?.trim() ? ["-e", f.name] : []));
  return { req: { ...base, command: "docker", args: ["run", "-i", "--rm", ...envFlags, ...runtimeArgs, opt.version ? `${opt.identifier}:${opt.version}` : opt.identifier, ...packageArgs] }, vars };
}
