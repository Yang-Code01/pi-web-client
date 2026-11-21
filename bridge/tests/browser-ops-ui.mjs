/**
 * 浏览器面板（#503）探针：第三颗执行 tab、卡片折叠、子步骤、疑似卡住与中断。
 *
 * 假 pi 的 `BROWSER` 场景发四颗调用：两颗 `mcp__browser_use`（一颗跑完，一颗只发一次 partial 就停住），
 * 两颗「`write` 脚本 + `bash node x.mjs`」的脚本卡（D318：折叠行要说清开的哪页、输入了什么）。
 * 「卡住」用页面里的 Date.now 快进来验，不真等两分钟。
 *
 * Run after `npm run build:bridge && npm run build:web`:
 *   node bridge/tests/browser-ops-ui.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";
import { freePort } from "../../tools/free-port.mjs";

const { chromium } = await loadPlaywright();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-browser-ops-"));
const STATE = path.join(ROOT, "state");
const LOG = path.join(ROOT, "fake-pi.log");
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const PORT = Number(process.env.BROWSER_OPS_PORT ?? (await freePort()));
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "browser-ops-pass";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok   " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`smoke failed: ${name}${detail ? ` — ${detail}` : ""}`);
};
const notes = () => {
  try {
    return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

fs.mkdirSync(STATE, { recursive: true });
const env = {
  ...process.env,
  PI_WEB_STATE: STATE,
  PI_WEB_WHATS_NEW: "0",
  PI_AGENT_DIR: path.join(ROOT, "agent"),
  PI_WEB_PORT: String(PORT),
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_TUNNEL: "0",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_BIN: FAKE_PI,
  FAKE_PI_LOG: LOG,
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
    } catch {
      /* bridge is starting */
    }
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
  socket.send(JSON.stringify({ type: "create", cwd: REPO, name: "browser-ops-ui" }));
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
  await page.waitForSelector('[data-exec-tab="browser"]', { timeout: 20000 });
  check("execution pane has a third tab", (await page.locator('[data-exec-tab="exec"]').count()) === 1);

  await page.locator('[data-exec-tab="browser"]').click();
  await page.waitForSelector(".browser-panel", { timeout: 20000 });
  check("empty round says there were no browser calls", (await page.locator(".browser-panel .exec-empty").innerText()).includes("这一轮没有浏览器操作"));

  await page.locator('[data-exec-tab="exec"]').click();
  socket.send(JSON.stringify({ type: "prompt", sessionId, text: "BROWSER" }));
  // 一颗浏览器调用在跑、而用户没在看浏览器 tab 时，那颗 tab 上要有 pip。
  await page.waitForSelector('[data-exec-tab="browser"] .exec-pip', { timeout: 20000 });
  check("a running browser call lights the tab pip", true);

  await page.locator('[data-exec-tab="browser"]').click();
  await page.waitForSelector(".browser-card", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".browser-card").length === 4, null, { timeout: 20000 });
  check("one card per browser call", (await page.locator(".browser-card").count()) === 4);
  check("summary counts the calls", (await page.locator(".browser-sum-text").innerText()).includes("共 4 次"));

  const done = page.locator('[data-bcall="call-browser-login"]');
  check("the finished call shows as done", (await done.count()) === 1);
  const doneBody = done.locator(".browser-body");
  check("a finished card starts folded away", (await doneBody.count()) === 0);
  const doneTitle = (await done.locator(".browser-title").innerText()).trim();
  check("a folded card reads as the actions it took", doneTitle.length > 0 && doneTitle.includes(" → ") && !doneTitle.includes("browser_exec"), doneTitle);
  check("the folded line keeps out code and coordinates", !/[(),]/.test(doneTitle) && !/browser_exec|goto_url|js\(/.test(doneTitle), doneTitle);
  check("the folded header carries the call duration", /\d/.test(await done.locator(".browser-dur").innerText()));

  // 脚本卡（`write` + `bash node x.mjs`）：真实会话里几张脚本卡结尾都是「读一眼页面」，
  // 折叠行只剩同一句「读取页面信息 ×2」，分不出这次是打开百度搜索、还是打开结果页截图。
  const scriptTitle = async (name) =>
    (await page.locator(".browser-card .browser-title").allInnerTexts()).find((line) => line.startsWith(`${name} · `)) ?? "";
  const searchTitle = await scriptTitle("search.mjs");
  const inspectTitle = await scriptTitle("inspect.mjs");
  check("a scripted call folds into its own card", searchTitle !== "" && inspectTitle !== "", `${searchTitle} | ${inspectTitle}`);
  check("a folded script card names the page it opened", /baidu\.com/.test(searchTitle) && /baidu\.com/.test(inspectTitle), `${searchTitle} | ${inspectTitle}`);
  check("…and says what it typed, not just how it ended", searchTitle.includes("南京今天天气"), searchTitle);
  const searchCard = page.locator('[data-bcall="call-bash-0"] .browser-title');
  check("a chain wider than the card is still all there on hover", (await searchCard.getAttribute("title")) === searchTitle, searchTitle);

  await done.locator(".browser-chev").click();
  check("the chevron expands the card", await done.locator(".browser-chev").getAttribute("aria-expanded") === "true");
  const steps = await done.locator(".browser-steps li").allInnerTexts();
  check("steps are the operations, not the raw code", steps.length >= 5 && steps.every((line) => !line.includes("goto_url")), steps.join(" | "));
  check("the first step is opening the url", steps[0].includes("打开") && steps[0].includes("/#/login"), steps[0]);
  check("the js step says it ran js", steps.some((line) => line.includes("执行 JS")), steps.join(" | "));
  check("the coordinate click reads as a click on those coordinates", steps.some((line) => line.includes("点击") && line.includes("412")), steps.join(" | "));
  check("the intent (what the model meant to do) is on the card", (await done.locator(".browser-intent").innerText()).includes("登录"));
  check("output is clamped to three lines until asked for more", await done.locator(".browser-out-body").evaluate((node) => Number(getComputedStyle(node).webkitLineClamp) === 3 && node.clientHeight < node.scrollHeight));
  await done.locator(".browser-out-toggle").click();
  const opened = await done.locator(".browser-out-body").evaluate((node) => ({ display: getComputedStyle(node).display, clamp: getComputedStyle(node).webkitLineClamp, scroll: node.scrollHeight, client: node.clientHeight, open: node.closest(".browser-out")?.className }));
  check("the output toggle opens the full text", opened.display === "block" && opened.open?.includes("open"), JSON.stringify(opened));

  const fold = page.locator(".browser-fold");
  check("the summary offers collapse-all", (await fold.innerText()).includes("全部折叠"));
  await fold.click();
  check("collapse-all folds every card", (await page.locator(".browser-card .browser-body").count()) === 0);
  check("the button flips to expand-all", (await fold.innerText()).includes("全部展开"));
  await fold.click();
  check("expand-all brings every body back", (await page.locator(".browser-card .browser-body").count()) === 4);

  const only = page.locator(".browser-only input");
  check("there is a main-session-only switch", (await only.count()) === 1);
  await only.check();
  check("switching it keeps the main cards", (await page.locator(".browser-card").count()) === 4);
  await only.uncheck();

  const gear = page.locator(".browser-gear");
  check("the summary has a gear for thresholds", (await gear.count()) === 1);
  await gear.click();
  const cfg = page.locator(".browser-cfg");
  check("the gear opens the thresholds and the tool list", (await cfg.locator("input[type=\"number\"]").count()) === 4 && (await cfg.locator(".browser-cfg-tools:not(.browser-cfg-commands)").inputValue()).includes("browser_use"), await cfg.innerText());
  check("the gear has an empty command-keyword box (D329)", (await cfg.locator(".browser-cfg-commands").inputValue()) === "");
  await cfg.locator(".browser-cfg-reset").click();
  check("reset drops the saved thresholds", (await page.evaluate(() => localStorage.getItem("pi.browserOps.thresholds"))) === null);
  await gear.click();
  check("the gear closes the editor again", (await page.locator(".browser-cfg").count()) === 0);

  // 时钟快进：不真等两分钟就能验「疑似卡住」。
  await page.evaluate(() => {
    const real = Date.now;
    window.__nowOff = 0;
    Date.now = () => real() + window.__nowOff;
  });
  const bump = (ms) => page.evaluate((value) => { window.__nowOff = value; }, ms);
  await bump(70_000);
  await page.waitForSelector('.browser-card[data-bstate="slow"]', { timeout: 5000 });
  check("a call past 60s is flagged", (await page.locator('.browser-card[data-bstate="slow"] .browser-badge').innerText()).includes("疑似卡住"));
  const slowHead = await page.locator('.browser-card[data-bstate="slow"] .browser-head').innerText();
  check("the flagged card offers to interrupt the round", (await page.locator('.browser-card[data-bstate="slow"] .browser-stop').count()) === 1, slowHead);
  check("the interrupt names the whole round", (await page.locator('.browser-card[data-bstate="slow"] .browser-stop').getAttribute("title")).includes("整轮"));
  await bump(130_000);
  await page.waitForSelector('.browser-card[data-bstate="stuck"]', { timeout: 5000 });
  check("a call past 120s turns red", true);

  let confirmText = "";
  page.on("dialog", (dialog) => {
    confirmText = dialog.message();
    void dialog.accept();
  });
  await page.locator('.browser-card[data-bstate="stuck"] .browser-stop').click();
  check("interrupting asks first, and says it stops the whole round", confirmText.includes("整轮"), confirmText);
  let aborted = false;
  for (let i = 0; i < 50 && !aborted; i += 1) {
    aborted = notes().some((note) => note.t === "abort");
    if (!aborted) await sleep(100);
  }
  check("interrupt aborts the run", aborted);

  check("page has no uncaught errors", pageErrors.length === 0, pageErrors.join("; "));
  console.log("All browser-panel smoke checks passed.");
} finally {
  if (browser) await browser.close();
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  bridge.kill();
  await sleep(150);
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (bridgeLog.includes("Error:")) console.error(bridgeLog.slice(-3000));
}
