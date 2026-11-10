/**
 * #288 页面探针：`ui.set` 关掉顶栏「终端」之后，页面跟着藏、刷新还藏、桥拔掉也不崩不还原。
 *
 *   npm run build:bridge && npm run build:web && node bridge/tests/chrome-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { loadPlaywright } from "../../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7922;
const ROOT = path.join(REPO, ".scratch", "chrome-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
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

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });

const out = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT, PI_CODING_AGENT_DIR: AGENT },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", (b) => out.push(b.toString()));
bridge.stderr.on("data", (b) => out.push(b.toString()));

const until = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
};

let browser;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: pass }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  // 控制端：与页面各走一条 WS，改动经由 hello + 广播回到页面。
  const control = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  let ctrlSeen = [];
  control.on("message", (b) => ctrlSeen.push(JSON.parse(b.toString())));
  await new Promise((r) => control.on("open", r));

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', pass);
    await page.click('button:has-text("进入")');
  }
  const term = page.locator('.topbar [data-act="terminal"]');
  await term.waitFor({ state: "visible", timeout: 20000 });
  check(true, "默认状态下顶栏「终端」可见");

  control.send(JSON.stringify({ type: "ui.set", chrome: { terminal: false } }));
  await until(() => ctrlSeen.some((m) => m.type === "ui" && m.ui.chrome.terminal === false), 10000, "ui ack");
  await term.waitFor({ state: "hidden", timeout: 10000 });
  check(true, "ui.set terminal:false 后页面立刻藏起来");

  await page.reload({ waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', pass);
    await page.click('button:has-text("进入")');
  }
  await page.locator(".topbar").waitFor({ state: "visible", timeout: 20000 });
  await term.waitFor({ state: "hidden", timeout: 10000 });
  check(true, "刷新后 hello 带回偏好，仍然藏着");

  bridge.kill();
  await sleep(1500);
  check(pageErrors.length === 0, `桥断开不抛页面错误 (${pageErrors.join(" | ") || "none"})`);
  check(!(await term.isVisible()), "桥断开后本地偏好不被清掉，「终端」仍藏着");
} catch (e) {
  failed = true;
  console.error("ERROR", e.message);
  console.error(out.join("").slice(-3000));
} finally {
  if (browser) await browser.close().catch(() => {});
  bridge.kill();
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
