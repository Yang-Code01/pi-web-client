/**
 * #484：上下文弹窗头部的三个入口 + 两个子弹窗的真浏览器冒烟。
 *
 * 跑在假 pi 上（`fixtures/fake-pi.mjs`），窗口固定 200K，所以「70% ≈ 140K」是可断言的。
 * 先 `npm run build:bridge && npm run build:web`，再：
 *   node bridge/tests/context-policy-ui.mjs
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-context-policy-ui-"));
const STATE = path.join(ROOT, "state");
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
// D296：端口交给系统分配（7914 在本机落在 Windows 保留段，listen 会 EACCES）。
const PORT = Number(process.env.CONTEXT_UI_PORT ?? (await freePort()));
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "context-ui-pass";
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
  // #484：自动交接要求 `/handoff` 技能存在（保存开关时查一次），假 pi 用 env 报一条给它。
  FAKE_PI_COMMANDS: JSON.stringify([{ name: "skill:handoff", description: "交接", source: "user" }]),
  // #484：交接全流程要用假 pi 把交接文档真的写到桥指定的路径上，好让「交接完成 → 页面切到新会话」能被验到。
  FAKE_PI_WRITE_HANDOFF: "1",
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
  const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");
  socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
  const frames = [];
  socket.on("message", (chunk) => frames.push(JSON.parse(chunk.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "create", cwd: REPO, name: "context-policy-ui" }));
  let sessionId = null;
  for (let i = 0; i < 100 && !sessionId; i += 1) {
    sessionId = frames.find((frame) => frame.type === "session" && frame.state?.id)?.state.id ?? null;
    if (!sessionId) await sleep(100);
  }
  check("session created", Boolean(sessionId));
  for (let i = 0; i < 100 && !frames.some((f) => f.type === "stats" && f.sessionId === sessionId); i += 1) await sleep(100);

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${BASE}/#/s/${sessionId}`);
  await page.waitForSelector(".app", { timeout: 20000 });
  await page.waitForSelector(".composer-input textarea", { timeout: 20000 });

  await page.locator('[data-act="context"]').click();
  await page.waitForSelector(".context-sheet", { timeout: 10000 });
  const actions = page.locator(".context-sheet .sheet-actions > .btn");
  check("context sheet header has 4 buttons (3 new + close)", (await actions.count()) === 4, String(await actions.count()));
  // AGENTS.md「网格里的可隐藏子元素」：横幅 hidden 时它不占格子，底栏必须仍贴底（#484 新增的
  // .handoff-banner 若被算进模板，输入框会被挤出 1fr —— 这个断言就是防它复发）。
  const stick = await page.evaluate(() => {
    const pane = document.querySelector(".chat-pane");
    const composer = document.querySelector(".chat-pane > .composer");
    const banner = document.querySelector(".chat-pane > .handoff-banner");
    if (!pane || !composer) return null;
    return {
      bannerHidden: !banner || banner.hidden,
      gap: Math.round(pane.getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom),
    };
  });
  check("banner hidden keeps the composer at the bottom", !!stick && stick.bannerHidden && Math.abs(stick.gap) <= 2, JSON.stringify(stick));

  check("the three entries exist", (await page.locator('.sheet-actions [data-act="context-policy"]').count()) === 1 && (await page.locator('.sheet-actions [data-act="context-compact"]').count()) === 1 && (await page.locator('.sheet-actions [data-act="context-handoff"]').count()) === 1);

  // --- 阈值子弹窗 ---------------------------------------------------------
  await page.locator('[data-act="context-policy"]').click();
  await page.waitForSelector(".sub-sheet", { timeout: 5000 });
  await page.waitForSelector('[data-role="compact-percent"]', { timeout: 10000 });
  const sheetText = await page.locator(".sub-sheet").innerText();
  check("policy sheet explains the window", sheetText.includes("200K"), sheetText.slice(0, 200));
  check("default compact line is 70% ≈ 140K", sheetText.includes("70") && sheetText.includes("140K"), sheetText);
  check("handoff starts unarmed", sheetText.includes("未武装"), sheetText);

  // 本地校验：40 vs 42 差 2 点 → 直接报错，不发 ws
  const before = frames.filter((f) => f.type === "context.policy").length;
  await page.locator('input[data-role="compact-percent"]').fill("40");
  await page.locator('[data-act="handoff-mode"]').selectOption("on");
  await page.locator('input[data-role="handoff-percent"]').fill("42");
  await page.locator('[data-act="policy-save"]').click();
  await page.waitForFunction(() => (document.querySelector(".sub-error")?.textContent ?? "").length > 0, null, { timeout: 5000 });
  check("a 2-point gap is rejected before it reaches the bridge", (await page.locator(".sub-error").innerText()).includes("5 个百分点"), await page.locator(".sub-error").innerText());
  check("nothing was saved", frames.filter((f) => f.type === "context.policy").length === before);

  await page.locator('input[data-role="handoff-percent"]').fill("45");
  await page.locator('[data-act="policy-save"]').click();
  let saved = null;
  for (let i = 0; i < 60 && !saved; i += 1) {
    saved = frames.find((f) => f.type === "context.policy" && f.sessionId === sessionId && f.policy?.layers?.session?.autoCompactPercent === 40) ?? null;
    if (!saved) await sleep(100);
  }
  check("saving writes a session-level override", Boolean(saved) && saved.policy.layers.session.autoHandoffPercent === 45, JSON.stringify(saved?.policy?.layers ?? null));
  check("the session override resolves as the effective source", saved?.policy?.policy?.compactFrom === "session" && saved?.policy?.policy?.handoffFrom === "session");
  check("the effective line is clamped to the model window", saved?.policy?.compact?.line === 80_000, String(saved?.policy?.compact?.line));

  await page.keyboard.press("Escape");
  await page.waitForSelector(".sub-sheet", { state: "detached", timeout: 5000 });
  check("Escape closes only the sub-sheet", (await page.locator(".context-sheet").count()) === 1);

  // --- 交接子弹窗 ---------------------------------------------------------
  await page.locator('[data-act="context-handoff"]').click();
  await page.waitForSelector('.sub-sheet [data-act="handoff-now"]', { timeout: 5000 });
  const handText = await page.locator(".sub-sheet").innerText();
  check("handoff sheet explains manual and automatic modes", handText.includes("手动交接") && handText.includes("自动交接"));
  check("handoff sheet shows the saved automatic line", handText.includes("45"), handText.slice(0, 300));
  const manual = page.locator('[data-act="handoff-now"]');
  check("manual handoff asks for a second click first", (await manual.innerText()).trim() === "手动交接");
  await manual.click();
  await page.waitForFunction(() => document.querySelector('[data-act="handoff-now"]')?.textContent?.includes("确认交接"), null, { timeout: 5000 });
  check("the first click arms instead of starting", !frames.some((f) => f.type === "handoff.state"));
  await page.keyboard.press("Escape");
  await page.waitForSelector(".sub-sheet", { state: "detached", timeout: 5000 });

  // --- 立即压缩 -----------------------------------------------------------
  await page.locator('[data-act="context-compact"]').click();
  let compacted = null;
  for (let i = 0; i < 50 && !compacted; i += 1) {
    compacted = frames.find((f) => f.type === "compacted" || f.type === "compaction" || f.type === "busy") ?? null;
    if (!compacted) await sleep(100);
  }
  // 桥收到 compact 之后 fake-pi 会回 compaction_start / end；页面至少不该报错。
  check("compact button does not blow up the page", pageErrors.length === 0, pageErrors.join("; "));
  console.log(`  info   compact frames seen: ${frames.filter((f) => f.type === "compacted" || f.type === "compaction").length}`);

  // --- 手动交接全流程（假 pi 会把交接文档写出来）---------------------------
  // #484 回归：交接完成后新会话建出来了，页面却没切过去，停在空白（用户实报）。
  await page.locator('[data-act="context-handoff"]').click();
  await page.waitForSelector('.sub-sheet [data-act="handoff-now"]', { timeout: 5000 });
  const sourceId = sessionId;
  await page.locator('[data-act="handoff-now"]').click();
  await page.locator('[data-act="handoff-now"]').click();
  let doneFrame = null;
  for (let i = 0; i < 300 && !doneFrame; i += 1) {
    doneFrame = frames.find((f) => f.type === "handoff.state" && f.sessionId === sourceId && f.phase === "done") ?? null;
    if (!doneFrame) await sleep(100);
  }
  check("handoff reports done with a new session", Boolean(doneFrame?.newId), JSON.stringify(doneFrame ?? null));
  const newId = String(doneFrame.newId);
  await page.waitForFunction((id) => location.hash.endsWith(id) && !!document.querySelector(".composer-input textarea"), newId, { timeout: 20000 });
  check("page follows the handoff into the new session", (await page.evaluate(() => location.hash)).endsWith(newId));
  check("the new session shows a working composer (not the blank state)", await page.locator(".composer-input textarea").isVisible());
  // D327：接棒的新会话在 create() 里置顶，落在 pin 末尾。
  check("the handoff session is pinned at the end (D327)", frames.some((f) => f.type === "manage" && Array.isArray(f.manage?.pin) && f.manage.pin.at(-1) === newId));
  check("the old session is archived after handoff", frames.some((f) => f.type === "manage" && Array.isArray(f.manage?.archived) && f.manage.archived.includes(sourceId)));

  check("page has no uncaught errors", pageErrors.length === 0, pageErrors.join("; "));
  console.log("All context-policy smoke checks passed.");
} finally {
  if (browser) await browser.close();
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  bridge.kill();
  await sleep(150);
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (bridgeLog.includes("Error:")) console.error(bridgeLog.slice(-3000));
}
