/**
 * Probe: 文件搜索面板（D321）在真浏览器里走一遍 —— 顶栏入口 → 建索引 → 输入 → 出结果 →
 * 点一行引用到输入框 → Ctrl+Enter 在预览里打开。
 *
 * 起一份隔离 bridge，索引范围只指到这个探针自己的临时目录（`PI_WEB_FILEINDEX_ROOTS`），
 * 不碰真机上的其它盘，也不会去读 ~/.pi/agent 的会话。
 *
 * Run: node probes/filesearch.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const PORT = Number(process.env.PI_WEB_PORT ?? 7882);
const ROOT = path.join(REPO, ".scratch/filesearch-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "zz-filesearch";

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK, OUT]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(dir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "文件搜索验证" }] } },
  { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name: "文件搜索" },
];
fs.writeFileSync(path.join(dir, `${SID}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// 被索引的内容：三条要能被 "report" 命中，一条在 node_modules 里不许命中。
fs.mkdirSync(path.join(WORK, "docs", "guide"), { recursive: true });
// 一个目录（2c 段验「目录行 = 打开目录」）：名字不命中 report，不干扰第 2 段。
fs.mkdirSync(path.join(WORK, "docs", "subfolder"), { recursive: true });
fs.mkdirSync(path.join(WORK, "node_modules", "pkg"), { recursive: true });
fs.writeFileSync(path.join(WORK, "quarterly-report.md"), "# 季报\n\n" + "a".repeat(400), "utf8");
fs.writeFileSync(path.join(WORK, "docs", "guide", "install-report.txt"), "b".repeat(80), "utf8");
fs.writeFileSync(path.join(WORK, "notes.txt"), "c", "utf8");
fs.writeFileSync(path.join(WORK, "node_modules", "pkg", "hidden-report.js"), "d", "utf8");

// 上一轮崩在端口上的 bridge 会拖住旧 dist，先清掉。
function killPort(port) {
  try {
    const pids = new Set();
    const out = execSync("netstat -ano", { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+(\S+)\s+\S+\s+(\d+)$/);
      if (m && Number(m[1]) === port && /:0$/.test(m[2])) pids.add(Number(m[3]));
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      } catch {
        /* 已经没了 */
      }
    }
    if (pids.size) console.log(`cleared stale bridge on :${port} (pid ${[...pids].join(",")})`);
  } catch {
    /* netstat 不可用就算了 */
  }
}
killPort(PORT);

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_WEB_FILEINDEX_ROOTS: WORK,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* 还没好 */
    }
    await sleep(150);
  }
  console.error(bridgeOut.join("").slice(-3000));
  assert(false, `timeout waiting for ${label}`);
}

let browser = null;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });

  await until(async () => (await page.locator(".session-card").count()) >= 1, 15000, "one card");
  await page.locator(".session-card").first().click();

  // ---- 0. Everything 默认画在顶栏（D331，2026-11-19 与文件管理器对调）：不用先去设置里点亮
  const fsearchBtn = page.locator('.topbar .icon-btn[data-act="filesearch"]');
  await until(async () => fsearchBtn.isVisible(), 8000, "Everything 默认出现在顶栏");
  assert((await page.locator('.topbar .icon-btn[data-act="files"]').isVisible()) === false, "文件管理器应默认不画在顶栏（D331）");
  log("0 文件管理器默认不画、Everything 默认就在顶栏");

  // ---- 1. 顶栏入口 → 面板打开，索引就绪
  const btn = fsearchBtn;
  await until(async () => (await btn.count()) > 0, 10000, "顶部「Everything」按钮");
  await btn.first().click();
  await page.locator(".fse-back .fse-console").waitFor({ timeout: 10000 });
  await page.locator(".fse-back .sys-badge[data-state=\"ready\"]").waitFor({ timeout: 30000 });
  await until(async () => (await page.locator(".fse-body .fse-row").count()) >= 3, 15000, "打开即列出");
  const count = await page.locator(".fse-back .sys-foot__meta").textContent();
  log("1 面板打开，状态行：", count.trim());
  await page.screenshot({ path: path.join(OUT, "1-open.png"), animations: "disabled" });

  // ---- 2. 输入 → 结果出现，且 node_modules 里的不出现
  await page.locator(".fse-input").fill("report");
  // 等「高亮」而不是等「行数」：打开面板时已经按修改时间列过一遍，行数早就够了。
  await until(async () => (await page.locator(".fse-row mark.fse-hit").count()) >= 1, 15000, "高亮出现");
  await until(async () => (await page.locator(".fse-body .fse-row").count()) === 2, 15000, "两行结果");
  const names = await page.$$eval(".fse-row .fse-name", (els) => els.map((e) => e.textContent.trim()));
  assert(names.includes("quarterly-report.md"), `应命中 quarterly-report.md（实际 ${names.join(",")}）`);
  assert(names.includes("install-report.txt"), `子串段应补上 install-report.txt（实际 ${names.join(",")}）`);
  assert(!names.some((n) => n.includes("hidden-report")), "node_modules 里的不该出现");
  assert((await page.locator(".fse-row mark.fse-hit").count()) >= 1, "命中片段应有高亮");
  const foot = await page.locator(".fse-back .sys-foot__meta").textContent();
  assert(/ms/.test(foot), `页脚应报耗时（${foot.trim()}）`);
  log("2 结果：", names.join(", "), "|", foot.trim());
  await page.screenshot({ path: path.join(OUT, "2-results.png"), animations: "disabled" });

  // ---- 2b. 行尾三颗动作（D321）：引用 / 打开 / 位置 —— 与文件弹层的 `.fc-acts` 同一套
  const actLabels = await page.$$eval(".fse-row .fse-acts .fse-act", (els) => els.map((e) => e.textContent.trim()));
  assert(actLabels.length === 2 * 3, `两行应有 6 颗按钮（实际 ${actLabels.length}）`);
  for (const want of ["引用", "打开", "位置"]) {
    assert(actLabels.includes(want), `缺「${want}」：${actLabels.join(",")}`);
  }
  // 「位置」不关面板：只验 title 写清了目标，不去点（点了会真的弹出资源管理器窗口）。
  const revealTitle = await page.locator(".fse-row .fse-acts .fse-act").last().getAttribute("title");
  assert(revealTitle && revealTitle.includes("文件管理器"), `「位置」的 title 没写清去哪（${revealTitle}）`);
  log("2b 行尾动作：", [...new Set(actLabels)].join(" / "));

  // ---- 2c. 目录行：没有「预览」这回事，两颗动作都改成「打开目录」（用户 2026-11-18）
  await page.locator(".fse-input").fill("subfolder");
  await until(async () => (await page.locator(".fse-body .fse-row").count()) === 1, 15000, "一个目录结果");
  const dirActs = await page.$$eval(".fse-row .fse-acts .fse-act", (els) => els.map((e) => e.textContent.trim()));
  assert(dirActs.join("/") === "引用/打开目录/打开目录", `目录行应是 引用/打开目录/打开目录（实际 ${dirActs.join("/")}）`);
  log("2c 目录行动作：", dirActs.join(" / "));

  // ---- 3. 点一行 → 引用到输入框（路径进 composer）
  await page.locator(".fse-input").fill("quarterly");
  await until(async () => (await page.locator(".fse-row", { hasText: "quarterly-report.md" }).count()) === 1, 15000, "quarterly 行");
  await page.locator(".fse-row", { hasText: "quarterly-report.md" }).first().click();
  await sleep(400);
  const composer = await page.locator(".composer-input textarea").first().inputValue();
  assert(composer.includes("quarterly-report.md"), `点一行应引用路径（composer 现在是「${composer}」）`);
  assert((await page.locator(".fse-back").count()) === 0, "引用之后面板应关掉");
  log("3 引用 ok：", composer.trim());
  await page.screenshot({ path: path.join(OUT, "3-quoted.png"), animations: "disabled" });

  // ---- 4. 再开一次，Ctrl+Enter 在预览里打开
  const btn2 = fsearchBtn;
  await btn2.first().click();
  await page.locator(".fse-back .fse-console").waitFor({ timeout: 10000 });
  await page.locator(".fse-input").fill("quarterly");
  await until(async () => (await page.locator(".fse-row").count()) >= 1, 15000, "quarterly 结果");
  await page.locator(".fse-input").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Control+Enter");
  await until(async () => (await page.locator(".fse-back").count()) === 0, 10000, "面板关闭");
  const viewerCount = await page.locator(".viewer, .image-view").count();
  assert(viewerCount > 0, "Ctrl+Enter 之后预览层应出现");
  await page.screenshot({ path: path.join(OUT, "4-preview.png"), animations: "disabled" });
  log("4 Ctrl+Enter 预览 ok");

  // ---- 5. 目录 → 打开目录：真进到那一层（应用内文件管理器，不弹资源管理器）
  // 预览面板盖住顶栏，点了也没反应 —— 重新加载一次最稳（偏好与索引都在桥端）。
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 15000, "one card");
  await page.locator(".session-card").first().click();
  await until(async () => fsearchBtn.isVisible(), 8000, "顶栏 Everything");
  await fsearchBtn.first().click();
  await page.locator(".fse-back .fse-console").waitFor({ timeout: 10000 });
  await page.locator(".fse-input").fill("subfolder");
  await until(async () => (await page.locator(".fse-body .fse-row").count()) === 1, 15000, "目录结果");
  await page.locator(".fse-row .fse-act", { hasText: "打开目录" }).first().click();
  await until(async () => (await page.locator(".fse-back").count()) === 0, 10000, "搜索面板关掉");
  await page.waitForSelector(".viewer", { timeout: 10000 });
  const shown = await page.locator(".viewer").first().innerText();
  assert(shown.includes("subfolder"), `文件管理器应落在 subfolder 这一层（实际：${shown.slice(0, 200)}）`);
  log("5 目录 → 打开目录 ok");
  await page.screenshot({ path: path.join(OUT, "5-dir.png"), animations: "disabled" });
} catch (err) {
  console.error("FAIL:", err?.message ?? err);
  console.error(bridgeOut.join("").slice(-2000));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
  await sleep(200);
  if (process.exitCode) process.exit(process.exitCode);
  console.log("\nfilesearch probe: ok");
}
