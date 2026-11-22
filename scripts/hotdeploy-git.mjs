/**
 * 热部署只做一件事：把「暂存本地改动 → 拉分支 → 恢复」这段 git 操作单独拎出来，
 * 好让 worker 和临时仓库测试共用同一份实现。这里不碰进程、不写状态。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function gitIn(repo, args) {
  // windowsHide：热部署 worker 无控制台，不带就每个 git 弹一扇窗。
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  return {
    ok: r.status === 0,
    status: r.status,
    out: String(r.stdout ?? ""),
    err: String(r.stderr ?? ""),
  };
}

const DEFAULT_HOTDEPLOY_PROXY = "http://127.0.0.1:18791";
export { DEFAULT_HOTDEPLOY_PROXY };

/**
 * `git fetch` 每次尝试的等待上限（D375）。libcurl 的连接超时是 300s，直连被墙时
 * 「检查更新」会静默坐满五分钟、界面看起来就是卡死；部署用的 fetch 宁可早点判不通。
 * 直连给得短（本机直连一旦通，握手在 1~2s 内完成）；代理给得长，首次拉取要传对象。
 */
export const FETCH_DIRECT_TIMEOUT_MS = 20_000;
export const FETCH_PROXY_TIMEOUT_MS = 90_000;

/**
 * 全部候选都不通时再试一轮（D376）：网络抖动几秒就好的情况，一次失败即终止太脆。
 * 重试前等 3s，然后把「直连 + 每个代理」原样再走一遍。
 */
export const FETCH_ATTEMPTS = 2;
export const FETCH_RETRY_DELAY_MS = 3_000;

/**
 * 所有尝试加起来的上限（D376）。候选一多，一轮就是 20s + N×90s，两轮能把「检查更新」又拖回五分钟；
 * 到这个预算还没通就收工，错误里带上每个候选的原因。
 */
export const FETCH_TOTAL_BUDGET_MS = 240_000;

/**
 * 换传输兜底（D377）：HTTPS 被整段掉线时，GitHub 的 SSH 端点还常能从 443 走通。
 * 这是一条独立于代理的路 —— 上面所有代理都不通时再试它。
 */
export const FETCH_SSH_TIMEOUT_MS = 25_000;
export const SSH_443_INSTEADOF = "url.ssh://git@ssh.github.com:443/.insteadOf=https://github.com/";

/** 只在 `origin` 是 GitHub 的 HTTPS 地址时才能换成 SSH（私有部署 / 公司 GitLab 不猜）。 */
export function ssh443InsteadOf(originUrl) {
  return /^https:\/\/github\.com\//i.test(String(originUrl ?? "").trim()) ? SSH_443_INSTEADOF : "";
}

/** 统一代理 URL：补 http://、压小写、去末尾斜杠，避免同一代理因写法不同重复尝试。 */
function normalizeProxy(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(withScheme).href.replace(/\/+$/, "");
  } catch {
    return withScheme.replace(/\/+$/, "");
  }
}

/**
 * Windows `ProxyServer` 的两种写法：
 *   `127.0.0.1:7899`                        —— 所有协议共用
 *   `http=127.0.0.1:7899;https=127.0.0.1:7900` —— 分协议
 * 一律换成 `http://host:port`：git/curl 的 `http.proxy` 说的就是「用 HTTP CONNECT 的那个代理」，
 * 跟目的地址是不是 https 无关。
 */
export function parseWindowsProxyServer(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const out = [];
  for (const part of text.includes("=") ? text.split(";") : [text]) {
    const value = part.includes("=") ? part.slice(part.indexOf("=") + 1) : part;
    const proxy = normalizeProxy(value);
    if (proxy && !out.includes(proxy)) out.push(proxy);
  }
  return out;
}

/** `scutil --proxy` 的文本输出 → 代理 URL。只认手动配置的 HTTP/HTTPS；PAC 自动脚本拿不到地址，不猜。 */
export function parseScutilProxy(text) {
  const fields = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(\S+)\s*$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  const out = [];
  for (const [hostKey, portKey] of [["HTTPProxy", "HTTPPort"], ["HTTPSProxy", "HTTPSPort"]]) {
    const host = fields[hostKey];
    const port = fields[portKey];
    if (!host || !port) continue;
    const proxy = normalizeProxy(`${host}:${port}`);
    if (proxy && !out.includes(proxy)) out.push(proxy);
  }
  return out;
}

/**
 * 系统代理（只取「手动配置」那一栏）：Windows 读注册表，macOS 问 scutil，其它平台返回空。
 * 任何失败都当成「没有」—— 热部署不能因为探代理出错而停摆。
 */
export function systemProxyCandidates(platform = process.platform) {
  try {
    if (platform === "win32") {
      const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
      const enabled = execFileSync("reg", ["query", key, "/v", "ProxyEnable"], { encoding: "utf8", windowsHide: true, timeout: 3_000 });
      if (!/0x1\b/.test(enabled)) return [];
      const server = execFileSync("reg", ["query", key, "/v", "ProxyServer"], { encoding: "utf8", windowsHide: true, timeout: 3_000 });
      const m = /ProxyServer\s+REG_SZ\s+(.+)/.exec(server);
      return m ? parseWindowsProxyServer(m[1]) : [];
    }
    if (platform === "darwin") {
      return parseScutilProxy(execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 3_000, windowsHide: true }));
    }
  } catch {
    // 读不到就是没有。
  }
  return [];
}

/**
 * pi 自己的代理设置（`~/.pi/agent/settings.json` 的 `httpProxy`，设置页「HTTP 代理」）。
 * 扩展市场读的是同一份（`bridge/src/market.ts` 的 `proxyUrl()`）：用户界面上填一次，两边都该用上。
 */
export function readPiHttpProxy(env = process.env) {
  const dir = env.PI_AGENT_DIR || (env.PI_CODING_AGENT_DIR ? String(env.PI_CODING_AGENT_DIR).replace(/^~(?=$|[\\/])/, os.homedir()) : "") || path.join(os.homedir(), ".pi", "agent");
  try {
    const raw = fs.readFileSync(path.join(dir, "settings.json"), "utf8").trim();
    const settings = raw ? JSON.parse(raw) : {};
    return typeof settings.httpProxy === "string" ? normalizeProxy(settings.httpProxy) : "";
  } catch {
    return "";
  }
}

/**
 * 热部署 fetch 的代理候选，按可信度排：pi 设置里显式填的 → 系统代理 → 当前进程 env → 历史默认端口。
 * 同一代理只留一次。**纯函数**：系统代理由调用方探好后从 `extra.system` 传进来，好测。
 */
export function proxyCandidates(env = process.env, extra = {}) {
  const out = [];
  const push = (value) => {
    const proxy = normalizeProxy(value);
    if (proxy && !out.includes(proxy)) out.push(proxy);
  };
  push(extra.httpProxy);
  for (const value of extra.system ?? []) push(value);
  for (const key of ["BILLION_CONTEXT_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) push(env[key]);
  push(DEFAULT_HOTDEPLOY_PROXY);
  return out;
}

/** worker 用的那份：先把 pi 设置和系统代理读出来，再交给 `proxyCandidates()` 排序。 */
export function resolveProxyCandidates(env = process.env) {
  return proxyCandidates(env, { httpProxy: readPiHttpProxy(env), system: systemProxyCandidates() });
}

/** `git stash list --format=%gd%x09%H%x09%s`：按唯一 message 找，别盲取 stash@{0}。 */
export function findStash(repo, message) {
  const r = gitIn(repo, ["stash", "list", "--format=%gd%x09%H%x09%s"]);
  if (!r.ok) return null;
  for (const line of r.out.split(/\r?\n/)) {
    const [ref, sha, subject] = line.split("\t");
    // stash 的 commit subject 是「On <branch>: <message>」，message 是我们生成的唯一串。
    if (ref && sha && (subject === message || subject.endsWith(`: ${message}`))) return { ref, sha, subject };
  }
  return null;
}

/** 暂存全部改动（含未跟踪、不含 ignored），成功后必须能在 stash list 里按 message 找到。 */
export function stashPush(repo, message) {
  const r = gitIn(repo, ["stash", "push", "--include-untracked", "-m", message]);
  if (!r.ok) return { ok: false, created: false, why: `git stash push 失败：${(r.err || r.out).trim().slice(-800)}` };
  const entry = findStash(repo, message);
  // push 已经成功、只是 find 不到：create 标记让 worker 把 message 写进状态，至少用户知道去哪找。
  if (!entry) return { ok: false, created: true, why: `git stash push 执行了，但 stash list 里找不到 ${message}` };
  return { ok: true, entry };
}

/**
 * 恢复 stash。只恢复工作区，不还原暂存区：`pop --index` 在 index 冲突时可能已经落地
 * 文件却返回非零，worker 会误判成没恢复。热部署只承诺工作区内容回来，index 状态不是契约。
 * 冲突时 git 会保留 stash 不动，worker 应该中止部署、让旧进程继续跑。
 */
export function stashRestore(repo, message) {
  const entry = findStash(repo, message);
  if (!entry) return { ok: false, why: `找不到 stash「${message}」；可能已被手动 pop/drop` };
  const r = gitIn(repo, ["stash", "pop", entry.ref]);
  if (!r.ok) return { ok: false, why: `git stash pop ${entry.ref} 失败：${(r.err || r.out).trim().slice(-1000)}` };
  return { ok: true, entry };
}
