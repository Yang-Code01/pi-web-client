/**
 * 热部署：设置 →「工具」里那颗按钮的后端。
 *
 * 和前身 `.pi/skills/bridge-update/bin/restart.mjs` 的区别：那个是给 agent 自己把 **main** 拉到最新用的，
 * 这个是给用户用的 —— 分支可选、进度要能看见、失败要说清「源码在哪、线上是哪份」。
 * 流程本身（先 build 再杀、可见窗口、只按 pid 杀）沿用 D154 的结论。
 *
 * 状态文件放在 `<repo>/.scratch/hot-deploy/`：worker 写，桥只读。桥被杀掉的那几十秒里
 * 页面照样能读到「跑到哪一步」，重连后从 state.json 收尾。
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import type * as http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonChecked } from "./paths.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `bridge/dist/hotdeploy.js` → 仓库根。桥在哪个检出里跑，热部署就管哪个检出。 */
export const REPO = path.resolve(HERE, "..", "..");
export const WORK = path.join(REPO, ".scratch", "hot-deploy");
const STATE = path.join(WORK, "state.json");
const LOG = path.join(WORK, "worker.log");
const WORKER = path.join(REPO, "scripts", "hotdeploy.mjs");

export interface HotdeployCtx {
  publicReq: boolean;
  port: number;
  log?: (line: string) => void;
  /** 正在跑的会话数：用来提示「会切断 N 个会话」。 */
  sessionCount?: () => number;
}

export interface WorktreeRow {
  path: string;
  branch: string | null;
  detached: boolean;
}

export interface BranchRow {
  name: string;
  sha: string;
  ahead: number;
  behind: number;
  current: boolean;
  /** 被另一个 worktree 检出时是那个目录；主检出自己不算占用。 */
  occupiedBy: string | null;
  remoteOnly: boolean;
  lastCommitAt: string | null;
}

export interface RunState {
  pid?: number;
  branch?: string;
  step?: number;
  phase?: "running" | "ok" | "fail";
  startedAt?: string;
  finishedAt?: string | null;
  fromBranch?: string;
  fromSha?: string;
  toSha?: string;
  buildId?: string;
  exitCode?: number | null;
  error?: string | null;
  port?: number;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

function fail(res: http.ServerResponse, status: number, code: string, error: string): void {
  json(res, status, { error, code });
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new Error("请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(null);
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

function git(args: string[], cwd = REPO): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      resolve({ ok: !err, out: String(out ?? ""), err: String(errOut ?? "") });
    });
  });
}

const NUL = String.fromCharCode(9);

/** `git worktree list --porcelain` → 行。空行分隔，「branch refs/heads/x」是检出引用。 */
export function parseWorktrees(porcelain: string): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  let cur: WorktreeRow | null = null;
  for (const raw of porcelain.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (cur) rows.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (cur) rows.push(cur);
      cur = { path: line.slice("worktree ".length), branch: null, detached: false };
    } else if (cur && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      cur.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (cur && line === "detached") {
      cur.detached = true;
    }
  }
  if (cur) rows.push(cur);
  return rows;
}

/** `%(upstream:track)` → `[ahead 2, behind 3]` / `[gone]` / 空。 */
export function parseTrack(text: string): { ahead: number; behind: number; gone: boolean } {
  const gone = /gone/.test(text);
  const ahead = Number((/ahead (\d+)/.exec(text) ?? [])[1] ?? 0);
  const behind = Number((/behind (\d+)/.exec(text) ?? [])[1] ?? 0);
  return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0, gone };
}

export interface RefLine {
  /** 已去掉 refs/heads/ 或 refs/remotes/origin/ 前缀 */
  name: string;
  sha: string;
  track: string;
  at: string | null;
  remote: boolean;
}

/** `git for-each-ref --format=%refname%09%objectname:short%09%upstream:track%09%committerdate:iso-strict` */
export function parseRefLines(out: string): RefLine[] {
  const rows: RefLine[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, sha, track = "", at = ""] = line.split(NUL);
    if (!ref || !sha) continue;
    if (ref.startsWith("refs/heads/")) {
      rows.push({ name: ref.slice("refs/heads/".length), sha, track, at: at || null, remote: false });
    } else if (ref.startsWith("refs/remotes/origin/")) {
      const name = ref.slice("refs/remotes/origin/".length);
      if (name === "HEAD") continue;
      rows.push({ name, sha, track, at: at || null, remote: true });
    }
  }
  return rows;
}

/**
 * 本地分支在前，只在远端存在过的补在后；被别的 worktree 检出的标出来。
 * `self` 是跑这个桥的主检出的路径 —— 它自己也出现在 worktree 列表里，不算占用。
 */
export function buildBranchRows(refs: RefLine[], worktrees: WorktreeRow[], current: string, self: string): BranchRow[] {
  const mine = (p: string) => path.resolve(p).toLowerCase();
  const occupied = new Map<string, string>();
  for (const w of worktrees) {
    if (!w.branch || mine(w.path) === mine(self)) continue;
    occupied.set(w.branch, w.path);
  }
  const locals = refs.filter((r) => !r.remote);
  const localNames = new Set(locals.map((r) => r.name));
  const rows: BranchRow[] = [];
  for (const r of locals) {
    const t = parseTrack(r.track);
    rows.push({
      name: r.name,
      sha: r.sha,
      ahead: t.ahead,
      behind: t.behind,
      current: r.name === current,
      occupiedBy: occupied.get(r.name) ?? null,
      remoteOnly: false,
      lastCommitAt: r.at,
    });
  }
  for (const r of refs) {
    if (!r.remote || localNames.has(r.name)) continue;
    rows.push({
      name: r.name,
      sha: r.sha,
      ahead: 0,
      behind: 0,
      current: r.name === current,
      occupiedBy: occupied.get(r.name) ?? null,
      remoteOnly: true,
      lastCommitAt: r.at,
    });
  }
  const rank = (r: BranchRow) => (r.current ? 0 : r.name === "main" ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? ""));
  return rows;
}

export function readState(): RunState | null {
  const { ok, value, error } = readJsonChecked<RunState | null>(STATE, null);
  if (!ok) return { phase: "fail", error: `state.json 读不出来：${error ?? ""}` } as RunState;
  return value && typeof value === "object" ? value : null;
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tailLines(file: string, max = 160): string[] {
  try {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-max);
  } catch {
    return [];
  }
}

/**
 * 测试 / 自动化用的逃生口：worktree 里的 bridge 默认拒绝换进程（那个检出正被 agent 改着），
 * UI 测试要驱动一次真跑时才把它设成 1。正常部署永远别设。
 */
const ALLOW_WORKTREE = process.env.PI_HOTDEPLOY_ALLOW_WORKTREE === "1";

/**
 * worker 被外部杀掉时它会停在 phase=running（自己没机会写结尾）。这里把「说自己在跑、pid 却没了」的
 * 状态翻成失败，否则界面会一直转圈、按钮也永远禁用。
 */
function stomped(state: RunState | null): RunState | null {
  if (!state || state.phase !== "running" || pidAlive(state.pid)) return state;
  return { ...state, phase: "fail", error: "crashed", finishedAt: state.finishedAt ?? new Date().toISOString() };
}

/** 主检出 vs 链接进去的 worktree：后者不归这颗按钮管（agent 正在里面改东西）。 */
async function inLinkedWorktree(): Promise<{ linked: boolean; dir: string | null }> {
  const gitDir = await git(["rev-parse", "--git-dir"]);
  if (!gitDir.ok) return { linked: false, dir: null };
  const common = await git(["rev-parse", "--git-common-dir"]);
  const a = path.resolve(REPO, gitDir.out.trim()).toLowerCase();
  const b = path.resolve(REPO, common.out.trim()).toLowerCase();
  return { linked: a !== b && !ALLOW_WORKTREE, dir: a !== b ? REPO : null };
}

export async function snapshot(ctx: HotdeployCtx): Promise<Record<string, unknown>> {
  const [branchRes, headRes, statusRes, refsRes, wtRes] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["rev-parse", "--short", "HEAD"]),
    git(["status", "--porcelain", "--untracked-files=normal"]),
    git(["for-each-ref", "--format=%(refname)%09%(objectname:short)%09%(upstream:track)%09%(committerdate:iso-strict)", "refs/heads", "refs/remotes/origin"]),
    git(["worktree", "list", "--porcelain"]),
  ]);
  const branch = branchRes.out.trim();
  const detached = branch === "HEAD";
  const dirtyFiles = statusRes.out
    .split(/\r?\n/)
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  const refs = parseRefLines(refsRes.out);
  const rows = buildBranchRows(refs, parseWorktrees(wtRes.out), detached ? "" : branch, REPO);
  const state = stomped(readState());
  const worktree = await inLinkedWorktree();
  return {
    repo: REPO,
    branch: detached ? "" : branch,
    detached,
    head: headRes.out.trim(),
    buildId: process.env.PI_BUILD_ID ?? "",
    port: ctx.port,
    sessions: ctx.sessionCount?.() ?? 0,
    dirty: dirtyFiles.length > 0,
    dirtyFiles: dirtyFiles.slice(0, 8),
    busy: Boolean(state?.phase === "running" && pidAlive(state.pid)),
    run: state,
    linkedWorktree: worktree.linked,
    log: LOG,
    branches: rows,
  };
}

async function startRun(req: http.IncomingMessage, res: http.ServerResponse, ctx: HotdeployCtx): Promise<void> {
  if (ctx.publicReq) return fail(res, 403, "hotdeploy_public", "公网不能换本机进程；请回本机操作");
  const link = await inLinkedWorktree();
  if (link.linked) return fail(res, 409, "hotdeploy_worktree", "这个 bridge 是从 worktree 起的，热部署只在主检出里用");
  const body = await readJsonBody(req).catch(() => null);
  const branch = typeof body?.branch === "string" ? body.branch.trim() : "";
  if (!branch) return fail(res, 400, "hotdeploy_branch", "没说要部署哪条分支");
  if (!fs.existsSync(WORKER)) return fail(res, 500, "hotdeploy_worker", `缺少 ${WORKER}`);

  const snap = await snapshot(ctx);
  const branches = snap.branches as BranchRow[];
  const row = branches.find((b) => b.name === branch);
  if (!row) return fail(res, 400, "hotdeploy_branch", `本地没有这条分支：${branch}`);
  if (row.occupiedBy) {
    return fail(res, 409, "hotdeploy_occupied", `${branch} 被另一个 worktree 检出：${row.occupiedBy}；先在那儿收掉它`);
  }
  if (snap.busy) return fail(res, 409, "hotdeploy_busy", "上一轮热部署还没结束");
  if (snap.dirty) {
    const list = (snap.dirtyFiles as string[]).slice(0, 3).join("、");
    return fail(res, 409, "hotdeploy_dirty", `主检出有未提交的改动（${list}…），先提交或还原再来`);
  }

  const run: RunState = {
    pid: 0,
    branch,
    step: 0,
    phase: "running",
    startedAt: new Date().toISOString(),
    fromBranch: String(snap.branch || "(detached)"),
    fromSha: String(snap.head ?? ""),
    toSha: "",
    port: ctx.port,
  };
  fs.mkdirSync(WORK, { recursive: true });
  try {
    const fd = fs.openSync(LOG, "a");
    const child = spawn(process.execPath, [WORKER, "--dir", REPO, "--branch", branch, "--port", String(ctx.port)], {
      cwd: REPO,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      env: { ...process.env, PI_WEB_PORT: String(ctx.port) },
    });
    child.unref();
    fs.closeSync(fd);
    run.pid = child.pid ?? 0;
    ctx.log?.(`hotdeploy: 起 worker pid ${run.pid}，目标 ${branch}`);
  } catch (err) {
    return fail(res, 500, "hotdeploy_spawn", `起不来 worker：${(err as Error).message}`);
  }
  try {
    fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(run, null, 2));
    fs.renameSync(`${STATE}.tmp`, STATE);
  } catch {}
  return json(res, 202, { ok: true, run });
}

async function removeWorktree(req: http.IncomingMessage, res: http.ServerResponse, ctx: HotdeployCtx): Promise<void> {
  if (ctx.publicReq) return fail(res, 403, "hotdeploy_public", "公网不能删本机目录；请回本机操作");
  const body = await readJsonBody(req).catch(() => null);
  const target = typeof body?.path === "string" ? body.path.trim() : "";
  const force = body?.force === true;
  if (!target) return fail(res, 400, "hotdeploy_path", "没说收哪一个 worktree");
  const wt = parseWorktrees((await git(["worktree", "list", "--porcelain"])).out);
  const known = wt.find((w) => path.resolve(w.path).toLowerCase() === path.resolve(target).toLowerCase());
  if (!known) return fail(res, 400, "hotdeploy_path", `git 的工作树列表里没有 ${target}`);
  const tool = path.join(REPO, "tools", "worktree-remove.mjs");
  if (!fs.existsSync(tool)) return fail(res, 500, "hotdeploy_tool", `缺少 ${tool}`);
  const args = [tool, known.path, ...(force ? ["--force"] : [])];
  const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, args, { cwd: REPO, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? Number((err as { code?: number }).code) : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
  return json(res, 200, { ok: out.code === 0, code: out.code, stdout: out.stdout.slice(-4000), stderr: out.stderr.slice(-4000) });
}

export async function handleHotdeploy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: HotdeployCtx,
): Promise<boolean> {
  const p = url.pathname;
  if (p !== "/api/hotdeploy" && !p.startsWith("/api/hotdeploy/")) return false;
  try {
    if (p === "/api/hotdeploy" && req.method === "GET") {
      json(res, 200, await snapshot(ctx));
      return true;
    }
    if (p === "/api/hotdeploy/log" && req.method === "GET") {
      const n = Math.max(20, Math.min(400, Number(url.searchParams.get("lines") ?? 160) || 160));
      json(res, 200, { lines: tailLines(LOG, n) });
      return true;
    }
    if (p === "/api/hotdeploy/run" && req.method === "POST") {
      await startRun(req, res, ctx);
      return true;
    }
    if (p === "/api/hotdeploy/remove-worktree" && req.method === "POST") {
      await removeWorktree(req, res, ctx);
      return true;
    }
    fail(res, 405, "hotdeploy_method", "这个接口不支持这个请求方法");
    return true;
  } catch (err) {
    ctx.log?.(`hotdeploy: ${(err as Error)?.stack ?? err}`);
    fail(res, 500, "hotdeploy_failed", `热部署接口挂了：${(err as Error).message}`);
    return true;
  }
}
