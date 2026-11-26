/**
 * Probe: Jira 面板点一次只能挂载一次外壳。
 *
 * 回归的形态与邮箱面板一模一样（D384，那是邮箱的修法；Jira 是当时漏改的那一个）：
 * `JiraPanel.render()` 每次重画都整棵重建 `.jc-back` + `.jc-console` 再 `replaceWith`，而一次 open()
 * 至少要画四次（`open()` 自己一次、`reload()` 拿到 config 一次、`loadMe()` 一次、`loadLists()` 一次，
 * 「@我的」回来还会再加一次）。Mac 材质给这两层挂的 `mac-fade-in` / `mac-window-in` 就跟着演好几遍 ——
 * 用户看到的是「打开 Jira dialog，dialog 会弹多次」。
 *
 * 这里只盯可数的东西：
 *   1. 点一次按钮，`.jc-back` 在 #app 里被插入几次（必须恰好 1）；
 *   2. 那次挂载的 `.jc-console` 身上有没有 `mac-window-in`（开场照旧演，但只演一次）；
 *   3. 切一次分区、点一次「刷新」：不许重挂；
 *   4. Esc 关闭后，迟到的重画不许把面板重新挂出来；关了再开，重新开场但也只挂一次。
 *
 * Jira 的几个 HTTP 口在浏览器里拦成假数据，不需要真连一张 Jira。
 *
 * Run: npm run build:web && npm run build:bridge && node probes/jira-panel-single-mount.mjs
 *
 * 从 7864 那份壳的会话里跑时，子桥不能带 `PI_HOST_LINK`（否则它会去连壳的命名管道、连不上就退），
 * 所以这里 spawn 时把它摘掉了。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const PORT = Number(process.env.PI_WEB_PORT ?? 18893);
const ROOT = path.join(REPO, ".scratch/jira-single-mount");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, OUT]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pageRef = null;
const failures = [];
const check = (cond, msg) => {
  if (cond) log("ok  ", msg);
  else {
    log("FAIL", msg);
    failures.push(msg);
  }
};

// ---- Jira 的假数据：两张票 + 一个项目，够面板走完 config → me → issues / projects / recent --------
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
  "/api/jira/recent": () => ({ kind: "mentions", items: [], skipped: 0 }),
};

const { PI_HOST_LINK: _hostLink, ...baseEnv } = process.env;
const child = spawn(process.execPath, [path.join(REPO, "bridge", "dist", "index.js")], {
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
  // PI_WEB_TUNNEL=0：隔离实例不起隧道；PI_WEB_NO_EXT=1：不装 / 不探扩展。
  // 不带 PI_HOST_LINK：本进程可能是 7864 那份壳起的会话，带着它子桥会去连壳的命名管道、连不上就退。
  env: { ...baseEnv, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_AGENT_DIR: AGENT, PI_WEB_ROOT: path.join(REPO, "web", "dist"), PI_WEB_TUNNEL: "0", PI_WEB_NO_EXT: "1" },
});
const bridgeOut = [];
child.stdout.on("data", (b) => bridgeOut.push(b.toString()));
child.stderr.on("data", (b) => bridgeOut.push(b.toString()));

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* 还没好 */
    }
    await sleep(100);
  }
  console.error(bridgeOut.join("").slice(-3000));
  // 超时了先把面板现状打出来：下次再红，一眼看得出停在哪一步（空壳 / 表单 / 报错）。
  if (pageRef && !pageRef.isClosed()) {
    console.error("面板现状:", await pageRef.evaluate(() => ({
      back: document.querySelectorAll(".jc-back").length,
      shellChildren: [...document.querySelectorAll(".jc-console")].map((s) => s.children.length),
      pane: (document.querySelector(".jc-pane")?.textContent ?? "").replace(/\s+/g, " ").slice(0, 300),
    })).catch(() => "(页面已不可读)"));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const stop = () => {
  try {
    child.kill();
  } catch {
    /* 已经没了 */
  }
};
process.on("exit", stop);

let browser = null;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const passphrase = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  pageRef = page;
  page.on("dialog", (d) => void d.accept());
  page.on("pageerror", (e) => log("page error:", e.message));

  // Jira 走 HTTP（/api/jira/...），在浏览器层拦掉，不连真站点。
  await page.route("**/api/jira/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = JIRA_ROUTES[pathname]?.() ?? {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', passphrase);
    await page.click('button:has-text("进入")');
  }
  const jiraBtn = page.locator('[data-act="jira"]');
  await until(() => jiraBtn.isVisible(), 20000, "Jira 按钮");

  // 先装观察者：只看 #app 的直接子节点插入里有没有 .jc-back。
  await page.evaluate(() => {
    const host = document.getElementById("app") ?? document.body;
    window.__jc = [];
    window.__jcObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || !node.classList?.contains("jc-back")) continue;
          const shell = node.querySelector(".jc-console");
          window.__jc.push({
            t: Math.round(performance.now()),
            anims: shell ? shell.getAnimations().map((a) => a.animationName) : [],
          });
        }
      }
    });
    window.__jcObserver.observe(host, { childList: true });
  });

  // ---- 1. 点一次：恰好挂载一次
  await jiraBtn.click();
  await until(async () => (await page.locator(".jira-issue").count()) > 0 && (await page.locator(".jira-issue").first().isVisible()), 15000, "面板出现且列表到货");
  await sleep(1600); // 等 config / me / lists / recent 的迟到重画都落地
  const mounts = await page.evaluate(() => window.__jc.map((m) => ({ ...m })));
  log("挂载记录:", JSON.stringify(mounts));
  check(mounts.length === 1, `点一次只挂载一次外壳（实际 ${mounts.length} 次）`);
  const entered = mounts.filter((m) => m.anims.includes("mac-window-in")).length;
  check(entered === 1 && mounts.length === 1, `入场动画只演一次（带 mac-window-in 的挂载 ${entered} 次）`);
  check((await page.locator(".jc-back").count()) === 1, "页面上只有一个 .jc-back");
  check((await page.locator('[role="dialog"][aria-label="Jira"]').count()) === 1, "页面上只有一扇 role=dialog 的 Jira 窗");
  await page.screenshot({ path: path.join(OUT, "panel-open.png") });

  // ---- 2. 切分区 / 刷新：重画不许重挂
  const beforeNav = await page.evaluate(() => window.__jc.length);
  await page.locator(".jc-nav__item").filter({ hasText: "最近消息" }).first().click();
  await sleep(700);
  const afterNav = await page.evaluate(() => window.__jc.length);
  check(afterNav === beforeNav, `切一次分区不重挂外壳（累计 ${afterNav} 次）`);
  await page.locator(".jc-head__actions button").filter({ hasText: "刷新" }).first().click();
  await sleep(1200);
  const afterRefresh = await page.evaluate(() => window.__jc.length);
  check(afterRefresh === beforeNav, `点一次刷新不重挂外壳（累计 ${afterRefresh} 次）`);
  check((await page.locator(".jc-back").count()) === 1, "刷新后页面上仍只有一个 .jc-back");

  // ---- 3. Esc 关闭后迟到重画不许把面板重新挂出来
  const beforeClose = await page.evaluate(() => window.__jc.length);
  await page.keyboard.press("Escape");
  await sleep(900);
  const stillOpen = await page.locator(".jc-back").count();
  const afterClose = await page.evaluate(() => window.__jc.length);
  check(stillOpen === 0, `Esc 之后面板已关闭（残留 ${stillOpen} 个 .jc-back）`);
  check(afterClose === beforeClose, `关闭前后没有新的挂载（${beforeClose} → ${afterClose}）`);

  // ---- 4. 再点一次：重新开场，仍然只挂一次（关闭时把 shell 清干净了）
  await jiraBtn.click();
  await until(async () => (await page.locator(".jira-issue").count()) > 0 && (await page.locator(".jira-issue").first().isVisible()), 15000, "面板再次出现");
  await sleep(1600);
  const total = await page.evaluate(() => window.__jc.length);
  const reentered = await page.evaluate((from) => window.__jc.slice(from).filter((m) => m.anims.includes("mac-window-in")).length, beforeClose);
  check(total === beforeClose + 1, `关了再开：只再挂载一次（累计 ${total} 次）`);
  check(reentered === 1, `再次打开入场照旧演一次（实际 ${reentered} 次）`);
} finally {
  await browser?.close().catch(() => {});
  stop();
}

if (failures.length) {
  console.error(`\n${failures.length} 条不通过：\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("\nJira 面板：一次 open 只挂载一次外壳，重画不重挂，关掉不会自己回来。");
}
