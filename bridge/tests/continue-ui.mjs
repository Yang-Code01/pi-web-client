/**
 * 「继续」按钮（D157）在真界面里跑一遍 —— 自带一个丢弃式的 bridge + 脚本化 pi（`fixtures/fake-pi.mjs`），
 * 不花模型 turn，也不碰 7864 上正在用的那份。
 *
 *   node bridge/tests/continue-ui.mjs
 *
 * 验的是三个只能看真 DOM 才知道的事：
 *   A. 新会话（一条用户消息都没有）按钮在、是灰的；
 *   B. 跑完一轮变亮；跑着的时候是灰的；被打断之后又是亮的（这正是这个按钮的来由）；
 *   C. 点它发出去的是字面「继续」，**草稿留在输入框里**，而且它没有跟权限按钮打架 ——
 *      继续在下、权限在上、两颗粒子同宽，整块只比输入框高 3.5px（28 + 4 + 44 = 76 vs 72.5）。
 *
 * 截图落在 .scratch/shots/continue-*.png。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.CONTINUE_UI_PORT ?? 7896);
const ROOT = path.join(REPO, ".scratch", "continue-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const OUT = path.join(REPO, ".scratch", "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "continue-ui-pass";

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

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  FAKE_PI_LOG: PI_LOG,
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

const piLog = () => (fs.existsSync(PI_LOG) ? fs.readFileSync(PI_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {
    /* wait */
  }
  await sleep(200);
}

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: PASS }),
});
const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");

// One session, driven from the test's own WS so the page stays the only UI in play.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
const seen = [];
ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "create", cwd: REPO, name: "continue-ui" }));
let sessionId = null;
for (let i = 0; i < 300 && !sessionId; i++) {
  const hit = seen.find((m) => m.type === "session" && m.state?.id);
  if (hit) sessionId = hit.state.id;
  else await sleep(200);
}
if (!sessionId) {
  console.error("no session:", bridgeLog.slice(-2000));
  process.exit(1);
}
log("session", sessionId);

const statusWhere = (from) => seen.slice(from).filter((m) => m.type === "pi.status" && m.sessionId === sessionId);

/** `prompt` + wait for that turn to end (running true → false) or to be aborted. */
async function turn(text, { abortAfter = 0 } = {}) {
  const from = seen.length;
  ws.send(JSON.stringify({ type: "prompt", sessionId, text }));
  if (abortAfter) {
    await sleep(abortAfter);
    ws.send(JSON.stringify({ type: "abort", sessionId }));
  }
  for (let i = 0; i < 300; i++) {
    const st = statusWhere(from);
    if (st.some((m) => m.running === true) && st.at(-1)?.running === false) return;
    await sleep(100);
  }
  throw new Error(`turn timeout: ${text}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => log("pageerror:", e.message));
await page.goto(`${BASE}/#/s/${sessionId}`);
await page.waitForSelector(".composer .perm-btn", { timeout: 20000 });

const button = page.locator(".continue-btn");
const shot = async (name, clip) => {
  await page.screenshot({ path: path.join(OUT, `continue-${name}.png`), clip });
  log("shot", `continue-${name}.png`);
};
const composerClip = async () => {
  const box = await page.locator(".composer").boundingBox();
  return box ? { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 220) } : undefined;
};

try {
  // -- A. a session nobody has spoken in ---------------------------------
  await page.waitForSelector(".continue-btn", { timeout: 20000 });
  check("按钮就在（不是藏起来）", await button.isVisible());
  check("新会话：灰的，没有可接的东西", await button.isDisabled());
  const geo = await page.evaluate(() => {
    const c = document.querySelector(".continue-btn").getBoundingClientRect();
    const p = document.querySelector(".perm-btn").getBoundingClientRect();
    const t = document.querySelector(".composer textarea").getBoundingClientRect();
    const r = document.querySelector(".composer .row").getBoundingClientRect();
    return { c: { x: c.x, y: c.y, w: c.width, h: c.height, b: c.bottom }, p: { x: p.x, y: p.y, w: p.width, h: p.height }, t: { h: t.height, top: t.top }, row: r.height };
  });
  check("竖着叠在权限按钮上方", geo.c.b <= geo.p.y && geo.p.y - geo.c.b <= 6, `继续底 ${geo.c.b.toFixed(1)} / 权限顶 ${geo.p.y.toFixed(1)}`);
  check("同宽（一颗按钮宽的贴片，不是另一行）", Math.abs(geo.c.w - geo.p.w) < 1, `${geo.c.w.toFixed(1)} vs ${geo.p.w.toFixed(1)}`);
  check("整行只比输入框高一点（≤ 6px）", geo.row - geo.t.h <= 6, `row ${geo.row.toFixed(1)} vs textarea ${geo.t.h.toFixed(1)}`);
  await shot("empty", await composerClip());

  // -- B. one finished turn, then one that gets interrupted --------------
  await turn("hi");
  check("跑完一轮就亮了（常驻，不只在被打断之后）", !(await button.isDisabled()));

  const from = seen.length;
  ws.send(JSON.stringify({ type: "prompt", sessionId, text: "SLOW please" }));
  for (let i = 0; i < 100; i++) {
    if (await button.isDisabled()) break;
    await sleep(100);
  }
  check("跑着的时候是灰的", await button.isDisabled());
  await shot("running", await composerClip());
  ws.send(JSON.stringify({ type: "abort", sessionId }));
  for (let i = 0; i < 200; i++) {
    const st = statusWhere(from);
    if (st.some((m) => m.running === true) && st.at(-1)?.running === false) break;
    await sleep(100);
  }
  for (let i = 0; i < 50; i++) {
    if (!(await button.isDisabled())) break;
    await sleep(100);
  }
  check("被打断之后又亮了 —— 这个按钮就是为这一刻准备的", !(await button.isDisabled()));
  await shot("interrupted", await composerClip());
  // 一张整页的：PR / 文档用得上，看得到「已中断」那条回复和它下面的按钮。
  await shot("interrupted-page");

  // -- C. what it actually sends, and what it leaves alone ---------------
  await page.locator(".composer textarea").fill("草稿别动");
  const before = piLog().length;
  await button.click();
  let sent = null;
  for (let i = 0; i < 100; i++) {
    sent = piLog().slice(before).find((r) => r.t === "turn");
    if (sent) break;
    await sleep(100);
  }
  check("发出去的是字面「继续」", sent?.text === "继续", JSON.stringify(sent?.text));
  check("草稿还在输入框里", (await page.locator(".composer textarea").inputValue()) === "草稿别动");
  const bubble = await page.locator(".msg.user .body").last().innerText().catch(() => "");
  check("对话里出现一条「继续」", bubble.trim() === "继续", JSON.stringify(bubble.slice(0, 40)));
  for (let i = 0; i < 100; i++) {
    if (!(await button.isDisabled())) break;
    await sleep(100);
  }
  await shot("after", await composerClip());
} catch (err) {
  check(`没跑完：${String(err?.message ?? err).split("\n")[0]}`, false);
  if (bridgeLog) log("bridge:", bridgeLog.slice(-1500));
} finally {
  await browser.close();
  ws.close();
  bridge.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} ok`);
  process.exit(failed.length ? 1 : 0);
}
