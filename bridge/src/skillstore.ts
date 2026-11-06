/**
 * 技能商店 (D126): search skills.sh, resolve where a skill lives inside its GitHub repo, install by
 * downloading exactly that folder, and uninstall only from the user's own skill roots.
 *
 * Sources, and why:
 * - **Search** — skills.sh's public JSON API (`/api/search?q=`), the directory the `npx skills` CLI
 *   publishes to. It ranks by anonymous install counts, so the list is a real popularity signal.
 *   It returns no description, so we read the skill's own `SKILL.md`.
 * - **Repo tree** — jsDelivr's `data.jsdelivr.com` tree for GitHub (`@HEAD`, no token). GitHub's own
 *   API answers 60 requests an hour anonymously; a search over a dozen repos would eat that.
 * - **Files** — `raw.githubusercontent.com/<repo>/HEAD/<path>`, binary-safe; when that host is
 *   unreachable (reset, not 404) the same file comes from jsDelivr's GitHub mirrors (D156).
 * - **Install** — a plain directory under `skillRoots()`: `<agentDir>/skills` (global) or
 *   `<cwd>/.pi/skills` (project). Nothing is registered anywhere else; pi discovers it by scan.
 * - **Uninstall** — project skills belong to a repository and stay read-only here; user skills are
 *   deleted, and a junction is unlinked rather than followed (`userSkillRootOf`).
 */
import fs from "node:fs";
import path from "node:path";
import { fetchJson, ghToken, requestRaw } from "./market.ts";
import { agentDir, ensureDir, readJson, statePath, writeJson } from "./paths.ts";
import { frontmatter, scanSkillEntries, userSkillRootOf, type SkillEntry } from "./skills.ts";

// ------------------------------------------------------------------ network seam

/** Everything this module asks the network for, behind one interface so tests stay offline. */
export interface SkillNet {
  json: (url: string, headers?: Record<string, string>) => Promise<any>;
  /**
   * One file, binary-safe. `alt` lists other origins serving the same bytes, tried in order when
   * `url` is unreachable; `label` is how the error message names the file (repo-relative path).
   */
  file: (url: string, opts?: { alt?: string[]; label?: string }) => Promise<Buffer>;
}

/** Socket-level failures: "this host is unreachable from here", not "this file is gone". */
const NET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED"]);

function unreachable(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (NET_CODES.has(String(e?.code ?? ""))) return true;
  return /socket hang up|ECONNRESET|EAI_AGAIN|请求超时/.test(String(e?.message ?? ""));
}

/** Files are binaries in general (scripts, fonts, images): never decode as UTF-8. */
async function download(url: string): Promise<Buffer> {
  const res = await requestRaw(url, { timeoutMs: 60_000, headers: { accept: "*/*" } });
  if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`${hostOf(url)} 返回 ${res.status}`), { code: `HTTP_${res.status}` });
  return res.body;
}

/** Everything here builds its own URLs; a malformed one is a bug, not a network condition. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}

/** The last line of a failed download: what the user can actually do about it. */
const FILE_HINT = "（直连 GitHub 被重置的话，在 pi 的设置里填 httpProxy，或给桥设 HTTPS_PROXY 后重启）";

/**
 * Download one file from the first origin that answers (D156).
 *
 * `raw.githubusercontent.com` is reset from some networks while jsDelivr's GitHub mirrors are not —
 * and the store already trusts jsDelivr for the repo tree. A host that fails at the socket is
 * remembered as down for ten minutes, so installing a twelve-file skill probes a blocked host once,
 * not twelve times. A 404 is *not* a reason to try another origin: the file really is missing, and
 * that message is the useful one. The thrown error keeps `code` (`HTTP_404`, `ECONNRESET`…), because
 * `installSkill` tells a missing file from a dead network by it.
 */
export function fileFetcher(fetchOne: (url: string) => Promise<Buffer>, clock: () => number = Date.now): SkillNet["file"] {
  const down = new Map<string, number>();
  const HOST_TTL = 10 * 60_000;
  return async (url, opts = {}) => {
    const label = opts.label ?? pathOf(url);
    const hosts = [url, ...(opts.alt ?? [])];
    const live = hosts.filter((u) => (down.get(hostOf(u)) ?? 0) <= clock());
    // Every host known dead: try them all anyway, the network may be back.
    const failed: string[] = [];
    const fail = (msg: string, code?: string): never => {
      throw Object.assign(new Error(`下载 ${label} 失败：${msg}`), code ? { code } : {});
    };
    for (const u of live.length ? live : hosts) {
      const host = hostOf(u);
      try {
        const buf = await fetchOne(u);
        down.delete(host);
        return buf;
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        if (!unreachable(err)) return fail(msg, (err as { code?: string })?.code);
        down.set(host, clock() + HOST_TTL);
        failed.push(`${host} ${msg}`);
      }
    }
    return fail(`${failed.join("；") || "没有可用的下载地址"}${FILE_HINT}`, "unreachable");
  };
}

export const LIVE_NET: SkillNet = {
  json: (url, headers) => fetchJson(url, headers),
  file: fileFetcher(download),
};

// ------------------------------------------------------------------ disk caches

const repoCacheFile = (): string => statePath("market", "skill-repos.json");
const metaCacheFile = (): string => statePath("market", "skill-meta.json");
const REPO_TTL = 12 * 3600_000;
const META_TTL = 12 * 3600_000;

type RepoCache = Record<string, { at: number; files: [string, number][] }>;
type MetaCache = Record<string, { at: number; name: string; description: string }>;

const inFlight = new Map<string, Promise<unknown>>();

/** One shared promise per key: two rows of the same repo ask jsDelivr once, not twice. */
function shared<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = inFlight.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function writeCache<T>(file: string, data: T): void {
  try {
    ensureDir(path.dirname(file));
    writeJson(file, data);
  } catch {
    /* a read-only state dir only costs a refetch */
  }
}

/** Files of a repo at `HEAD`, as `[path, size]`; cached for half a day. */
export function repoFiles(repo: string, net: SkillNet = LIVE_NET): Promise<[string, number][]> {
  const key = `repo:${repo}`;
  const disk = readJson<RepoCache>(repoCacheFile(), {});
  const hit = disk[key];
  if (hit && Date.now() - hit.at < REPO_TTL && Array.isArray(hit.files)) return Promise.resolve(hit.files);
  return shared(key, async () => {
    const files = await treeOf(repo, net);
    const cache = readJson<RepoCache>(repoCacheFile(), {});
    cache[key] = { at: Date.now(), files };
    writeCache(repoCacheFile(), cache);
    return files;
  });
}

/**
 * jsDelivr's flat tree of a GitHub repo (no token, no GitHub rate limit). Repos too big for it
 * (GitHub's own `/git/trees` says 403 “package size exceeded”) fall back to the GitHub API — one
 * request per such repo, cached like everything else. A token makes that fallback roomy; without
 * one it shares the anonymous 60/h that the rest of the bridge also uses.
 */
async function treeOf(repo: string, net: SkillNet): Promise<[string, number][]> {
  try {
    const data = await net.json(`https://data.jsdelivr.com/v1/packages/gh/${repo}@HEAD?structure=flat`);
    const files = Array.isArray(data?.files) ? data.files : [];
    return files
      .filter((f: any) => typeof f?.name === "string" && !f.name.endsWith("/"))
      .map((f: any) => [String(f.name).replace(/^\/+/, ""), Number(f.size) || 0] as [string, number]);
  } catch (err) {
    try {
      return await githubTree(repo, net);
    } catch (again) {
      // Report the first failure (the usual one) but say the fallback was tried too.
      const first = (err as Error)?.message ?? String(err);
      throw new Error(`${first}（GitHub API 备用通道也不行：${(again as Error)?.message ?? again}）`);
    }
  }
}

/** GitHub's own tree: the live one, and the only one that is not cached by jsDelivr for hours. */
async function githubTree(repo: string, net: SkillNet): Promise<[string, number][]> {
  const token = ghToken();
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const data = await net.json(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, headers);
  const blobs = (Array.isArray(data?.tree) ? data.tree : []).filter((e: any) => e?.type === "blob" && typeof e.path === "string");
  if (!blobs.length) throw new Error("空仓库");
  return blobs.map((e: any) => [String(e.path), Number(e.size) || 0] as [string, number]);
}

/**
 * The tree as GitHub has it *now*, replacing the cached one.
 *
 * jsDelivr caches `@HEAD` for hours, so after an upstream reorganisation its tree can still list
 * files that are gone — an install then 404s on a file the store was told existed. One GitHub request
 * (and the next installs are right again) beats asking the user to clear a cache they cannot see.
 */
async function freshRepoFiles(repo: string, net: SkillNet): Promise<[string, number][]> {
  const files = await githubTree(repo, net);
  const cache = readJson<RepoCache>(repoCacheFile(), {});
  cache[`repo:${repo}`] = { at: Date.now(), files };
  writeCache(repoCacheFile(), cache);
  return files;
}

/** Directories holding a `SKILL.md`, repo-relative (`""` when SKILL.md sits at the root). */
export function skillDirs(files: [string, number][]): string[] {
  const dirs = new Set<string>();
  for (const [file] of files) {
    const m = /^(?:(.*)\/)?SKILL\.md$/.exec(file);
    if (m) dirs.add(m[1] ?? "");
  }
  return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** Which of those directories the store's `skillId` names (`anthropics/skills/pdf` → `skills/pdf`). */
export function pickSkillDir(dirs: string[], key: string): string | null {
  const want = key.replace(/^\/+|\/+$/g, "").trim();
  if (!want || !dirs.length) return null;
  const base = (p: string): string => p.split("/").pop() ?? p;
  // `Skywork Excel` and `skywork-excel` are the same name to a human; skills.sh sometimes keeps the
  // display name in `skillId`.
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const depth = (p: string): number => (p ? p.split("/").length : 0);
  // A repo that keeps parallel copies (`skills/x`, `.claude/skills/x`, `.codex/skills/x`) should give
  // the plain `skills/` one: it is the copy pi itself (and every other client) reads.
  const preferred = (p: string): number => (p.startsWith("skills/") ? 0 : p.startsWith(".claude/skills/") ? 1 : p.startsWith(".codex/skills/") ? 2 : p.startsWith(".agents/skills/") ? 3 : 4);
  const best = (list: string[]): string | null => list.slice().sort((a, b) => depth(a) - depth(b) || preferred(a) - preferred(b) || a.localeCompare(b))[0] ?? null;
  const n = norm(want);
  const exact = dirs.filter((d) => base(d) === want);
  if (exact.length) return best(exact);
  const loose = n ? dirs.filter((d) => norm(base(d)) === n) : [];
  if (loose.length) return best(loose);
  // `excel-mcp` vs `skills/excel-mcp-report-formatting`: only when exactly one folder starts with it.
  const prefix = n ? dirs.filter((d) => norm(base(d)).startsWith(n)) : [];
  if (prefix.length === 1) return prefix[0];
  // A repository that holds a single skill (often right at the root) cannot be ambiguous.
  if (dirs.length === 1) return dirs[0];
  return null;
}

function encodePath(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function fileUrl(repo: string, file: string, ref = "HEAD"): string {
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${encodePath(file)}`;
}

/** jsDelivr's GitHub mirrors, in the order a reset raw.githubusercontent.com falls back to. */
const MIRROR_HOSTS = ["testingcf.jsdelivr.net", "fastly.jsdelivr.net", "gcore.jsdelivr.net"];

/**
 * The same file on jsDelivr's mirrors (D156). Byte-identical to the raw URL — jsDelivr serves the
 * GitHub object it has cached, it does not rewrite anything.
 *
 * jsDelivr spells the ref as one `@<ref>` segment, so a ref carrying a slash (a branch like
 * `feat/x`) has no unambiguous form there: no mirrors, the raw URL is the only candidate.
 */
export function mirrorUrls(repo: string, file: string, ref = "HEAD"): string[] {
  if (ref.includes("/")) return [];
  const path = encodePath(file);
  return MIRROR_HOSTS.map((host) => `https://${host}/gh/${repo}@${encodeURIComponent(ref)}/${path}`);
}

/** The arguments every file download passes: the mirrors, and the file's own repo path as its name. */
function fileFetch(repo: string, file: string, ref = "HEAD"): [string, { alt: string[]; label: string }] {
  return [fileUrl(repo, file, ref), { alt: mirrorUrls(repo, file, ref), label: file }];
}

export interface SkillMeta {
  name: string;
  description: string;
}

/** The skill's own frontmatter: `name`, `description`. Cached per repo + directory. */
export function skillMeta(repo: string, dir: string, net: SkillNet = LIVE_NET): Promise<SkillMeta> {
  const key = `${repo}#${dir}`;
  const disk = readJson<MetaCache>(metaCacheFile(), {});
  const hit = disk[key];
  if (hit && Date.now() - hit.at < META_TTL) return Promise.resolve({ name: hit.name, description: hit.description });
  return shared(`meta:${key}`, async () => {
    const file = dir ? `${dir}/SKILL.md` : "SKILL.md";
    const text = (await net.file(...fileFetch(repo, file))).toString("utf8");
    const fm = frontmatter(text);
    const meta: SkillMeta = { name: fm.name || (dir ? (dir.split("/").pop() ?? dir) : repo) , description: fm.description ?? "" };
    const cache = readJson<MetaCache>(metaCacheFile(), {});
    cache[key] = { at: Date.now(), ...meta };
    writeCache(metaCacheFile(), cache);
    return meta;
  });
}

// ------------------------------------------------------------------ search (skills.sh)

export interface StoreSkill {
  /** `owner/repo/skill-name`, as skills.sh names it. */
  id: string;
  name: string;
  source: string;
  installs: number;
  description: string;
  /** Where it lives in the repo once resolved; null when the repo tree has no match. */
  dir: string | null;
  /** Set by the second stage (`describeStoreSkills`): this row has been checked against its repo. */
  resolved?: boolean;
  /** Why the description is missing, when it is. */
  note?: string;
}

interface SkillsShHit {
  id?: string;
  source?: string;
  skillId?: string;
  name?: string;
  installs?: number;
}

export interface SkillSearchResult {
  items: StoreSkill[];
  at: number;
  note?: string;
}

/** Small concurrency limiter: a dozen raw fetches at once is rude and gets throttled. */
async function mapLimit<T, R>(list: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      out[index] = await fn(list[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Skills.sh's ranked search only: name, repo, install counts. Cheap (one request) — the rows can be
 * painted before any repo is touched, which is what keeps the dialog from sitting on 「查询中…」.
 * The directory itself is slow to answer (seconds), so ten minutes of answers are kept in memory:
 * typing and deleting a character should not re-ask.
 */
const searchMemo = new Map<string, { at: number; items: StoreSkill[] }>();
const SEARCH_TTL = 10 * 60_000;

export async function searchSkillStore(query: string, limit: number, net: SkillNet = LIVE_NET): Promise<SkillSearchResult> {
  const q = query.trim();
  if (q.length < 2) throw new Error("技能搜索至少输入 2 个字符");
  const key = q.toLowerCase();
  const hit = searchMemo.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return { items: hit.items.slice(0, limit), at: hit.at };
  const data = await net.json(`https://skills.sh/api/search?q=${encodeURIComponent(q)}`);
  const hits = (Array.isArray(data?.skills) ? data.skills : []).slice(0, 50) as SkillsShHit[];
  const items: StoreSkill[] = hits.map((h) => {
    const id = String(h.id ?? "");
    return {
      id,
      name: String(h.name ?? h.skillId ?? id.split("/").pop() ?? ""),
      source: String(h.source ?? ""),
      installs: Number(h.installs) || 0,
      description: "",
      dir: null,
    };
  });
  const at = Date.now();
  searchMemo.set(key, { at, items });
  return { items: items.slice(0, limit), at };
}

/**
 * The second stage of a search: where each row lives in its repo, and the `SKILL.md` description.
 * One tree per repo (cached for half a day) plus one file per row, a few at a time. A row that cannot
 * be resolved (repo moved, jsDelivr refusing a huge repo, GitHub hiccup) keeps its rank and gets a
 * note — a description is not worth failing the whole search.
 */
export async function describeStoreSkills(items: StoreSkill[], net: SkillNet = LIVE_NET): Promise<SkillSearchResult> {
  let degraded = false;
  const resolved = await mapLimit(items.slice(0, 60), 5, async (item) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(item.source)) return { ...item, note: "来源不是一个 GitHub 仓库", resolved: true };
    try {
      const files = await repoFiles(item.source, net);
      const dir = pickSkillDir(skillDirs(files), item.name);
      if (dir === null) return { ...item, note: "仓库里没找到同名目录", resolved: true };
      const meta = await skillMeta(item.source, dir, net).catch(() => null);
      return { ...item, dir, description: meta ? oneLine(meta.description) : "", resolved: true };
    } catch (err) {
      degraded = true;
      return { ...item, note: String((err as Error)?.message ?? err), resolved: true };
    }
  });
  const note = degraded ? "部分条目的说明没查到（GitHub / jsDelivr 没回答），安装仍可照常尝试。" : undefined;
  return { items: resolved, at: Date.now(), note };
}

/** Frontmatter descriptions are whole paragraphs; the store shows two lines. */
function oneLine(text: string, max = 400): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ------------------------------------------------------------------ input parsing

export type ParsedSource =
  | { kind: "repo"; repo: string; ref: string; path: string | null }
  | { kind: "local"; path: string }
  | { kind: "invalid"; reason: string };

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * `owner/repo`, `https://github.com/owner/repo(/tree/<ref>(/<path>)?)?`, `git@github.com:owner/repo.git`,
 * or a directory on this machine (a drive path, `~`, `.`/`..`, or anything that exists locally).
 */
export function parseSource(raw: string): ParsedSource {
  const input = String(raw ?? "").trim();
  if (!input) return { kind: "invalid", reason: "先填一个仓库（owner/repo）或本机目录" };
  const local = input === "." || input === ".." || input.startsWith("./") || input.startsWith("../") || input.startsWith("~") || /^[A-Za-z]:[\\/]/.test(input) || path.isAbsolute(input);
  if (local) return { kind: "local", path: path.resolve(expandTilde(input)) };
  const gh = /^(?:git@github\.com:|git:\/\/github\.com\/|https?:\/\/(?:www\.)?github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(input);
  if (gh) {
    const [, repo, ref, sub] = gh;
    const subPath = sub ? safeRelative(sub.replace(/\/(?:SKILL\.md)?$/i, (m) => (/SKILL\.md/i.test(m) ? "" : m))) : null;
    return { kind: "repo", repo, ref: ref || "HEAD", path: subPath || null };
  }
  if (REPO_RE.test(input)) return { kind: "repo", repo: input, ref: "HEAD", path: null };
  if (fs.existsSync(input)) return { kind: "local", path: path.resolve(input) };
  return { kind: "invalid", reason: "认不出这个地址：写 owner/repo、GitHub 链接，或本机的一个目录" };
}

function expandTilde(p: string): string {
  if (p === "~") return process.env.USERPROFILE || process.env.HOME || p;
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) return path.join(process.env.USERPROFILE || process.env.HOME || "~", p.slice(2));
  return p;
}

/** No `..`, no absolute, no backslashes: a repo-relative directory. */
function safeRelative(p: string): string | null {
  const clean = p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!clean) return null;
  if (clean.split("/").some((seg) => seg === ".." || seg === "")) return null;
  return clean;
}

// ------------------------------------------------------------------ preview (按地址安装)

export interface PreviewItem {
  /** Repo-relative directory, or an absolute path for a local directory. */
  path: string;
  name: string;
  description: string;
  local: boolean;
}

export interface PreviewResult {
  kind: "repo" | "local";
  /** `owner/repo` or the local path, echoed back so the page can label the list. */
  source: string;
  items: PreviewItem[];
}

/**
 * List the skills inside a repo (or a local directory) so the user picks one instead of typing a
 * path. Descriptions come from each `SKILL.md`; a repo with more than 60 skill folders is cut short.
 */
export async function previewSource(raw: string, net: SkillNet = LIVE_NET): Promise<PreviewResult> {
  const parsed = parseSource(raw);
  if (parsed.kind === "invalid") throw new Error(parsed.reason);
  if (parsed.kind === "local") return { kind: "local", source: parsed.path, items: localSkills(parsed.path) };
  const files = await repoFiles(parsed.repo, net);
  let dirs = skillDirs(files);
  if (parsed.path) {
    const sub = parsed.path;
    const inside = dirs.filter((d) => d === sub || d.startsWith(`${sub}/`));
    if (inside.length) dirs = inside;
    else if (files.some(([f]) => f === `${sub}/SKILL.md` || f === sub)) dirs = [sub];
    else throw new Error(`${parsed.repo} 里没有 ${sub}`);
  }
  const picked = dirs.slice(0, 60);
  const items = await mapLimit(picked, 5, async (dir) => {
    const fallback = dir ? (dir.split("/").pop() ?? dir) : parsed.repo;
    try {
      const meta = await skillMeta(parsed.repo, dir, net);
      return { path: dir, name: meta.name || fallback, description: oneLine(meta.description, 240), local: false };
    } catch {
      return { path: dir, name: fallback, description: "", local: false };
    }
  });
  return { kind: "repo", source: parsed.repo, items };
}

/** Local directory → its skills. A directory that is itself a skill is not searched any deeper. */
export function localSkills(dir: string): PreviewItem[] {
  const abs = path.resolve(dir);
  const isSkill = (p: string): boolean => {
    try {
      return fs.statSync(path.join(p, "SKILL.md")).isFile();
    } catch {
      return false;
    }
  };
  const item = (p: string): PreviewItem => {
    const text = (() => {
      try {
        return fs.readFileSync(path.join(p, "SKILL.md"), "utf8");
      } catch {
        return "";
      }
    })();
    const fm = frontmatter(text);
    return { path: p, name: fm.name || path.basename(p), description: oneLine(fm.description ?? "", 240), local: true };
  };
  if (isSkill(abs)) return [item(abs)];
  const out: PreviewItem[] = [];
  const skip = new Set([".git", "node_modules", "dist", "build", ".next", "target", "vendor", ".venv", "__pycache__"]);
  const walk = (p: string, depth: number): void => {
    if (depth > 4 || out.length >= 100) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (skip.has(entry.name) || entry.name.startsWith(".")) continue;
      const child = path.join(p, entry.name);
      if (isSkill(child)) out.push(item(child));
      else walk(child, depth + 1);
      if (out.length >= 100) return;
    }
  };
  walk(abs, 0);
  if (!out.length) throw new Error(`${abs} 里没有找到 SKILL.md`);
  return out;
}

// ------------------------------------------------------------------ install

export interface InstallRequest {
  /** `owner/repo` (or any form `parseSource` accepts, except a local path). */
  source?: string;
  /** Repo-relative skill directory. Without it, `skillId` is matched against the repo's folders. */
  dir?: string;
  skillId?: string;
  /** A local skill directory to copy. */
  local?: string;
  scope?: "user" | "project";
  cwd?: string | null;
  /** Folder name override; defaults to the frontmatter name, then the folder name. */
  name?: string;
}

export interface InstallResult {
  name: string;
  dir: string;
  root: string;
  files: number;
  /** `owner/repo` or the local source path, for the row's receipt. */
  from: string;
}

const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_FILES = 400;

const STORE_MARKER = ".pi-store.json";

export interface StoreMarker {
  /** Set for a GitHub install. */
  source?: string;
  dir?: string;
  /** Set for a copy from a local directory. */
  local?: string;
  at: number;
}

function safeName(raw: string): string {
  const name = String(raw ?? "").trim();
  if (!name || name === "." || name === ".." || name.length > 64 || /[\\/\u0000]/.test(name)) throw new Error(`技能名不合法：${raw}`);
  return name;
}

function targetRoot(req: InstallRequest): { root: string; scope: "user" | "project" } {
  const scope = req.scope === "project" ? "project" : "user";
  if (scope === "project") {
    const cwd = String(req.cwd ?? "").trim();
    if (!cwd) throw new Error("装到项目需要先打开一个会话（桥不知道项目目录）");
    return { root: path.join(cwd, ".pi", "skills"), scope };
  }
  return { root: path.join(agentDir(), "skills"), scope };
}

/**
 * Copy one skill into a skill root. A re-install from the same source replaces the folder the store
 * wrote earlier (its `.pi-store.json` matches); anything else with that name is left alone.
 */
export async function installSkill(req: InstallRequest, net: SkillNet = LIVE_NET): Promise<InstallResult> {
  const { root } = targetRoot(req);
  const local = req.local ? path.resolve(expandTilde(String(req.local))) : null;
  if (local) {
    if (!fs.statSync(local, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`不是目录：${local}`);
    if (!fs.existsSync(path.join(local, "SKILL.md"))) throw new Error(`${local} 里没有 SKILL.md，不是技能目录`);
    const fm = frontmatter(fs.readFileSync(path.join(local, "SKILL.md"), "utf8"));
    const name = safeName(req.name || fm.name || path.basename(local));
    const dir = path.join(root, name);
    const marker: StoreMarker = { local, at: Date.now() };
    prepareTarget(dir, marker);
    try {
      fs.cpSync(local, dir, { recursive: true, dereference: true });
      writeMarker(dir, marker);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    return { name, dir, root, files: countFiles(dir), from: local };
  }

  const parsed = parseSource(String(req.source ?? ""));
  if (parsed.kind === "invalid") throw new Error(parsed.reason);
  if (parsed.kind === "local") throw new Error("本机目录请用「本机目录」那条路（skill.install.local）");
  const files = await repoFiles(parsed.repo, net);
  // `dir: ""` means "SKILL.md at the repo root"; undefined means "work it out from skillId".
  let dir: string | null = req.dir === undefined ? null : String(req.dir) === "" ? "" : safeRelative(String(req.dir));
  if (dir === null && req.skillId) dir = pickSkillDir(skillDirs(files), String(req.skillId));
  if (dir === null) throw new Error(`在 ${parsed.repo} 里没找到这个技能目录`);
  const skillMd = dir ? `${dir}/SKILL.md` : "SKILL.md";
  if (!files.some(([f]) => f === skillMd)) throw new Error(`${parsed.repo} 里没有 ${skillMd}`);
  const meta = await skillMeta(parsed.repo, dir, net).catch(() => null);
  const name = safeName(req.name || meta?.name || (dir ? (dir.split("/").pop() ?? dir) : parsed.repo.split("/").pop() || "skill"));
  const target = path.join(root, name);
  const marker: StoreMarker = { source: parsed.repo, dir, at: Date.now() };
  prepareTarget(target, marker);

  const prefix = dir ? `${dir}/` : "";
  const wanted = files.filter(([f]) => f.startsWith(prefix)).sort((a, b) => a[0].localeCompare(b[0]));
  if (wanted.length > MAX_FILES) throw new Error(`这个技能有 ${wanted.length} 个文件，超过 ${MAX_FILES} 个上限，没装`);
  const total = wanted.reduce((sum, [, size]) => sum + size, 0);
  if (total > MAX_TOTAL) throw new Error(`这个技能有 ${(total / 1048576).toFixed(1)} MB，超过 64 MB 上限，没装`);
  let written = 0;
  // A skill folder is a handful of small files; four at a time keeps a cold install near one
  // round-trip instead of one request per file.
  const writeAll = async (list: [string, number][]): Promise<void> => {
    written = 0;
    await mapLimit(list, 4, async ([file, size]) => {
      if (size > MAX_FILE) throw new Error(`${file} 大于 16 MB，没装`);
      const rel = file.slice(prefix.length);
      if (!rel || rel.split("/").some((seg) => seg === "..")) return;
      const buf = await net.file(...fileFetch(parsed.repo, file, parsed.ref ?? "HEAD"));
      const dest = path.join(target, ...rel.split("/"));
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, buf);
      written++;
    });
  };
  try {
    try {
      await writeAll(wanted);
    } catch (err) {
      // A file the tree promised that 404s means the tree is older than the repo (jsDelivr caches
      // `@HEAD` for hours). Ask GitHub for the live tree once and redo the copy from it.
      if ((err as { code?: string })?.code !== "HTTP_404") throw err;
      const fresh = await freshRepoFiles(parsed.repo, net).catch(() => null);
      const again = fresh?.filter(([f]) => f.startsWith(prefix)) ?? [];
      if (!again.some(([f]) => f === skillMd)) throw err;
      if (again.length > MAX_FILES) throw new Error(`这个技能有 ${again.length} 个文件，超过 ${MAX_FILES} 个上限，没装`);
      // The first pass may have written files the new tree no longer has; start from an empty folder.
      fs.rmSync(target, { recursive: true, force: true });
      ensureDir(target);
      await writeAll(again.sort((a, b) => a[0].localeCompare(b[0])));
    }
    writeMarker(target, marker);
  } catch (err) {
    fs.rmSync(target, { recursive: true, force: true });
    throw err;
  }
  return { name, dir: target, root, files: written, from: parsed.repo };
}

/** Refuse to clobber a skill the user put there by hand; replace one this store wrote. */
function prepareTarget(target: string, marker: StoreMarker): void {
  if (!fs.existsSync(target)) return;
  const prev = readJson<StoreMarker | null>(path.join(target, STORE_MARKER), null);
  const same = prev && ((marker.source && prev.source === marker.source && (prev.dir ?? "") === (marker.dir ?? "")) || (marker.local && prev.local === marker.local));
  if (!same) throw new Error(`已经有同名技能：${target}（先在「已安装」里卸载，或换个名字）`);
  fs.rmSync(target, { recursive: true, force: true });
}

function writeMarker(dir: string, marker: StoreMarker): void {
  fs.writeFileSync(path.join(dir, STORE_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
}

function countFiles(dir: string): number {
  let n = 0;
  const walk = (p: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(p, entry.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

// ------------------------------------------------------------------ installed / uninstall

export interface InstalledSkill extends SkillEntry {
  /** Set when the store wrote it (`.pi-store.json`). */
  from: string | null;
  installedAt: number | null;
}

/** What the 已安装 tab lists: every skill pi would load, plus where it came from. */
export function installedSkills(cwd: string | null): InstalledSkill[] {
  return scanSkillEntries(cwd)
    .map((entry) => {
      const marker = readJson<StoreMarker | null>(path.join(entry.path, STORE_MARKER), null);
      return { ...entry, from: marker ? (marker.source ?? marker.local ?? null) : null, installedAt: marker?.at ?? null };
    })
    .sort((a, b) => Number(b.removable) - Number(a.removable) || a.name.localeCompare(b.name));
}

/**
 * Delete one user skill. A junction / symlink loses only the link — its target belongs to whoever
 * made it. Project skills are refused: they live in a repository, not in the user's skill folder.
 */
export function removeSkill(target: string): { name: string; dir: string; link: boolean; root: string } {
  const abs = path.resolve(String(target ?? ""));
  const root = userSkillRootOf(abs);
  if (!root) throw new Error(`只能删用户技能目录（${path.join(agentDir(), "skills")}、~/.agents/skills）里的技能：${abs}`);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) throw new Error(`已经不在了：${abs}`);
  if (st.isSymbolicLink()) {
    fs.unlinkSync(abs);
    return { name: path.basename(abs), dir: abs, link: true, root };
  }
  if (!st.isDirectory()) throw new Error(`不是目录：${abs}`);
  if (!fs.existsSync(path.join(abs, "SKILL.md"))) throw new Error(`不是技能目录（里面没有 SKILL.md）：${abs}`);
  const name = path.basename(abs);
  fs.rmSync(abs, { recursive: true });
  return { name, dir: abs, link: false, root };
}
