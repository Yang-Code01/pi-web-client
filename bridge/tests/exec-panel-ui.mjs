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
  for (let i = 0; i < 100 && !frames.some((frame) => frame.type === "stats" && frame.sessionId === sessionId); i += 1) await sleep(100);
  check("initial stats snapshot arrived before the first turn", frames.some((frame) => frame.type === "stats" && frame.sessionId === sessionId));
  await page.locator('[data-exec-tab="exec"]').click();
  await page.waitForFunction(() => document.querySelector(".exec-context-label")?.textContent?.includes("0.5%"), null, { timeout: 20000 });
  check("browser received current stats before the round starts", (await page.locator(".exec-context-label").innerText()).includes("0.5%"));

  socket.send(JSON.stringify({ type: "prompt", sessionId, text: "TOOLS" }));
  await page.waitForSelector(".exec-now", { timeout: 20000 });
  await page.waitForSelector(".exec-timeline .exec-step", { timeout: 20000 });
  check("execution tab shows the now card and loaded timeline", await page.locator(".exec-now").innerText().then((text) => text.includes("现在")));
  check("timeline steps link to loaded chat cards", (await page.locator(".exec-timeline .exec-step").count()) > 0);
  check("metrics count tools without treating skills as tools", await page.locator(".exec-metric-grid .exec-metric:nth-child(2)").innerText().then((text) => text.includes("工具 / 失败") && text.includes("3 / 0")));
  check("metrics show context usage and percent", await page.locator(".exec-context-label").innerText().then((text) => text.includes(" / ") && text.includes("0.5%")));
  await page.locator(".exec-timeline .exec-step").first().click();
  await page.waitForSelector(".exec-flash", { timeout: 5000 });
  check("clicking a timeline step jumps to and flashes its chat card", (await page.locator(".exec-flash").count()) > 0);

  socket.send(JSON.stringify({ type: "prompt", sessionId, text: "METRICS" }));
  const rounds = page.locator(".exec-rounds");
  await page.waitForFunction(() => document.querySelector(".exec-rounds")?.options.length === 2, null, { timeout: 20000 });
  await rounds.selectOption({ index: 1 });
  await page.waitForFunction(() => document.querySelector('[data-exec-metric="cost"] .exec-metric-value')?.textContent?.trim() === "$0.0100", null, { timeout: 20000 });
  check("cost rises at the first message-end stats frame while the run continues", (await page.locator('[data-exec-metric="cost"] .exec-metric-value').innerText()) === "$0.0100");
  await page.waitForFunction(() => document.querySelector('[data-exec-metric="cost"] .exec-metric-value')?.textContent?.trim() === "$0.0400", null, { timeout: 20000 });
  check("cost updates again at the next message-end stats frame", (await page.locator('[data-exec-metric="cost"] .exec-metric-value').innerText()) === "$0.0400");
  await rounds.selectOption({ index: 0 });
  check("historical round shows its own saved metrics", (await page.locator('[data-exec-metric="cost"] .exec-metric-value').innerText()) === "$0.0000");
  await rounds.selectOption({ index: 1 });
  check("returning to the current round restores its metrics", (await page.locator('[data-exec-metric="cost"] .exec-metric-value').innerText()) === "$0.0400");

  await page.reload();
  await page.waitForSelector(".app", { timeout: 20000 });
  await page.waitForSelector(".exec-now", { timeout: 20000 });
  check("execution-tab selection survives reload", await page.locator('[data-exec-tab="exec"]').getAttribute("aria-selected") === "true");
  await page.waitForFunction(() => document.querySelector('[data-exec-metric="cost"] .exec-metric-value')?.textContent?.trim() === "$0.0400", null, { timeout: 20000 });
  check("round metrics survive reload", (await page.locator('[data-exec-metric="cost"] .exec-metric-value').innerText()) === "$0.0400");

  await page.locator('[data-exec-tab="needs"]').click();
  socket.send(JSON.stringify({ type: "prompt", sessionId, text: "PLAN snapshot scenario" }));
  await page.waitForFunction(() => document.querySelector(".todo-tool")?.textContent?.includes("计划 1/3"), null, { timeout: 20000 });
  check("todo tool is a compact one-line chat card", (await page.locator(".todo-tool").innerText()).includes("开始「实现计划快照」"));
  await page.locator(".todo-tool").click();
  await page.waitForFunction(() => document.querySelector('[data-exec-tab="exec"]')?.getAttribute("aria-selected") === "true" && document.querySelector(".exec-plan.exec-flash"), null, { timeout: 5000 });
  check("clicking a todo card opens execution and flashes the plan", (await page.locator(".exec-plan.exec-flash").count()) === 1);
  check("current card title includes active plan task", (await page.locator(".exec-now h2").innerText()).includes("计划 2/3 · 实现计划快照"));
  check("plan item shows its attributed step count", (await page.locator('.exec-plan-task[data-plan-task-id="2"] .exec-plan-step-count').innerText()) === "1 步");
  await page.locator('.exec-plan-task[data-plan-task-id="2"]').click();
  check("selecting a plan item highlights matching steps and dims other steps", (await page.locator(".exec-step.selected").count()) === 1 && (await page.locator(".exec-step.dimmed").count()) === 1);
  await page.locator('.exec-plan-task[data-plan-task-id="2"]').click();
  check("selecting the active plan item again clears step highlighting", (await page.locator(".exec-step.dimmed").count()) === 0);

  socket.send(JSON.stringify({ type: "prompt", sessionId, text: "BGCHILD" }));
  await page.waitForFunction(() => [...document.querySelectorAll(".exec-subagent-task")].some((row) => row.textContent?.includes("inspect child updates")), null, { timeout: 20000 });
  const childToggle = page.locator(".exec-subagent").filter({ hasText: "inspect child updates" }).locator(".exec-subagent-toggle");
  await childToggle.click();
  await page.waitForFunction(() => document.querySelector(".exec-plan.mini .exec-plan-task") !== null
    && document.querySelector(".exec-subagent-plan")?.textContent === "计划 2/2", null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector(".exec-now")?.textContent?.includes("child_lookup"), null, { timeout: 20000 });
  check("now card shows a running child agent and its subscribed transcript step", (await page.locator(".exec-now").innerText()).includes("researcher")
    && (await page.locator(".exec-now").innerText()).includes("child_lookup"));
  check("child plan badge shows the latest snapshot progress", (await page.locator(".exec-subagent-plan").last().innerText()) === "计划 2/2");
  check("expanded child renders its compact read-only plan", (await page.locator(".exec-plan.mini .exec-plan-task").count()) === 2
    && await page.locator(".exec-plan.mini .exec-plan-task").first().evaluate((row) => row.tagName === "DIV" && row.onclick === null));
  await childToggle.click();
  check("child plan badge remains visible when collapsed", (await page.locator(".exec-subagent-plan").last().innerText()) === "计划 2/2");
  socket.send(JSON.stringify({ type: "prompt", sessionId, text: "NOWARGS" }));
  await page.waitForSelector(".exec-now-tool", { timeout: 20000 });
  const nowTool = page.locator(".exec-now-tool").first();
  const clamped = await nowTool.locator(".exec-args").evaluate((node) => ({ height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight) || 0, over: node.scrollWidth > node.clientWidth + 1 }));
  check("long tool args occupy one line", clamped.line > 0 && clamped.height <= clamped.line * 1.5 && clamped.over, JSON.stringify(clamped));
  check("long tool args get an expand button", await nowTool.locator(".exec-now-toggle").isVisible() && (await nowTool.locator(".exec-now-toggle").getAttribute("aria-expanded")) === "false");
  check("no expanded args before the click", (await page.locator(".exec-now-args").count()) === 0);
  await nowTool.locator(".exec-now-toggle").click();
  await page.waitForSelector(".exec-now-args", { timeout: 5000 });
  check("expanding shows the full argument text", (await page.locator(".exec-now-args").innerText()).length > 120 && (await page.locator(".exec-now-tool .exec-now-toggle").getAttribute("aria-expanded")) === "true");
  await page.locator(".exec-now-tool .exec-now-toggle").click();
  check("collapsing hides it again", (await page.locator(".exec-now-args").count()) === 0);
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
