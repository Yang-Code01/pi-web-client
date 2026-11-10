/**
 * Smoke the execution subtab against the local fake pi implementation.
 *
 * Run after `npm run build:bridge && npm run build:web` with:
 *   node bridge/tests/exec-panel-ui.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-exec-ui-"));
const STATE = path.join(ROOT, "state");
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const PORT = Number(process.env.EXEC_UI_PORT ?? 7913);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "exec-ui-pass";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok   " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`smoke failed: ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(STATE, { recursive: true });
const env = {
  ...process.env,
  PI_WEB_STATE: STATE,
  PI_AGENT_DIR: path.join(ROOT, "agent"),
  PI_WEB_PORT: String(PORT),
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_TUNNEL: "0",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_BIN: FAKE_PI,
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (chunk) => (bridgeLog += chunk.toString()));
bridge.stderr.on("data", (chunk) => (bridgeLog += chunk.toString()));
let browser;
let socket;

try {
  let healthy = false;
  for (let i = 0; i < 100; i += 1) {
    try {
      healthy = (await fetch(`${BASE}/healthz`)).ok;
      if (healthy) break;
    } catch { /* bridge is starting */ }
    await sleep(200);
  }
  check("bridge started", healthy);

  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  check("stub bridge login succeeded", login.ok, `HTTP ${login.status}`);
  const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");
  socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
  const frames = [];
  socket.on("message", (chunk) => frames.push(JSON.parse(chunk.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "create", cwd: REPO, name: "exec-panel-ui" }));
  let sessionId = null;
  for (let i = 0; i < 100 && !sessionId; i += 1) {
    sessionId = frames.find((frame) => frame.type === "session" && frame.state?.id)?.state.id ?? null;
    if (!sessionId) await sleep(100);
  }
  check("stub session created", Boolean(sessionId));

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${BASE}/#/s/${sessionId}`);
  await page.waitForSelector(".app", { timeout: 20000 });
  await page.waitForSelector(".composer-input textarea", { timeout: 20000 });
  await page.waitForSelector('[data-exec-tab="needs"]', { timeout: 20000 });
  check("needs-you remains the initial execution-pane tab", await page.locator('[data-exec-tab="needs"]').getAttribute("aria-selected") === "true");

  socket.send(JSON.stringify({ type: "prompt", sessionId, text: "TOOLS" }));
  await page.locator('[data-exec-tab="exec"]').click();
  await page.waitForSelector(".exec-now", { timeout: 20000 });
  await page.waitForSelector(".exec-timeline .exec-step", { timeout: 20000 });
  check("execution tab shows the now card and loaded timeline", await page.locator(".exec-now").innerText().then((text) => text.includes("现在")));
  check("timeline steps link to loaded chat cards", (await page.locator(".exec-timeline .exec-step").count()) > 0);
  await page.locator(".exec-timeline .exec-step").first().click();
  await page.waitForSelector(".exec-flash", { timeout: 5000 });
  check("clicking a timeline step jumps to and flashes its chat card", (await page.locator(".exec-flash").count()) > 0);

  await page.reload();
  await page.waitForSelector(".app", { timeout: 20000 });
  await page.waitForSelector(".exec-now", { timeout: 20000 });
  check("execution-tab selection survives reload", await page.locator('[data-exec-tab="exec"]').getAttribute("aria-selected") === "true");
  check("page has no uncaught errors", pageErrors.length === 0, pageErrors.join("; "));
  console.log("All execution-panel smoke checks passed.");
} finally {
  if (browser) await browser.close();
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  bridge.kill();
  await sleep(150);
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (bridgeLog.includes("Error:")) console.error(bridgeLog.slice(-3000));
}
