/**
 * Probe：评审面板的「评什么」不许串会话。
 *
 * 用户报的样子：在会话 A 里把 PR 号填成 `#661`（或从链接卡上带过来），切到会话 B（另一个仓库）
 * 打开右栏第四颗页签，那个格里还是 `#661` —— 点「开始评审」就会去评 B 目录里的 661 号，
 * 而这个号属于 A。号、范围、分支、提交都是**这一次会话要评的东西**，换会话就得从默认值开始。
 *
 * 验的全是外部行为（真桥 + 假 gh + 真 Chromium）：
 *   1. A 里填好号，框里是 `#661`（基线：这一段路本身是通的）；
 *   2. 切到 B 的会话，再打开评审页签 → 框是空的；
 *   3. 没号时「开始评审」是灰的（人点不下去），桥上也没收到 review.run。
 *
 * Run: npm run build:web && npm run probe:review-session（没装 playwright 时给 PW_PATH）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const PORT = Number(process.env.PI_WEB_PORT ?? 7885);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(REPO, ".scratch", "review-session-leak-probe");
const STATE = path.join(ROOT, "state");
const SESSIONS = path.join(ROOT, "sessions");
const WORK_A = path.join(ROOT, "work-a");
const WORK_B = path.join(ROOT, "work-b");
const SID_A = "zz-leak-a";
const SID_B = "zz-leak-b";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------- fixtures

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK_A, WORK_B]) fs.mkdirSync(d, { recursive: true });

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true });
for (const [dir, remote] of [
  [WORK_A, "git@github.com:acme/widgets.git"],
  [WORK_B, "git@github.com:acme/gadgets.git"],
]) {
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", remote);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init");
}

/** 两条会话，两个仓库：B 的目录里不该出现 A 的 PR 号。 */
const at = new Date().toISOString();
for (const [sid, cwd, name] of [
  [SID_A, WORK_A, "leak probe A"],
  [SID_B, WORK_B, "leak probe B"],
]) {
  const dir = path.join(SESSIONS, `--${sid}--`);
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { type: "session", version: 3, id: sid, timestamp: at, cwd },
    { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: `${name} 的第一句` }] } },
    { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name },
  ];
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

const fakeGh = path.join(REPO, "bridge", "tests", "fixtures", "fake-gh.mjs");

// ---------------------------------------------------------------- 桥

const out = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    // 刚起的实例会弹「更新日志」，它会盖住页面、把点击吃掉（探针里没有真人去关它）。
    PI_WEB_WHATS_NEW: "0",
    // 只从 fixture 目录列会话；不碰用户真的会话目录。
    PI_CODING_AGENT_SESSION_DIR: SESSIONS,
    // 假 gh：`pr list` 直接失败（这个探针不看列表，只要它别去打网络、别动真登录态）。
    PI_WEB_GH_JS: fakeGh,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", (b) => out.push(String(b)));
bridge.stderr.on("data", (b) => out.push(String(b)));

async function login() {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 25000, "bridge healthz");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

const openReviewTab = async (page) => {
  const tab = page.locator('.exec-tabs button[data-exec-tab="review"]');
  await tab.waitFor({ timeout: 20000 });
  await tab.click();
  await page.locator(".review").waitFor({ timeout: 20000 });
};

const openSession = async (page, id) => {
  await page.locator(`.session-card[data-id="${id}"]`).click();
  await until(async () => (await page.locator(`.session-card.active[data-id="${id}"]`).count()) === 1, 20000, `session ${id} active`);
};

let browser = null;
try {
  const cookie = await login();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".session-card").count()) >= 2, 30000, "two session cards");

  // ------------------------------------------------ 1) A 里填号：框里是 #661
  await openSession(page, SID_A);
  await openReviewTab(page);
  const input = page.locator(".rv-prq").first();
  await input.waitFor({ timeout: 20000 });
  // 直接把事件打给输入框，而不是 `fill()` / 逐字 `type()`：面板每敲一下就会重画一次（弹层打开），
  // 真人的输入法跟得上，合成按键会丢字符（实测打 "661" 只剩 "61"）。这里要走的是【填好号之后的状态】，
  // 不是测输入框本身 —— 事件走的是同一批 handler。
  await page.evaluate(() => {
    const el = document.querySelector(".rv-prq");
    el.value = "661";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  await page.evaluate(() => {
    document.querySelector(".rv-prq").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await until(async () => (await input.inputValue()) === "#661", 8000, "PR #661 selected");
  check("A 里填好号：框里显示 #661", (await input.inputValue()) === "#661", await input.inputValue());

  // ------------------------------------------------ 2) 切到 B：那个格必须是空的
  await openSession(page, SID_B);
  await openReviewTab(page);
  const inputB = page.locator(".rv-prq").first();
  await inputB.waitFor({ timeout: 20000 });
  // 面板可能晚一拍重画（review.get 先到、refs 后到）：给它一小会儿，但**不许**一直等下去 ——
  // 串了就永远等不到。
  await until(async () => (await inputB.inputValue()) === "", 4000, "PR box cleared").catch(() => {});
  check("切到另一个会话：PR 号不该跟过来", (await inputB.inputValue()) === "", await inputB.inputValue());

  // ------------------------------------------------ 3) 没号就开不了跑：按钮就是灰的，桥收不到任何东西
  const runBtn = page.locator(".rv-run").first();
  await runBtn.waitFor({ timeout: 20000 });
  check("没号时「开始评审」是灰的（人点不下去）", await runBtn.isDisabled(), "");
  const reviewDir = path.join(STATE, "review");
  const runs = fs.existsSync(reviewDir) ? fs.readdirSync(reviewDir) : [];
  check("桥上没收到 review.run（没拿 A 的号去评 B）", runs.length === 0, runs.join(","));

  await page.screenshot({ path: path.join(ROOT, "review-session-leak.png") }).catch(() => {});
  await context.close();
} catch (err) {
  failures++;
  console.log(`FAIL 探针中断 — ${err?.message ?? err}`);
  console.log(out.join("").slice(-2500));
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
}

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
