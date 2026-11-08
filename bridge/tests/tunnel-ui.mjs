/**
 * 「关掉公网隧道」点了没反应（#233）：按钮背后的 POST 失败时，旧代码 `.catch(() => null)` 把错误
 * 吞掉，界面停在旧标签上，用户只能看到「点了没反应」。这个用例只验**界面侧的反馈**：
 *
 *   A. 请求失败 → 冒出一条带原因的 toast（不是静悄悄）；
 *   B. 请求成功 → 标签翻成「关掉公网隧道」、面板里出现隧道地址；
 *   C. 失败后标签不变（别在没关成的时候谎报已关）。
 *
 * 隧道本身（真的 cloudflared + 公网回包）不在这里跑：自带丢弃式 bridge，POST /api/tunnel 用
 * Playwright 的 route 拦下来造成功/失败两种回包，不联网、不杀真进程。
 *
 *   npm run build:bridge && npm run build:web && node bridge/tests/tunnel-ui.mjs
 *
 * 端口默认 7896，`TUNNEL_UI_PORT` 可改。截图落在 .scratch/shots/tunnel-ui-*.png。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.TUNNEL_UI_PORT ?? 7896);
const ROOT = path.join(REPO, ".scratch", "tunnel-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const OUT = path.join(REPO, ".scratch", "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "tunnel-ui-pass";
const URL_UP = "https://demo-tunnel.trycloudflare.com";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(AGENT, { recursive: true });

// 这件用例不真的开隧道：把 cloudflared 的路径从环境里摘掉（bridge 就找不到它），
// 而 POST /api/tunnel 本来就被下面的 route 拦下，根本到不了桥。
const { CLOUDFLARED_BIN: _hideBin, ...inherited } = process.env;
const env = {
  ...inherited,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });

const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

let failed = false;
const done = (code = 0) => {
  try {
    bridge.kill();
  } catch {
    /* ignore */
  }
  const bad = failed || results.some((r) => !r.ok);
  if (bad) console.error("\nbridge log tail:\n" + bridgeLog.slice(-1500));
  process.exit(bad ? 1 : code);
};

for (let i = 0; i < 100; i += 1) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {
    /* wait */
  }
  await sleep(200);
}

const browser = await chromium.launch();
// 界面是中文的：en-US 会把按钮翻成英文，断言中文就假失败。
const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => log("  pageerror", String(e).slice(0, 160)));

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
const pw = page.locator('input[type="password"]');
if (await pw.count()) {
  await pw.first().fill(PASS);
  await pw.first().press("Enter");
}
await page.waitForTimeout(1200);

const tunButton = () => page.locator(".queue button", { hasText: "公网隧道" }).first();
const label = () => tunButton().textContent();
const toast = () => page.locator(".fail-toast").first().textContent().catch(() => "");

await tunButton().waitFor({ timeout: 10000 }).catch(() => {});
check("队列面板里有隧道按钮", (await tunButton().count()) > 0, await label().catch(() => "none"));

// A. 失败要说话。
await page.route("**/api/tunnel", (route) =>
  route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "桥那边炸了" }) }),
);
await tunButton().click();
await page.waitForTimeout(900);
const badToast = await toast();
check("失败 → 弹出带原因的 toast", badToast.includes("隧道操作失败") && badToast.includes("桥那边炸了"), JSON.stringify(badToast));
check("失败 → 标签不变（没关成就不谎报）", (await label()) === "开公网隧道", await label());
await page.screenshot({ path: path.join(OUT, "tunnel-ui-fail.png") });

// B. 成功要看得见。
await page.unroute("**/api/tunnel");
await page.route("**/api/tunnel", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ tunnel: { status: "up", url: URL_UP, error: null, updatedAt: Date.now() } }),
  }),
);
await page.locator(".fail-toast").first().waitFor({ state: "detached", timeout: 12000 }).catch(() => {});
await tunButton().click();
await page.waitForTimeout(900);
check("成功 → 标签翻成「关掉公网隧道」", (await label()) === "关掉公网隧道", await label());
const shownUrl = await page.locator(".queue a", { hasText: URL_UP }).count();
check("成功 → 面板里出现隧道地址", shownUrl > 0, String(shownUrl));
await page.screenshot({ path: path.join(OUT, "tunnel-ui-up.png") });

// C. 公网页面点「关」时回包可能死在隧道上：至少别静默。
await page.unroute("**/api/tunnel");
await page.route("**/api/tunnel", (route) => route.abort("connectionreset"));
await tunButton().click();
await page.waitForTimeout(900);
const deadToast = await toast();
check("回包丢了 → 也会说出来", deadToast.includes("隧道操作失败") || deadToast.includes("没收到回包"), JSON.stringify(deadToast));

await browser.close();
done();
