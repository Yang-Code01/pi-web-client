/**
 * 新会话「pi 启动完了」那一下不许把正在打字的人踢出输入框。
 *
 * 现场：开一个新会话 → pi 还在启动（`starting` 为真，D178 起输入框不禁用）→ 人已经在
 * 输入框里打字 → pi 答完 `get_state`，`starting` 翻假。前端 `mergeSession()` 把
 * `starting` 的变化当成「要整体重画」的理由，`renderChat()` 会 `replaceChildren()` 掉整块
 * composer —— 新的 textarea 是另一个节点，焦点跟着旧节点一起没了，人正在敲的字落进 body。
 *
 * 桩 pi 用 `FAKE_PI_BOOT_MS` 把启动拖住，所以这份测试能在启动窗口里真敲键盘：
 *   1. `starting` 期间输入框可聚焦、可输入（前提）；
 *   2. 启动结束之后焦点还在同一个输入框里；
 *   3. 期间敲进去的字符一个不少；
 *   4. 启动结束后接着敲的字仍然进输入框（不是事后补一次 focus 蒙混过关）。
 *
 * 端口由系统分配，可用 COMPOSER_FOCUS_PORT 钉住。截图落在 .scratch/shots/composer-focus-*.png。
 *
 * Run: npm run build && node bridge/tests/composer-focus.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "../../tools/playwright.mjs";
import { freePort } from "../../tools/free-port.mjs";

const { chromium } = await loadPlaywright();

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.COMPOSER_FOCUS_PORT ?? (await freePort()));
const ROOT = path.join(REPO, ".scratch", "composer-focus");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const CWD = path.join(ROOT, "cwd");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const OUT = path.join(REPO, ".scratch", "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "composer-focus-pass";
/** 启动窗口要长到「人已经打了一行字」，但别把测试拖太久。 */
const BOOT_MS = 5000;

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
fs.mkdirSync(CWD, { recursive: true });

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_WHATS_NEW: "0",
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  FAKE_PI_LOG: PI_LOG,
  FAKE_PI_BOOT_MS: String(BOOT_MS),
};
// First run only writes the passphrase down; the long-lived one reads it back.
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });

const bridge = spawn(process.execPath, [DIST], {
  cwd: REPO,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

let failed = 0;
let browser;
try {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(50);
  }
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 860 }, locale: "zh-CN" });
  await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("pageerror:", e.message));
  await page.goto(BASE);

  // 开新会话：面板 → 填目录 → 创建。会话一出现页面就切过去，此时 starting 还是真。
  await page.waitForSelector('.new-session [data-act="new"]', { timeout: 20000 });
  await page.locator('.new-session [data-act="new"]').click();
  await page.waitForSelector(".sheet.new-sheet", { timeout: 10000 });
  await page.locator(".sheet.new-sheet .ns-input.mono").first().fill(CWD);
  await page.locator(".sheet.new-sheet .dir-foot .btn.primary").click();
  await page.waitForSelector(".composer textarea", { timeout: 20000 });
  await page.waitForSelector(".sheet.new-sheet", { state: "detached", timeout: 20000 });

  const startingNow = await page.locator(".hint-status.starting").count();
  check("创建后正处启动窗口（界面显示「pi 正在启动…」）", startingNow > 0);

  const ta = page.locator(".composer textarea");
  await ta.click();
  const focusedBefore = await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA");
  check("启动期间输入框能聚焦（前提：D178 起不拦输入）", focusedBefore);

  // 人已经在打字：真按键，一次一个字符。starting 翻假的那一刻夹在这串按键里 ——
  // 修的正是「这一下别把焦点带走」。
  const typed = "启动完成前我一直在打字";
  let flippedAt = -1;
  let lostAt = -1;
  for (let i = 0; i < 200; i++) {
    if (await page.locator(".hint-status.starting").count() === 0) {
      flippedAt = i;
      break;
    }
    const active = await page.evaluate(() => document.activeElement?.classList?.contains("composer-input") || document.activeElement?.closest?.(".composer") != null);
    if (!active && lostAt < 0) lostAt = i;
    await page.keyboard.type(typed[i % typed.length]);
    await sleep(80);
  }
  check("启动窗口里真的敲进了字（不是空等）", flippedAt > 2, `flippedAt=${flippedAt}`);

  // 已翻假：这一刻就是用户被踢出输入框的时刻。
  await sleep(300);
  const after = await page.evaluate(() => {
    const a = document.activeElement;
    return {
      tag: a?.tagName ?? null,
      inComposer: Boolean(a?.closest?.(".composer")),
      value: (document.querySelector(".composer textarea"))?.value ?? "",
    };
  });
  check("启动结束后焦点仍在输入框", after.tag === "TEXTAREA" && after.inComposer, `activeElement=${after.tag} inComposer=${after.inComposer}`);
  // 失焦位置只作诊断信息；真正的判据是下面那条真断言。
  if (lostAt >= 0) log(`第 ${lostAt} 次按键时焦点被甩出去（这就是 bug）`);
  check("打字途中焦点没有被甩出去", lostAt < 0, lostAt >= 0 ? `第 ${lostAt} 次按键时失焦` : "");

  // 接着敲：不是靠重画后补一次 focus 过关，得真能继续输入。
  await page.keyboard.type("尾");
  const value = await page.locator(".composer textarea").inputValue();
  check("启动结束后接着敲的字照样进输入框", value.endsWith("尾"), JSON.stringify(value));
  const expected = typed.repeat(Math.ceil(flippedAt / typed.length)).slice(0, flippedAt);
  check("启动窗口里敲的字一个不少", value.startsWith(expected) && value.length >= flippedAt + 1, `len=${value.length} want≥${flippedAt + 1} prefix=${JSON.stringify(value.slice(0, Math.min(value.length, 24)))}`);

  await page.screenshot({ path: path.join(OUT, "composer-focus-after-boot.png") });
  log("shot composer-focus-after-boot.png");
} catch (e) {
  failed += 1;
  console.error("  FAIL", e?.stack ?? e?.message ?? e);
} finally {
  await browser?.close();
  bridge.kill();
}

const bad = results.filter((r) => !r.ok).length + failed;
console.log(bad ? `\n${bad} FAILED` : "\nALL OK");
if (bad) {
  console.error(bridgeLog.slice(-3000));
  process.exit(1);
}
