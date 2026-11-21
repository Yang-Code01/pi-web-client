/**
 * 两个本机实例的登录态互不覆盖（D366）。
 *
 * 浏览器存 cookie 只看 host、不看端口：正式实例在 `127.0.0.1:7864`、测试实例在
 * `127.0.0.1:17864`，同名 cookie 是**同一个槽**。以前两边都叫 `pwc`，在测试环境里输一次口令
 * `test`，正式实例的 cookie 就被签名不同的一枚顶掉 —— 页面下一次请求 `/api/me` 是 401，
 * 用户得刷新再重新登录（「开了测试环境后，每次主环境都变成了未认证」）。
 *
 * 这里开三份真实的桥（各自的 state 目录 = 各自的 secret / 各自的口令），用一个**忽略端口**的
 * 最小 cookie 罐模拟浏览器在 127.0.0.1 上的行为，全部走真实 HTTP：
 *   1. 空罐问 A → 401；
 *   2. 登录 A → 200，A 的 `/api/me` 200；
 *   3. 登录 B → 200（这时浏览器里 A 的 cookie 若不改名就会被覆盖），B 的 `/api/me` 200；
 *   4. **回头问 A 仍是 200** —— 这条是回归点，改回共用一个 cookie 名立刻红；
 *   5. A、B 的 cookie 名不同（各自跟 state 目录走，不是只把值换掉）；
 *   6. 拿 B 的 cookie 冒充 A → 401（名字分开不等于密钥共享）；
 *   7. 不设 `PI_WEB_STATE` 的实例（正式环境那份）仍叫 `pwc` —— 升级不用重登；
 *   8. 三份都登录过之后，A 仍是 200。
 *
 * `npm --prefix bridge run build && node bridge/tests/auth-cookie-scope.mjs`
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort } from "../../tools/free-port.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "auth-cookie-scope");
const APP_NAME = "pi-web-client";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = false;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed = true;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}

/** 浏览器在 127.0.0.1 上的 cookie 罐：按名字一个槽，**不看端口**。 */
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function storeSetCookies(res) {
  const names = [];
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = value === "" || attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
    if (expired) jar.delete(name);
    else jar.set(name, value);
    names.push(name);
  }
  return names;
}

const req = (base, p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { ...(init.headers ?? {}), cookie: cookieHeader() } });
const login = (base, passphrase) =>
  req(base, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });

/** `opts.defaultState`：不设 PI_WEB_STATE，走正式环境那条默认目录（Windows `LOCALAPPDATA`，POSIX `$HOME`）。 */
async function start(name, opts = {}) {
  const root = path.join(ROOT, name);
  const appdata = path.join(root, "appdata");
  const home = path.join(root, "home");
  const state = opts.defaultState ? path.join(appdata, APP_NAME) : path.join(root, "state");
  const agent = path.join(root, "agent");
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });
  if (opts.defaultState) {
    fs.mkdirSync(appdata, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PI_WEB_PORT: String(port),
    PI_WEB_HOST: "127.0.0.1",
    PI_WEB_TUNNEL: "0",
    PI_WEB_OPEN: "0",
    PI_WEB_WHATS_NEW: "0",
    PI_PEER: "0",
    PI_AGENT_DIR: agent,
  };
  if (opts.defaultState) {
    env.LOCALAPPDATA = appdata;
    env.HOME = home;
    env.USERPROFILE = home;
    delete env.PI_WEB_STATE;
  } else env.PI_WEB_STATE = state;
  const child = spawn(process.execPath, [path.join(REPO, "bridge", "dist", "index.js")], {
    cwd: REPO,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  child.stdout.on("data", (b) => out.push(b.toString()));
  child.stderr.on("data", (b) => out.push(b.toString()));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      const { spawnSync } = await import("node:child_process");
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else child.kill("SIGKILL");
  };
  try {
    await until(async () => (await fetch(`${base}/healthz`)).ok, 30000, `${name} bridge up`);
    const pass = await until(() => {
      const f = path.join(state, "passphrase.txt");
      return fs.existsSync(f) && fs.readFileSync(f, "utf8").trim();
    }, 20000, `${name} passphrase`);
    return { name, base, pass, stop };
  } catch (err) {
    await stop();
    throw new Error(`${err.message}\n${out.join("")}`);
  }
}

let a, b, d;
try {
  a = await start("main");
  b = await start("test");
  let r = await req(a.base, "/api/me");
  check(r.status === 401, `空罐问 A：401（拿到 ${r.status}）`);

  r = await login(a.base, a.pass);
  check(r.status === 200, `登录 A：200（拿到 ${r.status}）`);
  const namesA = storeSetCookies(r);
  const nameA = namesA[0];
  r = await req(a.base, "/api/me");
  check(r.status === 200, `A 已登录：/api/me 200（拿到 ${r.status}）`);

  // 浏览器打开测试实例、输口令 test。cookie 槽若同名，就是这一下把 A 顶掉的。
  r = await login(b.base, b.pass);
  check(r.status === 200, `登录 B：200（拿到 ${r.status}）`);
  const nameB = storeSetCookies(r)[0];
  r = await req(b.base, "/api/me");
  check(r.status === 200, `B 已登录：/api/me 200（拿到 ${r.status}）`);

  check(jar.size === 2 && nameA !== nameB, `A、B 各占一个 cookie 名（${nameA} / ${nameB}）`);

  r = await req(a.base, "/api/me");
  check(r.status === 200, `登录过 B 之后，A 仍是 200（拿到 ${r.status}）—— 回归点`);

  // 名字分开不等于密钥共享：把 B 的 cookie 原样递给 A。
  const bCookie = `${nameB}=${jar.get(nameB)}`;
  r = await fetch(`${a.base}/api/me`, { headers: { cookie: bCookie } });
  check(r.status === 401, `拿 B 的 cookie 冒充 A：401（拿到 ${r.status}）`);

  // 正式环境那份没设 PI_WEB_STATE：名字必须还是 `pwc`，否则用户升级后要重登一次。
  d = await start("default", { defaultState: true });
  r = await login(d.base, d.pass);
  check(r.status === 200, `登录默认实例：200（拿到 ${r.status}）`);
  const nameD = storeSetCookies(r)[0];
  check(nameD === "pwc", `不设 PI_WEB_STATE 的实例仍叫 pwc（拿到 ${nameD}）—— 升级不用重登`);
  check(jar.size === 3, `三份各占一个 cookie 名（${[...jar.keys()].join(" / ")}）`);

  r = await req(a.base, "/api/me");
  check(r.status === 200, `三份都登录过之后，A 仍是 200（拿到 ${r.status}）`);
} finally {
  await a?.stop();
  await b?.stop();
  await d?.stop();
}

log(failed ? "FAILED" : "OK");
process.exit(failed ? 1 : 0);
