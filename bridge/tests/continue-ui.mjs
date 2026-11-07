/**
 * 「继续」按钮（D159）在真界面里跑一遍 —— 自带一个丢弃式的 bridge + 脚本化 pi（`fixtures/fake-pi.mjs`），
 * 不花模型 turn，也不碰 7864 上正在用的那份。
 *
 *   node bridge/tests/continue-ui.mjs
 *
 * 验的是四个只能看真 DOM 才知道的事：
 *   A. 新会话（一条用户消息都没有）按钮在、是灰的；
 *   B. 跑完一轮变亮；跑着的时候是灰的；被打断之后又是亮的（这正是这个按钮的来由）；
 *   C. 点它发出去的是字面「继续」，**草稿留在输入框里**，而且它没有跟权限按钮打架 ——
 *      继续在下、权限在上、两颗粒子同宽，整块只比输入框高 3.5px（28 + 4 + 44 = 76 vs 72.5）；
 *   D. 英文界面：标签是 `Continue`，发出去的仍然是字面「继续」（模型读到的东西不跟界面语言变）。
 *
 * 端口默认 7888（其它探针已占 7891–7899），可用 CONTINUE_UI_PORT 改。
 *
 * 截图落在 .scratch/shots/continue-*.png。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.CONTINUE_UI_PORT ?? 7888);
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

  // -- D. 英文界面：标签译了，发出去的仍然是字面「继续」 -----------------
  // 两个 reviewer 都盯着这一点：模型读到的东西不该跟着界面语言变。
  const en = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await en.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const enPage = await en.newPage();
  await enPage.goto(`${BASE}/#/s/${sessionId}`);
  await enPage.waitForSelector(".composer .continue-btn", { timeout: 20000 });
  for (let i = 0; i < 100; i++) {
    if (!(await enPage.locator(".continue-btn").isDisabled())) break;
    await sleep(100);
  }
  const enLabel = (await enPage.locator(".continue-btn").innerText()).trim();
  check("英文界面标签是 Continue", enLabel === "Continue", JSON.stringify(enLabel));
  const beforeEn = piLog().length;
  await enPage.locator(".composer textarea").fill("english draft");
  await enPage.locator(".continue-btn").click();
  let sentEn = null;
  for (let i = 0; i < 100; i++) {
    sentEn = piLog().slice(beforeEn).find((r) => r.t === "turn");
    if (sentEn) break;
    await sleep(100);
  }
  check("英文界面发出去的仍是字面「继续」", sentEn?.text === "继续", JSON.stringify(sentEn?.text));
  check("英文界面草稿也在", (await enPage.locator(".composer textarea").inputValue()) === "english draft");
  await en.close();
  // -- E. 后台子代理（D170）：会话 settle 了，runner 还在跑 ------------------
  // 用户报的就是这一段：页面看着空闲（pi.status 已是 false），既没有提示，又能点「继续」。
  await turn("BGSTART please");
  const bar = page.locator(".bg-bar");
  for (let i = 0; i < 100; i++) {
    if (await bar.count()) break;
    await sleep(100);
  }
  check("输入框上方出现提示条", (await bar.count()) === 1);
  const barText = await page.locator(".bg-bar .bg-text").innerText().catch(() => "");
  check("提示条说是子代理在跑", /子代理运行中/.test(barText), JSON.stringify(barText));
  check("提示条写着是谁", /researcher/.test(barText), JSON.stringify(barText));
  check(
    "提示条在输入框上方",
    await page.evaluate(() => {
      const b = document.querySelector(".bg-bar").getBoundingClientRect();
      const r = document.querySelector(".composer .row").getBoundingClientRect();
      return b.bottom <= r.top + 1;
    }),
  );
  check("计时在走", /\d+:\d\d/.test(await page.locator(".bg-bar .bg-elapsed").innerText()), await page.locator(".bg-bar .bg-elapsed").innerText());
  check("「继续」灰了 —— pi 会在它回来时接着做", await button.isDisabled());
  const badges = await page.locator(".badge").allInnerTexts().catch(() => []);
  check("左栏那枚是「后台」而不是「完成」", badges.includes("后台"), JSON.stringify(badges.slice(0, 8)));
  await shot("bg", await composerClip());

  // -- F. 点开看详情（D170）：概览 + 活动记录尾 ---------------------------------
  // 假 pi 自己会把那份活动记录写进 `%TEMP%\acp-delegate`（跟真 runner 一个地方），这里只验桥读到了。
  await bar.click();
  let sheet = page.locator(".sheet.bg-sheet");
  await sheet.waitFor({ timeout: 5000 }).catch(() => {});
  check("点横幅能开详情", (await sheet.count()) === 1);
  check("标题是「后台子代理」", /后台子代理/.test(await page.locator(".sheet.bg-sheet .sheet-title").innerText().catch(() => "")));
  const cardText = await page.locator(".bg-run").innerText().catch(() => "");
  check("详情里写着是谁", /researcher/.test(cardText), JSON.stringify(cardText.slice(0, 120)));
  check("详情里写着派了什么活", /look at the files/.test(cardText), JSON.stringify(cardText.slice(0, 120)));
  check("详情里带着 runId", /del_fake/.test(cardText));
  for (let i = 0; i < 40; i++) {
    if (/continueState/.test(await page.locator(".bg-run-log").innerText().catch(() => ""))) break;
    await sleep(100);
  }
  const logText = await page.locator(".bg-run-log").innerText().catch(() => "");
  check("过程里能看到它在跑什么", /continueState/.test(logText), JSON.stringify(logText.slice(0, 120)));
  check("还在跑的时候没有「最终输出」", (await page.locator(".bg-run-out").isVisible().catch(() => false)) === false);
  await shot("bg-sheet", { x: 0, y: 0, width: 900, height: 620 });
  await page.locator(".sheet.bg-sheet .sheet-head button").click();
  check("关掉之后详情不在了", (await page.locator(".sheet.bg-sheet").count()) === 0);

  // 另一个入口：左栏那枚「后台」徽标。
  const bgBadge = page.locator(".badge.clickable").first();
  check("「后台」徽标可点", (await bgBadge.count()) === 1);
  await bgBadge.click();
  await page.locator(".sheet.bg-sheet").waitFor({ timeout: 5000 }).catch(() => {});
  check("点徽标也能开详情", (await page.locator(".sheet.bg-sheet").count()) === 1);
  await page.locator(".sheet.bg-sheet .sheet-head button").click();

  // -- G. 刷新页面之后（D170）：提示条还在，因为它是会话状态而不是前端记忆 -------------
  await page.reload();
  const bar2 = page.locator(".bg-bar");
  for (let i = 0; i < 150; i++) {
    if (await bar2.count()) break;
    await sleep(100);
  }
  check("刷新后提示条还在", (await bar2.count()) === 1);
  check("刷新后「继续」还是灰的", await button.isDisabled());
  await shot("bg-refresh", await composerClip());

  // -- H. 跑完了（D170）：提示条翻成「看结果」，但「继续」不再被拦 -------------------
  await turn("BGDONE now");
  for (let i = 0; i < 100; i++) {
    if (/已结束/.test(await page.locator(".bg-bar .bg-text").innerText().catch(() => ""))) break;
    await sleep(100);
  }
  const idleText = await page.locator(".bg-bar .bg-text").innerText().catch(() => "");
  check("完成通知一到，提示条翻成「已结束」", /子代理已结束/.test(idleText), JSON.stringify(idleText));
  check("跑完了就不再拦「继续」", !(await button.isDisabled()));
  check("跑完的样子不再闪", (await page.locator(".bg-bar.idle").count()) === 1);
  await shot("bg-done", await composerClip());

  // 结果还能点开看：这是「最终输出」唯一的正常路径 —— 没人在跑的时候点那一下。
  await bar2.click();
  sheet = page.locator(".sheet.bg-sheet");
  await sheet.waitFor({ timeout: 5000 }).catch(() => {});
  check("跑完之后徽标/横幅还点得开", (await sheet.count()) === 1);
  const doneText = await page.locator(".bg-run").innerText().catch(() => "");
  check("卡片上写「已完成」", /已完成/.test(doneText), JSON.stringify(doneText.slice(0, 160)));
  check("是总耗时不是「结束至今」", /用了/.test(doneText), JSON.stringify(doneText.slice(0, 160)));
  check("最终输出出来了", /三条接口都已对齐/.test(await page.locator(".bg-run-out").innerText().catch(() => "")));
  await shot("bg-done-sheet", { x: 0, y: 0, width: 900, height: 620 });
  await page.locator(".sheet.bg-sheet .sheet-head button").click();

  // 清理：给下一个人留干净的临时目录。
  fs.rmSync(path.join(os.tmpdir(), "acp-delegate", "del_fake.activity"), { force: true });
  fs.rmSync(path.join(os.tmpdir(), "acp-delegate", "del_fake.out"), { force: true });
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
