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
  check("失败那条进了左栏（且只一条）", (await page.locator('.bg-nav-item[data-state="failed"]').count()) === 1);
  check("左栏至少两条 run", (await page.locator(".bg-nav-item").count()) >= 2);
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

  // ---- 3. ARIA：tablist 只装 tab，每颗 tab 都指到一页；没选中的页整页 hidden
  const tabs = page.locator('.bg-sheet [role="tablist"] > *');
  check(
    "tablist 里只有 tab 子节点（计数那行不在里面）",
    await tabs.evaluateAll((ns) => ns.length > 0 && ns.every((n) => n.getAttribute("role") === "tab")),
    String(await tabs.count()),
  );
  check(
    "每颗 tab 都 aria-controls 到自己那页",
    await tabs.evaluateAll((ns) =>
      ns.every((n) => {
        const id = n.getAttribute("aria-controls");
        return Boolean(id && document.getElementById(id));
      }),
    ),
  );
  const selId = () => page.locator('.bg-nav-item[aria-selected="true"]').getAttribute("data-id");
  const beforeKey = await selId();
  await page.locator('.bg-nav-item[aria-selected="true"]').focus();
  await page.keyboard.press("ArrowUp");
  const afterKey = await selId();
  check("↑↓ 在左栏里换页", Boolean(afterKey) && afterKey !== beforeKey, `${beforeKey} → ${afterKey}`);

  // 键盘边界：第一条上按 ↑ 不动且焦点不丢、Home/End 跳首尾、Tab 能走进右栏（长日志要能用键盘滚）。
  await page.keyboard.press("Home");
  const firstId = await selId();
  await page.locator('.bg-nav-item[aria-selected="true"]').focus();
  await page.keyboard.press("ArrowUp");
  check("第一条上按 ↑ 不动", (await selId()) === firstId);
  check(
    "↑ 到头时焦点还在 tab 上",
    await page.evaluate(() => document.activeElement?.getAttribute("role") === "tab"),
  );
  await page.keyboard.press("End");
  const lastId = await selId();
  check("End 跳到末条", Boolean(lastId) && lastId !== firstId, `${firstId} → ${lastId}`);
  await page.keyboard.press("Home");
  check("Home 回第一条", (await selId()) === firstId);
  await page.keyboard.press("Tab");
  check(
    "Tab 从 tab 走进右栏（tabpanel 可聚焦）",
    await page.evaluate(() => document.activeElement?.getAttribute("role") === "tabpanel"),
  );

  // ---- 5. 窄窗（380×760）：左栏折成顶部横条，横条自己横滚、不被父级裁掉（#762 评审）
  await page.setViewportSize({ width: 380, height: 760 });
  await page.waitForTimeout(150);
  check(
    "窄窗折成单栏",
    await page
      .locator(".bg-body")
      .evaluate((n) => getComputedStyle(n).gridTemplateColumns.trim().split(/\s+/).length === 1),
  );
  const strip = page.locator(".bg-nav-list");
  const metrics = await strip.evaluate((n) => ({ scrollWidth: n.scrollWidth, clientWidth: n.clientWidth }));
  check("横条内容超出时能横滚", metrics.scrollWidth > metrics.clientWidth, JSON.stringify(metrics));
  check(
    "横条滚得动（scrollLeft 真变）",
    await strip.evaluate((n) => {
      n.scrollLeft = 200;
      return n.scrollLeft > 0;
    }),
  );
  check(
    "右栏抬头没被挤成三条",
    await page.locator(".bg-run:not([hidden]) .bg-run-head").evaluate((n) => n.getBoundingClientRect().height < 40),
  );
  // 上一段把横条往右滚了 200px：截图前拉回起点，不然拍到的是一半被裁掉的那颗。
  await strip.evaluate((n) => (n.scrollLeft = 0));
  await page.locator(".bg-sheet").screenshot({ path: path.join(OUT, "3-narrow.png"), animations: "disabled" });

  // ---- 6. 老占位文案不再出现在界面上（它把责任推给了桥）
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
