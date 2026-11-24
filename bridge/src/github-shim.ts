/**
 * `gh` 壳（真正的字节在 `<状态目录>/github/bin/gh` 与 `gh.cmd` 里，由 `ensureGithubBin()` 写）。
 *
 * 它做的三件事，顺序不能变：
 *  1. 问桥「这个会话是谁」—— 令牌**一次一取**，不留在 pi 子进程的环境里（否则一次 `printenv`
 *     就把它打进聊天记录）。
 *  2. 有真 gh 就带令牌透传；没有就自己用 REST 实现 PR 核心。
 *  3. 把这次调用的 argv / 退出码 / 输出尾巴回报给桥：桥据此认出 PR 链接、推开面板。
 *
 * 只认 `/api/github/shim/*` 两条回环路由，其余什么都不做 —— 策略与凭据全在桥那边，这里没有第二份。
 */
import { execFile, spawn } from "node:child_process";

const base = process.env.PI_WEB_LOOPBACK ?? "";
const token = process.env.PI_WEB_LOOPBACK_TOKEN ?? "";

interface Identity {
  ok: boolean;
  login: string | null;
  source: string;
  token: string | null;
  realGh: string | null;
  sessionId: string;
  cwd: string;
  api?: string | null;
  error?: string;
}

function die(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

if (!base || !token) {
  die("gh（pi-web-client 的壳）：缺 PI_WEB_LOOPBACK / PI_WEB_LOOPBACK_TOKEN —— 它只能由桥起的 pi 子进程运行。");
}

const argv = process.argv.slice(2);

async function post(pathname: string, body: unknown, timeoutMs = 10_000): Promise<any> {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pi-loopback": token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, error: text };
  }
}

// 桥挂了（或端口不通）也要说人话：一条「fetch failed」的栈对敲 `gh pr list` 的人毫无用处。
let identity: Identity;
try {
  identity = (await post("/api/github/shim/identity", {})) as Identity;
} catch (err: any) {
  die(`gh（壳）：连不上桥（${base}）：${String(err?.message ?? err)}。桥没在跑？重启它之后重试。`);
}
if (!identity.ok) die(`gh（壳）：桥没认出这个会话：${identity.error ?? "未知原因"}`);

// ---------------------------------------------------------------- 记账

/** 输出只留尾巴：记账要的是链接，不是整份日志。 */
const TAIL = 8 * 1024;
let out = "";
let err = "";

async function report(exit: number): Promise<void> {
  try {
    await post("/api/github/shim/report", { argv, exit, stdout: out.slice(-TAIL), stderr: err.slice(-TAIL), login: identity.login }, 3000);
  } catch {
    /* 记账失败不该改变这条命令的结果 */
  }
}

// ---------------------------------------------------------------- 透传真 gh

function passthrough(): Promise<number> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (identity.token) env.GH_TOKEN = identity.token;
    else delete env.GH_TOKEN;
    // 桥里已有的测试缝：用 node 跑一个顶替真 gh 的脚本（Windows 上也能跑）。
    const js = process.env.PI_WEB_GITHUB_REAL_GH_JS;
    const cmd = js ? process.execPath : (identity.realGh as string);
    const args = js ? [js, ...argv] : argv;
    const child = spawn(cmd, args, { env, stdio: ["inherit", "pipe", "pipe"], windowsHide: true });
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString("utf8");
      process.stdout.write(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString("utf8");
      process.stderr.write(b);
    });
    child.on("error", (e) => {
      process.stderr.write(`gh（壳）：真 gh 起不来：${e.message}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// ---------------------------------------------------------------- 内置实现（没装 gh 时）

const API = identity.api ?? "https://api.github.com";

function apiError(status: number, body: any): never {
  if (status === 401) die("gh（壳）：GitHub 不认这个令牌（可能过期或被撤销）");
  die(`gh（壳）：${body?.message ?? `GitHub 回了 ${status}`}`);
}

async function api(pathname: string, init: RequestInit = {}): Promise<any> {
  // 没有令牌也能**读**公开仓库（GitHub 的匿名额度 60 次/小时）；写才必须有一个账号。
  const write = (init.method ?? "GET").toUpperCase() !== "GET";
  if (!identity.token && write) {
    die(
      `gh（壳）：这台机器没装 gh，也没有给 ${identity.login ?? "任何账号"} 存 PAT —— 只能读公开仓库。` +
        `去「GitHub 面板 → 账号」里填一枚 fine-grained PAT。`,
    );
  }
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "pi-web-client",
    "x-github-api-version": "2022-11-28",
    ...(identity.token ? { authorization: `Bearer ${identity.token}` } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${API}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) apiError(res.status, body);
  return body;
}

function git(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["-C", identity.cwd, ...args], { encoding: "utf8", timeout: 10_000, windowsHide: true }, (e, stdout) => resolve(e ? "" : (stdout ?? "").trim()));
  });
}

async function repoName(): Promise<string> {
  const url = await git(["remote", "get-url", "origin"]);
  const ssh = /^git@[\w.-]+:([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  const https = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  const repo = ssh?.[1] ?? https?.[1] ?? "";
  if (!repo) die("gh（壳）：这个目录没有 GitHub 远端（git remote get-url origin 是空的）");
  return repo;
}

function flag(args: string[], ...names: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const name of names) {
      if (a === name) return args[i + 1] ?? "";
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
    }
  }
  return null;
}

function has(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.includes(a));
}

async function prCreate(args: string[]): Promise<number> {
  const repo = await repoName();
  const head = flag(args, "-H", "--head") || (await git(["rev-parse", "--abbrev-ref", "HEAD"]));
  if (!head || head === "HEAD") die("gh（壳）：认不出当前分支（HEAD 是分离的？用 --head 指明）");
  const fill = has(args, "-f", "--fill");
  const info = fill ? await api(`/repos/${repo}`) : null;
  const base = flag(args, "-B", "--base") || String(info?.default_branch ?? "main");
  const title = flag(args, "-t", "--title") || (fill ? await git(["log", "-1", "--pretty=%s"]) : "");
  if (!title) die("gh（壳）：没装 gh 时这条内置实现不做交互式填表 —— 用 --title/--body（或 --fill）给出来");
  const bodyText = flag(args, "-b", "--body") ?? (fill ? await git(["log", "-1", "--pretty=%b"]) : "");
  const draft = has(args, "-d", "--draft");
  const pr = await api(`/repos/${repo}/pulls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, body: bodyText, head, base, draft }),
  });
  process.stdout.write(`${String(pr?.html_url ?? "")}\n`);
  out += String(pr?.html_url ?? "");
  return 0;
}

async function prList(): Promise<number> {
  const repo = await repoName();
  const rows = await api(`/repos/${repo}/pulls?state=open&per_page=20&sort=updated&direction=desc`);
  for (const pr of Array.isArray(rows) ? rows : []) {
    process.stdout.write(`#${pr.number}\t${pr.draft ? "DRAFT\t" : ""}${pr.title}\t${pr.head?.ref} → ${pr.base?.ref}\t${pr.html_url}\n`);
  }
  return 0;
}

async function currentPrNumber(repo: string, state = "all"): Promise<number> {
  const head = (await git(["rev-parse", "--abbrev-ref", "HEAD"])) || "";
  const owner = repo.split("/")[0];
  const rows = await api(`/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=${state}&per_page=1`);
  return Number(rows?.[0]?.number ?? 0);
}

async function prView(args: string[]): Promise<number> {
  const repo = await repoName();
  let number = Number(args.find((a) => /^\d+$/.test(a)) ?? 0);
  if (!number) {
    number = await currentPrNumber(repo);
    if (!number) die("gh（壳）：当前分支还没有 PR");
  }
  const pr = await api(`/repos/${repo}/pulls/${number}`);
  const asJson = flag(args, "--json");
  if (asJson) {
    const bag: Record<string, unknown> = {
      number: pr?.number,
      title: pr?.title,
      state: pr?.state,
      url: pr?.html_url,
      body: pr?.body,
      headRefName: pr?.head?.ref,
      baseRefName: pr?.base?.ref,
      isDraft: pr?.draft,
    };
    const fields = asJson.split(",").map((s) => s.trim()).filter(Boolean);
    const picked = fields.length ? Object.fromEntries(fields.filter((f) => f in bag).map((f) => [f, bag[f]])) : bag;
    process.stdout.write(`${JSON.stringify(picked, null, 2)}\n`);
  } else {
    process.stdout.write(`#${pr?.number} ${pr?.title}\n${pr?.state}${pr?.draft ? "（草稿）" : ""} · ${pr?.head?.ref} → ${pr?.base?.ref}\n${pr?.html_url}\n\n${pr?.body ?? ""}\n`);
  }
  return 0;
}

async function prMerge(args: string[]): Promise<number> {
  const repo = await repoName();
  let number = Number(args.find((a) => /^\d+$/.test(a)) ?? 0);
  if (!number) {
    number = await currentPrNumber(repo, "open");
    if (!number) die("gh（壳）：当前分支没有开着的 PR");
  }
  const method = has(args, "--rebase") ? "rebase" : has(args, "--squash", "-s") ? "squash" : "merge";
  const res = await api(`/repos/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ merge_method: method }),
  });
  process.stdout.write(`${res?.merged ? "已合并" : "没合上"} #${number}（${method}）\n`);
  return res?.merged ? 0 : 1;
}

async function authStatus(): Promise<number> {
  if (!identity.login) {
    process.stderr.write("You are not logged into any GitHub hosts.\n");
    return 1;
  }
  const how =
    identity.source === "session"
      ? "会话选择"
      : identity.source === "project"
        ? "工作区设置"
        : identity.source === "global"
          ? "全局设置"
          : identity.source === "active"
            ? "gh 的 active 账号"
            : "存的 PAT";
  process.stdout.write(`github.com\n  ✓ 以 ${identity.login} 身份工作（${how}）\n  - 真 gh：${identity.realGh ?? "没装，走内置实现"}\n`);
  return 0;
}

async function builtin(): Promise<number> {
  const [cmd, sub] = argv;
  if (cmd === "--version" || cmd === "version") {
    process.stdout.write("gh 的内置实现（pi-web-client 的壳；这台机器没装 GitHub CLI）\n");
    return 0;
  }
  if (cmd === "auth" && sub === "status") return await authStatus();
  if (cmd === "pr") {
    if (sub === "create" || sub === "new") return await prCreate(argv.slice(2));
    if (sub === "list" || sub === "ls") return await prList();
    if (sub === "view") return await prView(argv.slice(2));
    if (sub === "merge") return await prMerge(argv.slice(2));
  }
  process.stderr.write(
    `gh（壳）：这台机器没装 gh，内置实现只覆盖 PR 核心（pr create / list / view / merge、auth status）。\n` +
      `装 gh 之后任意子命令都能透传，而且账号仍由本会话决定：https://cli.github.com/\n` +
      `这条命令是：gh ${argv.join(" ")}\n`,
  );
  return 1;
}

// ---------------------------------------------------------------- main

const exitCode = identity.realGh ? await passthrough() : await builtin();
await report(exitCode);
process.exit(exitCode);
