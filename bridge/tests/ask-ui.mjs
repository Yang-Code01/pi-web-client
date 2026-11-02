/**
 * The inline ask panel, driven in real Chromium against its own throwaway bridge.
 *
 *   node bridge/tests/ask-ui.mjs
 *
 * Costs three model turns (a live pi child has to actually call `question` / `questionnaire`).
 * Screenshots land in .scratch/shots/ask-*.png.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const ROOT = "F:/pi-web-client";
const DIST = path.join(ROOT, "bridge", "dist", "index.js");
const PORT = Number(process.env.ASK_UI_PORT ?? 7892);
const STATE = path.join(ROOT, ".scratch", "ask-ui-state");
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, ".scratch", "shots");
const PASS = "ask-ui-pass";
const ASK_WAIT = 90000; // the model needs a turn or two to call the tool
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });

const env = { ...process.env, PI_WEB_STATE: STATE, PI_WEB_PORT: String(PORT), PI_WEB_HOST: "127.0.0.1", PI_WEB_TUNNEL: "0", PI_WEB_ROOT: path.join(ROOT, "web", "dist") };
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

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
const setCookie = login.headers.get("set-cookie") ?? "";
const [cookieName, cookieValue] = setCookie.split(";")[0].split("=");

// ---------------------------------------------------------------- session
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
const seen = [];
ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "create", cwd: ROOT, name: "ask-ui" }));
let sessionId = null;
for (let i = 0; i < 300 && !sessionId; i++) {
  const hit = seen.find((m) => m.type === "session" && m.state?.id);
  if (hit) sessionId = hit.state.id;
  else await sleep(200);
}
check("session created", Boolean(sessionId), String(sessionId));
log("session", sessionId);

const toolResult = (name) => {
  const items = seen.filter((m) => m.type === "item.replace" && m.item?.kind === "tool" && String(m.item.name).startsWith(name)).map((m) => m.item);
  return items.at(-1)?.result ?? "";
};

/** Wait until the child finished the turn that started at event index `start`. */
async function waitTurnEnd(start, label) {
  for (let i = 0; i < 900; i++) {
    const s = seen.slice(start).filter((m) => m.type === "pi.status" && m.sessionId === sessionId);
    if (s.some((m) => m.running === true) && s.at(-1)?.running === false) return;
    await sleep(300);
  }
  throw new Error(`turn timeout: ${label}`);
}

// ---------------------------------------------------------------- browser
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => log("pageerror:", e.message));
await page.goto(`${BASE}/#/s/${sessionId}`);
await page.waitForSelector(".app", { timeout: 20000 });
log("app open");

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `ask-${name}.png`), fullPage: false });
  log("shot", `ask-${name}.png`);
};

try {
  // -- turn 1: single question, answered from the inline panel ------------
  const start1 = seen.length;
  ws.send(JSON.stringify({
    type: "prompt",
    sessionId,
    text: "只调用 question 工具一次，问我「选左边还是右边？」，选项只要「左边」和「右边」。不要做任何别的事。",
  }));
  await page.waitForSelector(".ask-slot .ask-opts", { timeout: ASK_WAIT });
  check("the inline panel opens by itself when a question arrives", true);
  const progress = seen.filter((m) => m.type === "pi.status" && m.running === true).length > 0;
  check("the turn is waiting on us", progress, "");
  check("the panel sits in the composer", await page.locator(".composer .ask-slot .ask-opts").isVisible());
  await shot("panel-single");

  // Reload: the pending ask must come back from the snapshot, not from live events.
  await page.reload();
  await page.waitForSelector(".app", { timeout: 20000 });
  const replayed = await page.waitForSelector(".ask-slot .ask-opts", { timeout: 20000 }).then(() => true).catch(() => false);
  check("a reload replays the pending question", replayed);
  await shot("panel-replayed");

  await page.locator(".ask-opt", { hasText: "右边" }).click();
  await page.waitForSelector(".ask-slot", { state: "detached", timeout: 20000 });
  check("answering puts the panel away", true);
  await waitTurnEnd(start1, "question");
  const r1 = toolResult("question");
  check("the model got the chosen option", /User selected: 2\. 右边/.test(r1), r1.slice(0, 100));

  // -- turn 2: questionnaire, two tabs, explicit submit -------------------
  const start2 = seen.length;
  ws.send(JSON.stringify({
    type: "prompt",
    sessionId,
    text: "只调用 questionnaire 工具一次，问我两个问题：1) 主题，选项「商务」「休闲」；2) 语气，选项「正式」「轻松」。不要做任何别的事。",
  }));
  await page.waitForSelector(".ask-slot .ask-opts", { timeout: ASK_WAIT });
  const tabs = await page.locator(".ask-tab").count();
  check("both questions show up as tabs", tabs === 2, String(tabs));
  await page.locator(".ask-opt", { hasText: "商务" }).click();
  await page.locator(".ask-opt", { hasText: "轻松" }).click();
  await shot("panel-multi");
  const submit = page.locator(".ask-foot .btn.primary");
  check("submit becomes available once every question is answered", (await submit.innerText()).includes("提交"), await submit.innerText());
  await submit.click();
  await page.waitForSelector(".ask-slot", { state: "detached", timeout: 20000 });
  await waitTurnEnd(start2, "questionnaire");
  const r2 = toolResult("questionnaire");
  check("both answers reached the model", /主题: user selected: 1\. 商务/.test(r2) && /语气: user selected: 2\. 轻松/.test(r2), r2.replace(/\n/g, " | ").slice(0, 140));

  // -- turn 3: cancel ------------------------------------------------------
  const start3 = seen.length;
  ws.send(JSON.stringify({
    type: "prompt",
    sessionId,
    text: "只调用 question 工具一次，问我「继续吗？」，选项「继续」「停止」。不要做任何别的事。",
  }));
  await page.waitForSelector(".ask-slot .ask-opts", { timeout: ASK_WAIT });
  await page.locator(".ask-head .btn.danger-text", { hasText: "取消提问" }).click();
  await page.waitForSelector(".ask-slot", { state: "detached", timeout: 20000 });
  check("取消提问 puts the panel away", true);
  await waitTurnEnd(start3, "cancel");
  const r3 = toolResult("question");
  check("cancelling tells the model", /cancel/i.test(r3), r3.slice(0, 100));

  // -- turn 4: 自己写（直接打字回答） ----------------------------------------
  const start4 = seen.length;
  ws.send(JSON.stringify({
    type: "prompt",
    sessionId,
    text: "只调用 question 工具一次，问我「继续吗？」，选项「继续」「停止」。不要做任何别的事。",
  }));
  await page.waitForSelector(".ask-slot .ask-opts", { timeout: ASK_WAIT });
  const free = page.locator(".composer-input textarea");
  await free.fill("随便写点");
  await free.press("Enter");
  await page.waitForSelector(".ask-slot", { state: "detached", timeout: 20000 });
  check("typing in the composer answers the question", true);
  await waitTurnEnd(start4, "free text");
  const r4 = toolResult("question");
  check("free text reaches the model as User wrote", /User wrote: 随便写点/.test(r4), r4.slice(0, 100));

  // -- phone layout --------------------------------------------------------
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await phone.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const p = await phone.newPage();
  await p.goto(`${BASE}/#/s/${sessionId}`);
  await p.waitForSelector(".app", { timeout: 20000 });
  const start5 = seen.length;
  ws.send(JSON.stringify({
    type: "prompt",
    sessionId,
    text: "只调用 question 工具一次，问我「选左边还是右边？」，选项只要「左边」和「右边」。不要做任何别的事。",
  }));
  await p.waitForSelector(".ask-slot .ask-opts", { timeout: ASK_WAIT });
  await p.screenshot({ path: path.join(OUT, "ask-phone.png") });
  log("shot ask-phone.png");
  await p.locator(".ask-opt", { hasText: "左边" }).click();
  await p.waitForSelector(".ask-slot", { state: "detached", timeout: 20000 });
  await waitTurnEnd(start5, "phone");
  check("works on a 390px phone viewport", true);

  // -- turn 6: 中断 releases a pending question ------------------------
  const start6 = seen.length;
  ws.send(JSON.stringify({
    type: "prompt",
    sessionId,
    text: "只调用 question 工具一次，问我「继续吗？」，选项「继续」「停止」。不要做任何别的事。",
  }));
  await page.waitForSelector(".ask-slot .ask-opts", { timeout: ASK_WAIT });
  await page.locator(".ask-head .btn.ghost", { hasText: "收起" }).click();
  const folded = await page.locator(".ask-slot").isVisible();
  const optsGone = (await page.locator(".ask-slot .ask-opts").count()) === 0;
  check("收起 keeps the head and drops the answers", folded && optsGone, JSON.stringify({ folded, optsGone }));
  await page.locator('[data-act="interrupt"]').click();
  await page.waitForSelector(".ask-slot", { state: "detached", timeout: 30000 }).catch(() => {});
  await sleep(800);
  check("interrupting the run clears the panel", !(await page.locator(".ask-slot").isVisible().catch(() => false)));
  await sleep(1500);
  const removed = seen.slice(start6).filter((m) => m.type === "ask.remove");
  check("the pending ask was cancelled, not left hanging", removed.some((m) => m.status === "cancelled"), JSON.stringify(removed.map((m) => m.status)));
  // 中断只结束这一轮，pi 子进程留在会话里继续待命（`owned` 仍为 true 是正常的），
  // 所以要验证的是「这一轮停了」，不是「进程没了」。
  const stopped = () => {
    const st = seen.slice(start6).filter((m) => m.type === "pi.status" && m.sessionId === sessionId);
    return st.some((m) => m.running === true) && st.at(-1)?.running === false;
  };
  for (let i = 0; i < 20 && !stopped(); i++) await sleep(500);
  check("the run really stopped", stopped(), "");
} catch (err) {
  check(`unexpected: ${err?.message ?? String(err)}`, false);
  await shot("failure").catch(() => {});
  console.log(bridgeLog.slice(-1500));
} finally {
  ws.close();
  await browser.close();
  bridge.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}
