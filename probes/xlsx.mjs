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

/** 页面视图要 LibreOffice；没有就明说 SKIP，不静默通过。 */
function findSoffice() {
  const env = (process.env.PI_SOFFICE ?? "").trim();
  if (env) return fs.existsSync(env) ? env : null;
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files/LibreOffice/program/soffice.com",
          "C:/Program Files (x86)/LibreOffice/program/soffice.com",
          "C:/Program Files/LibreOffice/program/soffice.exe",
        ]
      : [];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const out = execSync(process.platform === "win32" ? "where soffice" : "which soffice", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}
const SKIP_PDF = findSoffice() === null;
if (SKIP_PDF) {
  console.log("SKIP 页面视图：本机没有 LibreOffice（soffice），#112 的 PDF 断言跳过（不是静默通过）");
}

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

const { makeFixtures, makeUnsupportedFixtures, buildXlsx, makeStressFixtures } = await import(modp(path.join(REPO, "bridge/tests/fixtures/make-xlsx.mjs")));
const made = makeFixtures(WORK);
const odd = makeUnsupportedFixtures(WORK);
const stresses = await makeStressFixtures(WORK);
log("fixture:", made.plain, `stress: ${stresses.length} 档`);

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

let bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
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
  const pdfResponses = [];
  page.on("response", async (r) => {
    if (!r.url().includes("/api/sheet/pdf")) return;
    const headers = r.headers();
    let head = "";
    try {
      head = Buffer.from(await r.body()).subarray(0, 5).toString("latin1");
    } catch {
      /* fetch 预检把 body 取消了，字节走 iframe 那一趟 */
    }
    pdfResponses.push({
      status: r.status(),
      method: r.request().method(),
      type: headers["content-type"] ?? "",
      csp: headers["content-security-policy"] ?? null,
      kind: r.request().resourceType(),
      head,
    });
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
      // #107：查找框在工具条上，网格本身（.sd-view）里仍然一个输入控件都没有。
      fields: root.querySelectorAll(".sd-view input, .sd-view textarea, .sd-view select, .sd-view [contenteditable='true']").length,
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
      const rh = document.querySelector(".sd-cell[data-r=\"0\"]")?.offsetHeight ?? 20;
      view.scrollTop = 60 * rh;
      view.dispatchEvent(new Event("scroll"));
    }
  });
  await until(async () => (await cellText(60, 0)) !== null, 5000, "第 61 行");
  const later = await cellText(60, 0);
  check("滚动后显示别的行", later !== null && later !== "华东", String(later));
  await page.screenshot({ path: path.join(OUT, "02-scrolled.png") });

  check("每次窗口请求都带行区间", windowRequests.length > 0 && windowRequests.every((b) => Number.isFinite(b.r0) && Number.isFinite(b.r1)), JSON.stringify(windowRequests.slice(-3)));
  // 小表（151 行）预取 3 屏时可能刚好覆盖全表，这不算错；只要求窗口有上限、字段形状对。
  check("窗口请求不超过 400 行", windowRequests.every((b) => b.r1 - b.r0 + 1 <= 400), JSON.stringify(windowRequests.map((b) => [b.r0, b.r1])));
  check("滚动后请求覆盖第 61 行", windowRequests.some((b) => b.r0 <= 60 && b.r1 >= 60), JSON.stringify(windowRequests.map((b) => [b.r0, b.r1])));
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
    const txt = el.querySelector(".sd-txt");
    return {
      w: Math.round(el.getBoundingClientRect().width),
      clip: !!txt && txt.scrollWidth > el.clientWidth,
      ovf: el.classList.contains("sd-ovf"),
      nowrap: getComputedStyle(el).whiteSpace,
    };
  });
  check("窄列内容被裁不撑破", narrow?.clip === true && narrow?.ovf === false && narrow?.nowrap === "nowrap", JSON.stringify(narrow));

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

  // ---------------------------------------------------------------- 富样式（#427）
  // 样式表里的字体 / 填充 / 边框 / 换行 / 行高 / 隐藏行列，都要真的画出来，不是只有数字格式。
  await page.locator(".sd-close").first().click();
  await until(async () => (await page.locator(".sd").count()) === 0, 5000, "dialog closed");
  await openSheet("styled.xlsx");

  const cellCss = (r, c) =>
    page.evaluate(
      ([rr, cc]) => {
        const el = document.querySelector(`.sd-cell[data-r="${rr}"][data-c="${cc}"]`);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const txt = el.querySelector(".sd-txt");
        const rect = el.getBoundingClientRect();
        const nums = (v) => (String(v).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
        return {
          text: el.textContent ?? "",
          bg: nums(cs.backgroundColor),
          color: nums(cs.color),
          size: parseFloat(cs.fontSize),
          weight: Number(cs.fontWeight) || 400,
          align: cs.justifyContent,
          pad: parseFloat(cs.paddingLeft),
          wrap: cs.whiteSpace,
          bt: cs.borderTopStyle,
          bl: cs.borderLeftStyle,
          bw: parseFloat(cs.borderLeftWidth),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          ovf: el.classList.contains("sd-ovf"),
          overflowPx: txt ? txt.scrollWidth - el.clientWidth : 0,
          hash: el.classList.contains("is-hash"),
        };
      },
      [r, c],
    );
  const sameRgb = (a, b, tol = 2) => a.length >= 3 && b.every((v, i) => Math.abs(a[i] - v) <= tol);

  // 行高：默认 15pt → 20px；文件里 33pt → 44px；34.5pt → 46px；换行的行自己撑高。
  check("默认行高按 15pt 算", (await cellCss(3, 0))?.h === 20, JSON.stringify(await cellCss(3, 0)));
  check("换行行比默认高", ((await cellCss(4, 0))?.h ?? 0) > 20, JSON.stringify(await cellCss(4, 0)));
  check("文件行高生效（33pt）", (await cellCss(0, 0))?.h === 44, JSON.stringify(await cellCss(0, 0)));
  check("文件行高生效（34.5pt）", (await cellCss(2, 6))?.h === 46, JSON.stringify(await cellCss(2, 6)));
  const h9 = await page.locator('.sd-cell[data-r="8"]').count();
  const rno9 = await page.locator('.sd-rowno[data-r="8"]').count();
  check("隐藏行不画格也不画行号", h9 === 0 && rno9 === 0, `${h9}/${rno9}`);
  const rno10 = await page.locator('.sd-rowno[data-r="9"]').count();
  check("隐藏行之后接着编号", rno10 === 1, String(rno10));

  // 字体：标题 18pt 粗体深蓝；表头白字；正文 11pt。
  const titleCss = await cellCss(0, 0);
  check("标题字号取文件值", titleCss?.size === 24 && titleCss?.weight === 700, JSON.stringify({ size: titleCss?.size, weight: titleCss?.weight }));
  check("标题颜色取主题 rgb", !!titleCss && sameRgb(titleCss.color, [31, 56, 100]), JSON.stringify(titleCss?.color));
  const head = await cellCss(1, 0);
  check("表头深蓝填充", !!head && sameRgb(head.bg, [31, 78, 121]), JSON.stringify(head?.bg));
  check("表头白字", !!head && sameRgb(head.color, [255, 255, 255]), JSON.stringify(head?.color));
  const bodySize = (await cellCss(2, 0))?.size ?? 0;
  check("正文 11pt", bodySize > 14.4 && bodySize < 14.9, String(bodySize));

  // 边框：细灰四边 → 相邻格共用一条 1px，不是叠成 2px。
  const bodied = await cellCss(2, 0);
  check("细边框来自样式表", bodied?.bt === "solid" && bodied?.bl === "solid" && bodied?.bw === 1, JSON.stringify({ bt: bodied?.bt, bl: bodied?.bl, bw: bodied?.bw }));
  const headBottom = await page.evaluate(() => {
    const a = document.querySelector('.sd-cell[data-r="2"][data-c="0"]');
    const b = document.querySelector('.sd-cell[data-r="3"][data-c="0"]');
    if (!a || !b) return null;
    return { a: getComputedStyle(a).borderBottomWidth, b: getComputedStyle(b).borderTopWidth, ab: a.getBoundingClientRect().bottom, bt: b.getBoundingClientRect().top };
  });
  check("相邻格只画一条边框", headBottom?.a === "0px" && headBottom?.b !== "0px" && Math.abs(headBottom?.ab - headBottom?.bt) <= 1, JSON.stringify(headBottom));

  // 数字格式 + 对齐：货币右对齐，负数按格式变成红括号，放不下就满格 #。
  const money = await cellCss(2, 2);
  check("货币格式显示", money?.text === "¥1,234.50", JSON.stringify(money?.text));
  check("数字右对齐", /^(flex|flow)-end$/.test(money?.align ?? ""), JSON.stringify(money?.align));
  check("负数按格式显示括号", (await cellText(4, 9)) === "(400.00)", String(await cellText(4, 9)));
  const wide = await cellCss(2, 3);
  check("数字放不下显示 ###", wide?.hash === true && /^#+$/.test(wide?.text ?? ""), JSON.stringify({ text: wide?.text, hash: wide?.hash }));

  // 排版：换行、溢出到右边的空格、右缩进两格。
  check("wrapText 真是换行", (await cellCss(2, 6))?.wrap === "pre-wrap", JSON.stringify((await cellCss(2, 6))?.wrap));
  const spill = await cellCss(11, 1);
  check("长文本溢出到右侧空格", spill?.ovf === true && spill?.overflowPx > 0, JSON.stringify({ ovf: spill?.ovf, over: spill?.overflowPx }));
  const wrapFit = await page.evaluate(() =>
    [...document.querySelectorAll(".sd-cell[data-wrap=\"1\"]")].map((el) => {
      const span = el.querySelector(".sd-txt");
      const cb = el.getBoundingClientRect();
      const sb = span ? span.getBoundingClientRect() : null;
      return { r: el.dataset.r, c: el.dataset.c, cellH: Math.round(cb.height), spanH: sb ? Math.round(sb.height) : 0, bottomGap: sb ? Math.round(cb.bottom - sb.bottom) : null };
    }),
  );
  check("换行内容不被行高截断", wrapFit.length > 0 && wrapFit.every((w) => w.cellH >= w.spanH), JSON.stringify(wrapFit));
  const indented = await cellCss(11, 0);
  check("indent 变成左内边距", (indented?.pad ?? 0) >= 12, JSON.stringify(indented?.pad));

  // 合计行：黄底粗体；第二张表关掉网格线。
  const total = await cellCss(10, 0);
  check("合计行黄底粗体", !!total && sameRgb(total.bg, [255, 242, 204]) && total.weight === 700, JSON.stringify({ bg: total?.bg, weight: total?.weight }));
  await page.screenshot({ path: path.join(OUT, "08-styled.png") });
  await page.locator(".sd-wstab", { hasText: "说明" }).first().click();
  await until(async () => (await cellText(0, 0)) === "无网格线的说明页", 5000, "styled sheet 2");
  await page.waitForTimeout(150);
  const noGrid = await cellCss(1, 0);
  check("showGridLines=0 时不画网格线", noGrid?.bt === "none" && noGrid?.bl === "none", JSON.stringify({ bt: noGrid?.bt, bl: noGrid?.bl }));
  check("说明页文本左对齐", /^(flex|flow)-start$/.test(noGrid?.align ?? ""), JSON.stringify(noGrid?.align));
  const closeDbg = await page.evaluate(() => {
    const c = document.querySelector(".sd-close");
    const b = c?.getBoundingClientRect();
    const hit = b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
    return { has: !!c, box: b ? [b.left, b.top, b.width, b.height] : null, hit: hit ? `${hit.tagName}.${hit.className}` : null };
  });
  log(`关闭键 ${JSON.stringify(closeDbg)}`);
  await page.locator(".sd-close").first().click({ timeout: 5000 }).catch((e) => log(`关闭键点不动 ${e.message.split("\n")[0]}`));
  if (await page.locator(".sd").count()) await page.evaluate(() => document.querySelector(".sd-close")?.click());
  await until(async () => (await page.locator(".sd").count()) === 0, 5000, "dialog closed");

  // ---------------------------------------------------------------- 条件格式（#109）
  // 五类规则都在桥端求值，前端只吃结果：底色、字色、加粗、数据条宽度、图标等级。
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
  // ---------------------------------------------------------------- 公式与缺缓存值（#111）
  // 公式只用文件里存的结果；没存结果的格子显空（不猜 0），公式原文留给公式栏 / 悬停 / 状态条。
  await page.locator(".sd-close").first().click();
  await until(async () => (await page.locator(".sd").count()) === 0, 5000, "dialog closed");
  await openSheet("formula.xlsx");

  const fxBar = () =>
    page.evaluate(() => {
      const bar = document.querySelector(".sd-fx");
      const body = document.querySelector(".sd-fx-body");
      const ref = document.querySelector(".sd-fx-ref");
      if (!bar || !body) return null;
      return {
        text: (body.textContent ?? "").trim(),
        ref: (ref?.textContent ?? "").trim(),
        hidden: bar.hidden || getComputedStyle(bar).display === "none",
        above: Math.round(bar.getBoundingClientRect().bottom) <= Math.round(document.querySelector(".sd-view").getBoundingClientRect().top) + 1,
        h: Math.round(bar.getBoundingClientRect().height),
      };
    });
  const status = () =>
    page.evaluate(() => {
      const el = document.querySelector(".sd-status");
      if (!el) return null;
      return {
        text: (el.textContent ?? "").trim(),
        hidden: el.hidden || getComputedStyle(el).display === "none",
        inFoot: !!el.closest(".sd-foot"),
        title: el.getAttribute("title") ?? "",
      };
    });
  const clickCell = async (r, c) => {
    const b = await cellBox(r, c);
    if (!b) throw new Error(`no cell ${r}:${c}`);
    await page.mouse.click(b.l + b.w / 2, b.t + b.h / 2);
    await page.waitForTimeout(150);
  };
  const red = (s) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s ?? "");
    return !!m && Number(m[1]) > 150 && Number(m[2]) < 90 && Number(m[3]) < 90;
  };

  const fx0 = await fxBar();
  check("公式栏在网格上方", fx0 !== null && !fx0.hidden && fx0.above && fx0.h >= 20, JSON.stringify(fx0));
  check("公式栏默认跟着 A1", fx0?.ref === "A1" && fx0?.text === "项目", JSON.stringify(fx0));
  check("状态条在底栏里", (await status())?.inFoot === true, JSON.stringify(await status()));

  // 有缓存值的公式：格子显文件里的结果，选中后公式栏给原文（带 =）。
  check("公式格显缓存结果", (await cellText(1, 3)) === "37.5", String(await cellText(1, 3)));
  await clickCell(1, 3);
  const fx1 = await fxBar();
  check("选中公式格显示公式原文", fx1?.text === "=B2*C2", JSON.stringify(fx1));
  check("公式栏坐标跟着选中格", fx1?.ref === "D2", JSON.stringify(fx1));

  await clickCell(1, 4);
  check("文本公式原样", (await fxBar())?.text === '=B2&"×"&C2', (await fxBar())?.text);
  check("文本公式格显缓存文本", (await cellText(1, 4)) === "3×12.5", String(await cellText(1, 4)));

  await clickCell(1, 1);
  check("普通格公式栏显示值", (await fxBar())?.text === "3", (await fxBar())?.text);
  check("普通格没有多余前缀", (await fxBar())?.ref === "B2", (await fxBar())?.ref);

  // 缺缓存值：显空（不是 0）、红虚线、悬停给公式与解释。
  const ncInfo = () =>
    page.evaluate(() => {
      const el = document.querySelector('.sd-cell[data-r="2"][data-c="3"]');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        text: el.textContent,
        style: cs.borderTopStyle,
        width: cs.borderTopWidth,
        color: cs.borderTopColor,
        title: el.getAttribute("title") ?? "",
        outline: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor,
        shadow: cs.boxShadow,
      };
    });
  const nc = await ncInfo();
  check("缺缓存值格显空", nc?.text === "" && (await cellText(2, 3)) !== "0", JSON.stringify(nc?.text));
  check("缺缓存值格是红虚线", nc?.outline === "dashed" && parseFloat(nc.outlineWidth) >= 1 && red(nc.outlineColor), JSON.stringify({ outline: nc?.outline, width: nc?.outlineWidth, color: nc?.outlineColor }));
  check("缺缓存值格悬停给公式和解释", /B3\*C3/.test(nc?.title ?? "") && /需用表格软件重算/.test(nc?.title ?? ""), nc?.title);

  await clickCell(2, 3);
  const ncSel = await ncInfo();
  check("选中缺缓存值格显示公式", (await fxBar())?.text === "=B3*C3", (await fxBar())?.text);
  check("选中格有可见边框", /inset/.test(ncSel?.shadow ?? ""), JSON.stringify({ shadow: ncSel?.shadow }));
  const selRing = await page.evaluate(() => {
    const el = document.querySelector('.sd-cell[data-r="2"][data-c="3"]');
    const cs = getComputedStyle(el);
    return { style: cs.boxShadow, width: cs.outlineWidth, color: cs.outlineColor };
  });
  check("选中格边框画出来了", /inset/.test(selRing.style ?? "") && /15, 118, 110/.test(selRing.style ?? ""), JSON.stringify(selRing));
  check("缺缓存值格还是空的", (await cellText(2, 3)) === "", String(await cellText(2, 3)));

  const st1 = await status();
  check("状态条累计无缓存值格数", !st1?.hidden && st1?.text.includes("3 格无缓存值"), JSON.stringify(st1));
  check("状态条解释了要重算", /重算/.test(st1?.title ?? ""), st1?.title);
  await page.screenshot({ path: path.join(OUT, "09-formula.png") });

  // 换到没有公式的表：计数与红虚线都不该跟过去。
  await page.locator(".sd-wstab", { hasText: "说明" }).first().click();
  await until(async () => (await cellText(0, 0)) === "说明", 5000, "formula sheet 2");
  const st2 = await status();
  check("换到没公式的表计数消失", !st2 || st2.hidden || st2.text === "", JSON.stringify(st2));
  check("换表后公式栏回到该表 A1", (await fxBar())?.text === "说明", (await fxBar())?.text);
  await page.locator(".sd-wstab", { hasText: "销量" }).first().click();
  await until(async () => (await cellText(0, 0)) === "项目", 5000, "formula sheet 1");
  await until(async () => !(await status())?.hidden, 5000, "status back");
  check("切回来计数还在", (await status())?.text.includes("3 格无缓存值"), (await status())?.text);
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
  check("底栏有「用默认程序打开」", foot?.buttons.includes("用默认程序打开") === true, JSON.stringify(foot?.buttons));
  check("底栏有「在文件夹中显示」", foot?.buttons.some((b) => b.includes("在文件夹中显示")) === true, JSON.stringify(foot?.buttons));
  check("下载仍是裸地址", /^\/raw\/[^/]+\/plain\.xlsx$/.test(String(foot?.href)), String(foot?.href));
  check("下载是 <a download>，不看桥的脸色", foot?.dl === true && foot?.text === "下载", JSON.stringify(foot));
  const token = String(foot?.href ?? "").split("/")[2] ?? "";

  // 公网来客：桌面上的动作一律不开
  const pubOpen = await api("/api/open", { token }, AS_TUNNEL);
  check("公网点「用默认程序打开」被拒", pubOpen.status === 403, JSON.stringify(pubOpen));
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
      const rh = document.querySelector(".sd-cell[data-r=\"0\"]")?.offsetHeight ?? 20;
      view.scrollTop = 60 * rh;
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
    const hasOpen = await page.locator(".viewer-msg button", { hasText: "用默认程序打开" }).count();
    check(`${name} 给了「用默认程序打开」`, hasOpen === 1, String(hasOpen));
  }
  await page.screenshot({ path: path.join(OUT, "07-downgrade.png") });

  await openFile("fake.xlsx");
  await page.locator(".sd-block").first().waitFor({ timeout: 20000 });
  const fakeText = (await page.locator(".sd-block").first().textContent()) ?? "";
  check("改了扩展名的 zip 也说清不支持", fakeText.includes("这个格式这里不支持"), fakeText.trim().slice(0, 120));
  await page.screenshot({ path: path.join(OUT, "08-not-xlsx.png") });
  await page.locator(".sd-close").first().click();

  // 真把文件交给本机默认程序：默认不跑（会在桌面开窗、锁住文件），SHEET_OPEN=1 时跑一次。
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
  // ---------------------------------------------------------------- 页面视图（#112）
  const previewOf = async (file) => (await api("/api/preview", { sessionId: SID, path: file })).data;
  const chartPreview = await previewOf(made.chart);
  check("带图表的文件仍按网格预览", chartPreview?.kind === "sheet", JSON.stringify(chartPreview));
  const chartMeta = (await api("/api/sheet/meta", { token: chartPreview?.token })).data;
  check("meta 标出文件里有图表", chartMeta?.charts === true, JSON.stringify(chartMeta));
  const plainMeta = (await api("/api/sheet/meta", { token: (await previewOf(made.plain))?.token })).data;
  check("无图表不虚构 charts", plainMeta?.charts === false, JSON.stringify(plainMeta));

  // ---------------------------------------------------------------- #110 大表三档
  // 先把 xlsx 那扇关掉：文件管理器是在 viewer 里，浮窗留着会与下面的断言撞车。
  const closeSheet = async () => {
    const close = page.locator(".sd-close").first();
    if (await close.count()) await close.click();
    await until(async () => (await page.locator(".sd").count()) === 0, 5000, "sd closed");
  };
  await closeSheet();

  /** 点开一张表，量「点文件行 → 第一格出现」；none 档等的是 .sd-block。 */
  const openStress = async (name) => {
    await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().evaluate((el) => el.click());
    const row = page.locator(".file-row", { hasText: name }).first();
    await row.waitFor({ timeout: 20000 });
    const t0 = performance.now();
    await row.evaluate((el) => el.click());
    await page.locator(".sd").first().waitFor({ timeout: 30000 });
    await page.locator(".sd-cell, .sd-block").first().waitFor({ timeout: 30000 });
    const ms = performance.now() - t0;
    await page.waitForTimeout(120);
    return Math.round(ms);
  };

  /** 每一档都从冷桥开始量：上一档的 Book / CF 计划不能算进下一档的峰值。 */
  const restartBridge = async () => {
    try {
      execSync(`taskkill /PID ${bridge.pid} /T /F`, { stdio: "ignore" });
    } catch {}
    bridge.kill();
    await until(() => !listening(PORT), 8000, "bridge down");
    bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
      cwd: REPO,
      env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT },
      stdio: ["ignore", "pipe", "pipe"],
    });
    bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
    bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));
    await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up again");
    // cookie 用持久 secret 签名，重启后仍有效；页面重走一遍登录态即可。
    await openSession();
  };

  let rssSeq = 0;
  /** 边跑边采桥进程 WorkingSet64（PowerShell 在另一个进程里采，不挡首屏计时）。 */
  const withRss = async (fn) => {
    const file = path.join(OUT, `rss-${process.pid}-${rssSeq}.txt`);
    const stop = `${file}.stop`;
    rssSeq++;
    fs.rmSync(file, { force: true });
    fs.rmSync(stop, { force: true });
    const q = (p) => p.replace(/'/g, "''");
    const script = `$p=${bridge.pid};$o='${q(file)}';$s='${q(stop)}';while(-not (Test-Path $s)){$v=(Get-Process -Id $p -ErrorAction SilentlyContinue).WorkingSet64;if($v){Add-Content -Path $o -Value $v};Start-Sleep -Milliseconds 100}`;
    const ps = spawn("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim()) break;
      await sleep(100);
    }
    const result = await fn();
    fs.writeFileSync(stop, "1");
    await Promise.race([new Promise((res) => ps.on("exit", res)), sleep(4000)]);
    try {
      ps.kill();
    } catch {}
    const vals = fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").trim().split(/\s+/).map(Number).filter((n) => n > 0)
      : [];
    fs.rmSync(file, { force: true });
    fs.rmSync(stop, { force: true });
    return { ...result, baseRss: vals[0] ?? 0, peakRss: vals.length ? Math.max(...vals) : 0 };
  };

  const num = (n) => new Intl.NumberFormat("zh-CN").format(n);
  const tierWord = { full: "全量显示", light: "只值轻量（不涂条件格式）", none: "不给全表" };
  const stressNumbers = [];

  // 同一区间请求两次：不串行、不漂移（直接打桥端接口，同一 token / 同一区间）。
  const samePrev = await api("/api/preview", { sessionId: SID, path: stresses[2].file });
  const sameToken = samePrev.data?.token;
  const sameMeta = await api("/api/sheet/meta", { token: sameToken });
  const sameSheet = sameMeta.data?.sheets?.[0]?.name;
  const sameA = await api("/api/sheet/window", { token: sameToken, sheet: sameSheet, r0: 1200, r1: 1400, c0: 0, c1: 99 });
  const sameB = await api("/api/sheet/window", { token: sameToken, sheet: sameSheet, r0: 1200, r1: 1400, c0: 0, c1: 99 });
  check("同一区间两次结果一致", sameA.status === 200 && JSON.stringify(sameA.data) === JSON.stringify(sameB.data), `${sameA.status}/${sameB.status}`);

  for (const s of stresses) {
    await restartBridge();
    const winStart = windowRequests.length;
    const got = await withRss(async () => {
      const first = await openStress(s.name);
      const tierText = (await page.locator(".sd-tier").first().textContent()) ?? "";
      check(`${s.name} 落在 ${s.tier} 档`, tierText.includes(num(s.cells)) && tierText.includes(tierWord[s.tier]), tierText);

      const reqs = windowRequests.slice(winStart);
      const top = reqs[0];
      const vis = await page.evaluate(() => Math.ceil((document.querySelector(".sd-view")?.clientHeight ?? 0) / (document.querySelector(".sd-cell[data-r=\"0\"]")?.offsetHeight ?? 20)));
      let bytesTop = 0;
      let partBytes = 0;
      if (s.tier !== "none") {
        check(`${s.name} 只取窗口不是整表`, reqs.length > 0 && reqs.every((b) => b.r1 - b.r0 + 1 < s.rows), JSON.stringify(reqs.slice(0, 2)));
        // 顶部没有「上方」可预取：可见段 + 下方 3 屏 ≈ 4 屏；滚到中间时才是 7 屏。
        check(`${s.name} 预取 3 屏`, !!top && top.r1 - top.r0 + 1 >= vis * 3 && top.r1 - top.r0 + 1 <= 400, `可见 ${vis} 行，请求 ${top ? top.r1 - top.r0 + 1 : 0} 行`);
        const bg = await page.evaluate(() => {
          const el = document.querySelector('.sd-cell[data-r="5"][data-c="1"]');
          return el ? getComputedStyle(el).backgroundColor : null;
        });
        if (s.tier === "full") {
          check(`${s.name} 涂了条件格式`, !!bg && bg !== "rgb(255, 255, 255)" && bg !== "rgba(0, 0, 0, 0)", String(bg));
        } else {
          check(`${s.name} 不涂条件格式`, bg === "rgb(255, 255, 255)" || bg === "rgba(0, 0, 0, 0)", String(bg));
          check(`${s.name} 没有色条 / 图标`, (await page.locator(".sd-bar, .sd-icon").count()) === 0);
        }
        check(`${s.name} 格子照常可读`, (await cellText(5, 0)) === "6", String(await cellText(5, 0)));

        const prev = await api("/api/preview", { sessionId: SID, path: s.file });
        const token = prev.data?.token;
        const sheet = prev.data?.name && (await api("/api/sheet/meta", { token })).data?.sheets?.[0]?.name;
        const w = await api("/api/sheet/window", { token, sheet, r0: 0, r1: 20, c0: 0, c1: 99 });
        bytesTop = w.data?.bytes ?? 0;
        partBytes = w.data?.partBytes ?? 0;
        check(`${s.name} 顶部只解一小段`, bytesTop > 0 && bytesTop < partBytes / 2, `${bytesTop} / ${partBytes}`);
      } else {
        const block = (await page.locator(".sd-block").first().textContent()) ?? "";
        check("不给档只给清单 + 尺寸", block.includes(`${num(s.rows)} 行 × ${num(s.cols)} 列`), block.replace(/\s+/g, " ").slice(0, 160));
        check("不给档有「用本机程序打开」", (await page.locator(".sd-block button", { hasText: "用本机程序打开" }).count()) === 1);
        check("不给档没有网格", (await page.locator(".sd-cell").count()) === 0);
        check("不给档不取窗口", reqs.length === 0, JSON.stringify(reqs));
      }

      await page.screenshot({ path: path.join(OUT, `09-stress-${s.rows}.png`) });
      return { first, top: top ? { r0: top.r0, r1: top.r1 } : null, bytesTop, partBytes };
    });

    // 快速拖动：直接甩到底，量「有字」的时间；滚回顶部再对一次同一格。
    let deepMs = null;
    if (s.tier !== "none") {
      const before = await cellText(1, 0);
      deepMs = await page.evaluate(async (last) => {
        const view = document.querySelector(".sd-view");
        if (!view) return -1;
        const t0 = performance.now();
        view.scrollTop = view.scrollHeight;
        view.dispatchEvent(new Event("scroll"));
        return await new Promise((res) => {
          const tick = () => {
            const cell = document.querySelector(`.sd-cell[data-r="${last}"][data-c="0"]`);
            if (cell && cell.textContent) return res(performance.now() - t0);
            if (performance.now() - t0 > 5000) return res(-1);
            requestAnimationFrame(tick);
          };
          tick();
        });
      }, s.rows - 1);
      check(`${s.name} 快速拖到底不长时间空白`, deepMs >= 0 && deepMs < 2000, `${Math.round(deepMs)}ms`);
      check(`${s.name} 拖到底就是最后一行`, (await cellText(s.rows - 1, 0)) === String(s.rows), String(await cellText(s.rows - 1, 0)));
      await page.evaluate(() => {
        const view = document.querySelector(".sd-view");
        if (view) {
          view.scrollTop = 0;
          view.dispatchEvent(new Event("scroll"));
        }
      });
      await until(async () => (await cellText(1, 0)) === before, 6000, "scroll back to top");
      check(`${s.name} 滚远再滚回内容一致`, (await cellText(1, 0)) === before, `${before} → ${await cellText(1, 0)}`);
    }

    const rec = {
      tier: s.tier,
      cells: s.cells,
      rows: s.rows,
      cols: s.cols,
      fileBytes: fs.statSync(s.file).size,
      firstScreenMs: got.first,
      baseRss: got.baseRss,
      peakRss: got.peakRss,
      topRange: got.top,
      bytesTop: got.bytesTop,
      partBytes: got.partBytes,
      deepMs: deepMs === null ? null : Math.round(deepMs),
    };
    stressNumbers.push(rec);
    log(`#110 ${s.name}: 首屏 ${rec.firstScreenMs}ms，峰值 RSS ${(rec.peakRss / 1048576).toFixed(0)}MB，顶部解压 ${rec.bytesTop}B / ${rec.partBytes}B，拖到底 ${rec.deepMs}ms`);
    await closeSheet();
  }
  const numbersPath = path.join(OUT, "stress-numbers.json");
  fs.writeFileSync(numbersPath, `${JSON.stringify(stressNumbers, null, 1)}\n`);
  log("stress numbers →", numbersPath);

  // ---------------------------------------------------------------- CSV / TSV（#113）
  // 先把 xlsx 那扇关掉：文件管理器是在 viewer 里，浮窗留着会与下面的断言撞车。
  await closeSheet();
  // 浮窗几何已被上面改过，先清掉记忆回到默认尺寸。
  await page.evaluate(() => localStorage.removeItem("pi.sheetGeom"));
  // ---------------------------------------------------------------- 页面视图（#112）
if (SKIP_PDF) {
  // 没有 LibreOffice：转换必然失败，但「失败只影响页面视图」仍然可验。
  await openSheet("chart.xlsx");
  check("没有 LibreOffice 时网格仍可用", (await cellText(0, 0)) === "地区", String(await cellText(0, 0)));
  await page.locator('.sd-viewtab[data-view="page"]').click();
  await page.locator(".sd-pg-error").waitFor({ timeout: 20000 });
  const reason = await page.locator(".sd-pg-error").innerText();
  check("没有 LibreOffice 时页面视图说原因", reason.includes("LibreOffice"), reason);
  check("失败后给出重试按钮", (await page.locator(".sd-pg-error .sd-act").count()) === 1);
  await closeSheet();
  console.log("SKIP #112：自动转换 / 缓存命中 / PDF 字节 / 两档布局的断言（无 LibreOffice）");
} else {
  const splitState = () =>
    page.evaluate(() => {
      const grid = document.querySelector(".sd-gridpane");
      const paper = document.querySelector(".sd-pg");
      const divider = document.querySelector(".sd-split");
      const tabs = document.querySelector(".sd-viewtabs");
      const gb = grid?.getBoundingClientRect();
      const pb = paper?.getBoundingClientRect();
      const tb = tabs?.getBoundingClientRect();
      return {
        grid: gb ? { w: Math.round(gb.width), l: Math.round(gb.left) } : null,
        paper: pb ? { w: Math.round(pb.width), l: Math.round(pb.left) } : null,
        gridShown: !!gb && grid.offsetParent !== null && getComputedStyle(grid).display !== "none",
        paperShown: !!pb && paper.offsetParent !== null && getComputedStyle(paper).display !== "none",
        divider: !!divider && getComputedStyle(divider).display !== "none",
        tabs: !!tb && getComputedStyle(tabs).display !== "none" && tb.width > 0,
      };
    });
  const splitRatio = async () => {
    const st = await splitState();
    return st.grid && st.paper ? st.grid.w / (st.grid.w + st.paper.w) : 0;
  };

  const getBefore = pdfResponses.filter((r) => r.method === "GET").length;
  await openSheet("chart.xlsx");
  check("图表文件打开先出格子", (await splitState()).gridShown && !(await splitState()).paperShown, JSON.stringify(await splitState()));
  // 后台已把转换跑起来（#112：先出格子，页面视图在后台生成）；点「页面视图」标签切过去，等 iframe 出来。
  await page.locator('.sd-viewtab[data-view="page"]').click();
  await page.locator(".sd-pg-frame").waitFor({ timeout: 90000 });
  check("宽窗两栏都在", (await splitState()).gridShown && (await splitState()).paperShown, JSON.stringify(await splitState()));
  await page.waitForTimeout(2500);
  const frameSrc = await page.locator(".sd-pg-frame").getAttribute("src");
  const framePath = (() => {
    try {
      return new URL(String(frameSrc), page.url()).pathname;
    } catch {
      return "";
    }
  })();
  check("iframe 指向页面视图端点", framePath === "/api/sheet/pdf" && String(frameSrc).includes("token="), String(frameSrc));
  const firstGet = pdfResponses.find((r) => r.method === "GET");
  check("第一次打开触发一次转换", pdfResponses.filter((r) => r.method === "GET").length === getBefore + 1, JSON.stringify(pdfResponses.map((r) => r.method)));
  check("PDF 响应是 application/pdf", firstGet?.type.includes("application/pdf") === true, JSON.stringify(firstGet));
  check("PDF 端点不带 CSP sandbox", firstGet?.csp === null, String(firstGet?.csp));
  const direct = await page.request.get(new URL(String(frameSrc), page.url()).href);
  const bytes = await direct.body();
  check("PDF 端点返回 %PDF 字节", direct.status() === 200 && bytes.subarray(0, 5).toString("latin1") === "%PDF-", `${direct.status()} ${bytes.subarray(0, 5).toString("latin1")}`);
  await page.screenshot({ path: path.join(OUT, "08-page-view.png") });

  // 分界线拖动：左栏变窄，比例记进 localStorage。
  const wide0 = await splitRatio();
  await drag(".sd-split", -160, 0);
  const wide1 = await splitRatio();
  const storedSplit = await page.evaluate(() => Number(localStorage.getItem("pi.sheetSplit")));
  check("拖分界线改变左右比例", wide1 < wide0 - 0.1, `${wide0.toFixed(2)} → ${wide1.toFixed(2)}`);
  check("比例写进 localStorage", Math.abs(storedSplit - wide1) < 0.03, `${storedSplit} vs ${wide1}`);
  check("分界线仍在两栏之间", (await page.evaluate(() => {
    const g = document.querySelector(".sd-gridpane").getBoundingClientRect();
    const p = document.querySelector(".sd-pg").getBoundingClientRect();
    const d = document.querySelector(".sd-split").getBoundingClientRect();
    return d.left >= g.right - 1 && d.right <= p.left + 1;
  })));

  // 同一文件第二次打开：不再发起转换，纸面直接出来。
  await closeSheet();
  const getBeforeReopen = pdfResponses.filter((r) => r.method === "GET").length;
  const tOpen0 = Date.now();
  await openSheet("chart.xlsx");
  await page.locator('.sd-viewtab[data-view="page"]').click();
  await page.locator(".sd-pg-frame").waitFor({ timeout: 15000 });
  const reopenMs = Date.now() - tOpen0;
  check("第二次打开直接出来", reopenMs < 6000, `${reopenMs}ms`);
  check("第二次没有重新转换", pdfResponses.filter((r) => r.method === "GET").length === getBeforeReopen + 1, JSON.stringify(pdfResponses.map((r) => r.method)));
  const reopenedRatio = await splitRatio();
  check("重开后分界比例还在", Math.abs(reopenedRatio - wide1) < 0.03, `${reopenedRatio.toFixed(2)} vs ${wide1.toFixed(2)}`);

  // 缩到 900 以下：两栏退成两个标签页，只有一个面可见。
  await drag(".sd-resize", -400, 0);
  let st = await splitState();
  check("窄窗出现两个标签页", st.tabs, JSON.stringify(st));
  check("窄窗分界线消失", !st.divider);
  check("窄窗只显示一个面", st.gridShown !== st.paperShown, JSON.stringify(st));
  await page.locator('.sd-viewtab[data-view="page"]').click();
  st = await splitState();
  check("切到页面视图标签", !st.gridShown && st.paperShown && (await page.locator(".sd-pg-frame").count()) === 1, JSON.stringify(st));
  await page.screenshot({ path: path.join(OUT, "09-page-view-narrow.png") });
  await page.locator('.sd-viewtab[data-view="grid"]').click();
  st = await splitState();
  check("切回网格标签", st.gridShown && !st.paperShown, JSON.stringify(st));

  await drag(".sd-resize", 400, 0);
  st = await splitState();
  check("拉宽后回到整幅网格", st.gridShown && !st.paperShown && !st.divider && st.grid.w > 1000, JSON.stringify(st));
  await page.locator('.sd-viewtab[data-view="page"]').click();
  st = await splitState();
  check("宽窗切页面视图回到并排", st.gridShown && st.paperShown && st.divider, JSON.stringify(st));
  check("拉宽后比例仍是记住的那份", Math.abs((await splitRatio()) - wide1) < 0.03);
  await page.locator('.sd-viewtab[data-view="grid"]').click();
  st = await splitState();
  check("宽窗切回网格收起纸面", st.gridShown && !st.paperShown, JSON.stringify(st));
  await closeSheet();

  // 没有图表的文件不自动转，手动也能看版式。
  const getBeforeManual = pdfResponses.filter((r) => r.method === "GET").length;
  await openSheet("report.xlsx");
  check("无图表默认整幅网格", (await splitState()).grid.w > 1000 && !(await splitState()).paperShown, JSON.stringify(await splitState()));
  check("无图表文件不自动转", pdfResponses.filter((r) => r.method === "GET").length === getBeforeManual);
  check("宽窗也有页面视图标签", (await splitState()).tabs);
  await page.locator('.sd-viewtab[data-view="page"]').click();
  check("无图表给出「生成页面视图」按钮", (await page.locator(".sd-pg-idle .sd-act").count()) === 1);
  await page.locator(".sd-pg-idle .sd-act").click();
  await page.locator(".sd-pg-frame").waitFor({ timeout: 90000 });
  await page.waitForTimeout(1500);
  check("手动也能看页面视图", (await page.locator(".sd-pg-frame").count()) === 1);
  await page.screenshot({ path: path.join(OUT, "10-page-view-manual.png") });
  await closeSheet();

  // 转换失败只影响页面视图：桥端回 JSON 错误，界面说原因，网格照常能滚。
  await page.route("**/api/sheet/pdf**", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "probe 模拟：LibreOffice 不在", code: "sheet_pdf_failed" }),
    }),
  );
  await openSheet("chart.xlsx");
  // 先出格子，失败只影响页面视图：网格照常能滚。
  check("转换失败时网格仍可用", (await cellText(0, 0)) === "地区", String(await cellText(0, 0)));
  await page.locator('.sd-viewtab[data-view="page"]').click();
  await page.locator(".sd-pg-error").waitFor({ timeout: 20000 });
  const failText = await page.locator(".sd-pg-error").innerText();
  check("转换失败显示原因", failText.includes("LibreOffice 不在"), failText);
  check("转换失败后有重试", (await page.locator(".sd-pg-error .sd-act").count()) === 1);
  await page.unroute("**/api/sheet/pdf**");
  await closeSheet();
}

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

  // ------------------------------------------------ 交互（#107）：选区 / 复制 / 查找 / 缩放 / 引用
  // 前面几段把浮窗几何、scroll 都改过，这里清掉记忆从默认尺寸重开。
  await closeSheet();
  await page.evaluate(() => localStorage.removeItem("pi.sheetGeom"));
  await openSheet("plain.xlsx");

  const selState = () =>
    page.evaluate(() => {
      const cur = document.querySelector(".sd-cell.sel");
      const ids = [...document.querySelectorAll(".sd-cell.in-sel")].map((e) => `${e.dataset.r}:${e.dataset.c}`);
      return {
        r: cur ? Number(cur.dataset.r) : null,
        c: cur ? Number(cur.dataset.c) : null,
        ref: (document.querySelector(".sd-fx-ref")?.textContent ?? "").trim(),
        count: ids.length,
        ids: ids.sort(),
      };
    });

  // 状态条（#107 整合）：只读 / 行列数 / 档位 / 缩放 都在底栏一行里。
  const bar107 = await page.evaluate(() => {
    const t = (s) => (document.querySelector(s)?.textContent ?? "").trim();
    const inFoot = (s) => !!document.querySelector(s)?.closest(".sd-foot");
    return {
      ro: t(".sd-ro"),
      dims: t(".sd-dims"),
      tier: t(".sd-tier"),
      zoom: t(".sd-zoom-pct"),
      foot: [".sd-ro", ".sd-dims", ".sd-tier", ".sd-zoom-pct"].every(inFoot),
    };
  });
  check(
    "状态条有只读 / 行列数 / 档位 / 缩放",
    bar107.ro === "只读" &&
      bar107.dims === "151 行 × 8 列" &&
      /全量显示$/.test(bar107.tier) &&
      bar107.zoom === "100%" &&
      bar107.foot,
    JSON.stringify(bar107),
  );

  // 方向键移动、Shift 扩展成一个矩形。
  await clickCell(0, 0);
  const at0 = await selState();
  check("点一下选中一格", at0.ref === "A1" && at0.count === 1, JSON.stringify(at0));
  const focusable = await page.evaluate(() => {
    const v = document.querySelector(".sd-view");
    return v?.getAttribute("tabindex") === "0" && v.contains(document.activeElement);
  });
  check("网格能接键盘（不用先点输入框）", focusable === true, String(focusable));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const moved = await selState();
  check("方向键移动选中格", moved.ref === "B2" && moved.count === 1, JSON.stringify(moved));
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  const grown = await selState();
  check("Shift 扩展选区", grown.ref === "B2:C3" && grown.count === 4, JSON.stringify(grown));
  check("扩展出来的是矩形", grown.ids.join(",") === "1:1,1:2,2:1,2:2", grown.ids.join(","));

  // 拖选 A2:C4，复制出来是 TSV 纯文本（行列对齐、空值留空）。
  await page.evaluate(() => {
    window.__copied = null;
    document.addEventListener(
      "copy",
      (ev) => {
        window.__copied = ev.clipboardData?.getData("text/plain") ?? null;
      },
      { once: true },
    );
  });
  const a2 = await cellBox(1, 0);
  const c4 = await cellBox(3, 2);
  check("A2 与 C4 都在可视区", !!a2 && !!c4, JSON.stringify({ a2, c4 }));
  await page.mouse.move(a2.l + 8, a2.t + a2.h / 2);
  await page.mouse.down();
  await page.mouse.move(c4.l + c4.w - 8, c4.t + c4.h / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const dragged = await selState();
  check("拖选出一块矩形", dragged.ref === "A2:C4" && dragged.count === 9, JSON.stringify(dragged));
  // 前面「文件被改」那段把 A2 换成了「更换后」，所以期望值从网格里现取，不写死。
  const tsvWant = [];
  for (const r of [1, 2, 3]) {
    const row = [];
    for (const c of [0, 1, 2]) row.push(await cellText(r, c));
    tsvWant.push(row.join("\t"));
  }
  await page.keyboard.press("Control+c");
  await page.waitForTimeout(150);
  const copied = await page.evaluate(() => window.__copied);
  check(
    "复制出的是 TSV 纯文本",
    copied === tsvWant.join("\n") && copied.split("\n").every((l) => l.split("\t").length === 3),
    JSON.stringify({ got: copied, want: tsvWant.join("\n") }),
  );
  await page.screenshot({ path: path.join(OUT, "11-selection.png") });

  // 双击一片连续区（填充过的数据块）。
  await page.locator('.sd-cell[data-r="1"][data-c="0"]').first().dblclick();
  await page.waitForTimeout(150);
  const region = await selState();
  check("双击选一片连续区", region.count > 10 && region.ids.includes("1:0"), JSON.stringify({ count: region.count }));

  // 查找：Ctrl+F 打开、命中高亮、计数与跳转。
  await page.keyboard.press("Control+f");
  const opened = await page.evaluate(() => {
    const box = document.querySelector(".sd-find");
    const inp = document.querySelector(".sd-find-in");
    return box ? { hidden: box.hidden, focused: document.activeElement === inp } : null;
  });
  check("Ctrl+F 打开查找框并聚焦", opened?.hidden === false && opened?.focused === true, JSON.stringify(opened));
  await page.locator(".sd-find-in").first().fill("华东");
  // 命中数取决于 fixture 里填充行的地区列，不写死总数：只要 ≥2 就够验「跳下一处」。
  await until(
    async () => {
      const m = /^1\/(\d+)$/.exec(((await page.locator(".sd-find-count").first().textContent()) ?? "").trim());
      return !!m && Number(m[1]) >= 2;
    },
    8000,
    "find 1/N",
  );
  const found = await page.evaluate(() => {
    const on = document.querySelector(".sd-cell.hit-on");
    return {
      hits: [...document.querySelectorAll(".sd-cell.hit")].map((e) => `${e.dataset.r}:${e.dataset.c}`).sort(),
      on: on ? `${on.dataset.r}:${on.dataset.c}` : null,
      count: (document.querySelector(".sd-find-count")?.textContent ?? "").trim(),
    };
  });
  check("命中格高亮", found.hits.length >= 2, found.hits.join(","));
  // 扫表是按行从上往下，第一处就是「华东 & 华南 <测试>」所在的 F4，第二处是第 9 行的填充区。
  check("计数与当前项", /^1\/\d+$/.test(found.count) && found.on === "3:5", JSON.stringify(found));
  await page.screenshot({ path: path.join(OUT, "12-find.png") });
  await page.keyboard.press("Enter");
  const found2 = await (async () => {
    for (let i = 0; i < 60; i++) {
      const st = await page.evaluate(() => {
        const on = document.querySelector(".sd-cell.hit-on");
        return {
          on: on ? `${on.dataset.r}:${on.dataset.c}` : null,
          count: (document.querySelector(".sd-find-count")?.textContent ?? "").trim(),
        };
      });
      if (/^2\/\d+$/.test(st.count) && st.on === "9:0") return st;
      await page.waitForTimeout(100);
    }
    return { on: null, count: "" };
  })();
  check("Enter 跳到下一处（滚过去并高亮）", /^2\/\d+$/.test(found2.count) && found2.on === "9:0", JSON.stringify(found2));
  await page.locator(".sd-find-in").first().fill("不存在的东西");
  await until(async () => ((await page.locator(".sd-find-count").first().textContent()) ?? "").trim() === "0/0", 8000, "find 0/0");
  check("找不到就没有高亮", (await page.locator(".sd-cell.hit").count()) === 0);
  await page.keyboard.press("Escape");
  check("Esc 收起查找框", await page.evaluate(() => document.querySelector(".sd-find")?.hidden === true));

  // 缩放：格子与列宽一起变，百分比可复原。
  const z0 = await cellBox(1, 0);
  await page.locator('[data-k="zin"]').first().click();
  await page.locator('[data-k="zin"]').first().click();
  await page.waitForTimeout(200);
  // 找完 9 行之后视口被滚下去一截，缩放下先把视口拉回顶部，量的是同一块区域。
  await page.evaluate(() => {
    const v = document.querySelector(".sd-view");
    v.scrollTop = 0;
    v.scrollLeft = 0;
    v.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(250);
  const z1 = await cellBox(1, 0);
  const pct1 = await page.evaluate(() => (document.querySelector(".sd-zoom-pct")?.textContent ?? "").trim());
  check("缩放百分比", pct1 === "120%", pct1);
  check("格子高度跟着缩放", Math.abs(z1.h / z0.h - 1.2) <= 0.05, `${z0.h} → ${z1.h}`);
  check("列宽同步缩放", Math.abs(z1.w / z0.w - 1.2) <= 0.05, `${z0.w} → ${z1.w}`);
  await page.screenshot({ path: path.join(OUT, "13-zoom.png") });
  await page.locator('[data-k="z100"]').first().click();
  await page.waitForTimeout(200);
  const z2 = await cellBox(1, 0);
  check("点百分比复原 100%", z2.h === z0.h && z2.w === z0.w, JSON.stringify({ z0, z2 }));

  // 引用给 pi：路径 + A1:C9 进对话框，但不发。
  const countMsgs = () => {
    const raw = fs.readFileSync(path.join(dir, `${SID}.jsonl`), "utf8").trim();
    return raw ? raw.split("\n").filter((l) => l.includes('"type":"message"')).length : 0;
  };
  const msgsBefore = countMsgs();
  const a2b = await cellBox(1, 0);
  const c4b = await cellBox(3, 2);
  await page.mouse.move(a2b.l + 8, a2b.t + a2b.h / 2);
  await page.mouse.down();
  await page.mouse.move(c4b.l + c4b.w - 8, c4b.t + c4b.h / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  await page.locator(".sd-quote").first().click();
  await page.waitForTimeout(800);
  const compose = await page.evaluate(() => document.querySelector(".composer-input textarea")?.value ?? null);
  check(
    "引用把「路径 + A2:C4」插进对话框",
    typeof compose === "string" && compose.includes("plain.xlsx") && compose.includes("A2:C4"),
    String(compose).slice(0, 160),
  );
  check("引用没有自动发送", countMsgs() === msgsBefore, `${msgsBefore} → ${countMsgs()}`);
  await page.screenshot({ path: path.join(OUT, "14-quote.png") });

  // 拖到最窄：关闭键留在浮窗里，工具条换行而不被顶出去。
  await drag(".sd-resize", -1000, 0);
  const narrowBox = await box();
  check("最窄停在 420", narrowBox.w === 420, JSON.stringify(narrowBox));
  const fit = await page.evaluate(() => {
    const sd = document.querySelector(".sd");
    const sdb = sd.getBoundingClientRect();
    const closeBtn = document.querySelector(".sd-close");
    const cb = closeBtn.getBoundingClientRect();
    const hit = document.elementFromPoint(cb.left + cb.width / 2, cb.top + cb.height / 2);
    const inside = (r) => r.left >= sdb.left - 1 && r.right <= sdb.right + 1 && r.top >= sdb.top - 1 && r.bottom <= sdb.bottom + 1;
    const tools = document.querySelector(".sd-tools");
    const foot = document.querySelector(".sd-foot");
    const acts = [...document.querySelectorAll(".sd-foot .sd-act")];
    return {
      closeInside: inside(cb),
      closeClickable: hit === closeBtn || closeBtn.contains(hit),
      toolsFit: !tools || (tools.scrollWidth <= tools.clientWidth + 1 && inside(tools.getBoundingClientRect())),
      footFit: foot.scrollWidth <= foot.clientWidth + 1 && inside(foot.getBoundingClientRect()),
      actsInside: acts.length > 0 && acts.every((a) => inside(a.getBoundingClientRect())),
      quoteInside: inside(document.querySelector(".sd-quote").getBoundingClientRect()),
      gridW: document.querySelector(".sd-grid").getBoundingClientRect().width,
    };
  });
  check("最窄时关闭键还在浮窗里且点得到", fit.closeInside && fit.closeClickable, JSON.stringify(fit));
  check("最窄时底栏与工具条不溢出", fit.footFit && fit.toolsFit && fit.actsInside, JSON.stringify(fit));
  check("最窄时「引用给 pi」没被顶出去", fit.quoteInside === true, JSON.stringify(fit));
  await page.screenshot({ path: path.join(OUT, "15-narrow.png") });

  check("没有页面异常", pageErrors.length === 0, pageErrors.join(" | "));
  log(`窗口请求 ${windowRequests.length} 次，示例 ${JSON.stringify(windowRequests.slice(0, 3))}`);
} catch (err) {
  failures++;
  console.error("FAIL 异常:", err?.stack ?? err);
  console.error("页面异常:", typeof pageErrors === "undefined" ? "(unknown)" : pageErrors.join(" | ") || "(none)");
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
