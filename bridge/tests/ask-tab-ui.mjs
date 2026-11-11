/**
 * Verify automatic queue-tab attention changes against a throwaway bridge and fake pi.
 *
 * Run after `npm run build:bridge && npm run build:web` with:
 *   node bridge/tests/ask-tab-ui.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ask-tab-ui-"));
const STATE = path.join(ROOT, "state");
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const PORT = Number(process.env.ASK_TAB_UI_PORT ?? 7917);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "ask-tab-ui-pass";
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
  socket.send(JSON.stringify({ type: "create", cwd: REPO, name: "ask-tab-ui" }));
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
  await page.goto(`${BASE}/#/s/${sessionId}`);
  await page.waitForSelector(".app", { timeout: 20000 });
  await page.waitForSelector('[data-exec-tab="needs"]', { timeout: 20000 });
  const selected = (tab) => page.locator(`[data-exec-tab="${tab}"]`).getAttribute("aria-selected");
  const waitTurnEnd = async (start, label) => {
    for (let i = 0; i < 200; i += 1) {
      const status = frames.slice(start).filter((frame) => frame.type === "pi.status" && frame.sessionId === sessionId);
      if (status.some((frame) => frame.running === true) && status.at(-1)?.running === false) return;
      await sleep(100);
    }
    throw new Error(`turn timeout: ${label}`);
  };
  const beginQuestionnaire = async (text, manuallySwitchAway) => {
    const start = frames.length;
    socket.send(JSON.stringify({ type: "prompt", sessionId, text }));
    await page.waitForFunction(() => document.querySelector('[data-exec-tab="needs"]')?.getAttribute("aria-selected") === "true", null, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll(".queue .ask-tab").length === 2, null, { timeout: 20000 });
    check("a two-question questionnaire selects the needs tab", await selected("needs") === "true");
    if (manuallySwitchAway) {
      await page.locator('[data-exec-tab="exec"]').click();
      await sleep(300);
      check("manual switch away remains selected while questions are pending", await selected("exec") === "true");
      await page.locator('[data-exec-tab="needs"]').click();
    }
    await page.locator(".queue .ask-opt", { hasText: "方案乙" }).click();
    await page.locator(".queue .ask-opt", { hasText: "答案一" }).click();
    const submit = page.locator(".queue .ask-foot .btn.primary");
    await submit.waitFor({ state: "visible", timeout: 5000 });
    await submit.click();
    await page.waitForSelector(".queue .ask-slot", { state: "detached", timeout: 20000 });
    await waitTurnEnd(start, text);
  };

  await page.locator('[data-exec-tab="exec"]').click();
  check("execution tab is the user's starting selection", await selected("exec") === "true");
  await beginQuestionnaire("ASKTAB first", false);
  await page.waitForFunction(() => document.querySelector('[data-exec-tab="exec"]')?.getAttribute("aria-selected") === "true", null, { timeout: 5000 });
  check("answering the last question restores the remembered tab", await selected("exec") === "true");

  await beginQuestionnaire("ASKTAB second", true);
  check("a manual tab choice is retained after answering", await selected("needs") === "true");
  check("page has no active questionnaire after submit", (await page.locator(".queue .ask-slot").count()) === 0);
  console.log("All ask-tab UI checks passed.");
} finally {
  if (browser) await browser.close();
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  bridge.kill();
  await sleep(150);
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (bridgeLog.includes("Error:")) console.error(bridgeLog.slice(-3000));
}
