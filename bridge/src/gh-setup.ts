/**
 * 「这台机器没有 GitHub CLI / 没登录」时，在页面里把它装上、登录上（D425）。
 *
 * 评审（`gitpr.ts`）与 GitHub 面板原先都只认真 `gh`：没装就是一句 `gh_missing`，
 * 没登录就去终端里手敲 `gh auth login`。这里补上缺的那一段，并且**让桥自己可被页面驱动**：
 *
 * - `ghSetupStatus()`：装没装、哪一版、登录了谁、这台机器能用哪个包管理器、会跑哪条命令。
 * - `installGh()`：spawn 包管理器，逐行把输出交给页面；装完清掉 gh 的缓存并重新探测
 *   （PATH 不会在**已经跑起来的**桥进程里刷新，所以 `github.ts` 还会按已知安装位置再找一遍）。
 * - `loginGh()`：spawn `gh auth login --web`，把一次性码与 `github.com/login/device` 交给页面，
 *   子进程退出 0 就算登录完成。**不能经壳跑**：壳会注入 `GH_TOKEN`，gh 会拒绝存凭据
 *   （本机实测：「The value of the GH_TOKEN environment variable is being used for authentication.」）。
 * - `cancelGhSetup()`：用户点「取消」时杀掉那一条。
 *
 * 一次性码是凭据级的东西：`index.ts` 只把它发给发起的那条连接，不 broadcast。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ghAuthState, ghInvocation, ghVersion, resetGithubCaches, resolveGhBinary, type GithubCtx } from "./github.ts";
import { piChildEnv } from "./paths.ts";

/** 这台机器上能用的安装方式。空串 = 一个都没探到，只能照着官网手动装。 */
export type GhManagerId = "winget" | "brew" | "apt-get" | "dnf" | "pacman" | "snap" | "";

export interface GhInstallPlan {
  manager: GhManagerId;
  /** 要跑 / 要抄的那条命令（页面上原样显示，能复制）。 */
  text: string;
  /** 桥可以代跑的那条；`null` = 只能手动（没有包管理器，或需要 root 密码而桥拿不到）。 */
  run: { cmd: string; args: string[] } | null;
  /** 会不会弹提权（UAC / sudo 密码），界面提前说一句，别让人以为卡住了。 */
  elevated: boolean;
  /** 手动安装的官网。 */
  url: string;
}

export interface GhSetupStatus {
  installed: boolean;
  path: string;
  version: string;
  loggedIn: boolean;
  accounts: { login: string; active: boolean }[];
  /** 装了但读不出登录态时的原文（其余情况为空串）。 */
  error: string;
  platform: string;
  plan: GhInstallPlan;
}

export type GhSetupOp = "install" | "login";
export type GhSetupEvent = {
  op: GhSetupOp;
  kind: "started" | "log" | "code" | "url" | "done" | "error";
  line?: string;
  /** 设备码（`XXXX-XXXX`）。 */
  code?: string;
  /** 浏览器授权地址。 */
  url?: string;
  ok?: boolean;
  error?: string;
  status?: GhSetupStatus;
};
export type GhSetupSink = (event: GhSetupEvent) => void;

const MANUAL_URL = "https://cli.github.com/";
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LINE_MAX = 300;

const EXTS = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];

/** PATH 上找一条命令（与 `github.ts` 的 findRealGh 同一套口径，但找的是任意名字）。 */
function findCommand(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of EXTS) {
      const file = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(file).isFile()) {
          fs.accessSync(file, fs.constants.X_OK);
          return file;
        }
      } catch {
        /* 继续找 */
      }
    }
  }
  return null;
}

/**
 * 这台机器该用哪条命令装 gh。纯函数：平台与「有没有这条命令」都从参数进来，单测不用改环境。
 *
 * Linux 上 apt / dnf / pacman / snap 都要 root：桥没有 tty，`sudo` 会停在密码提示上假装卡死，
 * 所以只有**本来就是 root** 时才代跑；其余情况把命令摆出来让人自己抄。
 */
export function installPlan(
  platform: NodeJS.Platform = process.platform,
  has: (name: string) => boolean = (name) => findCommand(name) !== null,
  isRoot: boolean = typeof process.getuid === "function" && process.getuid() === 0,
): GhInstallPlan {
  const none: GhInstallPlan = { manager: "", text: "", run: null, elevated: false, url: MANUAL_URL };
  if (platform === "win32") {
    if (!has("winget")) return none;
    return {
      manager: "winget",
      text: "winget install --id GitHub.cli -e",
      run: {
        cmd: "winget",
        args: ["install", "--id", "GitHub.cli", "-e", "--source", "winget", "--accept-source-agreements", "--accept-package-agreements"],
      },
      // GitHub.cli 是 MSI：winget 必然过一次 UAC。提前说，别让人以为按钮没反应。
      elevated: true,
      url: MANUAL_URL,
    };
  }
  if (platform === "darwin") {
    if (!has("brew")) return none;
    return { manager: "brew", text: "brew install gh", run: { cmd: "brew", args: ["install", "gh"] }, elevated: false, url: MANUAL_URL };
  }
  // linux（以及其它 POSIX）
  if (has("brew")) {
    return { manager: "brew", text: "brew install gh", run: { cmd: "brew", args: ["install", "gh"] }, elevated: false, url: MANUAL_URL };
  }
  const table: { id: GhManagerId; text: string; cmd: string; args: string[] }[] = [
    { id: "apt-get", text: "sudo apt-get install -y gh", cmd: "apt-get", args: ["install", "-y", "gh"] },
    { id: "dnf", text: "sudo dnf install -y gh", cmd: "dnf", args: ["install", "-y", "gh"] },
    { id: "pacman", text: "sudo pacman -S --noconfirm github-cli", cmd: "pacman", args: ["-S", "--noconfirm", "github-cli"] },
    { id: "snap", text: "sudo snap install gh", cmd: "snap", args: ["install", "gh"] },
  ];
  for (const row of table) {
    if (!has(row.id)) continue;
    return { manager: row.id, text: row.text, run: isRoot ? { cmd: row.cmd, args: row.args } : null, elevated: true, url: MANUAL_URL };
  }
  return none;
}

/** 装没装、哪一版、登录了谁、这台机器怎么装。 */
export async function ghSetupStatus(
  ctx: Pick<GithubCtx, "ghPath"> = {},
  opts: { fresh?: boolean } = {},
): Promise<GhSetupStatus> {
  const key = String(ctx.ghPath ?? "");
  // 面板每次打开、每条 `gh.setup.status` 都会来问一次：5 秒内复用，别让匿名隧道
  // 连点就把 `gh --version` / `gh auth status` 变成子进程风暴（也省掉一次翻倍）。
  if (!opts.fresh && statusMemo && statusMemo.key === key && Date.now() - statusMemo.at < STATUS_MEMO_MS) {
    return statusMemo.value;
  }
  const plan = installPlan();
  const bin = resolveGhBinary(ctx);
  if (!bin) {
    const empty: GhSetupStatus = { installed: false, path: "", version: "", loggedIn: false, accounts: [], error: "", platform: process.platform, plan };
    statusMemo = { key, at: Date.now(), value: empty };
    return empty;
  }
  const version = opts.fresh ? await ghVersion(bin) : await ghVersionCached(bin);
  const auth = await ghAuthState(ctx);
  const accounts = auth.accounts;
  const value: GhSetupStatus = {
    installed: true,
    path: bin,
    version,
    loggedIn: accounts.length > 0,
    accounts,
    error: auth.state === "logged-out" ? auth.error : "",
    platform: process.platform,
    plan,
  };
  statusMemo = { key, at: Date.now(), value };
  return value;
}

/** 隧道访客只拿得到已有的一份：不让匿名请求触发新的 `gh` 子进程（D425）。 */
export function ghSetupCached(): GhSetupStatus | null {
  return statusMemo?.value ?? null;
}

// ---------------------------------------------------------------- 子进程的公共部分

type GhSetupOwner = object;

let active: { op: GhSetupOp; child: ChildProcess; cancelled: boolean; timedOut: boolean; owner: GhSetupOwner | null } | null = null;

/** `gh --version` 的 30 秒缓存：状态帧很密，版本号不会每秒钟变一次。 */
let versionMemo: { bin: string; at: number; value: string } | null = null;
async function ghVersionCached(bin: string): Promise<string> {
  if (versionMemo && versionMemo.bin === bin && Date.now() - versionMemo.at < 30_000) return versionMemo.value;
  const value = await ghVersion(bin);
  versionMemo = { bin, at: Date.now(), value };
  return value;
}

/** 同一个探测结果的缓存：见 `ghSetupStatus` 的理由。 */
let statusMemo: { key: string; at: number; value: GhSetupStatus } | null = null;
const STATUS_MEMO_MS = 5_000;

/** 正在装 / 正在登录时是哪个操作（没有就是空串）。 */
export function ghSetupBusy(): GhSetupOp | "" {
  return active?.op ?? "";
}

/**
 * 杀掉正在跑的那一条；没在跑就返回 false。
 *
 * `owner` = 发起它的那条连接：一个页签关掉只能停自己那份，不能把另一个页签正在跑的登录也杀。
 */
export function cancelGhSetup(owner?: GhSetupOwner): boolean {
  const run = active;
  if (!run) return false;
  if (owner && run.owner !== owner) return false;
  run.cancelled = true;
  try {
    run.child.kill();
  } catch {
    /* 已经退了 */
  }
  return true;
}

/** 子进程错误统一成一句话（`unknown` 不要 `any`）。 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "");
}

const clean = (line: string): string =>
  line
    // winget / brew 输出里有 ANSI 上色与进度控制符，原样塞进 <pre> 会是一堆乱码。
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim()
    .slice(0, LINE_MAX);

/** 逐行读子进程输出：`\r`（进度条）与 `\n` 都当分隔，空行丢掉，尾巴留一点给下一次。 */
function lineReader(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let buf = "";
  return {
    push(chunk: string) {
      buf += chunk;
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = clean(part);
        if (line) onLine(line);
      }
      if (buf.length > 4000) {
        const line = clean(buf);
        buf = "";
        if (line) onLine(line);
      }
    },
    flush() {
      const line = clean(buf);
      buf = "";
      if (line) onLine(line);
    },
  };
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((s) => clean(s))
      .find((s) => s.length > 0) ?? ""
  );
}

// ---------------------------------------------------------------- 安装

export interface GhSetupResult {
  ok: boolean;
  error: string;
  status: GhSetupStatus;
}

/**
 * 代跑包管理器装 gh。返回时状态已经重新探过（装上的话 `installed` 立刻变 true，
 * 不用等页面刷新 —— 也不会因为「PATH 没刷新」而假装没装）。
 */
export async function installGh(
  ctx: Pick<GithubCtx, "ghPath"> = {},
  sink: GhSetupSink = () => {},
  owner: GhSetupOwner | null = null,
): Promise<GhSetupResult> {
  const plan = installPlan();
  if (active) {
    const error = active.op === "install" ? "已经在装了，等它跑完。" : "正在登录 gh，先等它结束或点取消。";
    const status = await ghSetupStatus(ctx, { fresh: true });
    sink({ op: "install", kind: "error", error, status });
    return { ok: false, error, status };
  }
  if (!plan.run) {
    const error = plan.text ? "这条命令需要管理员权限：请把它复制到终端里执行。" : "这台机器上没有可用的包管理器，请按官网手动安装。";
    const status = await ghSetupStatus(ctx, { fresh: true });
    sink({ op: "install", kind: "error", error, status });
    return { ok: false, error, status };
  }
  // 闭包里 TS 不再收窄 `plan.run`：先固定下来，下面不再用 `!`。
  const runCmd = plan.run;
  sink({ op: "install", kind: "started", line: plan.text });
  const result = await new Promise<{ ok: boolean; error: string }>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(runCmd.cmd, runCmd.args, {
        env: piChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // .cmd/.bat（npm 全局装的包装脚本）在 Node 的新版本里不加 shell 直接 EINVAL。
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(runCmd.cmd),
      });
    } catch (err) {
      resolve({ ok: false, error: `起不来 ${runCmd.cmd}：${errMsg(err)}` });
      return;
    }
    const run = { op: "install" as const, child, cancelled: false, timedOut: false, owner };
    active = run;
    // spawn 失败时 Node 先 `error` 再 `close`：`settled` 让后面那次不再重复收尾。
    let settled = false;
    const settle = (value: { ok: boolean; error: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const tail: string[] = [];
    const out = lineReader((line) => {
      tail.push(line);
      if (tail.length > 30) tail.shift();
      sink({ op: "install", kind: "log", line });
    });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => out.push(chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => out.push(chunk));
    const timer = setTimeout(() => {
      run.timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
    }, INSTALL_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      if (active === run) active = null;
      settle({ ok: false, error: `起不来 ${runCmd.cmd}：${errMsg(err)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (active === run) active = null;
      out.flush();
      if (run.cancelled) settle({ ok: false, error: "已取消。" });
      else if (run.timedOut) settle({ ok: false, error: "安装超时（10 分钟）。" });
      else if (code === 0) settle({ ok: true, error: "" });
      else settle({ ok: false, error: firstLine(tail.join("\n")) || `安装命令退出码 ${code ?? "?"}` });
    });
  });
  // 装完 PATH 不会在桥进程里刷新：resetGithubCaches + 已知安装位置探测（github.ts）一起兜住。
  resetGithubCaches();
  const status = await ghSetupStatus(ctx, { fresh: true });
  const ok = result.ok && status.installed;
  const error = ok ? "" : result.ok && !status.installed ? "命令跑完了，但还没找到 gh；试试「重新检测」，或重启一下桥。" : result.error;
  sink({ op: "install", kind: ok ? "done" : "error", ok, error, status });
  return { ok, error, status };
}

// ---------------------------------------------------------------- 登录

const CODE_RE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i;
const URL_RE = /(https:\/\/github\.com\/login\/device)/i;

/** 从 gh 的输出里认一次性码 / 授权地址（也是单测的入口，两个域名以外的 URL 不认）。 */
export function parseLoginHint(text: string): { code: string; url: string } {
  return { code: CODE_RE.exec(text)?.[1] ?? "", url: URL_RE.exec(text)?.[1] ?? "" };
}

/**
 * `gh auth login --web` 的设备码流程。
 *
 * 为什么走真 gh 的交互命令而不是自己打 HTTP：一次性码、设备轮询、凭据落进 keyring / hosts.yml
 * 都由 gh 负责，我们照抄只会多一套要维护的 OAuth 客户端；实测 stdin 关闭时它照样跑
 * （打印 code + URL 后轮询，授权完成退出 0）。
 */
export async function loginGh(
  ctx: Pick<GithubCtx, "ghPath"> = {},
  sink: GhSetupSink = () => {},
  owner: GhSetupOwner | null = null,
): Promise<GhSetupResult> {
  if (active) {
    const error = active.op === "login" ? "已经在登录了，等浏览器里确认完。" : "正在装 gh，等它跑完再登录。";
    const status = await ghSetupStatus(ctx, { fresh: true });
    sink({ op: "login", kind: "error", error, status });
    return { ok: false, error, status };
  }
  const bin = resolveGhBinary(ctx);
  if (!bin) {
    const error = "这台机器还没装 gh。";
    const status = await ghSetupStatus(ctx, { fresh: true });
    sink({ op: "login", kind: "error", error, status });
    return { ok: false, error, status };
  }
  const { cmd, prefix } = ghInvocation(ctx);
  // 壳会注入 GH_TOKEN，gh 见到它就拒绝把凭据写进 hosts.yml；这里必须摘干净。
  const env = piChildEnv();
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  const args = [...prefix, "auth", "login", "--web", "--git-protocol", "https", "--hostname", "github.com"];
  sink({ op: "login", kind: "started", line: "gh auth login --web" });
  const result = await new Promise<{ ok: boolean; error: string }>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: `起不来 gh：${errMsg(err)}` });
      return;
    }
    const run = { op: "login" as const, child, cancelled: false, timedOut: false, owner };
    active = run;
    // 同 installGh：`error` 之后还会来一次 `close`，只收尾一次。
    let settled = false;
    const settle = (value: { ok: boolean; error: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let code = "";
    let url = "";
    const tail: string[] = [];
    const out = lineReader((line) => {
      tail.push(line);
      if (tail.length > 40) tail.shift();
      sink({ op: "login", kind: "log", line });
      const hint = parseLoginHint(line);
      if (hint.code && hint.code !== code) {
        code = hint.code;
        sink({ op: "login", kind: "code", code });
      }
      if (hint.url && hint.url !== url) {
        url = hint.url;
        sink({ op: "login", kind: "url", url });
      }
    });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => out.push(chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => out.push(chunk));
    const timer = setTimeout(() => {
      run.timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
    }, LOGIN_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      if (active === run) active = null;
      settle({ ok: false, error: `起不来 gh：${errMsg(err)}` });
    });
    child.on("close", (exit) => {
      clearTimeout(timer);
      if (active === run) active = null;
      out.flush();
      if (run.cancelled) settle({ ok: false, error: "已取消。" });
      else if (run.timedOut) settle({ ok: false, error: "登录超时（10 分钟）：一次性码过期了，再点一次登录。" });
      else if (exit === 0) settle({ ok: true, error: "" });
      else settle({ ok: false, error: firstLine(tail.join("\n")) || `gh auth login 退出码 ${exit ?? "?"}` });
    });
  });
  resetGithubCaches();
  const status = await ghSetupStatus(ctx, { fresh: true });
  const ok = result.ok && status.loggedIn;
  const error = ok ? "" : result.ok && !status.loggedIn ? "gh 退出了，但还没读到登录态；点「重新检测」再试。" : result.error;
  sink({ op: "login", kind: ok ? "done" : "error", ok, error, status });
  return { ok, error, status };
}
