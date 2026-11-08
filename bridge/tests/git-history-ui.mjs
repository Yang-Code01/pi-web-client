/**
 * D188 验收：在隔离实例上真开一次弹窗 —— 点 chip 出弹窗、两列有行、胶囊有数、挪窄变单列、
 * Esc 关得掉、fetch 失败时说人话（不是转一辈子）。
 *
 *   PI_WEB_BASE=http://127.0.0.1:17864 PI_WEB_DIR=<仓库> node bridge/tests/git-history-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { loadPlaywright } from "../../tools/playwright.mjs";

const BASE = process.env.PI_WEB_BASE ?? "http://127.0.0.1:17864";
const DIR = process.env.PI_WEB_DIR ?? process.cwd();
const OUT = process.env.PI_WEB_OUT ?? path.join(DIR, ".scratch/git-history-dialog/shots");
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: "test" }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const name = `分支弹窗 ${Date.now().toString().slice(-6)}`;
const sessionId = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie } });
  ws.on("open", () => ws.send(JSON.stringify({ type: "create", cwd: DIR, name })));
  ws.on("message", (b) => {
    let m = {};
    try {
      m = JSON.parse(b.toString());
    } catch {
      return;
    }
    if (m.type === "session.state" && m.session?.name === name) {
      resolve(m.session.id);
      ws.close();
    }
    if (m.type === "error") reject(new Error(m.message));
  });
  setTimeout(() => reject(new Error("create timeout")), 60000);
});
log("session", sessionId.slice(0, 8));

// 直接看一眼接口，省得把桥的错误当成页面的错误。
const api = await fetch(`${BASE}/api/git/history?dir=${encodeURIComponent(DIR)}&n=20`, { headers: { cookie } }).then((r) => r.json());
log("api:", JSON.stringify({ head: api.head, base: api.base, ahead: api.ahead, behind: api.behind, left: api.left?.length, right: api.right?.length, branches: api.branches?.length }));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const problems = [];
const fails = [];
/** 验收要能拒绝：不写断言的话这套东西只是把页面拍下来，Review 已经点过一次了。 */
const ok = (cond, msg) => {
  if (!cond) fails.push(msg);
};

async function open(width, height, tag) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: "zh-CN" });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`[${tag}] pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() === 401) problems.push(`[${tag}] 401 ${r.url()}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`[${tag}] console: ${m.text().slice(0, 200)}`);
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', "test");
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector(".session-list", { timeout: 20000 });
  await page.locator(`.session-card:has-text("${name}")`).first().click().catch(() => {});
  await page.waitForSelector(".git-chip", { timeout: 20000 });
  return { ctx, page };
}

// ---------------------------------------------------------------- 桌面
{
  const { ctx, page } = await open(1280, 820, "wide");
  await page.locator(".git-chip").first().click();
  await page.waitForSelector(".branch-sheet", { timeout: 15000 });
  await page.waitForSelector(".bc-row", { timeout: 15000 });
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)].map((n) => n.textContent.trim());
    return {
      title: document.querySelector(".branch-title")?.textContent?.trim(),
      pills: q(".bc-pill"),
      fork: document.querySelector(".bc-fork")?.textContent?.trim(),
      counts: q(".bc-counts span"),
      headL: document.querySelector(".bc-col[data-side='left'] .bc-name")?.textContent,
      headR: document.querySelector(".bc-col[data-side='right'] .bc-name")?.textContent,
      rowsL: document.querySelectorAll(".bc-col[data-side='left'] .bc-row").length,
      rowsR: document.querySelectorAll(".bc-col[data-side='right'] .bc-row").length,
      common: document.querySelectorAll(".bc-row.common").length,
      only: document.querySelectorAll(".bc-row.only").length,
      onlyR: document.querySelectorAll(".bc-row.onlyR").length,
      stamp: document.querySelector(".branch-stamp")?.textContent?.trim(),
      options: q(".bc-base option").slice(0, 6),
    };
  });
  log("弹窗:", JSON.stringify(info));
  ok(info.pills.length === 2, "缺少领先/落后胶囊");
  ok(info.rowsL > 0 && info.rowsR > 0, "两列都得有行");
  ok(info.common > 0, "同一仓库里两列一定有公共历史");
  ok(info.options[0] === "自动 · 跟随 origin/HEAD", `下拉第一项应是「自动」，实际 ${info.options[0]}`);
  ok(/^数据来自 .+ · 只读$/.test(info.stamp ?? ""), `底部数据时间格式不对：${info.stamp}`);
  await page.screenshot({ path: `${OUT}/dialog-wide.png` });

  // 换对照分支 → 数字要变（选下拉里第二个）
  const opts = await page.locator(".bc-base option").count();
  if (opts > 1) {
    // 挑一个真不一样的：第 0 个是裸 `origin`，第 1 个通常就是 origin/main。
    const values = await page.locator(".bc-base option").evaluateAll((ns) => ns.map((n) => n.value));
    const value = values.find((v) => v !== "origin" && v !== "origin/main") ?? values[1];
    await page.selectOption(".bc-base", value);
    await page.waitForTimeout(1200);
    log("换对照 →", await page.locator(".bc-pill").first().textContent(), "/", await page.locator(".bc-base").inputValue());
    await page.screenshot({ path: `${OUT}/dialog-other-base.png` });
  }

  // fetch：成功最好；失败也必须把话说清楚、按钮恢复可点（没有代理时 github 直连不通）
  const before = await page.locator(".branch-stamp").textContent();
  await page.locator(".branch-fetch").first().click();
  await page.waitForFunction(() => !document.querySelector(".branch-fetch")?.hasAttribute("disabled"), null, { timeout: 60000 }).catch(() => problems.push("fetch 按钮 60 秒没恢复"));
  await page.waitForTimeout(300);
  log("fetch →", JSON.stringify({ hint: (await page.locator(".branch-hint").textContent()).trim(), stamp: (await page.locator(".branch-stamp").textContent()).trim(), was: before }));
  await page.screenshot({ path: `${OUT}/dialog-after-fetch.png` });

  // 复制没被删掉，只是搬进来了：点一下「已复制」，0.9 秒后自己换回来
  await page.locator(".branch-tools .btn").first().click();
  await page.waitForTimeout(150);
  const copied = (await page.locator(".branch-tools .btn").first().textContent()).trim();
  ok(copied === "已复制", `复制按钮没反馈，文字是 ${copied}`);
  await page.waitForTimeout(1100);
  const restored = (await page.locator(".branch-tools .btn").first().textContent()).trim();
  ok(restored === "复制分支名", `复制按钮没换回原名，文字是 ${restored}`);
  log("复制:", JSON.stringify({ copied, restored }));

  // 分页封顶：桥端 300 封顶，按钮到顶要换成一句说明，不能再点出「点了没反应」
  for (let i = 0; i < 4; i++) {
    if (!(await page.locator(".bc-more").count())) break;
    await page.locator(".bc-more").first().click();
    await page.waitForTimeout(1500);
  }
  const cap = await page.evaluate(() => ({
    rows: document.querySelectorAll(".bc-row").length,
    more: document.querySelectorAll(".bc-more").length,
    note: [...document.querySelectorAll(".bc-empty")].map((n) => n.textContent.trim()).filter((t) => t.startsWith("只显示最近")),
  }));
  ok(cap.rows <= 600, `封顶后两列共 ${cap.rows} 行，超过 300×2`);
  if (cap.note.length) ok(cap.more === 0, "到了 300 封顶还留着「再加载」按钮");
  log("封顶:", JSON.stringify(cap));

  // Esc 关闭
  await page.keyboard.press("Escape");
  await page.waitForSelector(".branch-sheet", { state: "detached", timeout: 5000 });
  log("Esc 关掉:", true);
  await ctx.close();
}

// ---------------------------------------------------------------- 窄屏
{
  const { ctx, page } = await open(430, 860, "narrow");
  await page.locator(".git-chip").first().click();
  await page.waitForSelector(".branch-sheet", { timeout: 15000 });
  await page.waitForSelector(".bc-row", { timeout: 15000 });
  await page.waitForTimeout(400);
  const tabs = await page.locator(".branch-tabs button").count();
  const visible = await page.locator(".bc-col:visible").count();
  await page.screenshot({ path: `${OUT}/dialog-narrow-left.png` });
  if (tabs === 2) {
    await page.locator(".branch-tabs button").nth(1).click();
    await page.waitForTimeout(200);
    log("窄屏 tab 切换后可见列:", await page.locator(".bc-col:visible").count());
  }
  await page.screenshot({ path: `${OUT}/dialog-narrow-right.png` });
  log("窄屏:", JSON.stringify({ tabs, visible }));
  ok(tabs === 2, `窄屏应有 2 个 tab，实际 ${tabs}`);
  ok(visible === 1, `窄屏只应显示 1 列，实际 ${visible}`);
  await ctx.close();
}

await browser.close();
if (fails.length) problems.push(...fails.map((f) => `assert: ${f}`));
console.log(problems.length ? `problem:\n  ${problems.join("\n  ")}` : "accept: ok — 没有 pageerror / console error");
process.exitCode = fails.length ? 1 : 0;
