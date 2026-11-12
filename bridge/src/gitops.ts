/**
 * D235: 分支操作工作台的写执行通道与只读数据接口。
 *
 * 与上面 Q-021/D193 的只读 `git()` 分开：`git()` 把所有失败吞成 `null`，适合状态行；
 * 工作台需要退出码、原始 stderr、真实 argv 才能给失败卡和「交给 agent」。
 *
 * 五条不可让步的边界：
 * - 只接受 `id` + 结构化 params，绝不执行网页传来的任意 argv；
 * - 每个 id 在 `OP_BUILDERS` 里显式拼参数，参数一律经 `str`/`flag`/`refs` 清洗；
 * - 非交互三件套（TERMINAL_PROMPT / ASKPASS / credential.interactive）缺一不可；
 * - 同一仓库按 dir 串行，避免 index.lock 互踩；
 * - 写成功后清掉 5s TTL 缓存，让下一次读拿到新分支/新 dirty 数。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { invalidateGitCache } from "./git.ts";

const runGitRaw = promisify(execFile);

/** 所有写操作的固定前缀；`--no-optional-locks` 只给读用（fetch/push 需要自己的锁）。 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
  GCM_INTERACTIVE: "never",
};

export interface GitExecResult {
  ok: boolean;
  /** 进程退出码（0 = git 自己成功，哪怕结果是冲突也要看 pending/conflicts）。 */
  exitCode: number;
  argv: string[];
  stdout: string;
  stderr: string;
  /** 执行完的仓库状态；前端不用再另发一次 /api/git/state。 */
  state: GitState;
  /** 冲突文件（merge/rebase/cherry-pick/revert 失败或中断时）。 */
  conflicts: string[];
  /** git 还在冲突/进行中的动作；非空时前端只放行 中止 / 继续 / handoff。 */
  pending: GitPending | null;
  /** 是否真的改了仓库；成功后前端据此 fresh 刷新。 */
  refresh: boolean;
  /** 稳定错误码：auth / identity / conflict / dirty / op_failed / not_repo / unknown_op / invalid_params。 */
  code?: string;
}

export interface GitState {
  repo: string;
  head: string;
  branch: string;
  detached: boolean;
  empty: boolean;
  dirty: number;
  upstream: string;
  ahead: number;
  behind: number;
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: GitFile[];
  conflicts: string[];
  pending: GitPending | null;
}

export interface GitFile {
  path: string;
  status: string;
  /** 旧路径（rename 时）。 */
  old?: string;
}

export type GitPending = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect" | "am";

export interface GitRefs {
  repo: string;
  head: string;
  /** 自动对照：origin/HEAD → origin/main → 第一条远程分支。 */
  defaultBase: string;
  groups: { name: string; refs: { name: string; at: number; current: boolean; upstream?: string; ahead?: number; behind?: number }[] }[];
}

export interface GitDiff {
  repo: string;
  base: string;
  target: string;
  files: GitDiffFile[];
  /** 一侧最多 200 行 / 400 KB，超过就标 truncated。 */
  limit: { lines: number; bytes: number };
}

export interface GitDiffFile {
  path: string;
  /** 旧路径（rename 时），读左侧内容要用它。 */
  old?: string;
  status: string;
  kind: "text" | "image" | "pdf" | "sheet" | "binary" | "missing";
  binary: boolean;
  size: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  /** 文本并排：每行 {left, right, tag}。 */
  lines: { left: string; right: string; tag: "same" | "add" | "del" | "mod" }[];
  /** 图片：两侧 data URL（小图才给，> 2 MB 走占位）。 */
  images?: { base: string | null; target: string | null };
  note: string;
}

/** 网页来的参数：值都只能是 string / boolean / string[]，不收函数、不收 argv。 */
export interface GitOpParams {
  [key: string]: string | boolean | string[] | undefined;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/[\r\n\0]/g, "") : "";
}

/** ref / 分支名 / tag 名：不许以 `-` 开头（否则会被 git 当选项），不许空白与控制字符。 */
function ref(value: unknown, fallback = ""): string {
  const s = clean(value);
  if (!s || s.startsWith("-") || /[\s~^:?*\[\\]/.test(s)) return fallback;
  return s.slice(0, 240);
}

/**
 * 可解析成提交的任意 ref：`HEAD~3` / `HEAD^` / `origin/main` / `v1.0` / `HEAD@{1}` 都要能用
 * （对照检索器允许直接输入这类 ref）。只允许 git rev 语法里合法的字符，挡掉 `-` 开头、
 * 空白与控制字符、超长；合法性最终仍由 `rev-parse --verify --quiet ...^{commit}` 兜底。
 */
function commitish(value: unknown, fallback = ""): string {
  const s = clean(value);
  if (!s || s.startsWith("-") || /[\s\0-\x1f\x7f]/.test(s)) return fallback;
  return s.slice(0, 240);
}

/** 提交哈希/可解析 ref 的多值输入框：按空白切，逐条清洗，最多 50 条。 */
function hashes(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(" ") : typeof value === "string" ? value : "";
  return clean(raw)
    .split(/\s+/)
    .map((h) => commitish(h, ""))
    .filter(Boolean)
    .slice(0, 50);
}

function flag(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function boolSwitch(params: GitOpParams, key: string): boolean {
  return flag(params[key]);
}

/** 多选文件：逐条清掉空白/换行，拒绝 `-` 开头和 `..`，限定 200 条。 */
function paths(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return list
    .map((p) => clean(p).replace(/\\/g, "/"))
    .filter((p) => p && !p.startsWith("-") && !p.startsWith("..") && !p.includes("\0"))
    .slice(0, 200);
}

/** 多行提交说明；`-m` 传参不经 shell，但要防超长。 */
function message(value: unknown): string {
  return clean(value).slice(0, 4000);
}

/** 短选项值（例如 `-n 3`、`--max-count=3`）：只允许非负整数。 */
function count(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 10000 ? Math.floor(n) : fallback;
}

async function exec(dir: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv; binary?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = ["-C", dir, "-c", "core.fsmonitor=false", "-c", "credential.interactive=never", ...args];
  try {
    const { stdout, stderr } = await runGitRaw("git", argv, {
      timeout: opts.timeout ?? 20_000,
      env: opts.env ?? GIT_ENV,
      windowsHide: true,
      encoding: opts.binary ? "buffer" : "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: opts.binary ? "" : String(stdout), stderr: opts.binary ? "" : String(stderr) };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const code = typeof e.code === "number" ? e.code : 1;
    const stdout = e.stdout ? String(e.stdout) : "";
    // git 失败时 stderr 才是给用户看的；execFile 的 message 第一行是整条命令，
    // 只在 git 什么都没打印时兜底，并把 `Command failed: …\n` 那一行去掉。
    const raw = e.stderr ? String(e.stderr) : e.message ?? "git 执行失败";
    const stderr = raw.replace(/^Command failed:.*\r?\n/, "");
    return { code, stdout, stderr };
  }
}

/** 一次读，失败也带 stderr（与上面的只读 `git()` 不同）。 */
async function read(dir: string, args: string[], timeout = 8000): Promise<{ code: number; stdout: string; stderr: string }> {
  return exec(dir, args, { timeout, env: { ...GIT_ENV } });
}

function split(out: string): string[] {
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function classify(p: string): GitDiffFile["kind"] {
  const ext = path.extname(p).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if ([".xlsx", ".xls", ".csv", ".tsv", ".ods"].includes(ext)) return "sheet";
  if ([".zip", ".7z", ".gz", ".bin", ".exe", ".dll", ".woff", ".woff2", ".ttf", ".mp4", ".mp3", ".wasm"].includes(ext)) return "binary";
  return "text";
}

/** `status --porcelain=v1 -z` 的 rename 行是 `R  new\0old\0`，其余是 `XY path\0`。 */
function parseStatus(out: string): { staged: GitFile[]; unstaged: GitFile[]; untracked: GitFile[]; conflicts: string[] } {
  const fields = out.split("\0");
  const staged: GitFile[] = [];
  const unstaged: GitFile[] = [];
  const untracked: GitFile[] = [];
  const conflicts: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const row = fields[i];
    // `status -z` 的 rename/copy 是两条：状态行 + 旧路径；旧路径里也可能含空格，
    // 不能拿 `/^[ MADRCU?!]{2} /` 去认它（会误吞下一条合法状态行）。
    if (!row || row.length < 4) continue;
    const x = row[0];
    const y = row[1];
    const p = row.slice(3);
    if (!p) continue;
    const file: GitFile = { path: p, status: `${x}${y}`.trim() || "??" };
    if (x === "?" && y === "?") untracked.push(file);
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      conflicts.push(p);
      unstaged.push(file);
    } else {
      if (x !== " " && x !== "?") staged.push(file);
      if (y !== " ") unstaged.push(file);
    }
    // rename/copy: 紧跟的下一个 NUL 字段必定是旧路径。
    if ((x === "R" || x === "C" || y === "R" || y === "C") && fields[i + 1]) {
      file.old = fields[i + 1];
      i++;
    }
  }
  return { staged, unstaged, untracked, conflicts };
}

function pendingFrom(dir: string): GitPending | null {
  const gitDir = (() => {
    try {
      const out = fs.readFileSync(path.join(dir, ".git"), "utf8").trim();
      const m = /^gitdir:\s*(.+)$/i.exec(out);
      return m ? path.resolve(dir, m[1]) : path.join(dir, ".git");
    } catch {
      return path.join(dir, ".git");
    }
  })();
  const checks: [string, GitPending][] = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["BISECT_LOG", "bisect"],
    ["am", "am"],
  ];
  for (const [file, kind] of checks) if (fs.existsSync(path.join(gitDir, file))) return kind;
  return null;
}

/** 一个仓库的完整状态，所有读操作都从这里出，不给网页暴露 git 命令。 */
export async function gitState(dir: string): Promise<GitState> {
  const top = await read(dir, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) throw Object.assign(new Error("这个目录不在 git 仓库里"), { code: "not_repo" });
  const repo = path.resolve(dir, top.stdout.trim()).replace(/\\/g, "/");
  const [abbrev, shortHead, status, upstream] = await Promise.all([
    read(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    read(repo, ["rev-parse", "--short", "HEAD"]),
    read(repo, ["--no-optional-locks", "status", "--porcelain=v1", "-z"]),
    read(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
  ]);
  const branch = abbrev.stdout.trim();
  const detached = branch === "HEAD" || abbrev.code !== 0;
  const head = detached ? shortHead.stdout.trim() : branch;
  const empty = shortHead.code !== 0;
  const parsed = parseStatus(status.stdout);
  const up = upstream.code === 0 ? upstream.stdout.trim() : "";
  let ahead = 0;
  let behind = 0;
  if (up) {
    const c = await read(repo, ["rev-list", "--left-right", "--count", `HEAD...${up}`]);
    const nums = c.stdout.trim().split(/\s+/).map(Number);
    ahead = nums[0] || 0;
    behind = nums[1] || 0;
  }
  return {
    repo,
    head,
    branch: detached ? head : branch,
    detached,
    empty,
    dirty: parsed.staged.length + parsed.unstaged.length + parsed.untracked.length,
    upstream: up,
    ahead,
    behind,
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked,
    conflicts: parsed.conflicts,
    pending: pendingFrom(repo),
  };
}

/** 本地 + 远程分支，分组给可检索对照器；含 upstream/ahead/behind。 */
export async function gitRefs(dir: string): Promise<GitRefs> {
  const state = await gitState(dir);
  // `%(refname:short)` 会把本地 `feat/x` 也变成带斜杠的名字，靠 `includes("/")` 分本地/远程
  // 会把本地主题分支误判成远程。用完整 refname 前缀分组，再截成短名。
  const rows = await read(dir, ["for-each-ref", "--format=%(refname)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)", "--sort=-committerdate", "refs/heads", "refs/remotes"]);
  const groups: GitRefs["groups"] = [
    { name: "本地", refs: [] },
    { name: "远程", refs: [] },
  ];
  for (const line of split(rows.stdout)) {
    const [full, at, upstream, track] = line.split("\t");
    if (!full) continue;
    const remote = full.startsWith("refs/remotes/");
    const name = full.replace(remote ? "refs/remotes/" : "refs/heads/", "");
    if (!name || name.endsWith("/HEAD")) continue;
    const m = /ahead (\d+),?\s*behind (\d+)|ahead (\d+)|behind (\d+)/i.exec(track ?? "");
    groups[remote ? 1 : 0].refs.push({
      name,
      at: Number(at) * 1000,
      current: !remote && name === state.branch,
      upstream: upstream || undefined,
      ahead: m ? Number(m[1] ?? m[3] ?? 0) : 0,
      behind: m ? Number(m[2] ?? m[4] ?? 0) : 0,
    });
  }
  const sym = await read(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const remote = groups[1].refs.map((r) => r.name);
  const defaultBase = sym.code === 0 && sym.stdout.trim()
    ? sym.stdout.trim()
    : remote.find((r) => r === "origin/main") ?? remote[0] ?? state.head;
  return { repo: state.repo, head: state.head, defaultBase, groups };
}

const TEXT_LIMIT = { lines: 200, bytes: 400 * 1024 };

function truncate(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= TEXT_LIMIT.bytes) return { text, truncated: false };
  return { text: Buffer.from(text).subarray(0, TEXT_LIMIT.bytes).toString("utf8"), truncated: true };
}

/** 用 `git show ref:path` 读一侧内容（不 checkout，不碰工作区）。 */
async function blob(dir: string, ref: string, p: string, binary = false): Promise<{ code: number; data: string | Buffer }> {
  const argv = ["-C", dir, "-c", "core.fsmonitor=false", "show", `${ref}:${p}`];
  try {
    const { stdout } = await runGitRaw("git", argv, { timeout: 8000, env: GIT_ENV, windowsHide: true, encoding: binary ? "buffer" : "utf8", maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, data: binary ? Buffer.from(stdout) : String(stdout) };
  } catch {
    return { code: 1, data: binary ? Buffer.alloc(0) : "" };
  }
}

function sideBySide(base: string, target: string): GitDiffFile["lines"] {
  const a = base.split("\n");
  const b = target.split("\n");
  const n = Math.max(a.length, b.length);
  const lines: GitDiffFile["lines"] = [];
  for (let i = 0; i < Math.min(n, TEXT_LIMIT.lines); i++) {
    const l = a[i] ?? "";
    const r = b[i] ?? "";
    lines.push({ left: l, right: r, tag: l === r ? "same" : l && r ? "mod" : r ? "add" : "del" });
  }
  return lines;
}

/** 默认「当前分支 vs 对照」；`commit` 给了就切「该提交 vs 父提交」。 */
export async function gitDiff(dir: string, base: string, target = "HEAD", commit = ""): Promise<GitDiff> {
  const state = await gitState(dir);
  // 对照检索器允许直接输入 `HEAD~3` / `HEAD^` / `HEAD@{1}` 这类 ref；`ref()` 会拒绝 `~^:`，
  // 那样会静默回退到 defaultBase，导致「历史」tab 对照 HEAD~3、「差异」tab 却对照 origin/main。
  const b = commitish(base, "") || (await gitRefs(dir)).defaultBase;
  const t = commit ? commitish(commit, "HEAD") : commitish(target, "HEAD");
  if (!(await read(dir, ["rev-parse", "--verify", "--quiet", `${b}^{commit}`])).stdout.trim()) {
    throw Object.assign(new Error(`找不到对照分支 ${b}`), { code: "base_unknown" });
  }
  // 根提交没有父：拿空树当左侧，否则 `git diff HEAD^ HEAD` 直接失败。
  const parent = await read(dir, ["rev-parse", "--verify", "--quiet", `${t}^`]);
  const left = commit ? (parent.stdout.trim() || "4b825dc642cb6eb9a060e54bf8d69288fbee4904") : b;
  const right = t;
  const out = await read(dir, ["diff", "--numstat", "-z", "--find-renames", left, right], 12_000);
  const fields = out.stdout.split("\0");
  const files: GitDiffFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const row = fields[i];
    if (!row) continue;
    const parts = row.split("\t");
    const [add, del] = parts;
    let p = parts[2] ?? "";
    let old = parts[3];
    // `--numstat -z --find-renames` 的 rename/copy：一行三段，后两段是独立 NUL 字段
    // （`0	0\0old\0new\0`），不是用 tab 连起来的四段。
    if (!p && fields[i + 1]) {
      old = fields[++i];
      p = fields[++i] ?? "";
    }
    if (!p) continue;
    const kind = classify(p);
    const binary = add === "-" || del === "-";
    const file: GitDiffFile = {
      path: p,
      status: old ? "R" : "M",
      kind,
      binary,
      size: 0,
      additions: Number(add) || 0,
      deletions: Number(del) || 0,
      truncated: false,
      lines: [],
      note: "",
      ...(old ? { old } : {}),
    };
    if (kind === "image") {
      const [lb, rb] = await Promise.all([blob(dir, left, file.old ?? p, true), blob(dir, right, p, true)]);
      const toUrl = (x: { code: number; data: string | Buffer }): string | null => {
        if (x.code !== 0 || !Buffer.isBuffer(x.data)) return null;
        if (x.data.length > 2 * 1024 * 1024) return null;
        const mime = p.endsWith(".png") ? "image/png" : p.endsWith(".webp") ? "image/webp" : p.endsWith(".gif") ? "image/gif" : p.endsWith(".bmp") ? "image/bmp" : "image/jpeg";
        return `data:${mime};base64,${x.data.toString("base64")}`;
      };
      file.images = { base: toUrl(lb), target: toUrl(rb) };
      file.size = Math.max(Buffer.isBuffer(lb.data) ? lb.data.length : 0, Buffer.isBuffer(rb.data) ? rb.data.length : 0);
      if (!file.images.base && !file.images.target) file.note = "图片太大或读不到，显示占位";
    } else if (kind !== "text" || binary) {
      file.note = kind === "pdf" ? "PDF 用本机预览对比" : kind === "sheet" ? "表格用本机预览对比" : "二进制文件不显示内容";
    } else {
      const [lb, rb] = await Promise.all([blob(dir, left, file.old ?? p), blob(dir, right, p)]);
      const lt = truncate(String(lb.data));
      const rt = truncate(String(rb.data));
      file.lines = sideBySide(lt.text, rt.text);
      file.truncated = lt.truncated || rt.truncated || Math.max(lt.text.split("\n").length, rt.text.split("\n").length) > TEXT_LIMIT.lines;
      file.size = Math.max(Buffer.byteLength(String(lb.data)), Buffer.byteLength(String(rb.data)));
      if (file.truncated) file.note = `只显示前 ${TEXT_LIMIT.lines} 行 / ${Math.round(TEXT_LIMIT.bytes / 1024)} KB`;
    }
    files.push(file);
  }
  return { repo: state.repo, base: b, target: right, files, limit: TEXT_LIMIT };
}

/** 写操作注册表：id → 拼 argv 的纯函数。桥只认这些 id，不认网页传来的命令字符串。 */
type Builder = (p: GitOpParams, state: GitState) => string[] | Promise<string[]>;

const OP_BUILDERS: Record<string, Builder> = {
  stage: (p) => {
    const list = paths(p.paths);
    if (!list.length) return ["add", "-A"];
    return ["add", "--", ...list];
  },
  unstage: (p) => {
    const list = paths(p.paths);
    if (!list.length) return ["reset", "HEAD", "--", "."];
    return ["reset", "HEAD", "--", ...list];
  },
  commit: (p) => {
    const m = message(p.message);
    if (!m) throw Object.assign(new Error("提交说明不能为空"), { code: "invalid_params" });
    const argv = ["commit", "-m", m];
    if (boolSwitch(p, "amend")) argv.push("--amend");
    if (boolSwitch(p, "noVerify")) argv.push("--no-verify");
    return argv;
  },
  switch: (p) => {
    const name = ref(p.branch);
    if (!name) throw Object.assign(new Error("要切到的分支不能为空"), { code: "invalid_params" });
    const argv = ["switch", name];
    if (boolSwitch(p, "create")) argv.splice(1, 0, "-c");
    return argv;
  },
  branch_new: (p) => {
    const name = ref(p.name);
    if (!name) throw Object.assign(new Error("新分支名不能为空"), { code: "invalid_params" });
    return ["branch", name, ref(p.from, "HEAD")];
  },
  fetch: (p) => {
    const argv = ["fetch", "--prune", "--no-tags"];
    if (boolSwitch(p, "all")) argv.push("--all");
    else argv.push(ref(p.remote, "origin"));
    return argv;
  },
  pull: (p) => {
    const argv = ["pull"];
    if (boolSwitch(p, "rebase")) argv.push("--rebase");
    if (boolSwitch(p, "ffOnly")) argv.push("--ff-only");
    const remote = ref(p.remote, "");
    const branch = ref(p.branch, "");
    if (remote) argv.push(remote);
    if (branch) argv.push(branch);
    return argv;
  },
  push: (p) => {
    const argv = ["push"];
    if (boolSwitch(p, "setUpstream")) argv.push("-u");
    const remote = ref(p.remote, "origin");
    const branch = ref(p.branch, "");
    argv.push(remote);
    if (branch) argv.push(branch);
    else argv.push("HEAD");
    return argv;
  },
  push_force: (p) => {
    const argv = ["push"];
    argv.push(boolSwitch(p, "lease") ? "--force-with-lease" : "--force");
    argv.push(ref(p.remote, "origin"), ref(p.branch, "") || "HEAD");
    return argv;
  },
  merge: (p) => {
    const name = ref(p.branch);
    if (!name) throw Object.assign(new Error("要合并的分支不能为空"), { code: "invalid_params" });
    const argv = ["merge"];
    if (boolSwitch(p, "noFF")) argv.push("--no-ff");
    if (boolSwitch(p, "squash")) argv.push("--squash");
    argv.push(name);
    return argv;
  },
  rebase: (p) => {
    const name = ref(p.branch, "");
    const argv = ["rebase"];
    if (boolSwitch(p, "interactive")) argv.push("-i");
    if (name) argv.push(name);
    return argv;
  },
  cherry_pick: (p) => {
    const list = hashes(p.hashes);
    if (!list.length) throw Object.assign(new Error("要摘的提交不能为空"), { code: "invalid_params" });
    return ["cherry-pick", ...list];
  },
  revert: (p) => {
    const list = hashes(p.hashes);
    if (!list.length) throw Object.assign(new Error("要回滚的提交不能为空"), { code: "invalid_params" });
    return ["revert", "--no-edit", ...list];
  },
  tag: (p) => {
    const name = ref(p.name);
    if (!name) throw Object.assign(new Error("标签名不能为空"), { code: "invalid_params" });
    const argv = ["tag"];
    if (boolSwitch(p, "annotate")) argv.push("-a", name, "-m", message(p.message) || name);
    else argv.push(name);
    if (ref(p.at, "")) argv.push(ref(p.at));
    return argv;
  },
  stash: (p) => {
    const argv = ["stash", "push"];
    if (boolSwitch(p, "includeUntracked")) argv.push("--include-untracked");
    const m = message(p.message);
    if (m) argv.push("-m", m);
    const list = paths(p.paths);
    if (list.length) argv.push("--", ...list);
    return argv;
  },
  stash_pop: (p) => {
    const argv = ["stash", "pop"];
    const at = count(p.index, -1);
    if (at >= 0) argv.push(`stash@{${at}}`);
    return argv;
  },
  stash_drop: (p) => ["stash", "drop", `stash@{${count(p.index, 0)}}`],
  reset_hard: (p) => ["reset", "--hard", ref(p.at, "HEAD")],
  clean_fd: () => ["clean", "-fd"],
  branch_del: (p) => {
    const name = ref(p.name);
    if (!name) throw Object.assign(new Error("要删的分支不能为空"), { code: "invalid_params" });
    return ["branch", boolSwitch(p, "force") ? "-D" : "-d", name];
  },
  tag_del: (p) => {
    const name = ref(p.name);
    if (!name) throw Object.assign(new Error("要删的标签不能为空"), { code: "invalid_params" });
    return ["tag", "-d", name];
  },
  restore: (p) => {
    const list = paths(p.paths);
    if (!list.length) throw Object.assign(new Error("没有勾选要放弃的文件"), { code: "invalid_params" });
    return ["restore", "--", ...list];
  },
  /** 冲突收口：只允许三条，参数不带任意 argv。 */
  abort: (_p, state) => {
    if (!state.pending) return ["status", "--short"];
    if (state.pending === "rebase") return ["rebase", "--abort"];
    if (state.pending === "cherry-pick") return ["cherry-pick", "--abort"];
    if (state.pending === "revert") return ["revert", "--abort"];
    return ["merge", "--abort"];
  },
  continue: (_p, state) => {
    if (!state.pending) return ["status", "--short"];
    if (state.pending === "rebase") return ["rebase", "--continue"];
    if (state.pending === "cherry-pick") return ["cherry-pick", "--continue"];
    if (state.pending === "revert") return ["revert", "--continue"];
    if (state.pending === "merge") return ["commit", "--no-edit"];
    return ["status", "--short"];
  },
};

export const GIT_OP_IDS = Object.freeze(Object.keys(OP_BUILDERS));

/** 同一 dir 一次一个写操作：`index.lock` 互踩比慢一点更难查。 */
const queues = new Map<string, Promise<unknown>>();

function serial<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir).toLowerCase();
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

function errorCode(log: string): string {
  // `git merge` 的 `CONFLICT …` / `Automatic merge failed` 走 stdout，不是 stderr；只看 stderr 会把
  // 冲突误判成 op_failed，前端就不会进「只放行中止 / 继续 / handoff」的冲突态。stdout + stderr 一起看。
  // 注意别用宽泛的 `/credential/`：execFile 附带的 `Command failed: git -c credential.interactive=never …`
  // 会把「没有暂存的改动」这种普通失败误判成鉴权失败。只认 git 自己打印的失败句。
  if (/could not read Username|Authentication failed|Permission denied \(publickey\)|fatal: could not read|terminal prompts disabled/i.test(log)) return "auth";
  if (/user\.name|user\.email|Please tell me who you are|unable to auto-detect email/i.test(log)) return "identity";
  if (/CONFLICT|Merge conflict|unmerged|needs merge/i.test(log)) return "conflict";
  if (/local changes|would be overwritten|Your local changes|untracked working tree files/i.test(log)) return "dirty";
  return "op_failed";
}

function blankState(dir: string): GitState {
  return {
    repo: dir, head: "", branch: "", detached: false, empty: true, dirty: 0,
    upstream: "", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [], pending: null,
  };
}

/** 执行一个白名单动词。前端只给 id + params；失败也返回结构化结果，不抛给路由。 */
export async function executeGitOp(dir: string, id: string, params: GitOpParams = {}): Promise<GitExecResult> {
  return serial(dir, async () => {
    const argvTail = ["-C", dir, "-c", "core.fsmonitor=false", "-c", "credential.interactive=never"];
    let before: GitState;
    try {
      before = await gitState(dir);
    } catch (err) {
      // 不是仓库也要给失败卡画出 argv / stderr / state；抛给路由只会得到半份 {ok:false,error}。
      const message = String((err as Error).message ?? err);
      return {
        ok: false, exitCode: 1, argv: argvTail, stdout: "", stderr: message,
        state: blankState(dir), conflicts: [], pending: null, refresh: false, code: "not_repo",
      } satisfies GitExecResult;
    }
    const builder = OP_BUILDERS[id];
    if (!builder) {
      return {
        ok: false, exitCode: 1, argv: argvTail, stdout: "", stderr: `未知操作 id：${id}`,
        state: before, conflicts: [], pending: before.pending, refresh: false, code: "unknown_op",
      } satisfies GitExecResult;
    }
    let args: string[];
    try {
      args = await builder(params, before);
    } catch (err) {
      const e = err as { message?: string; code?: string };
      return {
        ok: false, exitCode: 1, argv: argvTail, stdout: "", stderr: e.message ?? "参数不合法",
        state: before, conflicts: [], pending: before.pending, refresh: false, code: e.code ?? "invalid_params",
      } satisfies GitExecResult;
    }
    const out = await exec(dir, args, { timeout: id === "fetch" || id === "push" || id === "push_force" || id === "pull" ? 60_000 : 20_000 });
    const after = await gitState(dir).catch(() => before);
    invalidateGitCache(dir);
    const pending = after.pending;
    const conflicts = after.conflicts;
    const ok = out.code === 0 && !pending && conflicts.length === 0;
    return {
      ok,
      exitCode: out.code,
      argv: [...argvTail, ...args],
      stdout: out.stdout.slice(0, 200_000),
      stderr: out.stderr.slice(0, 200_000),
      state: after,
      conflicts,
      pending,
      refresh: out.code === 0,
      ...(ok ? {} : { code: errorCode(`${out.stderr}\n${out.stdout}`) }),
    } satisfies GitExecResult;
  });
}

/** 给测试用：看某个 id 拼出来的 argv（不含执行）；避免测试直接复制一份注册表。 */
export function previewGitOp(id: string, params: GitOpParams = {}, state?: Partial<GitState>): string[] | null {
  const builder = OP_BUILDERS[id];
  if (!builder) return null;
  // 参数非法时抛错是执行路径的预期行为；preview 是探针，不该让一条坏数据炸掉整轮验证。
  try {
    return _preview(id, params, state);
  } catch {
    return null;
  }
}

function _preview(id: string, params: GitOpParams = {}, state?: Partial<GitState>): string[] | null {
  const builder = OP_BUILDERS[id];
  if (!builder) return null;
  const fake: GitState = {
    repo: "", head: "HEAD", branch: "HEAD", detached: false, empty: false, dirty: 0,
    upstream: "", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [], pending: null,
    ...state,
  };
  const out = builder(params, fake);
  return Array.isArray(out) ? out : null;
}
