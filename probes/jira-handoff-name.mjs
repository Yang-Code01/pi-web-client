/**
 * #487：从 Jira 面板交给 agent 时，新会话面板的「会话名称」自动填票号的数字号码。
 *
 * 隔离桥（临时状态目录）+ 真 Chromium；Jira 那几个 HTTP 口在浏览器里拦成假数据
 * （`/api/jira/config`、`me`、`issues`、`projects`、下载计划），所以不需要真的连一张 Jira。
 *
 * 三条场景，断言的落点是**左栏那一行会话叫什么**，不是面板输入框内部有什么：
 *  1. 还没有任何会话时，Jira「预填到当前会话」回退去建新会话 —— 名字也要填（17967）；
 *  2. 有会话时，Jira「新开一个会话」—— 建出来就叫 42（ABC_DEF-42 去前缀）；
 *  3. 开完面板点取消，再点 ＋ 开新会话 —— 名字框是空的（名字不漏）。
 *
 * 跑：node probes/jira-handoff-name.mjs（先 npm run build:bridge && npm run build:web）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const BRIDGE = path.join(REPO, "bridge", "dist", "index.js");
const DIST = path.join(REPO, "web", "dist");
// 这台机器上 78xx–80xx 整段被系统保留（listen 直接 EACCES），探针用高段端口。
const PORT = Number(process.env.PI_WEB_PORT ?? 18043);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jira-name-"));
const AGENT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jira-name-agent-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jira-name-work-"));
const SHOTS = path.join(REPO, ".scratch", "jira-handoff-name");
fs.mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(120);
  }
  throw new Error(`超时：${what}`);
};

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

// ---- Jira 的假数据：两张票，只为了让票号有「前缀」可去 -------------------------
const ISSUES = [
  { key: "CASPH30INC-17967", summary: "探针用的第一张票", type: "Bug", priority: "High", status: "In Progress", assignee: "Probe", updated: "2026-11-17T10:00:00.000+0800" },
  { key: "ABC_DEF-42", summary: "探针用的第二张票", type: "Task", priority: null, status: "Open", assignee: "Probe", updated: "2026-11-17T09:00:00.000+0800" },
];
const JIRA_ROUTES = {
  "/api/jira/config": () => ({ configured: true, siteUrl: "https://acme.atlassian.net", email: "me@acme.dev", keyMask: "…9f2c", readonly: false }),
  "/api/jira/me": () => ({ accountId: "acc-probe", displayName: "Probe", email: "me@acme.dev", timezone: "Asia/Shanghai", avatarUrl: "" }),
  "/api/jira/issues": () => ({ issues: ISSUES }),
  "/api/jira/projects": () => ({ projects: [{ key: "CASPH30INC", name: "CASPH30" }] }),
  "/api/jira/attachments/root": () => ({ root: null }),
};

const child = spawn(process.execPath, [BRIDGE], {
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_AGENT_DIR: AGENT, PI_WEB_ROOT: DIST, PI_WEB_NO_EXT: "1" },
});
const bridgeLog = [];
child.stderr.on("data", (b) => {
  const line = String(b).trim();
  if (line) {
    bridgeLog.push(line.slice(0, 400));
    if (bridgeLog.length <= 40) log("bridge:", line.slice(0, 200));
  }
});
child.stdout.on("data", (b) => {
  const line = String(b).trim();
  if (line) bridgeLog.push(line.slice(0, 400));
});
const stop = () => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
};
process.on("exit", stop);

/** 左栏那一行会话的名字（外部行为，不碰面板内部）。 */
const railNames = (page) => page.locator(".session-card .row .name").allTextContents();
const currentTitle = (page) => page.evaluate(() => document.querySelector(".topbar .title")?.textContent ?? "");
const composer = (page) => page.evaluate(() => document.querySelector(".composer textarea")?.value ?? "");
const sheetName = (page) => page.evaluate(() => document.querySelector(".sheet.new-sheet input.ns-input")?.value ?? "<无名字框>");

let browser;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => {
    try {
      return (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 20000, "healthz");
  const passphrase = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());
  page.on("pageerror", (e) => log("page error:", e.message));

  // Jira 走 HTTP（/api/jira/...），在浏览器层拦掉，不连真站点。
  await page.route("**/api/jira/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = JIRA_ROUTES[pathname]
      ? JIRA_ROUTES[pathname]()
      : pathname.endsWith("/download") || pathname.endsWith("/downloaded")
        ? { dir: "", items: [] }
        : {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', passphrase);
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector('[data-act="jira"]', { timeout: 20000 });

  /** 打开 Jira 面板 → 等到那张票的行 → 点它的「交给 agent」→ 选一项。 */
  const jiraHandoff = async (key, label) => {
    if (!(await page.locator(".jira-issue").count())) await page.click('[data-act="jira"]');
    await page.waitForSelector(".jira-issue", { timeout: 15000 });
    const row = page.locator(".jira-issue", { hasText: key }).first();
    await row.waitFor({ timeout: 10000 });
    await row.hover();
    await row.locator("button.jira-handoff").click();
    await page.waitForSelector(".jira-handoff-pop", { timeout: 5000 });
    await page.locator(".jira-handoff-pop button", { hasText: label }).click();
  };

  /** 面板里换掉 cwd（名字不动，除非调用方要我改），然后创建。 */
  const submitSheet = async () => {
    await until(async () => page.locator(".sheet.new-sheet").isVisible(), 8000, "新开会话面板");
    await page.locator(".sheet.new-sheet input.ns-input.mono").first().fill(WORK);
    await page.locator(".sheet.new-sheet .dir-foot .btn.primary").click();
    await until(async () => (await page.locator(".sheet.new-sheet").count()) === 0, 60000, "会话建好");
    const t0 = Date.now();
    let ok = false;
    while (Date.now() - t0 < 20000) {
      if ((await page.locator(".composer textarea").count()) === 1) { ok = true; break; }
      await sleep(1000);
      log("  等 composer：会话卡片", JSON.stringify(await railNames(page)), "顶层字幕", JSON.stringify((await page.evaluate(() => document.querySelector(".flash, .toast, .err")?.textContent ?? ""))));
    }
    if (!ok) {
      log("--- bridge 日志 ---");
      for (const line of bridgeLog.slice(-25)) log(line);
      await page.screenshot({ path: path.join(SHOTS, "stuck.png") });
      throw new Error("超时：composer");
    }
    await page.waitForTimeout(700);
  };

  // ---- 场景 1：一个会话都没有 → 预填到当前会话回退成新会话，名字也要填
  log("== 场景 1：没有会话 + Jira「预填到当前会话」==");
  check("开场左栏是空的", (await railNames(page)).length === 0, JSON.stringify(await railNames(page)));
  await jiraHandoff("CASPH30INC-17967", "预填到当前会话");
  await until(async () => page.locator(".sheet.new-sheet").isVisible(), 8000, "回退出来的新会话面板");
  const firstName = await sheetName(page);
  log("名字框:", JSON.stringify(firstName));
  check("回退出来的面板里名字已是 17967", firstName === "17967", firstName);
  await page.screenshot({ path: path.join(SHOTS, "1-prefill-fallback.png") });
  await submitSheet();
  const afterFirst = await railNames(page);
  log("左栏:", JSON.stringify(afterFirst), "标题:", JSON.stringify(await currentTitle(page)));
  check("建出来的会话在左栏就叫 17967", afterFirst.some((n) => n.trim() === "17967"), JSON.stringify(afterFirst));
  check("标题栏也是 17967", (await currentTitle(page)).includes("17967"), await currentTitle(page));
  const firstComposer = await composer(page);
  check("这张票的提示词进了它的输入框", firstComposer.includes("CASPH30INC-17967"), firstComposer.slice(0, 80));

  // ---- 场景 2：有会话 → Jira「新开一个会话」，票号 ABC_DEF-42 → 42
  log("== 场景 2：Jira「新开一个会话」==");
  await jiraHandoff("ABC_DEF-42", "新开一个会话");
  await until(async () => page.locator(".sheet.new-sheet").isVisible(), 8000, "新开会话面板");
  const secondName = await sheetName(page);
  log("名字框:", JSON.stringify(secondName));
  check("新会话面板里名字已是 42", secondName === "42", secondName);
  await page.screenshot({ path: path.join(SHOTS, "2-new-session.png") });
  await submitSheet();
  const afterSecond = await railNames(page);
  log("左栏:", JSON.stringify(afterSecond));
  check("建出来的会话在左栏就叫 42", afterSecond.some((n) => n.trim() === "42"), JSON.stringify(afterSecond));
  check("先前那个 17967 还在", afterSecond.some((n) => n.trim() === "17967"), JSON.stringify(afterSecond));
  check("第二个会话的输入框拿到的是第二张票", (await composer(page)).includes("ABC_DEF-42"), (await composer(page)).slice(0, 80));

  // ---- 场景 3：交接面板取消 → 再开新会话，名字框必须空
  log("== 场景 3：取消之后名字不漏 ==");
  await jiraHandoff("CASPH30INC-17967", "新开一个会话");
  await until(async () => page.locator(".sheet.new-sheet").isVisible(), 8000, "新开会话面板（要取消）");
  check("取消前名字是 17967", (await sheetName(page)) === "17967", await sheetName(page));
  await page.locator(".sheet.new-sheet .sheet-head .btn.ghost", { hasText: "取消" }).click();
  await until(async () => (await page.locator(".sheet.new-sheet").count()) === 0, 5000, "面板关掉");
  await page.locator('.new-session [data-act="new"]').click();
  await until(async () => page.locator(".sheet.new-sheet").isVisible(), 8000, "普通新会话面板");
  const plainName = await sheetName(page);
  log("普通新会话的名字框:", JSON.stringify(plainName));
  check("交接取消后，普通新会话的名字框是空的", plainName === "", plainName);
  await page.screenshot({ path: path.join(SHOTS, "3-after-cancel.png") });
  await page.locator(".sheet.new-sheet .sheet-head .btn.ghost", { hasText: "取消" }).click();

  console.log(failures.length ? `\n${failures.length} 项失败：${failures.join(" / ")}` : "\n全部通过");
  if (failures.length) process.exitCode = 1;
  await ctx.close();
} finally {
  await browser?.close();
  stop();
}
