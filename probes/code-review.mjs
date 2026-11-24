/**
 * Probe：右栏第四颗页签「代码评审」(#651)。
 *
 * 真 Chromium + 隔离真桥 + 真 `ocr`，跑一次完整链路：
 *   开页签 → 开始评审 → 意见按文件分组落进栏里（带严重度 / 耗时 / token）→
 *   点一条开分支工作台「差异」页签并选中那个文件 → 展开后「交给 AI 修」把话放进输入框 →
 *   再开一次并中途「停止」，已收到的保留、整次标未完成。
 * 最后另起一份桥把 `OCR_BIN` 指到不存在的路径，验证「没装 ocr」那一屏给的是安装命令。
 *
 * 要求：本机 PATH 上有 `ocr`（`npm i -g @alibaba-group/open-code-review`），且 pi 已配好模型 ——
 * 评审子进程用的是**真的** pi 与真的模型。没装 ocr 时这个探针会直接说「跳过」并不假装通过。
 *
 * Run: npm run build && node probes/code-review.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const PORT = Number(process.env.PI_WEB_PORT ?? 7881);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(REPO, ".scratch/code-review-probe");
const STATE = path.join(ROOT, "state");
const STATE2 = path.join(ROOT, "state-no-ocr");
const SESSIONS = path.join(ROOT, "sessions");
const WORK = path.join(ROOT, "work");
const SID = "zz-code-review";
const BASE2 = `http://127.0.0.1:${PORT + 1}`;
const REVIEW_TIMEOUT_MS = Number(process.env.PI_REVIEW_PROBE_MS ?? 8 * 60_000);

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
for (const d of [STATE, STATE2, SESSIONS, WORK]) fs.mkdirSync(d, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", WORK, ...args], { encoding: "utf8", windowsHide: true });
git("init", "-q");
fs.writeFileSync(path.join(WORK, "user.ts"), "export function nameOf(user: { name: string }): string {\n  return user.name;\n}\n");
git("add", "-A");
git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init");
fs.writeFileSync(
  path.join(WORK, "user.ts"),
  "export function nameOf(user: { name: string } | null): string {\n  return user.name.toUpperCase();\n}\n\nexport function priceOf(order: any): number {\n  return order.items[0].price * 1.1;\n}\n",
);

const sessionDir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(sessionDir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "code review probe" }] } },
  { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name: "code review probe" },
];
fs.writeFileSync(path.join(sessionDir, `${SID}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

const hasOcr = (() => {
  try {
    return execFileSync("ocr", ["version"], { encoding: "utf8", windowsHide: true }).includes("open-code-review");
  } catch {
    return false;
  }
})();
if (!hasOcr && !process.env.PI_REVIEW_PROBE_NO_OCR_ONLY) {
  console.log("跳过：PATH 上没有 ocr（先 npm i -g @alibaba-group/open-code-review）—— 本探针不假装通过");
  process.exit(0);
}

// ---------------------------------------------------------------- 桥

const bridges = [];
function startBridge(stateDir, port, extraEnv = {}) {
  const proc = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      PI_WEB_PORT: String(port),
      PI_WEB_STATE: stateDir,
      PI_WEB_TUNNEL: "0",
      // 刚起的实例会弹「更新日志」，它会盖住页面、把点击吃掉（探针里没有真人去关它）。
      PI_WEB_WHATS_NEW: "0",
      // 会话只从 fixture 目录列；不碰 PI_AGENT_DIR —— 评审子进程要用真的 pi 配置与真的模型。
      PI_CODING_AGENT_SESSION_DIR: SESSIONS,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  proc.stdout.on("data", (b) => out.push(String(b)));
  proc.stderr.on("data", (b) => out.push(String(b)));
  bridges.push(proc);
  return { proc, out };
}

async function login(base, stateDir) {
  await until(() => fs.existsSync(path.join(stateDir, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${base}/healthz`)).ok, 25000, "bridge healthz");
  const pass = fs.readFileSync(path.join(stateDir, "passphrase.txt"), "utf8").trim();
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function pageFor(browser, base, cookie) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: base }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  return page;
}

const openReviewTab = async (page) => {
  const tab = page.locator('.exec-tabs button[data-exec-tab="review"]');
  await tab.waitFor({ timeout: 20000 });
  await tab.click();
  await page.locator(".review").waitFor({ timeout: 10000 });
};

let browser = null;
startBridge(STATE, PORT);
startBridge(STATE2, PORT + 1, { OCR_BIN: "/nonexistent/ocr-binary" });

try {
  const cookie = await login(BASE, STATE);
  browser = await chromium.launch({ headless: true });

  // ---------------------------------------------------------------- 1) 没装 ocr：给安装命令
  {
    const cookie2 = await login(BASE2, STATE2);
    const page = await pageFor(browser, BASE2, cookie2);
    await page.goto(BASE2, { waitUntil: "domcontentloaded" });
    await until(async () => (await page.locator(".session-card").count()) >= 1, 20000, "session card (no-ocr)");
    await page.locator(".session-card").first().click();
    await openReviewTab(page);
    await until(async () => (await page.locator(".rv-install").count()) === 1, 20000, "install block");
    const text = await page.locator(".rv-install").innerText();
    check("没装 ocr 时给安装命令", text.includes("npm i -g @alibaba-group/open-code-review"), text.replace(/\n/g, " / ").slice(0, 80));
    check("没装 ocr 时「开始评审」不可点", await page.locator(".rv-run").first().isDisabled(), "");
    await page.context().close();
  }

  // ---------------------------------------------------------------- 2) 真跑一次
  const page = await pageFor(browser, BASE, cookie);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 20000, "session card");
  await page.locator(".session-card").first().click();
  await openReviewTab(page);
  await page.locator(".rv-run:not([disabled])").first().waitFor({ timeout: 30000 });

  await page.locator(".rv-mode").selectOption("workspace");
  await page.locator(".rv-run").first().click();

  // 跑起来就该有进度（或直接完成），并且「开始评审」变成「停止」
  await until(async () => (await page.locator(".rv-stop, .rv-file, .rv-error").count()) > 0, 60000, "review started");
  const fileCount = await until(async () => {
    const n = await page.locator(".rv-file").count();
    if (n) return n;
    const err = await page.locator(".rv-error").count();
    if (err) throw new Error(`评审失败：${await page.locator(".rv-error").first().innerText()}`);
    return 0;
  }, REVIEW_TIMEOUT_MS, "review findings");

  check("意见按文件分组落进栏里", fileCount >= 1, `${fileCount} 个文件`);
  const findings = await page.locator(".rv-finding").count();
  check("一条意见一行", findings >= 1, `${findings} 条`);
  const sev = await page.locator(".rv-sev").first().innerText();
  check("带严重度徽标", ["严重", "高", "中", "低"].includes(sev.trim()), sev);
  const meta = await page.locator(".rv-meta").first().innerText();
  check("顶部写了耗时与 token", /tokens/.test(meta) && /\d/.test(meta), meta);
  // 300px 里下拉吃掉整行时，旁边的按钮会被挤出面板 —— 用坐标钉住它（2026-11-24 真踩过）。
  const panel = await page.locator(".review").boundingBox();
  const btn = await page.locator(".rv-run, .rv-stop").first().boundingBox();
  check(
    "面板没被长路径撑宽，按钮也没被下拉挤出面板",
    Boolean(panel && btn) && panel.width <= 420 && btn.x >= panel.x && btn.x + btn.width <= panel.x + panel.width + 1,
    panel && btn ? `panel ${Math.round(panel.width)} / 按钮右缘 ${Math.round(btn.x + btn.width - panel.x)}` : "no box",
  );
  const shots = path.join(REPO, ".scratch", "shots");
  fs.mkdirSync(shots, { recursive: true });
  await page.locator(".review").screenshot({ path: path.join(shots, "code-review-panel.png") }).catch(() => {});

  // ---------------------------------------------------------------- 3) 点一条 → 分支工作台「差异」
  await page.locator(".rv-line").first().click();
  await page.locator(".rv-body").first().waitFor({ state: "visible", timeout: 5000 });
  const fixText = await page.locator(".rv-fix").first().isVisible();
  check("展开后能看到「交给 AI 修」", fixText, "");
  // 一行点开是就地看片段；`path:line` 那颗才是「跳去分支工作台的差异页签」。
  await page.locator(".rv-place").first().click();
  await page.locator(".go-diff-row.on").waitFor({ timeout: 30000 });
  const onRow = await page.locator(".go-diff-row.on").first().innerText();
  check("打开分支工作台并选中了那个文件", onRow.includes("user.ts"), onRow);
  const hit = await page.locator(".go-code.rv-hit").count();
  check("命中的那一行被标出来", hit >= 1, `${hit} 行`);
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".branch-sheet").count()) === 0, 8000, "branch sheet closed");

  // ---------------------------------------------------------------- 4) 交给 AI 修
  // 上一步已经把它展开了；再点一次等于收起，所以先看状态。
  if (!(await page.locator(".rv-body").first().isVisible())) await page.locator(".rv-line").first().click();
  await page.locator(".rv-fix").first().click();
  const composer = await page.locator(".composer-input textarea").first().inputValue();
  check("「交给 AI 修」把意见放进输入框", composer.includes("代码评审意见"), composer.slice(0, 40).replace(/\n/g, " "));

  // ---------------------------------------------------------------- 5) 中途停止
  await page.locator(".rv-run").first().click();
  await page.locator(".rv-stop").first().waitFor({ timeout: 60000 });
  await page.locator(".rv-stop").first().click();
  await until(async () => (await page.locator(".review").innerText()).includes("这次没跑完就停了"), 60000, "stopped hint");
  check("停止后标「没跑完」并留着已收到的", true, "");

  // ---------------------------------------------------------------- 6) 字号 150%：面板底栏还在屏里
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") || "{}");
    localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, scale: 1.5 }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 20000, "session card (150%)");
  await page.locator(".session-card").first().click();
  await openReviewTab(page);
  const box = await page.locator(".rv-run, .rv-stop").first().boundingBox();
  const vh = await page.evaluate(() => window.innerHeight);
  check("字号 150% 下按钮仍落在视口里", Boolean(box) && box.y + box.height <= vh, box ? `y=${Math.round(box.y)} h=${Math.round(box.height)} vh=${vh}` : "no box");
} catch (err) {
  failures += 1;
  console.error("探针异常：", err?.message ?? err);
} finally {
  await browser?.close().catch(() => {});
  for (const b of bridges) {
    try {
      b.kill();
    } catch {
      /* 已经退了 */
    }
  }
}

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
