/**
 * 一轮就是**一块**：工具模块体内分两页（「操作」/「AI 执行失败」），失败不再长在模块外面。
 *
 *   node bridge/tests/ops-tabs-ui.mjs
 *
 * 自带丢弃式 bridge + 脚本化 pi（`TOOLS` 三颗成功、`FAILS` 四颗失败），不花模型 turn，也不碰
 * 7864 上正在用的那份。验的是只有真 DOM 才说得清的事：
 *   A. 没失败的一轮：页签整条不长，模块和从前一样，只有工具行；
 *   B. 有失败的一轮：标题照旧报「N 个操作 · … · N 失败」，体内多出两枚页签，失败那枚带计数；
 *   C. 点「AI 执行失败」→ 工具行让位、四条失败在原来那块里，模块**不跟着合上**（页签不是 summary）；
 *   D. 失败页里的「为什么没成」与完整原文都在，且没有任何 `.fitem` 落在 `.ops` 外面 ——
 *      模块外不再有第二张卡（这正是这次改东西的理由）；
 *   E. 没有失败时切不出去：只有一页就不该有页签；
 *   F. **老一轮**的页签也得点得动：翻回去点前面那几轮，切的是它自己那块，最后那一轮纹丝不动
 *      （`aria-selected` 与 `details.open` 一起验 —— 用户报障：前面几轮点了没反应）。
 *
 * 端口由系统分配，可用 OPS_TABS_UI_PORT 钉住。截图落在 .scratch/shots/ops-tabs-*.png。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";
import { freePort } from "../../tools/free-port.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.OPS_TABS_UI_PORT ?? (await freePort()));
const ROOT = path.join(REPO, ".scratch", "ops-tabs-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const OUT = path.join(REPO, ".scratch", "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "ops-tabs-ui-pass";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(ROOT, { recursive: true, force: true });
for (const dir of [STATE, AGENT, WORK]) fs.mkdirSync(dir, { recursive: true });

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
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });

const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

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
ws.send(JSON.stringify({ type: "create", cwd: WORK, name: "ops-tabs-ui" }));
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

async function turn(text) {
  const from = seen.length;
  ws.send(JSON.stringify({ type: "prompt", sessionId, text }));
  for (let i = 0; i < 300; i++) {
    const st = statusWhere(from);
    if (st.some((m) => m.running === true) && st.at(-1)?.running === false) return;
    await sleep(100);
  }
  throw new Error(`turn timeout: ${text}`);
}

const text = (loc) => loc.innerText().then((s) => s.replace(/\s+/g, " ").trim());
/** 轮询到条件成立为止（替掉固定 waitForTimeout）：等的是「那一刻的状态」，不是机器快慢。 */
const until = async (fn, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};
const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `ops-tabs-${name}.png`), fullPage: false });
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => log("pageerror:", e.message));

try {
  await page.goto(`${BASE}/#/s/${sessionId}`);
  await page.waitForSelector(".composer .perm-btn", { timeout: 20000 });

  // -- A. 没失败的一轮：不许多出一条控件 ------------------------------------
  await turn("TOOLS 查一下明天的天气");
  const first = page.locator(".ops").first();
  await first.waitFor({ timeout: 20000 });
  await first.locator(".ops-summary").click();
  await first.locator(".ops-panel .tool").first().waitFor({ timeout: 5000 });
  check("没失败时页签整条不出现", !(await page.locator(".ops-tab").first().isVisible()), "tabs hidden");
  check("工具行照旧在操作页", (await page.locator(".ops-panel[data-panel='ops'] .tool").count()) === 3);
  check("标题照旧报数量", /3 个操作/.test(await text(first.locator(".ops-title"))), await text(first.locator(".ops-title")));
  await shot("clean");

  // -- B. 有失败的一轮：页签长出来，标题仍报结论 ----------------------------
  await turn("FAILS 把这一轮的失败整理一下");
  const box = page.locator(".ops").last();
  await box.waitFor({ timeout: 20000 });
  const title = await text(box.locator(".ops-title"));
  check("标题报出 4 个操作", /4 个操作/.test(title), title);
  check("标题报出 4 失败（折叠时也能看出来）", /4 失败/.test(title), title);
  await box.locator(".ops-summary").click();
  await box.locator(".ops-tab").first().waitFor({ timeout: 5000 });
  check("体内长出两枚页签", (await box.locator(".ops-tab").count()) === 2);
  check("页签名是「操作」「AI 执行失败」", /^操作 ?/.test(await text(box.locator(".ops-tab").first())) && /AI 执行失败/.test(await text(box.locator(".ops-tab[data-panel='fail']"))), JSON.stringify([await text(box.locator(".ops-tab").first()), await text(box.locator(".ops-tab[data-panel='fail']"))]));
  check("失败页签带计数 4", /4/.test(await text(box.locator(".ops-tab[data-panel='fail']"))), await text(box.locator(".ops-tab[data-panel='fail']")));
  const aria = await box.locator(".ops-tab").evaluateAll((ns) => ns.map((n) => n.getAttribute("aria-selected")));
  check("初始页签就带 aria-selected（不用等第一次点击）", aria.join() === "true,false", JSON.stringify(aria));
  const cntColor = await box.locator(".ops-tab[data-panel='fail'] .cnt").evaluate((n) => getComputedStyle(n).color);
  check("失败计数是红的（不是灰的计数点）", cntColor === "rgb(251, 113, 133)", cntColor);
  check("一开始停在操作页", await box.locator(".ops-panel[data-panel='ops']").isVisible() && !(await box.locator(".ops-panel[data-panel='fail']").isVisible()));
  await shot("tabs");

  // -- C/D. 切到失败页：就是原来那块，工具行让位，模块不合上 ------------------
  await box.locator(".ops-tab[data-panel='fail']").click();
  await box.locator(".fitem").first().waitFor({ timeout: 5000 });
  check("模块没跟着合上（页签不是 summary）", await box.evaluate((n) => n.open === true));
  check("工具行让位", !(await box.locator(".ops-panel[data-panel='ops']").isVisible()));
  check("四条失败都在第二页里", (await box.locator(".fitem").count()) === 4);
  const head = await text(box.locator(".fitem").first());
  check("第一条给的是结论（徽标 + 一句话）", /EXIT 1|失败/.test(head) && head.includes("为什么没成"), head.slice(0, 80));
  const keys = await box.locator(".fitem .k").allInnerTexts();
  check("诊断键齐全（为什么没成 / AI 想做什么 / 影响）", ["为什么没成", "AI 想做什么", "影响 / 改进"].every((k) => keys.includes(k)), JSON.stringify(keys.slice(0, 5)));
  const raw = box.locator(".fitem details.raw").first();
  await raw.locator("summary.raw-top").click();
  check("完整原文能展开", await raw.locator("pre").isVisible());
  const outside = await page.evaluate(() => Array.from(document.querySelectorAll(".fitem")).filter((n) => !n.closest(".ops")).length);
  check("没有一条失败落在模块外面", outside === 0, `${outside} 个在外面`);
  await shot("fail");

  // -- C 反向：切回去还是同一块 --------------------------------------------
  await box.locator(".ops-tab[data-panel='ops']").click();
  check("切回操作页，工具行回来", await box.locator(".ops-panel[data-panel='ops']").isVisible());
  check("切回操作页，失败页收起", !(await box.locator(".ops-panel[data-panel='fail']").isVisible()));
  check("页签高亮跟着走", /操作/.test(await text(box.locator(".ops-tab.is-on"))) && !/AI 执行失败/.test(await text(box.locator(".ops-tab.is-on"))), await text(box.locator(".ops-tab.is-on")));

  // -- F. 老一轮的页签：点谁切谁（用户报障：翻回去点前面几轮的页签没反应）----
  // 页签的 onclick 以前读的是「当前这一轮」的模块指针，只有最后一轮的模块点得动；
  // 前面几轮的页签点了，动的是最后一轮（在屏幕外，所以看着像没反应）。
  await turn("FAILS 再跑一轮，凑出两个带页签的模块");
  // 倒数第二块：不写死下标，上面再多跑几轮也不会静默指错模块。
  const olderBox = page.locator(".ops").nth(-2);
  const newestBox = page.locator(".ops").last();
  await newestBox.waitFor({ timeout: 20000 });
  // 上一段已经把它点开了，这里再点一下就合上 —— 先把状态问清楚，别盲目 toggle。
  if (!(await olderBox.evaluate((n) => n.open))) await olderBox.locator(".ops-summary").click();
  const hidden = (loc, name) => loc.locator(`.ops-panel[data-panel='${name}']`).evaluate((n) => n.hidden);
  const sel = (loc, name) => loc.locator(`.ops-tab[data-panel='${name}']`).getAttribute("aria-selected");
  check("两个模块都长出两枚页签", (await olderBox.locator(".ops-tab").count()) === 2 && (await newestBox.locator(".ops-tab").count()) === 2);
  await olderBox.locator(".ops-tab[data-panel='fail']").click();
  check("点老一轮的「AI 执行失败」，那一轮自己切过去", await until(async () => (await hidden(olderBox, "ops")) === true && (await hidden(olderBox, "fail")) === false), JSON.stringify({ ops: await hidden(olderBox, "ops"), fail: await hidden(olderBox, "fail") }));
  check("老一轮的 is-on 与 aria-selected 都落在失败页", (await olderBox.locator(".ops-tab.is-on").getAttribute("data-panel")) === "fail" && (await sel(olderBox, "fail")) === "true" && (await sel(olderBox, "ops")) === "false", JSON.stringify({ on: await olderBox.locator(".ops-tab.is-on").getAttribute("data-panel"), ops: await sel(olderBox, "ops"), fail: await sel(olderBox, "fail") }));
  check("老一轮切页时最后那一轮不动", (await hidden(newestBox, "ops")) === false && (await hidden(newestBox, "fail")) === true, JSON.stringify({ ops: await hidden(newestBox, "ops"), fail: await hidden(newestBox, "fail") }));
  check("最后那一轮的高亮与 aria-selected 没被抢", (await newestBox.locator(".ops-tab.is-on").getAttribute("data-panel")) === "ops" && (await sel(newestBox, "ops")) === "true" && (await sel(newestBox, "fail")) === "false");
  check("点页签不碰模块的开合（老那一轮还是展开的）", (await olderBox.evaluate((n) => n.open)) === true);
  await shot("older-turn");
  await olderBox.locator(".ops-tab[data-panel='ops']").click();
  check("老一轮点回「操作」也是它自己回去", await until(async () => (await hidden(olderBox, "ops")) === false && (await hidden(olderBox, "fail")) === true));
} catch (err) {
  check(`场景跑完（${String(err?.message ?? err).split("\n")[0]}）`, false);
  await shot("failed").catch(() => {});
} finally {
  await browser.close();
  bridge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ok${failed.length ? `, ${failed.length} FAIL` : ""}`);
if (failed.length) {
  console.log(bridgeLog.slice(-2000));
  process.exit(1);
}
