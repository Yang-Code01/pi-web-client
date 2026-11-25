/**
 * #588 D358 守卫：启动时那张「本服务更新了什么」（本项目更新日志的新批次）。
 *
 * 要守的六件事，每一件都真的起桥、真的开页面：
 *  1. 全新状态 → 弹；内容是最新一批，`还有 N 批更早的` 的 N = 总批数 - 1；一打开就把已读写盘。
 *  2. 同一进程里刷新页面 → 不再弹（本次启动已派发过）。
 *  3. 重启桥、已读没动 → 不再弹（最新那批已经看过）。
 *  4. 有新批次但不到 24 小时 → 不弹，且已读**不前进**（被闸挡下的那批不会丢）。
 *  5. 有新批次且过了一天 → 弹，且只显示最新一批（没有「还有 N 批」时不出那一段）。
 *  6. 输入框里有没发出去的草稿 → 先不弹，清空之后才弹；Esc 能关；设置页能看到「上次看到」、
 *     开关能关掉自动提示；窄屏铺满整屏、字号 150% 时底部按钮仍在屏幕里。
 *
 * 「有没有新批次」靠改状态文件里的 `seenTitle` 模拟（把它写成比最新更旧的一批），不动 CHANGELOG.md。
 *
 * Run: npm --prefix web run build && node probes/whatsnew-dialog.mjs
 * （起自己的一份 bridge（临时状态目录 + 桩会话），不碰 7864，也不花模型调用。）
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge/dist/index.js");
if (!fs.existsSync(DIST)) {
  console.error("bridge/dist/index.js 不存在：先 npm run build");
  process.exit(2);
}

const PORT = Number(process.env.PI_WEB_PORT ?? 7937);
const ROOT = path.join(REPO, ".scratch/whatsnew-dialog");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "zz-whatsnew";
const STATE_FILE = path.join(STATE, "whatsnew.json");

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK, OUT]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 桩会话：桥要有一个能开的会话，否则页面停在空态（弹窗本身不需要它，但设置页那几页要）。
const dir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(dir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "更新日志弹窗探针" }] } },
  { type: "message", id: "m2", parentId: "m1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "好。" }] } },
  { type: "session_info", id: "n1", parentId: "m2", timestamp: at, name: "更新日志弹窗探针" },
];
fs.writeFileSync(path.join(dir, `${SID}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

// 桥只在「这台机器以前跑过」（口令文件已在）时才派发更新日志，所以先把口令种下：这份探针验的就是
// 老用户看到的那条路。口令固定，后面直接拿它登录。
const PASS = "whatsnew-probe";
const salt = crypto.randomBytes(16).toString("hex");
fs.writeFileSync(path.join(STATE, "passphrase.hash"), `scrypt$${salt}$${crypto.scryptSync(PASS, salt, 32).toString("hex")}`);
fs.writeFileSync(path.join(STATE, "passphrase.txt"), `${PASS}\n`);

/** CHANGELOG.md 里的批次标题（文件顺序 = 新的在前），探针自己解析一遍当期望值。 */
const LOG_TEXT = fs.readFileSync(path.join(REPO, "CHANGELOG.md"), "utf8");
const TITLES = LOG_TEXT.split(/\r?\n/)
  .map((line) => /^##\s+(.+?)\s*$/.exec(line))
  .filter(Boolean)
  .map((m) => m[1]);
if (TITLES.length < 3) {
  console.error("CHANGELOG.md 里批次太少，这个探针至少要 3 批才能验「还有 N 批」");
  process.exit(2);
}
const [NEWEST, SECOND] = TITLES;
/** `2026-11-24 · 主题` → `主题`：结构化条目把日期画在单独一行（`.cl-date`），标题只剩主题。 */
const shortTitle = (raw) => raw.replace(/^([0-9]{4}-[0-9]{2}-[0-9]{2}|未发布)(?: · |$)/, "");
/**
 * 最新那一批的第一条（去掉 markdown 记号）。`## 未发布` 那种批次没有标题，只好用条目正文
 * 认「弹的是这一批」—— 只看标题的话这条断言会恒真。
 */
const NEWEST_FIRST = (() => {
  const lines = LOG_TEXT.split(/\r?\n/);
  const at = lines.findIndex((line) => /^##\s/.test(line));
  for (const line of lines.slice(at)) {
    if (line !== lines[at] && /^##\s/.test(line)) break;
    if (/^\s*- /.test(line)) return line.replace(/^\s*-\s*/, "").replace(/[`*]/g, "").slice(0, 12);
  }
  return "";
})();

let bridge = null;
let bridgeOut = [];
function startBridge() {
  bridge = spawn(process.execPath, [DIST], {
    cwd: REPO,
    env: {
      ...process.env,
      PI_WEB_PORT: String(PORT),
      PI_WEB_STATE: STATE,
      PI_WEB_TUNNEL: "0",
      PI_AGENT_DIR: AGENT,
      PI_PEER: "0",
      PI_WEB_FILEINDEX_ROOTS: WORK,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeOut = [];
  bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
  bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));
}
async function stopBridge() {
  if (!bridge) return;
  bridge.kill();
  bridge = null;
  // 端口真正放开再起下一个，否则新桥 EADDRINUSE。
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/healthz`);
      await sleep(80);
    } catch {
      return;
    }
  }
}
/** 起桥并等 /healthz：端口刚放掉的几百毫秒里偶发 EADDRINUSE，重试一次再判死。 */
async function startBridgeUp(label) {
  for (let attempt = 1; ; attempt++) {
    startBridge();
    try {
      await until(async () => (await fetch(`${BASE}/healthz`)).ok, 10000, label);
      return;
    } catch (err) {
      await stopBridge();
      if (attempt >= 3) throw err;
      await sleep(800);
    }
  }
}

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(120);
  }
  console.error(bridgeOut.join("").slice(-3000));
  throw new Error(`timeout: ${label}`);
}
function writeState(state) {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

const fails = [];
const ok = (cond, label) => {
  console.log(`  ${cond ? "✔" : "✖"} ${label}`);
  if (!cond) fails.push(label);
};

/** 起一次页面（同一份 cookie），返回 page + 关掉它的函数。 */
let browser = null;
let cookie = "";
async function openPage(opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 860 },
    locale: "zh-CN",
  });
  if (opts.seed) await context.addInitScript(opts.seed);
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(`${BASE}${opts.hash ?? ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .topbar, #app .composer", { timeout: 15000 });
  return { page, context };
}

/** 弹窗出现/不出现。 */
const dialogVisible = (page) => page.evaluate(() => Boolean(document.querySelector(".whatsnew-back")));
async function waitDialog(page, ms = 15000) {
  return until(() => dialogVisible(page), ms, "whatsnew dialog").then(() => true);
}
async function noDialog(page, ms = 2500) {
  await sleep(ms);
  return !(await dialogVisible(page));
}

let page = null;
let context = null;
try {
  await startBridgeUp("bridge up");
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  browser = await chromium.launch({ headless: true });

  // ---- 1) 全新状态：弹，内容是最新一批，N = 总批数 - 1，一打开就写已读
  log("1) 全新状态：首次连接就弹");
  ({ page, context } = await openPage());
  await waitDialog(page);
  const body1 = await page.evaluate(() => {
    // 只看正文顶上那一块（最新一批）；`older` 里还有同一个选择器，先取父层级才不会摸到它们。
    const main = document.querySelector(".whatsnew-body > .whatsnew-log, .whatsnew-body > .whatsnew-md");
    return {
      title: main?.querySelector(".cl-batch h3, .whatsnew-title")?.textContent ?? "",
      structured: Boolean(main?.querySelector(".cl-batch")),
      date: main?.querySelector(".cl-date")?.textContent ?? "",
      summary: document.querySelector(".whatsnew-older > summary")?.textContent ?? "",
      text: document.querySelector(".whatsnew-body")?.textContent ?? "",
      buttons: [...document.querySelectorAll(".whatsnew-foot .btn")].map((b) => b.textContent ?? ""),
    };
  });
  ok(body1.structured, "弹窗用的是与设置页同一套条目（.whatsnew-log）");
  ok(body1.title.trim() === shortTitle(NEWEST), `弹的是最新一批（${body1.title.trim().slice(0, 24)}…）`);
  ok(body1.date.trim().length > 0, `条目头上有日期或「未发布」（${body1.date.trim()}）`);
  ok(body1.text.includes(NEWEST_FIRST), `正文里就是最新那批的第一条（${NEWEST_FIRST}…）`);
  ok(body1.summary.includes(String(TITLES.length - 1)), `「还有 N 批更早的」N=${TITLES.length - 1}（${body1.summary}）`);
  ok(body1.text.length > 20, "正文渲染出了内容");
  ok(body1.buttons.join("|").includes("知道了") && body1.buttons.join("|").includes("看全部日志"), `底部两颗按钮（${body1.buttons.join(" / ")}）`);
  await sleep(400);
  ok(readState()?.seenTitle === NEWEST, "一打开就把已读写到状态目录");
  await page.screenshot({ path: path.join(OUT, "01-first-run.png") });

  // ---- 2) 同一进程刷新：不弹（本次启动已派发）
  log("2) 同一进程里刷新页面");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .topbar, #app .composer", { timeout: 15000 });
  ok(await noDialog(page), "刷新后不再弹（同一进程只派发一次）");
  await context.close();

  // ---- 3) 重启桥、已读没动：不弹
  log("3) 重启桥，已读仍是最新那批");
  await stopBridge();
  await startBridgeUp("bridge up#2");
  ({ page, context } = await openPage());
  ok(await noDialog(page, 3500), "重启后仍不弹（最新那批看过了）");

  // ---- 4) 有新批次但没过 24 小时：不弹，已读不前进
  log("4) 有新批次但闸未满");
  await page.close();
  await context.close();
  await stopBridge();
  writeState({ seenTitle: "", lastShownAt: Date.now() });
  await startBridgeUp("bridge up#3");
  ({ page, context } = await openPage());
  ok(await noDialog(page, 3500), "不满 24 小时不弹");
  ok((readState()?.seenTitle ?? "") === "", "被闸挡下的已读没有前进（那几批还能在下次弹出来）");

  // ---- 5) 过了一天又有新批次：弹，且只有一批（没有「还有 N 批」）
  log("5) 有新批次且过了一天的闸");
  await page.close();
  await context.close();
  await stopBridge();
  writeState({ seenTitle: SECOND, lastShownAt: 0 });
  await startBridgeUp("bridge up#4");
  ({ page, context } = await openPage());
  await waitDialog(page);
  const body5 = await page.evaluate(() => {
    const main = document.querySelector(".whatsnew-body > .whatsnew-log, .whatsnew-body > .whatsnew-md");
    return {
      title: main?.querySelector(".cl-batch h3, .whatsnew-title")?.textContent ?? "",
      hasOlder: Boolean(document.querySelector(".whatsnew-older")),
    };
  });
  ok(body5.title.trim() === shortTitle(NEWEST), "弹的还是最新那一批");
  ok(!body5.hasOlder, "只差一批时不出「还有 N 批」那一段");

  // ---- 6) 「看全部日志」把人送到设置那一页；那一页上看得到「上次看到」与开关，且翻完不算已读
  log("6) 看全部日志 → 设置页那一页");
  // 「打开即已读」是一次 fire-and-forget 的 POST：先等它真落盘，否则下面「一个字节没动」比的是两份空。
  await until(() => readState()?.seenTitle === NEWEST, 5000, "seen 落盘");
  const beforeSettings = readState();
  await page.locator(".whatsnew-foot .btn", { hasText: "看全部日志" }).click();
  await page.waitForSelector(".st-console .settings-row", { timeout: 15000 });
  const landed = await page.evaluate(() => ({
    nav: document.querySelector(".st-nav__item.on")?.textContent ?? "",
    seg: document.querySelector(".st-seg__btn.on")?.textContent ?? "",
  }));
  ok(landed.nav.includes("更新日志"), `落在「更新日志」那一格（${landed.nav.trim()}）`);
  ok(landed.seg.trim() === "本项目", `页内分段切在「本项目」（${landed.seg.trim()}）`);
  const afterSettings = readState();
  ok(
    afterSettings?.seenTitle === beforeSettings?.seenTitle && afterSettings?.lastShownAt === beforeSettings?.lastShownAt,
    "在设置页里自己翻完不算已读（状态文件一个字节没动）",
  );
  const settings = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".settings-row")].map((r) => ({
      name: r.querySelector(".settings-name")?.textContent ?? "",
      ctl: r.querySelector(".settings-ctl")?.textContent ?? "",
      checked: r.querySelector('input[type="checkbox"]')?.checked ?? null,
    }));
    return rows;
  });
  const seenRow = settings.find((r) => r.name.includes("上次看到"));
  const switchRow = settings.find((r) => r.name.includes("启动时自动打开更新日志"));
  ok(Boolean(seenRow), "设置页有「上次看到」这一行");
  ok((seenRow?.ctl ?? "").includes(NEWEST.slice(0, 12)), `「上次看到」显示的是最新那批（${(seenRow?.ctl ?? "").slice(0, 26)}…）`);
  ok(switchRow?.checked === true, "开关默认开");
  // D367：这两行的容器曾经拿成横排小节头，整页被挤成一列字 —— 文字断言拦不住，只有几何能露出来。
  const squished = await page.evaluate(() =>
    [...document.querySelectorAll(".st-pane .settings-row")]
      .filter((r) => {
        const box = r.getBoundingClientRect();
        const name = r.querySelector(".settings-name");
        if (!name) return false;
        const cs = getComputedStyle(name);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
        return box.height > box.width || name.getBoundingClientRect().height > lh * 2.5;
      })
      .map((r) => (r.querySelector(".settings-name")?.textContent ?? "").trim()),
  );
  ok(squished.length === 0, `这两行设置是横条不是竖条（${squished.join(" / ") || "0 条被压竖"}）`);
  /**
   * 点开关并等状态落盘。11:17 那天在步骤 6 抖过一次（点了但 enabled=false 没写进状态文件，重跑就好了），
   * 所以先滚到中间、等一拍再点，第一次没落盘就再点一次；真·点了不生效仍然会红，只是把「重试过」写进断言里。
   */
  const quiet = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (await fn()) return true;
      } catch {}
      await sleep(120);
    }
    return false;
  };
  const flipSwitch = async (want) => {
    const input = page.locator(".settings-row", { hasText: "启动时自动打开更新日志" }).locator('input[type="checkbox"]');
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // 上一次点击可能只是 POST 落盘慢一点：真值已经是 `want` 就直接算成，别再点一次 ——
      // 第二次点击会把刚存下的值又翻回去，越点越不像。
      if (readState()?.enabled === want) return attempt;
      await input.scrollIntoViewIfNeeded();
      await sleep(200);
      await input.click();
      if (await quiet(() => readState()?.enabled === want, 3000)) return attempt;
      if (attempt === 2) break;
    }
    return 0;
  };
  const offTries = await flipSwitch(false);
  ok(offTries > 0, `关掉开关会写进状态目录（关着期间已读不前进${offTries > 1 ? `，第 ${offTries} 次点击才生效` : ""}）`);
  const onTries = await flipSwitch(true);
  // `flipSwitch` 两次都没落盘时返回 0 —— 那种情况下只看 `readState().enabled` 可能被上一次
  // 就已是 true 的状态蒙过去，这一次点击根本没验到。
  ok(onTries > 0 && readState()?.enabled === true, `再打开也一样落盘${onTries > 1 ? `（第 ${onTries} 次）` : ""}`);
  await page.screenshot({ path: path.join(OUT, "02-settings-page.png") });
  await page.close();
  await context.close();

  // ---- 7) 草稿没发出去时先不弹；清空后才弹；窄屏铺满 + 字号 150% 底栏还在
  log("7) 空着输入框才弹 + 窄屏 + 字号 150%");
  await stopBridge();
  writeState({ seenTitle: SECOND, lastShownAt: 0, enabled: true });
  await startBridgeUp("bridge up#5");
  // 直接路由到桩会话：输入框从第一帧就在，草稿也从 `pi.drafts` 里恢复（没会话时编辑器整块不画，
  // 「输入框空着」这条就无从验起）。
  ({ page, context } = await openPage({
    viewport: { width: 700, height: 820 },
    hash: `#/s/${SID}`,
    // 键是会话 id（`SID`）—— 页面脚本里拿不到外层变量，所以写字面量。
    seed: () => localStorage.setItem("pi.drafts", JSON.stringify([["zz-whatsnew", "正在写的一句话"]])),
  }));
  await page.waitForSelector(".composer textarea", { timeout: 15000 });
  await page.evaluate(() => {
    // D123 / D263：字号 125% 以上时，裸 vh 会把弹层和底栏推出屏幕。这里直接把 zoom 拉满验它。
    document.documentElement.style.setProperty("--ui-scale", "1.5");
  });
  const draft = await page.inputValue(".composer textarea");
  ok(draft.includes("正在写的一句话"), `草稿已恢复在输入框里（${JSON.stringify(draft)}）`);
  ok(await noDialog(page, 3500), "输入框里有草稿时不弹");
  await page.fill(".composer textarea", "");
  await waitDialog(page, 12000);
  ok(true, "草稿清空后按点弹出来");
  const geo = await page.evaluate(() => {
    const sheet = document.querySelector(".whatsnew-sheet");
    const foot = document.querySelector(".whatsnew-foot");
    const ok = document.querySelector(".whatsnew-foot .btn.primary");
    if (!sheet || !foot || !ok) return null;
    const cs = getComputedStyle(sheet);
    const back = document.querySelector(".whatsnew-back");
    return {
      w: Number.parseFloat(getComputedStyle(sheet).width),
      backW: Math.round(back?.getBoundingClientRect().width ?? 0),
      vw: window.innerWidth,
      scale: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1,
      radius: cs.borderRadius,
      footBottom: Math.round(foot.getBoundingClientRect().bottom),
      okBottom: Math.round(ok.getBoundingClientRect().bottom),
      vh: window.innerHeight,
    };
  });
  ok(Boolean(geo), "窄屏下面板 / 底栏 / 按钮都在");
  // 比 computed 宽度而不是 rect：`#app` 上挂着 zoom，rect 与 CSS px 不是同一个坐标系（rect 会少掉
  // zoom 的份额）。铺满 = 面板宽度正好等于「一屏 / 字号倍数」。
  const wantW = (geo?.vw ?? 0) / (geo?.scale ?? 1);
  ok(Math.abs((geo?.w ?? 0) - wantW) <= 1, `窄屏铺满整屏（面板 ${geo?.w} = 屏宽 ${geo?.vw} / 字号 ${geo?.scale}）`);
  ok((geo?.radius ?? "") === "0px", `窄屏没有圆角（${geo?.radius}）`);
  ok((geo?.okBottom ?? 1e9) <= (geo?.vh ?? 0) + 1, `字号 150% 时「知道了」还在屏幕里（${geo?.okBottom} ≤ ${geo?.vh}）`);
  ok((geo?.footBottom ?? 1e9) <= (geo?.vh ?? 0) + 1, `字号 150% 时底栏贴底可见（${geo?.footBottom} ≤ ${geo?.vh}）`);
  await page.screenshot({ path: path.join(OUT, "03-narrow-150.png") });
} finally {
  try {
    await context?.close();
  } catch {}
  if (browser) await browser.close();
  bridge?.kill();
}

console.log(`\n截图：${OUT}`);
if (fails.length) {
  console.log(`FAIL — ${fails.length} 处不对：`);
  for (const f of fails) console.log("  " + f);
  process.exitCode = 1;
} else {
  console.log("ALL OK — 更新日志弹窗的认定、节流、排队与外观都对得上");
}
