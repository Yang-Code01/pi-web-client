/**
 * Probe: 「子代理」详情卡上的字必须跟着数据走，不是建卡那一刻定死。
 *
 * 复现的是 2026-11-21 那次（会话 `skill`）：两张卡都写着「（任务原文没传到桥）」——
 *   1. 脚本式 workflow（`subagent({options:{script:…}})`）：原文只在 `options.script` 里，
 *      `status.json` 的 `steps[]` / `workflowChildren.children[]` 才是桥能读到的那一份，
 *      而它比派活晚 ~1.4 秒才落盘。卡片开了以后必须自己补上，不能等关弹层重开。
 *   2. 前台派活失败（`workflow: true` 但消息里没有 js 围栏）：失败原因只在那条工具结果里，
 *      老代码把它扔了，卡片只剩「失败 · 0:00」。现在要原样出现在卡上。
 *
 * 自带丢弃式 bridge + 脚本化 pi（fake-pi 的 BGSCRIPT / BGFAIL），不花模型 turn、不碰 7864。
 *
 *   npm --prefix web run build && npm --prefix bridge run build && node probes/bg-runs.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { WebSocket } from "ws";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";
import { freePort } from "../tools/free-port.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.BG_RUNS_PORT ?? (await freePort()));
const ROOT = path.join(REPO, ".scratch", "bg-runs-probe");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "bg-runs-pass";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, WORK, OUT]) fs.mkdirSync(d, { recursive: true });

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
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

let browser = null;
try {
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

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
  const seen = [];
  ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "create", cwd: WORK, name: "bg-runs" }));
  let sid = null;
  for (let i = 0; i < 300 && !sid; i++) {
    sid = seen.find((m) => m.type === "session" && m.state?.id)?.state.id ?? null;
    if (!sid) await sleep(100);
  }
  if (!sid) throw new Error(`no session:\n${bridgeOut.join("").slice(-2000)}`);
  const prompt = (text, clientId) => ws.send(JSON.stringify({ type: "prompt", sessionId: sid, text, images: [], clientId }));

  browser = await chromium.launch({ headless: !process.env.PW_HEADFUL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  // 停在会话列表：「后台」那枚徽标在卡片右下角，点它开会话详情（D170）。
  await page.goto(`${BASE}/#/`, { waitUntil: "networkidle" });
  await page.locator(".session-card, .session-cards .row").first().waitFor({ timeout: 15000 });

  // ---- 1. 脚本式 workflow：卡片开了以后，任务原文自己补上
  prompt("BGSCRIPT", "probe-script");
  const badge = page.locator(".badge.clickable").first();
  await badge.waitFor({ timeout: 20000 });
  await badge.click();
  await page.locator(".bg-sheet").waitFor({ timeout: 10000 });
  // 两栏：左栏一行一条 run，右栏一页一条。断言都对着「当前可见的那一页」。
  const card = page.locator(".bg-run:not([hidden])").first();
  await card.waitFor({ timeout: 10000 });
  check("左栏列出这条 run", (await page.locator(".bg-nav-item").count()) === 1);

  // 刚开卡时桥只认得出「有这么一个 run」：原文要等 `status.json`（fake-pi 延迟 1.2 s 才写）。
  const early = (await card.locator(".bg-run-task").textContent()) ?? "";
  check("开卡那刻还没有原文", early.includes("没有任务原文"), early);
  const filled = await page
    .waitForFunction(
      () => {
        const t = document.querySelector(".bg-run:not([hidden]) .bg-run-task")?.textContent ?? "";
        return t.includes("STANDARDS axis only") ? t : null;
      },
      undefined,
      { timeout: 12000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  check("留在同一张卡上就自动补上原文（不重开弹层）", Boolean(filled), filled ?? "(仍是占位)");
  check("两条孩子都列出来", typeof filled === "string" && filled.includes("SPEC axis only"), filled ?? "");
  const head = (await page.locator(".bg-run:not([hidden]) .bg-run-agent").textContent()) ?? "";
  check("卡片头跟着数据补成 reviewer", head === "reviewer", head);
  const navAgent = (await page.locator(".bg-nav-item").first().locator(".bg-nav-agent").textContent()) ?? "";
  check("左栏那一行也叫 reviewer", navAgent === "reviewer", navAgent);
  await page.locator(".bg-sheet").screenshot({ path: path.join(OUT, "1-script-filled.png"), animations: "disabled" });

  // ---- 2. 前台派活失败：失败原因要出现在卡上（弹层一直开着）
  prompt("BGFAIL", "probe-fail");
  // 失败那条在左栏（灯变红）：点它，右栏换页；再对着可见页断言。
  const failItem = page.locator('.bg-nav-item[data-state="failed"]').first();
  await failItem.waitFor({ timeout: 20000 });
  check("左栏现在有两条 run", (await page.locator(".bg-nav-item").count()) === 2);
  await failItem.click();
  const failCard = page.locator(".bg-run:not([hidden])").first();
  check("点左栏就换到失败那一页", ((await failCard.locator(".bg-run-id").textContent()) ?? "").includes("call_00_79ZGyKVyGhxhy8l7XsKw7723"));
  const stateText = (await failCard.locator(".bg-run-state").textContent()) ?? "";
  check("失败那张卡标了「失败」", stateText.includes("失败"), stateText);
  const errText = await failCard
    .locator(".bg-run-err")
    .textContent({ timeout: 12000 })
    .catch(() => null);
  check("失败原因照原样出现在卡上", (errText ?? "").startsWith("The workflow script is missing."), errText ?? "(空)");
  check("失败卡不出「最终输出」（没有 Return 块）", (await failCard.locator(".bg-run-out").count()) === 0 || !(await failCard.locator(".bg-run-out").isVisible()));
  check("失败卡不摆空的过程框", !(await failCard.locator(".bg-run-log").isVisible()));
  await page.locator(".bg-sheet").screenshot({ path: path.join(OUT, "2-failed.png"), animations: "disabled" });

  // ---- 3. 老占位文案不再出现在界面上（它把责任推给了桥）
  const body = await page.locator(".bg-sheet").innerText();
  check("不再断言「任务原文没传到桥」", !body.includes("任务原文没传到桥"), body.replace(/\n+/g, " | ").slice(0, 200));
  check("没有页面报错", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser?.close();
  bridge.kill();
}

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} 项失败` : `\nbg-runs: ${results.length} 项全过（截图在 ${OUT}）`);
process.exit(bad.length ? 1 : 0);
