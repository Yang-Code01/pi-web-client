/**
 * 「⚡ AI 出错记录」（D164）在真界面里跑一遍：自带丢弃式 bridge + 脚本化 pi（`FAILS` 场景故意做四颗失败），
 * 不花模型 turn，也不碰 7864 上正在用的那份。
 *
 *   node bridge/tests/failures-ui.mjs
 *
 * 验的是只有真 DOM + 真账本文件才说得清的事：
 *   A. 一轮跑完、有失败没入账 → 右下角「⚡ 总结本轮错误」亮，数字 = 这次会话的失败数；
 *   B. 点一下 → 账本落盘、四颗失败归成三类（两条 cd 同类、一条 netstat、一条 edit），toast 可撤销；
 *   C. bug 记录里第五个 tab「⚡ AI 出错记录」按次数排序，右边能看每次发生、能标已修复、能交给 agent；
 *   D. 再点一次同类 → 只加次数不新增行；撤销把整本退回点之前。
 *
 * 端口默认 7895（continue-ui 用 7888），可用 FAILURES_UI_PORT 改。
 * 截图落在 .scratch/shots/failures-*.png。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.FAILURES_UI_PORT ?? 7895);
const ROOT = path.join(REPO, ".scratch", "failures-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const OUT = path.join(REPO, ".scratch", "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "failures-ui-pass";

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
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });

const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

const piLog = () =>
  fs.existsSync(PI_LOG) ? fs.readFileSync(PI_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

/** 账本落盘在哪：`<state>/failures/*.json`，一个工作区一份。 */
const ledgerFile = () => {
  const dir = path.join(STATE, "failures");
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((n) => n.endsWith(".json"))[0];
  return f ? path.join(dir, f) : null;
};
const ledger = () => {
  const f = ledgerFile();
  return f ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
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
const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
const seen = [];
ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "create", cwd: REPO, name: "failures-ui" }));
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

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => log("pageerror:", e.message));
await page.goto(`${BASE}/#/s/${sessionId}`);
await page.waitForSelector(".composer .perm-btn", { timeout: 20000 });

const cta = page.locator(".fail-cta");
const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `failures-${name}.png`) });
  log("shot", `failures-${name}.png`);
};

try {
  // -- A. 一轮跑完、四颗失败还躺在会话里没入账 --------------------------
  await turn("FAILS now");
  await cta.waitFor({ state: "visible", timeout: 10000 });
  const label = (await cta.innerText()).replace(/\s+/g, " ").trim();
  check("右上角出现「⚡ 总结本轮错误」", label.includes("总结本轮错误"), JSON.stringify(label));
  check("数字是本轮的失败数（4 次，不是 4 类）", label.includes("4"), JSON.stringify(label));
  await shot("cta");

  // 刷新一页：没入账的失败要从会话快照里回放出来，按钮不能就这么没了。
  await page.reload();
  await cta.waitFor({ state: "visible", timeout: 15000 });
  await sleep(400);
  const again = ((await cta.innerText()) || "").replace(/\s+/g, " ").trim();
  check("刷新后按钮还在（快照里回放出这 4 次）", again.includes("4"), JSON.stringify(again));

  // -- B. 点一下弹小卡，再选「记进账本」：归并、落盘、可撤销 ----------
  await cta.click();
  await page.waitForSelector(".fail-menu", { timeout: 5000 });
  const menuText = (await page.locator(".fail-menu").innerText()).replace(/\s+/g, " ").trim();
  check("单击弹出小卡，两个举动都写着代价", menuText.includes("记进账本") && menuText.includes("发到会话复盘"), JSON.stringify(menuText));
  check("小卡顶部报出这一轮几次、归成几类", /本轮 4 次失败/.test(menuText), JSON.stringify(menuText.slice(0, 60)));
  await shot("menu");
  await page.locator(".fail-menu-item", { hasText: "记进账本" }).click();
  await page.waitForSelector(".fail-toast", { timeout: 10000 });
  const toast = (await page.locator(".fail-toast").innerText()).replace(/\s+/g, " ").trim();
  check("toast 报出这次入账几次", toast.includes("4"), JSON.stringify(toast));
  check("toast 带撤销", toast.includes("撤销"), JSON.stringify(toast));
  await shot("toast");

  for (let i = 0; i < 50 && !ledger(); i++) await sleep(100);
  let book = ledger();
  check("账本落在 <state>/failures/", Boolean(book), ledgerFile() ?? "missing");
  const classes = book?.entries?.map((e) => `${e.key}×${e.count}`) ?? [];
  check("四颗失败归成三类（两条 cd 并成一类）", book?.entries?.length === 3, JSON.stringify(classes));
  const pathEntry = book?.entries?.find((e) => e.tool === "bash" && e.code === "path");
  const nocmdEntry = book?.entries?.find((e) => e.code === "nocmd");
  const editEntry = book?.entries?.find((e) => e.tool === "edit");
  check("cd 那类记了 2 次", pathEntry?.count === 2, JSON.stringify(classes));
  check("netstat 没命中、edit 目标不存在各 1 次", nocmdEntry?.count === 1 && editEntry?.count === 1, JSON.stringify(classes));
  check("排序：次数多的在前", book?.entries?.[0]?.key === pathEntry?.key, JSON.stringify(classes));
  check("明细留了原文（能看出是哪个目录拼错了）", /feat-setti/.test(pathEntry?.occ?.[0]?.out ?? ""), (pathEntry?.occ?.[0]?.out ?? "").slice(0, 40));
  check("点完之后按钮灭掉", !(await cta.isVisible()));

  // 没有新失败的一轮：按钮不该又冒出来（它不是常驻打扰）。
  await turn("hi");
  await sleep(400);
  check("没有新失败时按钮不亮", !(await cta.isVisible()));

  // -- C. bug 记录里的第五个 tab ----------------------------------------
  await page.locator(".notes-btn").click();
  await page.waitForSelector(".notes-tab.fail-tab", { timeout: 10000 });
  const tab = page.locator(".notes-tab.fail-tab");
  check("tab 叫「⚡ AI 出错记录」", (await tab.innerText()).includes("AI 出错记录"), await tab.innerText());
  check("tab 上的计数 = 待修类数（3）", (await tab.innerText()).replace(/\s+/g, " ").includes("3"), await tab.innerText());
  await tab.click();
  await page.waitForSelector(".fail-list .fail-card", { timeout: 10000 });
  const rows = page.locator(".fail-list .fail-card");
  check("左栏三类都列出来", (await rows.count()) === 3, String(await rows.count()));
  const first = (await rows.first().innerText()).replace(/\s+/g, " ").trim();
  check("第一行是次数最多的那类（2 次）", first.includes("2"), JSON.stringify(first));
  check("搜索框在", await page.locator(".fail-search").isVisible());
  await shot("ledger");

  await rows.first().click();
  await page.waitForSelector(".fail-detail", { timeout: 5000 });
  const detail = (await page.locator(".fail-detail").innerText()).replace(/\s+/g, " ");
  check("右边说清楚为什么没成", detail.includes("没成"), detail.slice(0, 80));
  check("明细行显示两次发生", (await page.locator(".fail-ev").count()) >= 2, String(await page.locator(".fail-ev").count()));
  check("动作里有标为已修复 / 忽略 / 删除", detail.includes("标为已修复") && detail.includes("忽略这类") && detail.includes("删除"));
  await shot("detail");

  const hand = page.locator(".fail-hand");
  await hand.click();
  await page.waitForSelector(".note-handoff", { timeout: 5000 });
  const menu = (await page.locator(".note-handoff").innerText()).replace(/\s+/g, " ");
  check("「交给 agent」给两个落点（预填 / 新开）", menu.includes("预填") && menu.includes("新开"), JSON.stringify(menu.slice(0, 60)));
  await page.keyboard.press("Escape");

  // 标为已修复：从待修里消失，tab 计数减一。
  await page.locator(".fail-actions .btn", { hasText: "标为已修复" }).click();
  for (let i = 0; i < 50; i++) {
    if ((await page.locator(".fail-list > .fail-card").count()) === 2) break;
    await sleep(100);
  }
  check("标为已修复后离开待修列表", (await page.locator(".fail-list > .fail-card").count()) === 2, String(await page.locator(".fail-list > .fail-card").count()));
  check("tab 计数跟着减", !(await tab.innerText()).replace(/\s+/g, " ").includes("3"), await tab.innerText());
  await shot("fixed");
  await page.locator(".notes-head .btn.ghost", { hasText: "关闭" }).click();
  await sleep(300);

  // -- D. 同类再犯只加次数；撤销退回点之前 ------------------------------
  await turn("FAILS third");
  await cta.waitFor({ state: "visible", timeout: 10000 });
  check("新一轮又亮了", await cta.isVisible());
  const before = ledger();
  await cta.click();
  await page.waitForSelector(".fail-menu", { timeout: 5000 });
  await page.locator(".fail-menu-item", { hasText: "记进账本" }).click();
  for (let i = 0; i < 60; i++) {
    const now = ledger();
    if (now && now.entries.find((e) => e.code === "path" && e.tool === "bash")?.count === 4) break;
    await sleep(100);
  }
  book = ledger();
  const grown = book?.entries?.find((e) => e.tool === "bash" && e.code === "path");
  check("同类累计到 4 次（2 + 新的 2，且旧的没被重记）", grown?.count === 4, String(grown?.count));
  check("没有多出一行（还是三类）", book?.entries?.length === 3, String(book?.entries?.length));
  const undoBtn = page.locator(".fail-toast-undo");
  await undoBtn.waitFor({ state: "visible", timeout: 5000 });
  await undoBtn.click();
  await sleep(300);
  log("undo toast:", JSON.stringify(((await page.locator(".fail-toast").innerText().catch(() => "")) || "").slice(0, 80)));
  for (let i = 0; i < 60; i++) {
    if (ledger()?.entries?.find((e) => e.tool === "bash" && e.code === "path")?.count === 2) break;
    await sleep(100);
  }
  book = ledger();
  check("撤销把次数退回 2", book?.entries?.find((e) => e.tool === "bash" && e.code === "path")?.count === 2, String(book?.entries?.find((e) => e.tool === "bash" && e.code === "path")?.count));
  await shot("after-undo");

  // -- E. 第二个举动：发到会话复盘 ----------------------------------------
  await turn("FAILS review");
  await cta.waitFor({ state: "visible", timeout: 10000 });
  await cta.click();
  await page.waitForSelector(".fail-menu", { timeout: 5000 });
  const reviewItem = page.locator(".fail-menu-item", { hasText: "发到会话复盘" });
  const reviewLabel = (await reviewItem.innerText()).replace(/\s+/g, " ").trim();
  check("小卡写明这一下会发出什么", reviewLabel.includes("账本视角"), JSON.stringify(reviewLabel));
  await shot("menu-review");
  await reviewItem.click();

  await page.waitForSelector(".msg.review", { timeout: 20000 });
  const bubble = (await page.locator(".msg.review").first().innerText()).replace(/\s+/g, " ").trim();
  check("会话里出现「⚡ 自动复盘」那条", bubble.includes("自动复盘"), JSON.stringify(bubble.slice(0, 60)));
  check("发出去的是账本视角，不是把报错原文再贴一遍", bubble.includes("账本视角"), JSON.stringify(bubble.slice(0, 120)));
  check("它自己不会接着展开一堆解释（形状与提醒不同）", !bubble.includes("老毛病重犯"));
  await shot("review");

  const lastReview = piLog().filter((n) => n.t === "review").at(-1);
  check("脚本化 pi 收到了复盘提示词，并认出三类行", Boolean(lastReview) && (lastReview.classes ?? 0) > 0, JSON.stringify(lastReview ?? null));

  const ruleFile = () => {
    const dir = path.join(STATE, "rules");
    if (!fs.existsSync(dir)) return null;
    const f = fs.readdirSync(dir).filter((n) => n.endsWith(".json"))[0];
    return f ? path.join(dir, f) : null;
  };
  // 规矩是模型回答回来之后才写回的：等它落盘，而不是等文件出现（`readRules` 读一次就会建出空账）。
  let rule = null;
  for (let i = 0; i < 100 && !rule; i++) {
    const f = ruleFile();
    if (f) {
      try {
        rule = JSON.parse(fs.readFileSync(f, "utf8"))?.rules?.[0] ?? null;
      } catch {
        rule = null;
      }
    }
    if (!rule) await sleep(100);
  }
  check("规矩落在 <state>/rules/，与账本同一个工作区一份", Boolean(rule), ruleFile() ?? "missing");
  check("模型写在那行里的一句规矩被捡回来了", /先 test -d 再 cd/.test(rule?.rule ?? ""), JSON.stringify(rule?.rule ?? null));
  check("规矩挂在同一套归并键上", rule?.key === "bash|path|cd <path>", JSON.stringify(rule?.key ?? null));

  await page.locator(".notes-btn").click();
  await page.waitForSelector(".notes-tab.fail-tab", { timeout: 10000 });
  await page.locator(".notes-tab.fail-tab").click();
  await page.waitForSelector(".fail-fold.rules", { timeout: 10000 });
  const fold = (await page.locator(".fail-fold.rules").innerText()).replace(/\s+/g, " ").trim();
  check("账本左栏多出「⚡ 规矩」一节，且写着那句话", fold.includes("规矩") && fold.includes("先 test -d"), JSON.stringify(fold.slice(0, 80)));
  await page.locator(".fail-rule-row").first().click();
  await page.waitForSelector(".fail-rule", { timeout: 5000 });
  const ruleBlock = (await page.locator(".fail-rule").innerText()).replace(/\s+/g, " ").trim();
  check("右边能把这条规矩看全", ruleBlock.includes("这条规矩") && ruleBlock.includes("先 test -d"), JSON.stringify(ruleBlock.slice(0, 80)));
  check("规矩能改能删（人只动字，不凭空造类）", (await page.locator(".fail-rule .fail-rule-btn").count()) >= 2);
  await shot("rules");
  // 人改一句：同键覆盖，账本里的次数不动。
  await page.locator(".fail-rule .fail-rule-btn", { hasText: "改" }).first().click();
  const ruleInput = page.locator(".fail-rule-input");
  await ruleInput.waitFor({ timeout: 5000 });
  await ruleInput.fill("先 git rev-parse 拿路径，再 cd");
  await ruleInput.press("Enter");
  let edited = null;
  for (let i = 0; i < 60 && !edited; i++) {
    const f = ruleFile();
    try {
      const book = f ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
      if (book?.rules?.[0]?.rule === "先 git rev-parse 拿路径，再 cd") edited = book.rules[0];
      else if (book?.rules?.length !== 1) edited = null;
    } catch {
      edited = null;
    }
    if (!edited) await sleep(100);
  }
  check("改完一句就覆盖同一条（不新开一类）", edited?.key === "bash|path|cd <path>", JSON.stringify(edited?.rule ?? null));
  const ledgerAfter = JSON.parse(fs.readFileSync(ledgerFile(), "utf8"));
  check("改规矩不动账本里的次数", ledgerAfter.entries.some((e) => e.key === "bash|path|cd <path>" && e.count >= 2));
  await shot("rules-edited");
  // 删掉之后，这一节连「空壳」都不留。
  await page.locator(".fail-rule .fail-rule-btn", { hasText: "删" }).first().click();
  for (let i = 0; i < 60 && fs.existsSync(ruleFile()); i++) {
    const f = ruleFile();
    const book = f ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    if (!book?.rules?.length) break;
    await sleep(100);
  }
  await sleep(300);
  check("删掉那条之后左栏的「⚡ 规矩」也收了", (await page.locator(".fail-fold.rules").count()) === 0);
  await page.locator(".notes-head .btn.ghost", { hasText: "关闭" }).click();
  await sleep(300);
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
