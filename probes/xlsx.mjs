/**
 * Probe #105：打开 .xlsx → 表格浮窗里的格子 → 拖动 / 缩放 → 关闭 → 重开几何还在。
 *
 * 唯一那条缝（CONTEXT.md）：真 Chromium + 隔离真桥。只断言用户能看见的东西：
 * 格子里的字、窗口的框、请求里的行区间、localStorage。不 import 前端内部模块。
 *
 * 自带桥（7867 + 临时 state / agent / 工作目录），不碰 7864 的正式实例。
 * Run: npm run build:web && npm run build:bridge && node probes/xlsx.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const modp = (p) => pathToFileURL(p).href;

const PORT = Number(process.env.PI_WEB_PORT ?? 7867);
const ROOT = path.join(REPO, ".scratch/xlsx-probe");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const OUT = path.join(REPO, "probes/out/xlsx");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "zz-xlsx-105";

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK, OUT]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假会话：只为了让首页有一张卡、文件管理器从 WORK 起步。不跑模型。
const dir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(dir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "xlsx 骨架验证" }] } },
  { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name: "xlsx 骨架" },
];
fs.writeFileSync(path.join(dir, `${SID}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

const { makeFixtures, makeUnsupportedFixtures, buildXlsx } = await import(modp(path.join(REPO, "bridge/tests/fixtures/make-xlsx.mjs")));
const made = makeFixtures(WORK);
const odd = makeUnsupportedFixtures(WORK);
log("fixture:", made.plain);

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
        // /T：桥会给每个会话拉 `pi --mode rpc` 子进程，子进程会继承监听 socket，只杀父进程端口仍被占。
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      } catch {}
    }
    if (pids.size) log(`cleared stale bridge on :${port}`);
    // 杀完等端口真的释放：不等的话紧接着 spawn 会 EADDRINUSE，登录落到上一轮的桥上就成假失败。
    for (let i = 0; i < 20; i++) {
      if (!listening(port)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    return pids.size;
  } catch {
    return 0;
  }
}

function listening(port) {
  const out = execSync("netstat -ano", { encoding: "utf8" });
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+(\S+)\s+\S+\s+(\d+)$/);
    if (m && Number(m[1]) === port && /:0$/.test(m[2])) return true;
  }
  return false;
}
killPort(PORT);

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT },
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
    } catch {}
    await sleep(150);
  }
  console.error(bridgeOut.join("").slice(-3000));
  throw new Error(`timeout waiting for ${label}`);
}

let browser = null;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 15000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => {
    pageErrors.push(e.message);
    log("page error:", e.message);
  });
  const windowRequests = [];
  page.on("request", (r) => {
    if (!r.url().includes("/api/sheet/window")) return;
    try {
      windowRequests.push(JSON.parse(r.postData() ?? "{}"));
    } catch {
      windowRequests.push({ bad: r.postData() });
    }
  });

  const openSession = async () => {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await until(async () => (await page.locator(".session-card").count()) >= 1, 15000, "session card");
    await page.locator(".session-card").first().click();
    await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().waitFor({ timeout: 15000 });
  };

  const openSheet = async (name = "plain.xlsx") => {
    await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().evaluate((el) => el.click());
    const row = page.locator(".file-row", { hasText: name }).first();
    await row.waitFor({ timeout: 20000 });
    await row.evaluate((el) => el.click());
    await page.locator(".sd").first().waitFor({ timeout: 20000 });
    await page.locator(".sd-cell").first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(250);
  };

  /** 从文件管理器点开一个文件，不管它落在哪条分支（浮窗 / 二进制面板）。 */
  const openFile = async (name) => {
    await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().evaluate((el) => el.click());
    const row = page.locator(".file-row", { hasText: name }).first();
    await row.waitFor({ timeout: 20000 });
    await row.evaluate((el) => el.click());
    await page.waitForTimeout(700);
  };

  /** 桥端接口直呼：公网 / 伪造凭据这些分支，浏览器里点不出来，只能直接发。 */
  const api = async (p, body, extra = {}) => {
    const r = await fetch(`${BASE}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, ...extra },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await r.json();
    } catch {}
    return { status: r.status, data };
  };
  // 桥端把「隧道来客」认作公网（cloudflared 注入的头）。Host 头谁都能编，不算数。
  const AS_TUNNEL = { "cf-connecting-ip": "203.0.113.9" };

  const box = () =>
    page.evaluate(() => {
      const el = document.querySelector(".sd");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) };
    });
  const geom = () => page.evaluate(() => JSON.parse(localStorage.getItem("pi.sheetGeom") ?? "null"));
  const cellText = (r, c) =>
    page.evaluate(
      ([rr, cc]) => document.querySelector(`.sd-cell[data-r="${rr}"][data-c="${cc}"]`)?.textContent ?? null,
      [r, c],
    );

  await openSession();
  await openSheet();

  // ---------------------------------------------------------------- 壳与只读
  const title = await page.locator(".sd-name").first().textContent();
  const subtitle = await page.locator(".sd-path").first().textContent();
  check("标题是文件名", title?.trim() === "plain.xlsx", String(title));
  check("副标题是路径", (subtitle ?? "").includes(WORK.replace(/\//g, "\\")) || (subtitle ?? "").includes(WORK), String(subtitle));
  check("没有遮罩", (await page.locator(".sd-back, .sheet-back").count()) === 0);
  check("不是 viewer 面板", (await page.locator(".viewer").count()) === 0);
  check("不抢焦点", await page.evaluate(() => !document.querySelector(".sd")?.contains(document.activeElement)));

  const readonly = await page.evaluate(() => {
    const root = document.querySelector(".sd");
    const cell = document.querySelector(".sd-cell");
    if (!root || !cell) return null;
    const cs = getComputedStyle(cell);
    return {
      fields: root.querySelectorAll("input, textarea, select, [contenteditable='true']").length,
      cursor: cs.cursor,
      select: cs.userSelect,
      editable: cell.isContentEditable,
    };
  });
  check("格子里没有输入控件", readonly?.fields === 0, JSON.stringify(readonly));
  check("格子上不是文本光标", readonly?.cursor === "default", readonly?.cursor);
  check("格子不可选中/不可编辑", readonly?.select === "none" && readonly?.editable === false, JSON.stringify(readonly));

  // ---------------------------------------------------------------- 表头与值
  const colA = await page.locator('.sd-colhead-in [data-c="0"]').first().textContent();
  const colC = await page.locator('.sd-colhead-in [data-c="2"]').first().textContent();
  const rowNo = await page.locator('.sd-rowhead-in [data-r="0"]').first().textContent();
  check("列头 A / C 都在", colA?.trim() === "A" && colC?.trim() === "C", `${colA}/${colC}`);
  check("行号从 1 开始", rowNo?.trim() === "1", String(rowNo));
  check("表头文字", (await cellText(0, 1)) === "产品", String(await cellText(0, 1)));
  check("文本原样", (await cellText(1, 0)) === "华东", String(await cellText(1, 0)));
  check("小数不丢", (await cellText(1, 2)) === "12.5", String(await cellText(1, 2)));
  check("多位小数原样", (await cellText(2, 2)) === "3.14159", String(await cellText(2, 2)));
  check("整数原样", (await cellText(3, 2)) === "45292", String(await cellText(3, 2)));
  check("数字没变成日期", !/\d{4}[-/年]\d{1,2}/.test((await cellText(3, 2)) ?? ""), String(await cellText(3, 2)));
  check("前导零仍是文本", (await cellText(1, 6)) === "001", String(await cellText(1, 6)));
  check("XML 实体已还原", (await cellText(3, 5)) === "华东 & 华南 <测试>", String(await cellText(3, 5)));
  check("内联字符串", (await cellText(5, 5)) === "内联字符串", String(await cellText(5, 5)));
  check("布尔值", (await cellText(4, 7)) === "TRUE", String(await cellText(4, 7)));
  check("错误值原样", (await cellText(2, 7)) === "#DIV/0!", String(await cellText(2, 7)));

  await page.screenshot({ path: path.join(OUT, "01-open.png") });

  // ---------------------------------------------------------------- 按可见范围取数
  await page.evaluate(() => {
    const view = document.querySelector(".sd-view");
    if (view) {
      view.scrollTop = 60 * 28;
      view.dispatchEvent(new Event("scroll"));
    }
  });
  await until(async () => (await cellText(60, 0)) !== null, 5000, "第 61 行");
  const later = await cellText(60, 0);
  check("滚动后显示别的行", later !== null && later !== "华东", String(later));
  await page.screenshot({ path: path.join(OUT, "02-scrolled.png") });

  check("每次窗口请求都带行区间", windowRequests.length > 0 && windowRequests.every((b) => Number.isFinite(b.r0) && Number.isFinite(b.r1)), JSON.stringify(windowRequests.slice(-3)));
  check("请求不是整表", windowRequests.every((b) => b.r1 - b.r0 <= 60), JSON.stringify(windowRequests.map((b) => [b.r0, b.r1])));
  check("请求没有整表字段", windowRequests.every((b) => !("all" in b) && !("rows" in b)));

  // 回到顶部，后面量几何。
  await page.evaluate(() => {
    const view = document.querySelector(".sd-view");
    if (view) {
      view.scrollTop = 0;
      view.dispatchEvent(new Event("scroll"));
    }
  });
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------- 默认几何
  const vw = 1440;
  const vh = 900;
  const def = await box();
  check("默认宽度受视口约束", def.w === Math.min(1180, vw - 48), String(def.w));
  check("默认高度受视口约束", def.h === Math.min(780, vh - 48), String(def.h));
  check("默认居中", Math.abs(def.l - (vw - def.w) / 2) <= 2, JSON.stringify(def));

  const drag = async (sel, dx, dy, yOff = 0) => {
    const r = await page.locator(sel).first().boundingBox();
    if (!r) throw new Error(`no box for ${sel}`);
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2 + yOff;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  };

  // ---------------------------------------------------------------- 拖标题栏
  const b0 = await box();
  await drag(".sd-head", -120, 60);
  const b1 = await box();
  check("拖标题栏移动", Math.abs(b1.l - (b0.l - 120)) <= 2 && Math.abs(b1.t - (b0.t + 60)) <= 2, `${JSON.stringify(b0)} → ${JSON.stringify(b1)}`);
  check("移动后尺寸不变", b1.w === b0.w && b1.h === b0.h);
  check("几何写进 localStorage", (await geom()) !== null, JSON.stringify(await geom()));

  // ---------------------------------------------------------------- 右下角改宽高
  await drag(".sd-resize", -120, -80);
  const b2 = await box();
  check("右下角同时改宽高", b2.w === b1.w - 120 && b2.h === b1.h - 80, `${JSON.stringify(b1)} → ${JSON.stringify(b2)}`);

  // ---------------------------------------------------------------- 顶边只改高
  const b3 = await box();
  await drag(".sd-grip", 0, -60, 1);
  const b4 = await box();
  check("顶边只改高", b4.h === b3.h + 60 && b4.w === b3.w, `${JSON.stringify(b3)} → ${JSON.stringify(b4)}`);
  check("顶边拖动时底边不动", Math.abs(b4.b - b3.b) <= 2 && b4.t < b3.t, `${b3.b}/${b4.b}`);

  // ---------------------------------------------------------------- 拖出视口 clamp
  await drag(".sd-head", -4000, -4000);
  const b5 = await box();
  check("左上拖出被 clamp", b5.l >= 0 && b5.t >= 0, JSON.stringify(b5));
  await drag(".sd-resize", 4000, 4000);
  const b6 = await box();
  check("右下拖出被 clamp", b6.r <= vw + 1 && b6.b <= vh + 1, JSON.stringify(b6));
  await page.screenshot({ path: path.join(OUT, "03-dragged.png") });

  // ---------------------------------------------------------------- 双击复原
  await page.locator(".sd-head").first().dblclick();
  await page.waitForTimeout(200);
  const b7 = await box();
  check("双击标题栏复原默认大小", b7.w === def.w && b7.h === def.h, JSON.stringify(b7));
  check("双击后位置也回默认", Math.abs(b7.l - def.l) <= 2 && Math.abs(b7.t - def.t) <= 2, JSON.stringify(b7));

  // ---------------------------------------------------------------- 关掉重开 / 刷新
  await drag(".sd-head", 90, 40);
  await drag(".sd-resize", -100, -50);
  const kept = await box();
  const stored = await geom();
  check("关闭前几何已存", stored && stored.w === kept.w && stored.h === kept.h, JSON.stringify(stored));

  await page.locator(".sd-close").first().click();
  await until(async () => (await page.locator(".sd").count()) === 0, 5000, "dialog closed");
  check("关闭后浮窗消失", (await page.locator(".sd").count()) === 0);

  await openSheet();
  const b8 = await box();
  check("重开后位置还在", Math.abs(b8.l - kept.l) <= 2 && Math.abs(b8.t - kept.t) <= 2, `${JSON.stringify(kept)} → ${JSON.stringify(b8)}`);
  check("重开后大小还在", b8.w === kept.w && b8.h === kept.h, `${kept.w}x${kept.h} → ${b8.w}x${b8.h}`);
  await page.screenshot({ path: path.join(OUT, "04-reopened.png") });

  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 15000, "session card after reload");
  await page.locator(".session-card").first().click();
  await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().waitFor({ timeout: 15000 });
  await openSheet();
  const b9 = await box();
  check("刷新后位置还在", Math.abs(b9.l - kept.l) <= 2 && Math.abs(b9.t - kept.t) <= 2, `${JSON.stringify(kept)} → ${JSON.stringify(b9)}`);
  check("刷新后大小还在", b9.w === kept.w && b9.h === kept.h, `${kept.w}x${kept.h} → ${b9.w}x${b9.h}`);

  // ---------------------------------------------------------------- 结构保真（#108）
  // 同一份表要长得像在 Excel 里：合并标题、文件里的列宽、数字/日期格式、冻结、多表。
  await page.locator(".sd-close").first().click();
  await until(async () => (await page.locator(".sd").count()) === 0, 5000, "dialog closed");
  await openSheet("report.xlsx");

  const cellBox = (r, c) =>
    page.evaluate(
      ([rr, cc]) => {
        const el = document.querySelector(`.sd-cell[data-r="${rr}"][data-c="${cc}"]`);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
      },
      [r, c],
    );

  // 合并标题：A1:H1 一个块，跨过 8 列，字居中；被并掉的格子不单独出现。
  const mergedTitle = await cellText(0, 0);
  check("合并标题在 A1", mergedTitle === "2024 年度销售汇总", String(mergedTitle));
  const tb = await cellBox(0, 0);
  const a1 = await cellBox(1, 0);
  check("合并区横跨多列", tb !== null && a1 !== null && tb.w > a1.w * 8, JSON.stringify({ merged: tb, oneCol: a1 }));
  check("合并区里没有空格子", (await page.locator('.sd-cell[data-r="0"][data-c="1"]').count()) === 0);
  check("合并格标题居中", (await page.evaluate(() => getComputedStyle(document.querySelector('.sd-cell[data-r="0"][data-c="0"]')).justifyContent)) === "center");

  // 列宽取文件值：A 列 width=18 → 131px，H 列 width=5 → 40px；窄列长文本被裁，不撑破布局。
  const wa = (await cellBox(1, 0))?.w ?? 0;
  const wh = (await cellBox(1, 7))?.w ?? 0;
  check("A 列用文件宽度", Math.abs(wa - 131) <= 3, String(wa));
  check("H 列是窄列", Math.abs(wh - 40) <= 3, String(wh));
  const narrow = await page.evaluate(() => {
    const el = document.querySelector('.sd-cell[data-r="2"][data-c="7"]');
    if (!el) return null;
    return { w: Math.round(el.getBoundingClientRect().width), clip: el.scrollWidth > el.clientWidth, nowrap: getComputedStyle(el).whiteSpace };
  });
  check("窄列内容被裁不撑破", narrow?.clip === true && narrow?.nowrap === "nowrap", JSON.stringify(narrow));

  // 数字 / 货币 / 百分比 / 日期 / 时刻：格式取自文件，45678 必须是日期。
  check("货币格式", (await cellText(2, 2)) === "¥1,234.50", String(await cellText(2, 2)));
  check("千分位整数", (await cellText(2, 3)) === "1,234,568", String(await cellText(2, 3)));
  check("百分比", (await cellText(2, 4)) === "12.3%", String(await cellText(2, 4)));
  check("45678 按日期格式显示", (await cellText(2, 5)) === "2025-01-21", String(await cellText(2, 5)));
  check("时刻格式", (await cellText(2, 6)) === "18:00", String(await cellText(2, 6)));
  check("没写格式的格保持原样", (await cellText(1, 7)) === "备注", String(await cellText(1, 7)));
  await page.screenshot({ path: path.join(OUT, "05-structure.png") });

  // 冻结首行首列：滚远之后标题行与第一列仍贴在左边/上边。
  const viewBox = await page.evaluate(() => {
    const v = document.querySelector(".sd-view");
    const b = v.getBoundingClientRect();
    return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  });
  await page.evaluate(() => {
    const v = document.querySelector(".sd-view");
    v.scrollTop = 420;
    v.scrollLeft = 260;
    v.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(250);
  const scrolled = await page.evaluate(() => Math.round(document.querySelector(".sd-view").scrollLeft));
  check("表比窗口宽，能横向滚动", scrolled > 100, String(scrolled));
  const frozenTitle = await cellBox(0, 0);
  const frozenCol = await cellBox(20, 0);
  check("滚动后冻结行还贴在顶上", !!frozenTitle && Math.abs(frozenTitle.t - viewBox.t) <= 2, JSON.stringify({ frozenTitle, viewBox }));
  check("滚动后冻结列还贴在左边", !!frozenCol && Math.abs(frozenCol.l - viewBox.l) <= 2, JSON.stringify({ frozenCol, viewBox }));
  check("冻结分界线可见", await page.evaluate(() => {
    const v = document.querySelector(".sd-frz-v");
    const h = document.querySelector(".sd-frz-h");
    const vb = (el) => (el ? el.getBoundingClientRect() : null);
    const a = vb(v);
    const b = vb(h);
    return !!a && !!b && a.height > 100 && b.width > 100;
  }));
  await page.screenshot({ path: path.join(OUT, "06-frozen.png") });

  // 底部工作表：只列可见的两张，切换后内容变、滚动位置归零，当前表有选中态。
  const tabs = await page.locator(".sd-wstab").allTextContents();
  check("底部只列可见工作表", tabs.length === 2 && tabs.join("/") === "报表/明细", JSON.stringify(tabs));
  const hint = (await page.locator(".sd-wshint").innerText()) ?? "";
  check("隐藏工作表有提示", /1\s*个隐藏工作表/.test(hint), hint);
  await page.locator(".sd-wstab", { hasText: "明细" }).first().click();
  await until(async () => (await cellText(0, 0)) === "明细表头", 5000, "sheet switched");
  check("切换后内容变了", (await cellText(0, 0)) === "明细表头", String(await cellText(0, 0)));
  check("切换后滚动位置归零", (await page.evaluate(() => document.querySelector(".sd-view").scrollTop)) === 0);
  check("当前表有选中态", await page.evaluate(() => {
    const on = [...document.querySelectorAll(".sd-wstab")].filter((b) => b.getAttribute("aria-selected") === "true");
    return on.length === 1 && on[0].textContent?.trim() === "明细";
  }));
  await page.screenshot({ path: path.join(OUT, "07-sheet-switch.png") });
  await page.locator(".sd-wstab", { hasText: "报表" }).first().click();
  await until(async () => (await cellText(0, 0)) === "2024 年度销售汇总", 5000, "sheet switched back");
  check("切回来还是合并标题", (await cellText(0, 0)) === "2024 年度销售汇总", String(await cellText(0, 0)));

  // ---------------------------------------------------------------- 条件格式（#109）
  // 五类规则都在桥端求值，前端只吃结果：底色、字色、加粗、数据条宽度、图标等级。
  await page.locator(".sd-close").first().click();
  await until(async () => (await page.locator(".sd").count()) === 0, 5000, "dialog closed");
  await openSheet("cf.xlsx");

  const fxOf = (r, c) =>
    page.evaluate(
      ([rr, cc]) => {
        const el = document.querySelector(`.sd-cell[data-r="${rr}"][data-c="${cc}"]`);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const bar = el.querySelector(".sd-bar");
        const icon = el.querySelector(".sd-icon");
        const rect = el.getBoundingClientRect();
        return {
          text: el.textContent ?? "",
          bg: cs.backgroundColor,
          color: cs.color,
          weight: Number(cs.fontWeight) || 400,
          w: Math.round(rect.width),
          bar: bar
            ? {
                w: bar.getBoundingClientRect().width,
                cw: rect.width,
                bg: getComputedStyle(bar).backgroundColor,
              }
            : null,
          icon: icon
            ? { level: icon.dataset.level, set: icon.dataset.set, glyph: icon.textContent ?? "", color: getComputedStyle(icon).color }
            : null,
        };
      },
      [r, c],
    );
  const rgb = (css) => (String(css).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const near = (css, [r, g, b], tol = 6) => {
    const [rr, gg, bb] = rgb(css);
    return Math.abs(rr - r) <= tol && Math.abs(gg - g) <= tol && Math.abs(bb - b) <= tol;
  };
  const white = (css) => near(css, [255, 255, 255], 1);

  // 色阶：10 → 红、55（50 分位）→ 黄、100 → 绿；相邻格深浅有序，不是一片同色。
  const csMin = await fxOf(1, 1);
  const csMid = await fxOf(11, 1);
  const csMax = await fxOf(10, 1);
  check("色阶最小值偏红", rgb(csMin?.bg)[0] > rgb(csMin?.bg)[1] + 60, String(csMin?.bg));
  check("色阶中点偏黄", rgb(csMid?.bg)[0] > 200 && rgb(csMid?.bg)[1] > 180 && rgb(csMid?.bg)[2] < 180, String(csMid?.bg));
  check("色阶最大值偏绿", rgb(csMax?.bg)[1] > rgb(csMax?.bg)[0] + 30, String(csMax?.bg));
  check("色阶三档颜色各不相同", new Set([csMin?.bg, csMid?.bg, csMax?.bg]).size === 3);
  await page.screenshot({ path: path.join(OUT, "09-cf.png") });

  // 数据条：100 / 500 / 1000 对应 10% / 50% / 100% 的格宽，文字还在。
  const barSmall = await fxOf(1, 2);
  const barMid = await fxOf(5, 2);
  const barBig = await fxOf(10, 2);
  const frac = (x) => (x?.bar ? x.bar.w / x.bar.cw : NaN);
  check("数据条存在", !!barSmall?.bar && !!barMid?.bar && !!barBig?.bar, JSON.stringify({ barSmall, barMid, barBig }).slice(0, 200));
  check("数据条 100 → 10% 格宽", Math.abs(frac(barSmall) - 0.1) <= 0.02, String(frac(barSmall)));
  check("数据条 500 → 50% 格宽", Math.abs(frac(barMid) - 0.5) <= 0.03, String(frac(barMid)));
  check("数据条 1000 → 满格", frac(barBig) >= 0.94, String(frac(barBig)));
  check("数据条长度随值成比例", frac(barBig) / frac(barSmall) > 8.5 && frac(barMid) / frac(barSmall) > 4.2, `${frac(barBig) / frac(barSmall)} / ${frac(barMid) / frac(barSmall)}`);
  check("数据条边上文字仍可读", barMid?.text.includes("500") && rgb(barMid?.color).reduce((a, b) => a + b, 0) < 400, `${barMid?.text} / ${barMid?.color}`);

  // 图标集：1 / 4 / 8 落在三个等级，每个格子都有图标且不撑破列宽。
  const iconCount = await page.locator(".sd-cell .sd-icon").count();
  check("图标集每格一个图标", iconCount === 11, String(iconCount));
  const iconLow = await fxOf(1, 3);
  const iconMid = await fxOf(4, 3);
  const iconHigh = await fxOf(8, 3);
  check("图标集有三个等级", new Set([iconLow?.icon?.level, iconMid?.icon?.level, iconHigh?.icon?.level]).size === 3, JSON.stringify([iconLow?.icon, iconMid?.icon, iconHigh?.icon]));
  check("图标等级随值上升", Number(iconLow?.icon?.level) < Number(iconMid?.icon?.level) && Number(iconMid?.icon?.level) < Number(iconHigh?.icon?.level));
  check("图标不撑破列宽", iconLow?.w === barSmall?.w, `${iconLow?.w} vs ${barSmall?.w}`);

  // 单元格值规则：小于 0 红字、大于 0 绿字加粗、等于 0 黄底、介于 10..20 浅绿底。
  const less = await fxOf(1, 4);
  const greater = await fxOf(4, 4);
  const equal = await fxOf(3, 4);
  check("小于 0 是红字", rgb(less?.color)[0] > 120 && rgb(less?.color)[1] < 60, String(less?.color));
  check("大于 0 是绿字", rgb(greater?.color)[1] > 80 && rgb(greater?.color)[0] < 80, String(greater?.color));
  check("大于 0 是加粗", Number(greater?.weight) >= 600, String(greater?.weight));
  check("等于 0 有黄底", near(equal?.bg, [255, 242, 204]), String(equal?.bg));
  const inRange = await fxOf(2, 5);
  const outRange = await fxOf(1, 5);
  check("介于 10..20 有浅绿底", near(inRange?.bg, [226, 239, 218]), String(inRange?.bg));
  check("范围外不涂色", white(outRange?.bg), String(outRange?.bg));

  // 公式规则 + 不支持的规则：前者隔行上色，后者不涂色但计数。
  const evenRow = await fxOf(1, 6);
  const oddRow = await fxOf(2, 6);
  check("公式规则命中偶数行", near(evenRow?.bg, [242, 242, 242]), String(evenRow?.bg));
  check("公式规则不碰奇数行", white(oddRow?.bg), String(oddRow?.bg));
  const unsupported = await fxOf(1, 7);
  check("不支持的规则不涂色", white(unsupported?.bg), String(unsupported?.bg));
  const cfHint = await page.evaluate(() => document.querySelector(".sd-cfhint")?.textContent ?? "");
  check("状态条报一条暂不支持", /1\s*条条件格式暂不支持/.test(cfHint), cfHint.trim());
  await page.screenshot({ path: path.join(OUT, "10-cf-bars-icons.png") });

  // 后面几段（#106 出口 / #113 CSV）测的是原来那份 plain.xlsx，换回去再往下走。
  await page.locator(".sd-close").first().click();
  await until(async () => (await page.locator(".sd").count()) === 0, 5000, "dialog closed");
  await openSheet("plain.xlsx");

  // ---------------------------------------------------------------- #106 出口
  const foot = await page.evaluate(() => {
    const bar = document.querySelector(".sd-foot");
    if (!bar) return null;
    const buttons = [...bar.querySelectorAll("button")].map((b) => b.textContent.trim());
    const a = bar.querySelector("a.sd-dl");
    return { buttons, href: a?.getAttribute("href") ?? null, text: a?.textContent.trim() ?? null, dl: a ? a.hasAttribute("download") : false };
  });
  check("底栏有「用 Excel 打开」", foot?.buttons.includes("用 Excel 打开") === true, JSON.stringify(foot?.buttons));
  check("底栏有「在文件夹中显示」", foot?.buttons.some((b) => b.includes("在文件夹中显示")) === true, JSON.stringify(foot?.buttons));
  check("下载仍是裸地址", /^\/raw\/[^/]+\/plain\.xlsx$/.test(String(foot?.href)), String(foot?.href));
  check("下载是 <a download>，不看桥的脸色", foot?.dl === true && foot?.text === "下载", JSON.stringify(foot));
  const token = String(foot?.href ?? "").split("/")[2] ?? "";

  // 公网来客：桌面上的动作一律不开
  const pubOpen = await api("/api/open", { token }, AS_TUNNEL);
  check("公网点「用 Excel 打开」被拒", pubOpen.status === 403, JSON.stringify(pubOpen));
  check("公网拒绝说了原因", pubOpen.data?.code === "open_public" && /本机/.test(String(pubOpen.data?.error)), JSON.stringify(pubOpen.data));
  const pubReveal = await api("/api/reveal", { path: made.plain }, AS_TUNNEL);
  check("公网点「在文件夹中显示」仍被拒", pubReveal.status === 403, JSON.stringify(pubReveal));

  // 凭据：没有 token / 伪造 token，路径塞在 body 里也不算数
  const noTok = await api("/api/open", { path: "C:\\\\Windows\\\\win.ini" });
  check("没凭据不开文件", noTok.status === 403 && noTok.data?.code === "sheet_grant", JSON.stringify(noTok));
  const forged = await api("/api/open", { token: "forged-token-000", path: odd.legacy });
  check("伪造凭据不开文件", forged.status === 403 && forged.data?.code === "sheet_grant", JSON.stringify(forged));
  const forgedMeta = await api("/api/sheet/meta", { token: "forged-token-000", path: made.plain });
  check("伪造凭据读不了表", forgedMeta.status === 403 && forgedMeta.data?.code === "sheet_grant", JSON.stringify(forgedMeta));

  // 表格端点只认发放时记下的那份文件：body 里再带一个 path 也不看
  const metaPath = await api("/api/sheet/meta", { token, path: odd.legacy });
  check("表端点忽略请求里的 path", metaPath.status === 200 && metaPath.data?.sheets?.[0]?.name === "销量", JSON.stringify(metaPath.data).slice(0, 200));
  const winPath = await api("/api/sheet/window", { token, path: odd.legacy, sheet: "销量", r0: 0, r1: 3, c0: 0, c1: 2 });
  check("取数也忽略请求里的 path", winPath.status === 200 && winPath.data?.rows?.[1]?.cells?.[0]?.t === "华东", JSON.stringify(winPath.data).slice(0, 200));

  // ---------------------------------------------------------------- #106 文件被改
  await sleep(60);
  fs.writeFileSync(made.plain, buildXlsx({ firstArea: "更换后" }));
  await page.evaluate(() => {
    const view = document.querySelector(".sd-view");
    if (view) {
      view.scrollTop = 60 * 28;
      view.dispatchEvent(new Event("scroll"));
    }
  });
  await page.locator(".sd-block").first().waitFor({ timeout: 10000 });
  const staleText = (await page.locator(".sd-block").first().textContent()) ?? "";
  check("文件被改后有提示", staleText.includes("文件已改变"), staleText);
  check("被改后不再展示旧格子", (await page.locator(".sd-cell").count()) === 0);
  await page.screenshot({ path: path.join(OUT, "05-stale.png") });

  const staleOpen = await api("/api/open", { token });
  check("过期凭据不开文件", staleOpen.status === 400 && staleOpen.data?.code === "sheet_stale", JSON.stringify(staleOpen));

  await page.locator(".sd-block button", { hasText: "重新打开" }).first().click();
  await until(async () => (await cellText(1, 0)) === "更换后", 10000, "重新打开后的新内容");
  check("重新打开读到新内容", (await cellText(1, 0)) === "更换后", String(await cellText(1, 0)));
  await page.screenshot({ path: path.join(OUT, "06-reopened-new.png") });
  await page.locator(".sd-close").first().click();
  await until(async () => (await page.locator(".sd").count()) === 0, 5000, "dialog closed");

  // ---------------------------------------------------------------- #106 降级
  const legacyPrev = await api("/api/preview", { sessionId: SID, path: odd.legacy });
  check(".xls 归到二进制分支", legacyPrev.data?.kind === "binary", JSON.stringify(legacyPrev.data)?.slice(0, 160));
  const legacyMeta = await api("/api/sheet/meta", { token: legacyPrev.data?.token });
  check(".xls 不给读表", legacyMeta.status === 400 && legacyMeta.data?.code === "sheet_unsupported", JSON.stringify(legacyMeta));

  for (const name of ["legacy.xls", "secret.xlsx", "table.ods"]) {
    await openFile(name);
    const msg = (await page.locator(".viewer-msg").first().textContent()) ?? "";
    check(`${name} 说清这个格式不支持`, msg.includes("这个格式这里不支持"), msg.trim().slice(0, 120));
    const hasOpen = await page.locator(".viewer-msg button", { hasText: "用 Excel 打开" }).count();
    check(`${name} 给了「用 Excel 打开」`, hasOpen === 1, String(hasOpen));
  }
  await page.screenshot({ path: path.join(OUT, "07-downgrade.png") });

  await openFile("fake.xlsx");
  await page.locator(".sd-block").first().waitFor({ timeout: 20000 });
  const fakeText = (await page.locator(".sd-block").first().textContent()) ?? "";
  check("改了扩展名的 zip 也说清不支持", fakeText.includes("这个格式这里不支持"), fakeText.trim().slice(0, 120));
  await page.screenshot({ path: path.join(OUT, "08-not-xlsx.png") });
  await page.locator(".sd-close").first().click();

  // 真把文件交给 Excel：默认不跑（会在桌面开窗、锁住文件），SHEET_OPEN=1 时跑一次。
  if (process.env.SHEET_OPEN) {
    const tmp = path.join(process.env.TEMP ?? process.env.TMP ?? "/tmp", `pi-xlsx-open-${process.pid}.xlsx`);
    fs.writeFileSync(tmp, buildXlsx());
    const prev = await api("/api/preview", { sessionId: SID, path: tmp });
    const before = bridgeOut.join("");
    const out = await api("/api/open", { token: prev.data?.token, path: "C:\\\\Windows\\\\win.ini" });
    check("本机开文件成功", out.status === 200 && out.data?.ok === true, JSON.stringify(out));
    const said = bridgeOut.join("").slice(before.length);
    check("开的是发放过的那份，不是 body 里的 path", said.includes(path.basename(tmp)) && !said.includes("win.ini"), said.trim().slice(-200));
    await sleep(1500);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
  }
  // ---------------------------------------------------------------- CSV / TSV（#113）
  // 先把 xlsx 那扇关掉：文件管理器是在 viewer 里，浮窗留着会与下面的断言撞车。
  const closeSheet = async () => {
    const close = page.locator(".sd-close").first();
    if (await close.count()) await close.click();
    await until(async () => (await page.locator(".sd").count()) === 0, 5000, "sd closed");
  };
  await closeSheet();
  // 浮窗几何已被上面改过，先清掉记忆回到默认尺寸。
  await page.evaluate(() => localStorage.removeItem("pi.sheetGeom"));
  const tab = (name) => page.locator(`.sd-tab[data-tab="${name}"]`).first();
  const srcText = async () => page.locator(".sd-src").first().inputValue();

  await openSheet("utf8.csv");
  check("CSV 开在表格浮窗里", (await page.locator(".sd").count()) === 1);
  check("CSV 有表格 / 源码两个标签页", (await page.locator(".sd-tab").count()) === 2, String(await page.locator(".sd-tab").count()));
  check("CSV 中文表头", (await cellText(0, 0)) === "地区", String(await cellText(0, 0)));
  check("CSV 列数正确", (await page.locator(".sd-col").count()) === 4, String(await page.locator(".sd-col").count()));
  check("CSV 引号里的分号不断列", (await cellText(1, 1)) === "螺丝;M4", String(await cellText(1, 1)));
  check("CSV 转义引号已还原", (await cellText(2, 3)) === '他说 "好"', String(await cellText(2, 3)));
  await page.screenshot({ path: path.join(OUT, "05-csv-grid.png") });

  await tab("source").click();
  const u8src = await srcText();
  check("源码是解码后的原文", u8src.includes('地区;产品;单价;备注') && u8src.includes('华东;"螺丝;M4";12.5'), u8src.slice(0, 60));
  await page.screenshot({ path: path.join(OUT, "06-csv-source.png") });
  await tab("grid").click();
  check("切回表格仍有格子", (await cellText(0, 0)) === "地区");
  await closeSheet();

  await openSheet("bom.csv");
  const bomCell = await cellText(0, 0);
  const bomAll = await page.locator(".sd-cells").textContent();
  check("BOM 不残留在第一格", bomCell === "地区", JSON.stringify(bomCell));
  check("BOM 不残留在整片格子", !(bomAll ?? "").includes("\ufeff"));
  await tab("source").click();
  const bomSrc = await srcText();
  check("BOM 源码开头没有 BOM 字符", !bomSrc.startsWith("\ufeff") && bomSrc.startsWith("地区,产品"), JSON.stringify(bomSrc.slice(0, 12)));
  await closeSheet();

  await openSheet("gbk.csv");
  check("GBK 中文正确", (await cellText(1, 0)) === "华东" && (await cellText(1, 1)) === "螺丝", `${await cellText(1, 0)}/${await cellText(1, 1)}`);
  await tab("source").click();
  const gbkSrc = await srcText();
  check("GBK 源码已解码", gbkSrc.includes("华东;螺丝;12.5;中文备注"), gbkSrc.slice(0, 40));
  await page.locator(".sd-src").first().fill(gbkSrc.replace("螺丝;12.5", "螺丝钉;12.5"));
  await page.locator(".sd-save").first().click();
  await until(async () => ((await page.locator(".sd-save-msg").first().textContent()) ?? "").includes("已保存"), 8000, "csv saved");
  const gbkAfter = fs.readFileSync(made.csv.gbk);
  const gbkText = new TextDecoder("gbk").decode(gbkAfter);
  check("GBK 保存后内容已写入", gbkText.includes("华东;螺丝钉;12.5;中文备注"), gbkText.split("\r\n")[1]);
  check("GBK 保存后仍是 GBK", (() => {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(gbkAfter);
      return false;
    } catch {
      return true;
    }
  })(), `${gbkAfter.length} bytes`);
  check("GBK 保存后分隔符不变", gbkText.split(";").length === 13 && !gbkText.includes("\t"), `${gbkText.split(";").length} 段`);
  await closeSheet();

  await openSheet("big.csv");
  const footText = (await page.locator(".sd-foot").first().textContent()) ?? "";
  check("超 5 万行截断并有提示", /只显示前/.test(footText), footText);
  check("截断后仍能看格子", (await cellText(0, 0)) === "行号", String(await cellText(0, 0)));
  check("截断的文件不提供保存", (await page.locator(".sd-save").count()) === 0);
  await page.screenshot({ path: path.join(OUT, "07-csv-truncated.png") });
  await closeSheet();

  check("没有页面异常", pageErrors.length === 0, pageErrors.join(" | "));
  log(`窗口请求 ${windowRequests.length} 次，示例 ${JSON.stringify(windowRequests.slice(0, 3))}`);
} catch (err) {
  failures++;
  console.error("FAIL 异常:", err?.stack ?? err);
  console.error(bridgeOut.join("").slice(-3000));
} finally {
  if (browser) await browser.close();
  bridge.kill();
  try {
    execSync(`taskkill //PID ${bridge.pid} //T //F`, { stdio: "ignore" });
  } catch {}
}

console.log(failures ? `${failures} 项失败` : "全部通过");
process.exit(failures ? 1 : 0);
