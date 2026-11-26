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

// Windows 上 npm 装出来的是 `ocr.cmd`，Node 不带 shell 拒绝执行 `.cmd` —— 跟桥一样过一层 cmd.exe。
const ocrCommand = () =>
  process.platform === "win32" ? { cmd: "cmd.exe", args: ["/c", "ocr"] } : { cmd: "ocr", args: [] };
const hasOcr = (() => {
  try {
    const { cmd, args } = ocrCommand();
    return execFileSync(cmd, [...args, "version"], { encoding: "utf8", windowsHide: true }).includes("open-code-review");
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
// 从 pi 里跑探针时，父进程的「我在某个会话里」标记会漏给桥：`PI_HOST_LINK` 让它一起来就去连那个
// 生产壳的命名管道，握不上手就 exit 1（探针只能看到「timeout waiting for bridge healthz」）。
// 跟 probes/review-session-leak.mjs 与 bridge/src/paths.ts 的 `piChildEnv()` 一样剥掉这些标记。
const cleanEnv = () => {
  const env = { ...process.env };
  const drop = (key) => delete env[key];
  drop("PI_HOST_LINK");
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_WEB_")) drop(key);
    else if (key.startsWith("PI_SDK_")) drop(key);
    else if (["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL"].includes(key)) drop(key);
  }
  return env;
};
function startBridge(stateDir, port, extraEnv = {}) {
  const proc = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: REPO,
    env: {
      ...cleanEnv(),
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

/** 面板那颗模型 chip → 「模型与思考」弹层 → 挑一个不是当前那个的模型 → 确认。 */
async function pickModel(page) {
  await page.locator(".rv-model").first().click();
  await page.locator(".model-sheet").waitFor({ timeout: 15000 });
  const rows = page.locator(".model-sheet .pm-row");
  try {
    await rows.first().waitFor({ timeout: 8000 });
  } catch {
    // 模型目录还没到：空态那一行点一下重试（跟设置页同一个手势）。
    await page.locator(".model-sheet .pm-empty").first().click({ timeout: 5000 }).catch(() => {});
    try {
      await rows.first().waitFor({ timeout: 20000 });
    } catch {
      // 把「等超时」翻成一句能看的话：不然只能看到 Playwright 的 locator 名与毫秒数。
      throw new Error("模型弹层里等不到模型目录（`.pm-row` 一直没有）");
    }
  }
  const fresh = page.locator(".model-sheet .pm-row:not(.on)");
  const total = await rows.count();
  const target = (await fresh.count()) ? fresh.first() : rows.nth(total > 1 ? total - 1 : 0);
  await target.click();
  await page.locator(".model-sheet .st-foot .btn.primary").click();
  await until(async () => (await page.locator(".model-sheet").count()) === 0, 10000, "model sheet closed");
}

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
    await until(async () => (await page.locator(".session-card").count()) >= 1, 30000, "session card (no-ocr)");
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
  await until(async () => (await page.locator(".session-card").count()) >= 1, 30000, "session card");
  await page.locator(".session-card").first().click();
  await openReviewTab(page);
  const credit = (await page.locator(".rv-credit").first().innerText().catch(() => "")).trim();
  check("写明评审内核来自 open code review", /open code review/.test(credit), credit.replace(/\n/g, " / ").slice(0, 60));
  check("默认范围是「GitHub PR」", (await page.locator(".rv-mode").inputValue()) === "pr", await page.locator(".rv-mode").inputValue());
  // 先挑一个模型：记录卡上要写的是「这一次用的模型」，不挑的话只能记「没记模型」。
  await pickModel(page);
  check("挑完模型 chip 上有名字", !(await page.locator(".rv-model").first().innerText()).includes("默认模型"), (await page.locator(".rv-model").first().innerText()).trim());
  await page.locator(".rv-mode").selectOption("workspace");
  await page.locator(".rv-run:not([disabled])").first().waitFor({ timeout: 30000 });
  await page.locator(".rv-run").first().click();

  // D429：跑起来只是多一张记录卡，面板不再跟着跳进那一次；意见只在「完整详情」里。
  await until(async () => (await page.locator(".rv-run-card").count()) >= 1, 60000, "run card");
  if (await page.locator(".rv-run-card.is-live .rv-run-stop").count()) {
    // D420：跑着的时候这张「评什么」描述的是**下一条**，所以不再整张禁用；停止是每条记录自己的事。
    check("评审中「评什么」不再整张锁住（它描述下一条）", !(await page.locator(".rv-mode").isDisabled()), "");
    check("评审中模型 chip 也能换（只影响下一条）", !(await page.locator(".rv-model").first().isDisabled()), "");
    check("主按钮仍是「开始评审」，不再变成中断", (await page.locator(".rv-run").first().innerText()).includes("开始"), "");
    check(
      "在跑的那一条自己有「停止」",
      (await page.locator(".rv-run-card.is-live .rv-run-stop").first().innerText()).includes("停止"),
      "",
    );
  }
  // 300px 里下拉吃掉整行时，旁边的按钮会被挤出面板 —— 用坐标钉住它（2026-11-24 真踩过）。
  // 跑着的时候面板按计时器重画：`locator.boundingBox()` 会撞上元素被换掉那一下、返回 null（实测偶发
  // 「no box」），所以两个框一起在页面里量，量不到就等下一次重画。
  const geom = await until(
    () =>
      page.evaluate(() => {
        const panel = document.querySelector(".review");
        const btn = document.querySelector(".rv-run");
        if (!panel || !btn) return null;
        const a = panel.getBoundingClientRect();
        const b = btn.getBoundingClientRect();
        if (!a.width || !b.width) return null;
        return { width: a.width, px: a.x, bx: b.x, bw: b.width };
      }),
    10000,
    "panel geometry",
  );
  check(
    "面板没被长路径撑宽，按钮也没被下拉挤出面板",
    geom.width <= 420 && geom.bx >= geom.px && geom.bx + geom.bw <= geom.px + geom.width + 1,
    `panel ${Math.round(geom.width)} / 按钮右缘 ${Math.round(geom.bx + geom.bw - geom.px)}`,
  );
  // toast 只在跑完那一刻挂几秒：先等它、当场读，别等开了浮层、读完意见再回头找（那时早没了）。
  const toast = await page
    .locator(".fail-toast")
    .first()
    .waitFor({ timeout: REVIEW_TIMEOUT_MS })
    .then(() => page.locator(".fail-toast").first().innerText())
    .catch(() => "");
  check("跑完弹一句结果", /评审/.test(toast.trim()), toast.trim().slice(0, 60));
  // 「完整详情 ›」：记录卡右下角那个入口，打开的是**这张卡**那次；左边时间线、右边结果。
  // 跑着的时候面板按计时器整块重画：locator.click() 会卡在「等元素稳定」上（review-cards 里踩过）。
  // 先量坐标再用鼠标真点，点完没开就重来一次。
  {
    let opened = false;
    for (let i = 0; i < 3 && !opened; i += 1) {
      const at = await page.evaluate(() => {
        const node = document.querySelector(".rv-run-card")?.querySelector(".rv-run-more");
        if (!node) return null;
        const b = node.getBoundingClientRect();
        return b.width && b.height ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
      });
      if (!at) {
        await sleep(150);
        continue;
      }
      await page.mouse.click(at.x, at.y);
      opened = await page
        .locator(".rv-sheet")
        .waitFor({ timeout: 3000 })
        .then(() => true)
        .catch(() => false);
    }
    check("「完整详情」打开浮层", opened, "");
  }
  // 不能把「评审失败」写成 until 回调里的 throw：until 的 try/catch 会把它当「还没好」吞掉重试，
  // 最后只剩一句 timeout waiting for review findings，错误原文就查不到了。
  let fileCount = 0;
  const findingsDeadline = Date.now() + REVIEW_TIMEOUT_MS;
  while (Date.now() < findingsDeadline) {
    fileCount = await page.locator(".rv-sheet .rv-file").count();
    if (fileCount) break;
    if (await page.locator(".rv-sheet .rv-error, .review .rv-error").count()) {
      const why = (await page.locator(".rv-error").first().innerText()).trim().replace(/\s+/g, " ");
      throw new Error(`评审失败：${why}`);
    }
    await sleep(150);
  }
  check("意见按文件分组落进详情", fileCount >= 1, `${fileCount} 个文件`);
  check("面板里不再有意见栏（只剩记录卡）", (await page.locator(".review .rv-findings").count()) === 0, "");
  const findings = await page.locator(".rv-sheet .rv-finding").count();
  check("一条意见一行", findings >= 1, `${findings} 条`);
  const sev = await page.locator(".rv-sheet .rv-sev").first().innerText();
  check("带严重度徽标", ["严重", "高", "中", "低"].includes(sev.trim()), sev);
  const meta = await page.locator(".rv-sheet .rv-inst").first().innerText();
  check("仪表写了耗时与 token", /tokens/.test(meta) && /\d/.test(meta), meta.replace(/\n/g, " ").slice(0, 60));
  const stages = await page.locator(".rv-sheet .rv-stg").count();
  const sheetFindings = await page.locator(".rv-sheet .rv-finding").count();
  check("详情 dialog 有分组日志与结果", stages >= 1 && sheetFindings > 0, `${stages} 段日志 · ${sheetFindings} 条意见`);
  // 仪表（进度/用量/用时）曾被 settings-console.css 的 `.st-console{display:grid}` 挤成 0 高，压一下。
  const instBox = await page.locator(".rv-sheet .rv-inst").boundingBox();
  check(
    "仪表条没被外层网格挤掉",
    Boolean(instBox) && instBox.height > 40,
    instBox ? `仪表高 ${Math.round(instBox.height)}` : "no box",
  );
  fs.mkdirSync(path.join(REPO, ".scratch", "shots"), { recursive: true });
  await page.waitForTimeout(500);
  await page.locator(".rv-sheet").screenshot({ path: path.join(REPO, ".scratch", "shots", "code-review-sheet.png") }).catch(() => {});
  // 一键交给 agent：全部 / 按严重度；点「全部」应把整批连同上下文放进输入框。
  const bulkAll = page.locator(".rv-bulk-btn.all");
  check("详情里有一键交给 agent", (await bulkAll.count()) === 1, "");
  await bulkAll.click();
  await page.locator(".handoff-sheet").waitFor({ timeout: 10000 });
  await page.locator(".handoff-actions .btn.primary").click();
  const bulkText = await page.locator(".composer-input textarea").first().inputValue();
  check("批量交给 agent 说清先判断是否真的成立", /先判断/.test(bulkText), bulkText.slice(0, 60).replace(/\n/g, " "));
  await page.locator(".rv-sheet-head .btn:not([hidden])").last().click();
  await until(async () => (await page.locator(".rv-sheet").count()) === 0, 8000, "review sheet closed");

  // 记录卡（D429）：卡就是卡，正文点了没反应，唯一入口是右下角那颗。
  const cards = await page.locator(".rv-run-card").count();
  check("每次都留一张记录卡", cards >= 1, `${cards} 张`);
  check("面板里已经没有「清理历史」", (await page.locator(".rv-clean").count()) === 0, "");
  // 工作区那次没有 PR 标题（.rv-run-title 只在有标题时才有），点卡上的时间同样落在正文上。
  await page.locator(".rv-run-at").first().click();
  await page.waitForTimeout(300);
  check("点卡片正文不打开详情", (await page.locator(".rv-sheet").count()) === 0, "");
  await page.locator(".rv-run-card").first().locator(".rv-run-more").click();
  await page.locator(".rv-sheet").waitFor({ timeout: 10000 });
  const eyebrow = (await page.locator(".rv-sheet-eyebrow").first().innerText()).trim();
  check("详情抬头写着这是哪一次", /代码评审/.test(eyebrow), eyebrow.slice(0, 40));
  await page.locator(".rv-sheet-head .btn:not([hidden])").last().click();
  await until(async () => (await page.locator(".rv-sheet").count()) === 0, 8000, "review sheet closed again");

  // 模型那颗 chip 走的是输入框背后同一个「模型与思考」弹层（不是面板自己的下拉）。
  const modelBefore = (await page.locator(".rv-model").innerText()).trim();
  await pickModel(page);
  const modelAfter = (await page.locator(".rv-model").innerText()).trim();
  check("模型 chip 打开的是「模型与思考」弹层，挑完会换掉", modelAfter !== modelBefore && modelAfter.length > 0, `${modelBefore} → ${modelAfter}`);

  const shots = path.join(REPO, ".scratch", "shots");
  fs.mkdirSync(shots, { recursive: true });
  await page.locator(".review").screenshot({ path: path.join(shots, "code-review-panel.png") }).catch(() => {});

  // ---------------------------------------------------------------- 3) 详情里点一条 → 分支工作台「差异」
  await page.locator(".rv-run-card").first().locator(".rv-run-more").click();
  await page.locator(".rv-sheet").waitFor({ timeout: 10000 });
  await page.locator(".rv-sheet .rv-line").first().click();
  await page.locator(".rv-sheet .rv-body").first().waitFor({ state: "visible", timeout: 5000 });
  const fixText = await page.locator(".rv-sheet .rv-fix").first().isVisible();
  check("展开后能看到「交给 AI 修」", fixText, "");
  // 一行点开是就地看片段；`path:line` 那颗才是「跳去分支工作台的差异页签」。
  await page.locator(".rv-sheet .rv-place").first().click();
  await page.locator(".go-diff-row.on").waitFor({ timeout: 30000 });
  const onRow = await page.locator(".go-diff-row.on").first().innerText();
  check("打开分支工作台并选中了那个文件", onRow.includes("user.ts"), onRow);
  const hit = await page.locator(".go-code.rv-hit").count();
  check("命中的那一行被标出来", hit >= 1, `${hit} 行`);
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".branch-sheet").count()) === 0, 8000, "branch sheet closed");

  // ---------------------------------------------------------------- 4) 交给 AI 修
  // 上一步点了 `path:line` 去分支工作台：回来时浮层可能已经被盖住或关掉（第 5 步就是这么兜的）。
  // 不先兜，下面的 `.rv-body` 可见性判断会落在隐藏节点上，点击一路超时。
  if (!(await page.locator(".rv-sheet").count())) {
    await page.locator(".rv-run-card").first().locator(".rv-run-more").click();
    await page.locator(".rv-sheet").waitFor({ timeout: 10000 });
  }
  // 上一步已经把它展开了；再点一次等于收起，所以先看状态。
  if (!(await page.locator(".rv-sheet .rv-body").first().isVisible())) await page.locator(".rv-sheet .rv-line").first().click();
  await page.locator(".rv-sheet .rv-fix").first().click();
  await page.locator(".handoff-sheet").waitFor({ timeout: 10000 });
  const handoffName = await page.locator(".handoff-body .rv-hint").first().innerText().catch(() => "");
  check("交给 agent 先问去处（当前会话 / 新开会话）", /名字/.test(handoffName), handoffName.slice(0, 40));
  await page.waitForTimeout(300);
  await page.locator(".handoff-sheet").screenshot({ path: path.join(REPO, ".scratch", "shots", "code-review-handoff.png") }).catch(() => {});
  await page.locator(".handoff-actions .btn.primary").click();
  const composer = await page.locator(".composer-input textarea").first().inputValue();
  check("选「插到当前会话」后把意见放进输入框", composer.includes("代码评审意见"), composer.slice(0, 40).replace(/\n/g, " "));

  // ---------------------------------------------------------------- 5) 中途停止
  if (await page.locator(".rv-sheet").count()) {
    await page.keyboard.press("Escape");
    await until(async () => (await page.locator(".rv-sheet").count()) === 0, 8000, "sheet closed before stop test");
  }
  await page.locator(".rv-run").first().click();
  await page.locator(".rv-run-card.is-live .rv-run-stop").first().waitFor({ timeout: 60000 });
  await page.locator(".rv-run-card.is-live .rv-run-stop").first().click();
  // 停下来之后不自动跳走：还是列表，那张卡自己标「没跑完」，明细在那张卡的「完整详情」里。
  await until(async () => (await page.locator(".rv-run-card.is-live").count()) === 0, 60000, "stopped card");
  check("停下后不会被拽进浮层", (await page.locator(".rv-sheet").count()) === 0, "");
  await page.locator(".rv-run-card").first().locator(".rv-run-more").click();
  await page.locator(".rv-sheet").waitFor({ timeout: 10000 });
  // 「标已停止」得自己断言：只用 until 等文案的话，超时是抛错中止整条探针、记不成一条 FAIL。
  const stoppedHint = await until(
    async () => (await page.locator(".rv-sheet").innerText()).includes("已停止"),
    60000,
    "stopped hint",
  ).catch(() => false);
  check("浮层里标着「已停止」", stoppedHint === true, "");
  const kept = await page.locator(".rv-sheet .rv-finding, .rv-sheet .rv-stg").count();
  check("停止后留着已收到的", kept >= 1, `${kept} 行日志/意见`);
  await page.locator(".rv-sheet-head .btn:not([hidden])").last().click();
  await until(async () => (await page.locator(".rv-sheet").count()) === 0, 8000, "sheet closed after stop");

  // ---------------------------------------------------------------- 5.5) 同时评两条（D417）
  // 一条在跑时「评什么」仍可用（描述下一条）；开满两条后按钮置灰并说明原因；停止按条算，停下就腾回额度。
  {
    const starts = async () => {
      await page.locator(".rv-run").first().click();
    };
    const countRunning = async () => Number((await page.locator(".rv-runs-head").innerText().catch(() => "")).match(/(\d+) 个在跑/)?.[1] ?? 0);

    await starts();
    await until(async () => (await countRunning()) === 1, 30000, "one running");
    check("跑着一条时还能再开一条", await page.locator(".rv-run").first().isEnabled(), "");

    await starts();
    await until(async () => (await countRunning()) === 2, 30000, "two running");
    check("两条同时在跑：一条一张卡，各自有停止", (await page.locator(".rv-run-card.is-live .rv-run-stop").count()) === 2, "");
    check("开满两条后主按钮置灰", await page.locator(".rv-run").first().isDisabled(), "");
    const why = (await page.locator(".rv-hint.rv-why").first().innerText().catch(() => "")).trim();
    check("置灰同时说明为什么（已满 2 个）", /2/.test(why) && /停/.test(why), why.slice(0, 40));

    // 停一条：只停那一条，额度回来，焦点不被抢走（我们此刻停在列表上）。
    await page.locator(".rv-run-card.is-live .rv-run-stop").first().click();
    await until(async () => (await countRunning()) <= 1, 30000, "one stopped");
    check("停一条、记录收尾后额度回来", await page.locator(".rv-run").first().isEnabled(), "");
    check("跑完/停下的那一条不会替你打开浮层", (await page.locator(".rv-sheet").count()) === 0, "");
    // 收尾：把剩下那条也停掉，别让后面的段落撞上「已满」。
    const rest = page.locator(".rv-run-card.is-live .rv-run-stop");
    if (await rest.count()) await rest.first().click();
    await until(async () => (await page.locator(".rv-run-card.is-live").count()) === 0, 60000, "all stopped");
  }

  // ---------------------------------------------------------------- 6) PR 模式：列表拉不到也要能用
  // fixture 仓库没有 remote：`gh pr list` 这一步会失败。验收的是「说清原因 + 号输入框照样在」，
  // 真 PR 的端到端要联网与 gh 登录，探针不替环境赌这一把。
  await page.locator(".rv-mode").selectOption("pr");
  await page.locator(".rv-prq").waitFor({ timeout: 20000 });
  await page.locator(".rv-prq").click();
  await page.locator(".rv-prmenu").waitFor({ timeout: 10000 });
  // 打开列表会顺手补拉一次，所以先等「正在拉…」过去，再断言它把原因说出来了。
  const prHint = (
    await until(
      async () => {
        const text = (await page.locator(".rv-prmenu .rv-hint").first().innerText().catch(() => "")).trim();
        return text && !text.includes("正在拉") ? text : "";
      },
      20000,
      "pr menu hint",
    )
  ).trim();
  check("PR 模式：没有 remote 时列表里说清原因", /远程|gh|origin/i.test(prHint), prHint.slice(0, 50));
  await page.locator(".rv-prq").fill("7");
  check("PR 模式：号也能直接输，填完就能开评", await page.locator(".rv-run").first().isEnabled(), "");

  // ---------------------------------------------------------------- 7) 字号 150%：面板底栏还在屏里
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") || "{}");
    localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, scale: 1.5 }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 30000, "session card (150%)");
  await page.locator(".session-card").first().click();
  await openReviewTab(page);
  const box = await page.locator(".rv-run").first().boundingBox();
  const vh = await page.evaluate(() => window.innerHeight);
  check("字号 150% 下按钮仍落在视口里", Boolean(box) && box.y + box.height <= vh, box ? `y=${Math.round(box.y)} h=${Math.round(box.height)} vh=${vh}` : "no box");
  // 刷新之后「评什么」要自己接上（存在桥那边，不再只活在内存里）。
  await until(async () => (await page.locator(".rv-prq").count()) === 1, 15000, "pr combobox back");
  const prAfterReload = String((await page.locator(".rv-prq").inputValue()) ?? "").replace(/^#/, "");
  check(
    "刷新后范围与号自己接上",
    (await page.locator(".rv-mode").inputValue()) === "pr" && prAfterReload === "7",
    `${await page.locator(".rv-mode").inputValue()} / ${prAfterReload}`,
  );
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
