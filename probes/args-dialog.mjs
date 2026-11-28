/**
 * D460：「参数」对话框的可读性 + 外观守卫。
 *
 * 起因：执行面板「现在」卡上点开一条 bash，打开的窗口把 `JSON.stringify(args)` 原样铺在 <pre> 里 ——
 * 一条十几行的 heredoc 命令，每个换行都是字面的 `\n`，整段变成一堵两千字的墙（用户 2026-11-29 截图）。
 * 这个探针在真 Chromium 里点开那条 bash，量四件事：
 *   1. 命令按**真换行**铺开（`innerText` 有多行、不含字面 `\n`），且行首缩进还在；
 *   2. 命令上了 bash 语法色（`.hljs-*` 有 span）、顶上有「命令」+ 行数，其余参数成了事实胶囊；
 *   3. 「复制」拿到的是原文（真换行，不是 JSON 转义）；
 *   4. 窗口是 mac 的那一档材质（`data-mac-surface=window`、玻璃遮罩、14px 圆角），
 *      字号 150% 时底边不越出视口。
 * 顺便在 mac-dark / mac-light / 150% 三态各拍一张图（`.scratch/args-dialog/shots`）。
 *
 * Run: npm run build:bridge && npm run build:web && node probes/args-dialog.mjs
 * （起自己的一份 bridge + fake-pi，不碰 7864，也不花模型调用。）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";
import { freePort } from "../tools/free-port.mjs";
import { WebSocket } from "ws";

const { chromium } = await loadPlaywright();
const ROOT = path.join(REPO, ".scratch/args-dialog");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const OUT = path.join(ROOT, "shots");
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const PORT = Number(process.env.ARGS_DIALOG_PORT ?? (await freePort()));
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "args-dialog-pass";

// 每次重来：shots 里除了上一次的图，也可能混进子目录（逐个 rmSync 不递归会抛 EISDIR）。
fs.rmSync(OUT, { recursive: true, force: true });
for (const dir of [STATE, AGENT, OUT]) fs.mkdirSync(dir, { recursive: true });

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok   " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

if (!fs.existsSync(DIST)) {
  console.error("bridge/dist/index.js 不存在：先 npm run build:bridge");
  process.exit(2);
}
if (!fs.existsSync(path.join(REPO, "web", "dist", "index.html"))) {
  console.error("web/dist 不存在：先 npm run build:web");
  process.exit(2);
}

const env = {
  ...process.env,
  PI_WEB_STATE: STATE,
  PI_WEB_WHATS_NEW: "0",
  PI_AGENT_DIR: AGENT,
  PI_WEB_PORT: String(PORT),
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_TUNNEL: "0",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_BIN: FAKE_PI,
};
// 探针可能是在一个正在跑的 bridge 里面起的（agent 会话里跑的就是这样）：那两个变量会让新进程
// 以为自己是那台壳的「脑」，于是它去连 7864 的控制通道而不是自己起一份。必须摘掉。
delete env.PI_HOST_LINK;
delete env.PI_HOST_PID;
// 第一遍只写口令（跟 exec-panel-ui 一样），第二遍才真起桥。
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (chunk) => (bridgeLog += chunk.toString()));
bridge.stderr.on("data", (chunk) => (bridgeLog += chunk.toString()));

let browser;
let socket;
try {
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i += 1) {
    try {
      healthy = (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      /* 还在起 */
    }
    if (!healthy) await sleep(200);
  }
  check("bridge started", healthy);
  if (!healthy) throw new Error("bridge did not start");

  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");
  socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
  const frames = [];
  socket.on("message", (chunk) => frames.push(JSON.parse(chunk.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "create", cwd: REPO, name: "args-dialog" }));
  let sessionId = null;
  for (let i = 0; i < 100 && !sessionId; i += 1) {
    sessionId = frames.find((frame) => frame.type === "session" && frame.state?.id)?.state.id ?? null;
    if (!sessionId) await sleep(100);
  }
  check("session created", Boolean(sessionId));

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${BASE}/#/s/${sessionId}`);
  await page.waitForSelector(".composer-input textarea", { timeout: 20000 });
  await page.locator('[data-exec-tab="exec"]').click();
  socket.send(JSON.stringify({ type: "prompt", sessionId, text: "BASHARGS" }));

  const row = page.locator(".exec-now-tool", { hasText: "bash" }).first();
  await row.waitFor({ timeout: 20000 });
  check("the now card turns a long bash call into an openable row", await row.evaluate((node) => node.tagName === "BUTTON" && node.getAttribute("aria-haspopup") === "dialog"));
  await row.click();
  await page.waitForSelector(".argdialog", { timeout: 5000 });
  await sleep(500); // 入场动画（mac-window-in 460ms）演完再量几何

  // ---- 1. 真的换行，不是字面的 \n
  const text = page.locator(".argdialog-text").first();
  const body = await text.innerText();
  const rawLines = await text.evaluate((node) => node.textContent.split("\n"));
  check("the command is laid out with real newlines", body.split("\n").length >= 10, `${body.split("\n").length} lines`);
  check("no literal \\n is left in the text", !body.includes("\\n"), body.includes("\\n") ? JSON.stringify(body.slice(0, 160)) : "");
  check("indentation inside the heredoc survives", rawLines.some((line) => /^ {4}\S/.test(line)), JSON.stringify(rawLines.slice(6, 9)));
  check("the command is not one long single line", (await text.evaluate((node) => node.scrollHeight)) > 180);

  // ---- 2. 分块 + 语法色 + 事实胶囊
  check("the block is labelled as a command", (await page.locator(".argdialog-label").first().innerText()) === "命令");
  check("the block header counts the lines", /^\d+ 行$/.test((await page.locator(".argdialog-blockmeta").first().innerText()).trim()), await page.locator(".argdialog-blockmeta").first().innerText());
  check("bash syntax colours are applied", (await text.locator(".hljs-string, .hljs-built_in, .hljs-comment").count()) > 0);
  const facts = await page.locator(".argdialog-fact").allInnerTexts();
  check("short args become fact chips instead of JSON", facts.some((line) => line.includes("cwd")) && facts.some((line) => line.includes("timeout")), JSON.stringify(facts));
  check("the raw command is not dumped as JSON", !(await page.locator(".argdialog-body").innerText()).includes('{"command"'));

  // ---- 3. 复制的是原文
  await page.locator(".argdialog-copy").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check("copy hands back the real command text", copied.split("\n").length >= 10 && copied.startsWith("cd /Users/") && !copied.includes("\\n"), JSON.stringify(copied.slice(0, 60)));

  // ---- 4. mac 窗口材质
  const shell = await page.evaluate(() => {
    const scrim = document.querySelector(".argdialog");
    const panel = scrim?.firstElementChild;
    if (!scrim || !panel) return null;
    const scrimStyle = getComputedStyle(scrim);
    const panelStyle = getComputedStyle(panel);
    const rect = panel.getBoundingClientRect();
    return {
      surface: scrim.dataset.macSurface,
      scrimFilter: scrimStyle.backdropFilter || scrimStyle.webkitBackdropFilter,
      radius: panelStyle.borderTopLeftRadius,
      panelFilter: panelStyle.backdropFilter || panelStyle.webkitBackdropFilter,
      panelBg: panelStyle.backgroundColor,
      enter: panelStyle.animationName,
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      viewport: window.innerHeight,
    };
  });
  check("the dialog is marked as a mac window", shell?.surface === "window", JSON.stringify(shell));
  check("the scrim is the glass one, not a hard black sheet", /blur/.test(shell?.scrimFilter ?? ""), shell?.scrimFilter);
  check("the panel is a 14px rounded glass window", shell?.radius === "14px" && /blur/.test(shell?.panelFilter ?? "") && shell?.enter === "mac-window-in", JSON.stringify(shell));

  // 复制成功会弹一条 1.6s 的吐司，等它收掉再拍，别糊在截图里。
  await sleep(1800);
  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, name) });
    log("截图", path.join(OUT, name));
  };
  await shot("01-light.png");

  // ---- 5. 深色主题 + 150% 字号（#app 上有 zoom，量到的是视觉 px，直接跟视口比）
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "mac-dark"));
  await sleep(250);
  await shot("02-dark.png");
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "1.5"));
  await sleep(300);
  const tall = await page.evaluate(() => {
    const panel = document.querySelector(".argdialog-panel");
    const rect = panel.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height, viewport: window.innerHeight };
  });
  check("at 150% the window still fits the viewport", tall.top >= 0 && tall.bottom <= tall.viewport + 1 && tall.height > 200, JSON.stringify(tall));
  await shot("03-dark-150.png");
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--ui-scale", "1");
    document.documentElement.setAttribute("data-theme", "mac-light");
  });

  // ---- 6. 关掉之后窗口真的摘掉
  await page.keyboard.press("Escape");
  await sleep(400);
  check("Escape closes it", (await page.locator(".argdialog").count()) === 0);

  // ---- 7. 没有长字段的参数（ask_user_question 那种嵌套对象）退回缩进 JSON，也要能读
  await page.locator('[data-act="interrupt"]').click();
  await sleep(500);
  socket.send(JSON.stringify({ type: "prompt", sessionId, text: "NOWARGS" }));
  const askRow = page.locator(".exec-now-tool", { hasText: "ask_user_question" }).first();
  await askRow.waitFor({ timeout: 20000 });
  await askRow.click();
  await page.waitForSelector(".argdialog", { timeout: 5000 });
  await sleep(500);
  const jsonText = page.locator(".argdialog-text").first();
  const json = await jsonText.innerText();
  check("the outline is indented JSON, not one line", json.split("\n").length >= 6 && /^ {2}"questions"/m.test(json), JSON.stringify(json.slice(0, 120)));
  check("the outline is coloured, not plain text", (await jsonText.locator(".hljs-attr, .hljs-string").count()) > 0);
  check("the outline is labelled as arguments", (await page.locator(".argdialog-label").first().innerText()) === "参数");
  // questions[0].prompt 是埋在两层里的长文本：它要单独占一块（真换行），结构那块里只留省略号。
  const labels = await page.locator(".argdialog-label").allInnerTexts();
  check("a long nested string gets its own block", labels.includes("questions[0].prompt"), JSON.stringify(labels));
  const pulled = page.locator(".argdialog-block", { hasText: "questions[0].prompt" }).locator(".argdialog-text");
  const pulledText = await pulled.innerText();
  check("the pulled-out text is the full original", pulledText.length > 190 && !pulledText.includes("\\n"), JSON.stringify(pulledText.slice(0, 80)));
  check("the outline does not repeat it escaped", json.includes('"prompt": "…"'));
  await sleep(300);
  await shot("04-json.png");
  await page.keyboard.press("Escape");
  await sleep(400);

  check("page has no uncaught errors", pageErrors.length === 0, pageErrors.join("; "));

  if (failures) console.error(`\n${failures} 项没过`);
  else console.log("\n参数对话框：全部通过");
} catch (error) {
  failures += 1;
  console.error("探针失败:", error?.message ?? error);
  if (bridgeLog) console.error(bridgeLog.slice(-3000));
} finally {
  if (browser) await browser.close();
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  bridge.kill();
  await sleep(200);
  process.exitCode = failures ? 1 : 0;
}
