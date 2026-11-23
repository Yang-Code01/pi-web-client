/**
 * D389 提醒中心：在真 Chromium 里把它推一遍（角标 / 清单 / 两种读法 / 吐司 / 已读 / 开关）。
 *
 *   node probes/reminders.mjs
 *
 * 起一份自己的桥（`PI_WEB_STATE` 指到 `.scratch/reminders-state`）+ 已经构建好的 `web/dist`，
 * 所以先 `npm run build:bridge && npm run build:web`。
 *
 * 这里**不跑模型**：审批 / 问卷那条流由 `bridge/tests/reminders-unit.mjs` 钉住（合并窗口、重启失效、
 * 静音、cap），这份探针只管「页面把它们画对没有」，用 `/api/notify` 这个公开入口造数据。
 * 截图落在 `.scratch/shots/reminders-*.png`。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";
import { freePort } from "../tools/free-port.mjs";

const { chromium } = await loadPlaywright();

const ROOT = REPO;
const DIST = path.join(ROOT, "bridge", "dist", "index.js");
const PORT = Number(process.env.REMINDERS_PORT ?? (await freePort()));
const STATE = path.join(ROOT, ".scratch", "reminders-state");
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, ".scratch", "shots");
const PASS = "reminders-pass";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });

const env = {
  ...process.env,
  PI_WEB_STATE: STATE,
  PI_WEB_WHATS_NEW: "0",
  PI_WEB_PORT: String(PORT),
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_TUNNEL: "0",
  PI_WEB_ROOT: path.join(ROOT, "web", "dist"),
};
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

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* still booting */
    }
    await sleep(200);
  }

  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");
  const cookie = `${cookieName}=${cookieValue}`;
  const token = fs.readFileSync(path.join(STATE, "notify-token"), "utf8").trim();

  // ---------------------------------------------------------------- API 面
  const noToken = await fetch(`${BASE}/api/notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "没带 token" }),
  });
  check("/api/notify 不带 token → 403", noToken.status === 403, String(noToken.status));

  const push = (title, body, source = "构建") =>
    fetch(`${BASE}/api/notify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-notify-token": token },
      body: JSON.stringify({ title, body, source }),
    });

  const first = await push("prisma 迁移失败", 'exit 1：relation "users" already exists');
  check("/api/notify 带 token → 200", first.ok, String(first.status));
  const view1 = await (await fetch(`${BASE}/api/reminders`, { headers: { cookie } })).json();
  check("GET /api/reminders 返回一条在等的", view1.items?.length === 1 && view1.items[0].state === "waiting", JSON.stringify(view1.items?.[0]?.state));
  check("角标 = 1", view1.badge === 1, String(view1.badge));

  // ---------------------------------------------------------------- 浏览器
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".app", { timeout: 20000 });

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `reminders-${name}.png`) });
    console.log(`  shot reminders-${name}.png`);
  };

  /* 角标：连上之后自动取一次，不用点任何东西 */
  await page.waitForSelector(".remind-bell:not([hidden])", { timeout: 8000 }).catch(() => {});
  const badge = await page.locator(".remind-bell-count").textContent().catch(() => null);
  check("★ 行右端出现角标，数字 1", badge === "1", String(badge));
  check("非阻塞的提醒不弹吐司", (await page.locator(".remind-toast").count()) === 0);
  await shot("badge");

  await page.click(".remind-bell");
  await page.waitForSelector(".remind-pop", { timeout: 4000 });
  check("点角标开清单", (await page.locator(".remind-pop .remind-row").count()) === 1);

  /* 再塞两条，看角标涨、清单跟上 */
  await push("定时任务跑完", "nightly-report · 2 分 10 秒", "cron");
  await push("npm run build 失败", "tsc: 3 errors", "构建");
  await page.waitForFunction(() => document.querySelector(".remind-bell-count")?.textContent === "3", null, { timeout: 5000 }).catch(() => {});
  check("新提醒实时涨到 3", (await page.locator(".remind-bell-count").textContent()) === "3");

  /* 两种读法 */
  check("默认「按事件」那颗是亮的", (await page.locator(".remind-pop .remind-mode.on").textContent()) === "按事件");
  await page.click(".remind-pop .remind-mode:nth-child(2)"); // 按会话
  await page.waitForSelector(".remind-card", { timeout: 4000 }).catch(() => {});
  check("切到「按会话」：没有会话来源的落到一张卡里", (await page.locator(".remind-card").count()) >= 1);
  check("灯跟着切到「按会话」", (await page.locator(".remind-pop .remind-mode.on").textContent()) === "按会话");
  await shot("grouped");
  await page.click(".remind-pop .remind-mode:nth-child(1)"); // 按事件
  await page.waitForSelector(".remind-pop .remind-row", { timeout: 4000 });
  check("切回「按事件」：又是流水", (await page.locator(".remind-card").count()) === 0);

  /* 点一条 = 已读（非阻塞就那么离开「在等」） */
  await page.click(".remind-pop .remind-row");
  await page.waitForFunction(() => document.querySelector(".remind-bell-count")?.textContent === "2", null, { timeout: 5000 }).catch(() => {});
  check("点开一条非阻塞 → 已读，角标 3 → 2", (await page.locator(".remind-bell-count").textContent()) === "2");
  check("已读的留在清单里（灰着）", (await page.locator(".remind-pop .remind-row.settled").count()) === 1);

  /* 开关：走页面同一条帧（`reminder.set`），把「其它」打开 → 非阻塞的也该弹 */
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  await new Promise((r) => ws.on("open", r));
  const before = await (await fetch(`${BASE}/api/reminders`, { headers: { cookie } })).json();
  check("默认设置：其它 = 关（只进清单不弹）", before.settings.others === false, JSON.stringify(before.settings));
  /* 本机 / 局域网连接建连时就是「已 step-up」（index.ts:2372），所以设置直接生效 ——
     与 `notify.set` 走同一条门；只有公网隧道上的页面才会被要口令。 */
  ws.send(JSON.stringify({ type: "reminder.set", others: true }));
  await sleep(400);
  const after = await (await fetch(`${BASE}/api/reminders`, { headers: { cookie } })).json();
  check("reminder.set 把「其它」打开了", after.settings.others === true, JSON.stringify(after.settings));
  await push("构建又失败了", "tsc: 1 error");
  await page.waitForSelector(".remind-toast", { timeout: 6000 }).catch(() => {});
  check("打开之后非阻塞的也弹一条", (await page.locator(".remind-toast").count()) >= 1);
  await shot("toast");
  ws.close();

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 通过`);
  if (pageErrors.length) console.log("页面报错：", pageErrors.join(" | "));
  if (results.some((r) => !r.ok)) {
    console.log("\n桥日志尾部：\n" + bridgeLog.split("\n").slice(-25).join("\n"));
    process.exitCode = 1;
  }
  await browser.close();
} finally {
  bridge.kill();
}
