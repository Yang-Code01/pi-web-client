/**
 * 会出网的几件事（评审取 PR、PR 面板问 `gh`）怎么走代理：直连 → 代理候选 → 全失败再整轮重试。
 *
 * 为什么要有这一层：评审的 `git fetch` / `gh` 以前只有直连一条路（`run()` 直接把 `process.env`
 * 塞给子进程），直连被中间设备重置时整次评审就死在那一步，界面只看到 git 的 stderr 首行
 * （现场看到的那句`error: RPC failed; curl 56 Recv failure: Connection was reset`）。热部署早就按
 * D376 做了「候选顺序 + 每路限时 + 整轮重试」，这里把同一套规则给评审用上。
 *
 * 候选分两段，**没有任何写死的端口**（D272 / D402）：
 *   1. 有人明确说过用哪个：pi 设置里的 `httpProxy` → 系统代理（win 注册表 / macOS scutil）→ 进程 env；
 *   2. 谁都没说过、直连又挂了：现探 —— 看本机哪些端口在听，逐个用 `CONNECT` 问一句「你是代理吗」。
 * 第二段只在第一段全失败后才跑（`viaRoutes` 的 `discover` 钩子），探测结果缓存 60s。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { agentDir } from "./paths.ts";

/** 每路限时与重试节奏（与 D375 / D376 的数字对齐）。 */
export const FETCH_DIRECT_TIMEOUT_MS = 20_000;
export const FETCH_PROXY_TIMEOUT_MS = 90_000;
export const FETCH_ATTEMPTS = 2;
export const FETCH_RETRY_DELAY_MS = 3_000;
export const FETCH_TOTAL_BUDGET_MS = 240_000;

/** 传给子进程的代理环境变量（大小写都设，git/curl 两套都认）。 */
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;

/** 统一代理 URL：补 http://、去末尾斜杠，避免同一个代理因写法不同被试两次。 */
export function normalizeProxy(value: unknown): string {
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
 *   `127.0.0.1:7899`                          —— 所有协议共用
 *   `http=127.0.0.1:7899;https=127.0.0.1:7900` —— 分协议
 * 一律换成 `http://host:port`：`https_proxy` 说的是「用 CONNECT 连的那个 HTTP 代理」，与目的协议无关。
 */
export function parseWindowsProxyServer(raw: unknown): string[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const out: string[] = [];
  for (const part of text.includes("=") ? text.split(";") : [text]) {
    const value = part.includes("=") ? part.slice(part.indexOf("=") + 1) : part;
    const proxy = normalizeProxy(value);
    if (proxy && !out.includes(proxy)) out.push(proxy);
  }
  return out;
}

/** `scutil --proxy` 的文本输出 → 代理 URL。只认手动配置的 HTTP/HTTPS；PAC 拿不到地址，不猜。 */
export function parseScutilProxy(text: unknown): string[] {
  const fields: Record<string, string> = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(\S+)\s*$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  const out: string[] = [];
  for (const [hostKey, portKey] of [
    ["HTTPProxy", "HTTPPort"],
    ["HTTPSProxy", "HTTPSPort"],
  ]) {
    const host = fields[hostKey];
    const port = fields[portKey];
    if (!host || !port) continue;
    const proxy = normalizeProxy(`${host}:${port}`);
    if (proxy && !out.includes(proxy)) out.push(proxy);
  }
  return out;
}

/** 系统代理（只取手动配置那一栏）：Windows 读注册表，macOS 问 scutil。读不到就是没有。 */
export function systemProxyCandidates(platform: string = process.platform): string[] {
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
    // 读不到就是没有：探代理失败不该让评审停摆。
  }
  return [];
}

/**
 * pi 自己的代理设置（`~/.pi/agent/settings.json` 的 `httpProxy`，设置页「HTTP 代理」）。
 * 扩展市场读的是同一份（`market.ts` 的 `proxyUrl()`）：用户在界面上填一次，三处都该用上。
 * `agentDir()` 每次调用时读 env，所以测试给一个临时 `PI_AGENT_DIR` 就能造这份设置。
 */
export function readPiHttpProxy(): string {
  try {
    const raw = fs.readFileSync(path.join(agentDir(), "settings.json"), "utf8").trim();
    const settings = raw ? JSON.parse(raw) : {};
    return typeof settings?.httpProxy === "string" ? normalizeProxy(settings.httpProxy) : "";
  } catch {
    return "";
  }
}

/**
 * 代理候选，按可信度排：pi 设置里显式填的 → 系统代理 → 当前进程 env，同一代理只留一次。
 * **纯函数**：系统代理由调用方探好后从 `extra.system` 传进来，好测。
 *
 * 这里没有「历史默认端口」那种兜底：写死端口等于把候选绑到某台机器上（18791 就是热部署
 * 留下的一个）。谁都没配时交给 `discoverLocalProxies()` 现探。
 *
 * `BILLION_CONTEXT_PROXY` 故意不在名单里：它是模型网关的占位主机名（`http://billion-context.inline`），
 * 不是 HTTP 出口代理，拿去连只是一次白等满 90s。hotdeploy 那边还留着它，两份实现的差异由测试锁住。
 */
export function proxyCandidates(env: NodeJS.ProcessEnv = process.env, extra: { httpProxy?: unknown; system?: unknown[] } = {}): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    const proxy = normalizeProxy(value);
    if (proxy && !out.includes(proxy)) out.push(proxy);
  };
  push(extra.httpProxy);
  for (const value of extra.system ?? []) push(value);
  for (const key of PROXY_KEYS) push(env[key]);
  return out;
}

/** 真跑时用的那份：先把 pi 设置与系统代理读出来，再交给 `proxyCandidates()` 排序。
 * `env` 可注入：单测传一个干净的环境，别让本机挂的 `ALL_PROXY` 之类混进断言。 */
export function resolveProxyCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return proxyCandidates(env, { httpProxy: readPiHttpProxy(), system: systemProxyCandidates() });
}

// ---------------------------------------------------------------------------
// 现探：本机在听的端口里，哪几个是 HTTP 代理
// ---------------------------------------------------------------------------

/** 一个 LISTENING 的本地地址。`host` 已归一到「能拿出来连」的形式。 */
export interface Listener {
  host: string;
  port: number;
}

const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|::1)$/;
/** 通配监听（`0.0.0.0` / `::` / `*`）：本机一定有它的一个环回入口。 */
const WILDCARD = /^(?:0\.0\.0\.0|::|\*)$/;

function toListener(rawHost: string, rawPort: string): Listener | null {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  // netstat / lsof / ss 的 IPv6 一律带方括号（`[::1]:7899`）：先摘掉再比，否则 `::1`
  // 这条永远是死代码。`Listener.host` 保持裸地址，直接给 net.connect 用；拼 URL 时再补括号。
  const host = rawHost.replace(/^\[(.+)\]$/, "$1");
  if (WILDCARD.test(host)) return { host: "127.0.0.1", port };
  if (!LOOPBACK.test(host)) return null;
  return { host, port };
}

/**
 * 把 `netstat` / `lsof` / `ss` 的输出解成本机在听的地址，只留环回与通配，去重后按端口排。
 * 三家的形状不一样，所以各一个正则；不认识的行直接跳过（宁可少探一个，不要报错）。
 */
export function parseListeners(text: string, platform: string = process.platform): Listener[] {
  const seen = new Set<string>();
  const out: Listener[] = [];
  const add = (host: string, port: string) => {
    const listener = toListener(host, port);
    if (!listener) return;
    const key = `${listener.host}:${listener.port}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(listener);
  };
  const source = String(text ?? "");
  if (platform === "win32") {
    //   TCP    127.0.0.1:7899     0.0.0.0:0      LISTENING    1234
    for (const m of source.matchAll(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\b/gim)) add(m[1], m[2]);
  } else if (platform === "darwin") {
    //  lsof -nP -iTCP -sTCP:LISTEN -F n  →  一行一个 "n127.0.0.1:7899"（也有 nTCP，忽略）
    for (const m of source.matchAll(/^n(\S+):(\d+)\s*$/gm)) add(m[1], m[2]);
  } else {
    //  LISTEN 0 4096 127.0.0.1:7899 0.0.0.0:*
    for (const m of source.matchAll(/^\S+\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+/gm)) add(m[1], m[2]);
  }
  return out.sort((a, b) => a.port - b.port);
}

/** 问一句「这个端口是不是 HTTP 代理」：发一个不依赖本机 DNS 的 `CONNECT`，看回的第一行。 */
export function probeHttpProxy(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("error", () => done(false));
    socket.on("close", () => done(false));
    socket.on("connect", () => {
      // 200 = 代理同意开隧道；407 = 它确实是代理，只是要鉴权。别的（400/404/405…）都不是。
      socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    });
    socket.on("data", (chunk: Buffer) => {
      const first = chunk.toString("latin1");
      const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(first);
      if (m) done(m[1] === "200" || m[1] === "407");
      else if (first.length > 512) done(false);
    });
  });
}

/**
 * 系统里所有在听的本机地址（拉一条命令，失败就是空）。
 *
 * 代理探测（`probeProxy()`）靠它判断「某个端口上有没有人听」，所以这里只能给**在听**的
 * 那些地址，连不通的/刚关掉的都不该出现。
 */
export function listListeners(platform: string = process.platform): Listener[] {
  try {
    // 三个平台各一条：写成 if/else 而不是嵌套三元，读的人不用对着 `:` 数层级。
    let cmd = "ss";
    let args = ["-ltn"];
    if (platform === "win32") {
      cmd = "netstat";
      args = ["-ano", "-p", "tcp"];
    } else if (platform === "darwin") {
      cmd = "lsof";
      args = ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "n"];
    }
    return parseListeners(execFileSync(cmd, args, { encoding: "utf8", timeout: 5_000, windowsHide: true }), platform);
  } catch {
    return [];
  }
}

/**
 * 现探本机的 HTTP 代理：列出在听的环回端口，并行问一遍「你是代理吗」，按端口序交出命中的。
 * `listeners` / `probe` 可注入，测试不必真去探整台机器。
 */
export async function discoverLocalProxies(
  opts: {
    listeners?: () => Listener[];
    probe?: (host: string, port: number) => Promise<boolean>;
    /** 一次最多探几个端口（机器上跑着几十个服务时别把自己拖慢）。 */
    limit?: number;
  } = {},
): Promise<string[]> {
  const listeners = (opts.listeners ?? listListeners)().slice(0, opts.limit ?? 64);
  if (!listeners.length) return [];
  const probe = opts.probe ?? probeHttpProxy;
  const verdicts = await Promise.all(
    listeners.map(async (listener) => {
      try {
        return { listener, ok: await probe(listener.host, listener.port) };
      } catch {
        return { listener, ok: false };
      }
    }),
  );
  const out: string[] = [];
  for (const { listener, ok } of verdicts) {
    // IPv6 拼 URL 必须带方括号（`http://[::1]:7899`），`net.connect` 那边则要裸地址。
    const host = listener.host.includes(":") ? `[${listener.host}]` : listener.host;
    const proxy = ok ? normalizeProxy(`${host}:${listener.port}`) : "";
    if (proxy && !out.includes(proxy)) out.push(proxy);
  }
  return out;
}

/** 现探结果在进程里缓存一小会儿：一次评审要发好几条命令，不必每条都 `netstat` 一遍。 */
const DISCOVERY_TTL_MS = 60_000;
let discovery: { at: number; list: string[] } | null = null;

/** 给 `viaRoutes` 的 `discover` 钩子用：只在「谁都没配代理、直连又挂了」时才被调到。 */
export async function discoverLocalProxyCandidates(): Promise<string[]> {
  if (discovery && Date.now() - discovery.at < DISCOVERY_TTL_MS) return discovery.list;
  const list = await discoverLocalProxies();
  discovery = { at: Date.now(), list };
  return list;
}

// ---------------------------------------------------------------------------
// 路由：直连 → 代理候选 → 再整轮
// ---------------------------------------------------------------------------

export interface RoutePlan {
  /** 直连这一路给多少毫秒。 */
  directMs: number;
  /** 每个代理候选给多少毫秒。 */
  proxyMs: number;
  /** 整轮最多来几次（1 = 不重试）。 */
  attempts: number;
  /** 两轮之间等多久。 */
  retryMs: number;
  /** 全部尝试加起来的上限，超了就不再起新的。 */
  budgetMs: number;
}

/** 取 PR 提交用 D376 的数：直连 20s、代理 90s、两轮、总共 4 分钟。 */
export const FETCH_PLAN: RoutePlan = {
  directMs: FETCH_DIRECT_TIMEOUT_MS,
  proxyMs: FETCH_PROXY_TIMEOUT_MS,
  attempts: FETCH_ATTEMPTS,
  retryMs: FETCH_RETRY_DELAY_MS,
  budgetMs: FETCH_TOTAL_BUDGET_MS,
};

/** `gh` 的小请求：面板等人看，别按 fetch 的预算拖。 */
export const GH_PLAN: RoutePlan = { directMs: 20_000, proxyMs: 40_000, attempts: 1, retryMs: 0, budgetMs: 70_000 };

/**
 * 一次尝试能拿到的东西：成功给值，失败给一句人话（通常是 stderr 首行）。
 *
 * `stop: true` 表示「换一条路也没用」—— 对端已经明确回答了（`GraphQL: Could not resolve to a
 * Repository…`、401/403），失败跟走不走代理无关。这时不再换代理、不再整轮重试，直接把这一句
 * 交给界面；否则用户看到的是「直连：…；代理 …：…」两条一模一样的答案，以为是网络问题。
 */
export type RouteAttempt<T> = (
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<{ ok: true; value: T } | { ok: false; err: string; stop?: boolean }>;

export type RouteResult<T> = { ok: true; value: T; route: string } | { ok: false; reason: string; tried: string[] };

/** 不经过任何代理的 env：进程里可能挂着死代理变量，直连这一路必须先把它们摘掉。 */
export function directEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of PROXY_KEYS) delete env[key];
  // 子进程没有终端：卡在「Username for 'https://github.com'」上等于挂死。
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** 走某个代理的 env：先摘掉继承来的代理变量，再把同一个代理写到 git/curl 认的几个名字上。 */
export function proxyEnv(proxy: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = directEnv(base);
  const url = normalizeProxy(proxy);
  for (const key of PROXY_KEYS) env[key] = url;
  return env;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const seconds = (ms: number) => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
};

/** 异常 → 一句人话。用 `unknown` 接住，不必为了读 `.message` 把 catch 放宽成 any。 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 依次试：直连 → 每个代理候选 → 还没有就现探本机代理 → 全都失败时（且确实有代理可试）
 * 等一会儿再整轮来一次，总时长封顶 `budgetMs`。
 *
 * `proxies` 允许传函数：直连就通的机器不该为了探代理去读注册表。`discover` 更晚一步 ——
 * 只在直连与已有候选全挂了才调一次（要跑 netstat、逐个端口试探，不该白花）。
 */
export async function viaRoutes<T>(
  attempt: RouteAttempt<T>,
  opts: {
    proxies: string[] | (() => string[]);
    discover?: () => Promise<string[]>;
    plan?: Partial<RoutePlan>;
    sleep?: (ms: number) => Promise<void>;
    onLog?: (line: string) => void;
  },
): Promise<RouteResult<T>> {
  const plan: RoutePlan = { ...FETCH_PLAN, ...(opts.plan ?? {}) };
  const wait = opts.sleep ?? sleepMs;
  const log = opts.onLog ?? (() => {});
  const deadline = Date.now() + Math.max(1, plan.budgetMs);
  const tried: string[] = [];
  const remaining = () => deadline - Date.now();
  /** 对端已经明确答过（仓库不可见 / 没权限）：一路定死，不再换代理、不再整轮重试。 */
  let stopReason: string | null = null;
  const stopped = (): { ok: false; reason: string; tried: string[] } | null =>
    stopReason ? { ok: false, reason: stopReason, tried } : null;

  const runOne = async (route: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<T | undefined> => {
    const budgetLeft = remaining();
    if (budgetLeft <= 0) return undefined;
    const slice = Math.max(1, Math.min(timeoutMs, budgetLeft));
    log(`${route}（最多 ${seconds(slice)}）`);
    let res: { ok: true; value: T } | { ok: false; err: string; stop?: boolean };
    try {
      res = await attempt(env, slice);
    } catch (err: unknown) {
      res = { ok: false, err: errorText(err) || "未知错误" };
    }
    if (res.ok) return res.value;
    const reason = String(res.err ?? "").trim() || "失败（没有输出）";
    // 对端已经答过了（仓库不可见 / 令牌没权限）：换路只是把同一句话再拿一次。
    if (res.stop) {
      log(`${route}失败（换路也没用，不再重试）：${reason}`);
      stopReason = `${route}：${reason}`;
      tried.push(`${route}：${reason}`);
      return undefined;
    }
    tried.push(`${route}：${reason}`);
    log(`${route}失败：${reason}`);
    return undefined;
  };

  const rounds = Math.max(1, plan.attempts);
  /** 现探到的候选：只探一次，后面的轮次跟着一起重试。 */
  let discovered: string[] | null = null;
  const tryProxies = async (list: string[]): Promise<{ value: T; route: string } | undefined> => {
    for (const proxy of list) {
      const value = await runOne(`代理 ${proxy}`, proxyEnv(proxy), plan.proxyMs);
      if (value !== undefined) return { value, route: `代理 ${proxy}` };
      if (stopReason) return undefined;
    }
    return undefined;
  };

  for (let round = 1; round <= rounds; round += 1) {
    if (round > 1) {
      if (remaining() <= 0) break;
      log(`${seconds(plan.retryMs)} 后整轮重试（第 ${round} 轮）`);
      await wait(plan.retryMs);
    }
    const direct = await runOne("直连", directEnv(), plan.directMs);
    if (direct !== undefined) return { ok: true, value: direct, route: "直连" };
    const stoppedDirect = stopped();
    if (stoppedDirect) return stoppedDirect;

    const known = typeof opts.proxies === "function" ? opts.proxies() : opts.proxies;
    const viaKnown = await tryProxies(known);
    if (viaKnown) return { ok: true, value: viaKnown.value, route: viaKnown.route };
    const stoppedProxy = stopped();
    if (stoppedProxy) return stoppedProxy;

    if (opts.discover && discovered === null && remaining() > 0) {
      log("没有可用的代理配置，探一下本机在听什么");
      try {
        discovered = await opts.discover();
      } catch (err: unknown) {
        discovered = [];
        log(`探测本机代理失败：${errorText(err) || "未知错误"}`);
      }
      log(discovered.length ? `本机探到 ${discovered.length} 个代理：${discovered.join("、")}` : "本机没探到在听的代理");
    }
    if (discovered?.length) {
      const viaDiscovered = await tryProxies(discovered.filter((proxy) => !known.includes(proxy)));
      if (viaDiscovered) return { ok: true, value: viaDiscovered.value, route: `现探的${viaDiscovered.route}` };
      const stoppedFound = stopped();
      if (stoppedFound) return stoppedFound;
    }

    // 一条代理都没有（现有配置与现探都是空）：重试只是把同一件事再做一遍。
    if (!known.length && !discovered?.length) break;
  }
  return { ok: false, reason: tried.join("；") || "没有可用的网络路径", tried };
}
