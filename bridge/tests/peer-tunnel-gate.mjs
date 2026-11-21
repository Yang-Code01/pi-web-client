/**
 * 审计 C1 的回归测试：隧道请求不能靠「回环地址」冒充本机（fix/audit-critical-high）。
 *
 * cloudflared 由 bridge 自己在本地起（`--url http://127.0.0.1:<port>`），所以公网请求进到
 * Node 时 `remoteAddress` 也是 127.0.0.1。旧门禁只看回环 + cookie，隧道访客不带 cookie
 * 就能读 `/api/peer/*`、改好友与配置。
 *
 * 判据（真实 HTTP，一份临时 state）：
 *   1. 不带任何隧道头、不带 cookie → 200（本机 e2e / 健康检查的既有契约）；
 *   2. `cf-connecting-ip` + 无 cookie → 401（回归点，旧代码是 200）；
 *   3. `x-forwarded-proto: https` + 无 cookie → 401；
 *   4. 登录后带 cookie + 隧道头 → 200（真隧道用户不受影响）；
 *   5. 登录后本机不带隧道头 → 200。
 *
 * 用法：npm run build:bridge && node bridge/tests/peer-tunnel-gate.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort } from "../../tools/free-port.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "peer-tunnel-gate");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (ok, what, extra = "") => {
  if (ok) log(`ok   ${what}`);
  else {
    failed += 1;
    console.error(`FAIL ${what} ${extra}`);
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

const state = path.join(ROOT, "state");
const agent = path.join(ROOT, "agent");
fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
fs.mkdirSync(state, { recursive: true });
fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(REPO, "bridge", "dist", "index.js")], {
  cwd: REPO,
  env: {
    ...process.env,
    PI_WEB_PORT: String(port),
    PI_WEB_HOST: "127.0.0.1",
    PI_WEB_TUNNEL: "0",
    PI_WEB_OPEN: "0",
    PI_WEB_WHATS_NEW: "0",
    PI_PEER: "0",
    PI_WEB_STATE: state,
    PI_AGENT_DIR: agent,
  },
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
  await until(async () => (await fetch(`${base}/healthz`)).ok, 30000, "bridge up");
  const pass = await until(() => {
    const f = path.join(state, "passphrase.txt");
    return fs.existsSync(f) && fs.readFileSync(f, "utf8").trim();
  }, 20000, "passphrase");

  const peer = (headers = {}) => fetch(`${base}/api/peer/threads`, { headers });

  let r = await peer();
  check(r.status === 200, "本机不带隧道头、不带 cookie：200（既有契约）", `拿到 ${r.status}`);

  r = await peer({ "cf-connecting-ip": "203.0.113.9" });
  check(r.status === 401, "隧道头 + 无 cookie：401（回归点）", `拿到 ${r.status}`);

  r = await peer({ "x-forwarded-proto": "https" });
  check(r.status === 401, "x-forwarded-proto + 无 cookie：401", `拿到 ${r.status}`);

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  check(login.status === 200, `登录：200（拿到 ${login.status}）`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map((line) => line.split(";")[0]).join("; ");
  check(Boolean(cookie), "登录拿到 cookie");

  r = await peer({ cookie, "cf-connecting-ip": "203.0.113.9" });
  check(r.status === 200, "真隧道用户（带 cookie + 隧道头）：200", `拿到 ${r.status}`);

  r = await peer({ cookie });
  check(r.status === 200, "登录后本机直连：200", `拿到 ${r.status}`);
} catch (err) {
  failed += 1;
  console.error(`FAIL ${err.message}\n${out.join("")}`);
} finally {
  await stop();
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

log(failed ? "FAILED" : "OK");
process.exit(failed ? 1 : 0);
