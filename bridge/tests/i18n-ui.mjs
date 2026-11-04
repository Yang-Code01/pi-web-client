/**
 * 语言切换冒烟：英文/日文各看一眼，确认不是只换了词典而界面没动。
 *
 * 起一个自己的 bridge（独立端口 + 独立 state + fake-pi），再用 **en-US** 的浏览器打开：
 * 默认语言必须自动是英文（这是第 2 条决定的真实验收点），然后切到日文、切回简体，
 * 刷新一次确认偏好存下来了（localStorage `pi.prefs.lang`）。
 *
 *   npm run build:bridge && npm run build:web && node bridge/tests/i18n-ui.mjs
 *
 * 截图落在 `bridge/tests/../.scratch/i18n-shots/`（不写死别人的 worktree 路径）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "../../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_WEB_PORT ?? 7905);
const ROOT = path.join(REPO, ".scratch", "i18n-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SHOTS = path.join(REPO, ".scratch", "i18n-shots");
const BASE = `http://127.0.0.1:${PORT}`;

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
async function until(fn, ms = 20000, what = "") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(150);
  }
}

delete process.env.PI_BIN;
const { resolvePi } = await import("../dist/pi.js");
const realPkg = path.dirname(path.dirname(path.dirname(resolvePi().cli)));

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const env = { ...process.env };
for (const k of Object.keys(env)) if (/_API_KEY$|_TOKEN$/.test(k)) delete env[k];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
    PI_WEB_PI_PKG: realPkg,
    PI_OFFLINE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", () => {});
bridge.stderr.on("data", (b) => console.error("bridge:", b.toString().trim()));

const { chromium } = await loadPlaywright();
let browser;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  check(login.status === 200 && cookie, "登录");

  browser = await chromium.launch();
  // 关键：en-US 的浏览器，默认语言必须自己变成英文。
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, locale: "en-US" });
  await ctx.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    failed = true;
    console.error("  FAIL pageerror:", e.message);
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  const lang = () => page.evaluate(() => document.documentElement.lang);
  const lookTitle = () => page.getAttribute('[data-act="look"]', "title");
  const sheetTitle = () => page.textContent(".sheet h2, .sheet-title, .sheet h3").catch(() => null);

  await until(async () => (await lang()) === "en", 15000, "html lang=en");
  check((await lang()) === "en", "en-US 浏览器默认落到英文");
  await sleep(1200);
  await page.screenshot({ path: path.join(SHOTS, "en-1-home.png") });
  log("en look title =", await lookTitle());
  check(/Appearance/i.test((await lookTitle()) ?? ""), "顶栏按钮标题跟着换");

  await page.click('[data-act="look"]');
  await sleep(500);
  log("en sheet title =", await sheetTitle());
  check(/Appearance/i.test((await sheetTitle()) ?? ""), "设置面板标题跟着换");
  await page.screenshot({ path: path.join(SHOTS, "en-2-settings.png") });

  // 切日文（面板里第一组是语言）
  await page.click('.sheet [lang="ja"]');
  await sleep(700);
  check((await lang()) === "ja", "切到日文后 html lang=ja");
  await page.screenshot({ path: path.join(SHOTS, "ja-1-settings.png") });
  log("ja sheet title =", await sheetTitle());

  // 刷新 → 偏好要活下来
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(1500);
  check((await lang()) === "ja", "刷新后仍是日文（localStorage）");
  await page.screenshot({ path: path.join(SHOTS, "ja-2-home.png") });

  // 切回简体（中文界面本来就有，用来确认没把默认那套弄坏）
  await page.click('[data-act="look"]');
  await sleep(400);
  await page.click('.sheet [lang="zh-Hans"]');
  await sleep(600);
  check((await lang()) !== "ja", "切回简体");
  await page.screenshot({ path: path.join(SHOTS, "zh-1-home.png") });

  await ctx.close();
} catch (e) {
  failed = true;
  console.error("  FAIL", e?.message ?? e);
} finally {
  await browser?.close();
  bridge.kill();
}

if (failed) {
  console.error("\ni18n-ui: FAILED");
  process.exit(1);
}
console.log(`\ni18n-ui: ok — 截图在 ${SHOTS}`);
