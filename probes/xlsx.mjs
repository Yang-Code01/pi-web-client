/**
 * Probe: 表格预览（D116）在真浏览器里跑一遍 —— 样式/合并/冻结/sheet 标签/图表占位、改一格存盘
 * （图表不能丢）、GBK 分号 csv 写回原样、32 万格降级成只读轻量。
 *
 * 起一个自己的桥（独立端口 + 临时 agent 目录 + 临时工作目录），不碰真实会话。
 *
 * Run: node probes/xlsx.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
/** Windows 下动态 import 绝对路径要 file:// URL。 */
const modp = (p) => pathToFileURL(p).href;
// 从 bridge 的 node_modules 里解析（probe 自己不装依赖）。
const bridgeRequire = createRequire(modp(path.join(REPO, "bridge/package.json")));
const ExcelJS = bridgeRequire("exceljs");
const iconv = bridgeRequire("iconv-lite");

const PORT = Number(process.env.PI_WEB_PORT ?? 7884);
const ROOT = path.join(REPO, ".scratch/xlsx");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "zz-xlsx";

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
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "表格验证" }] } },
  { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name: "表格预览" },
];
fs.writeFileSync(path.join(dir, `${SID}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// fixture 现场合成到工作目录里（不把二进制进 git）。
process.env.XLSX_FIXTURES = WORK;
const { makeFixtures } = await import(modp(path.join(REPO, "bridge/tests/fixtures/make-xlsx.mjs").replace(/\\/g, "/")));
const files = await makeFixtures();
log("fixtures:", Object.keys(files).join(", "));

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
      } catch {}
    }
    if (pids.size) console.log(`cleared stale bridge on :${port}`);
  } catch {}
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
    await sleep(200);
  }
  console.error(bridgeOut.join("").slice(-3000));
  assert(false, `timeout waiting for ${label}`);
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
  page.on("pageerror", (e) => log("page error:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") log("console:", m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400) log("http", r.status(), r.url().replace(BASE, ""));
  });
  await page.goto(BASE, { waitUntil: "networkidle" });

  await until(async () => (await page.locator(".session-card").count()) >= 1, 10000, "one card");
  await page.locator(".session-card").first().click();
  await page.locator(".topbar .icon-btn", { hasText: "文件" }).waitFor({ timeout: 10000 });

  // 顶栏「📁 文件管理器」在 viewer 里开浏览态，起点就是会话 cwd（= WORK）。
  const openFile = async (name) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().evaluate((el) => el.click());
      await page.locator(".viewer-browse .dirpicker").first().waitFor({ timeout: 15000 });
      const row = page.locator(`.dirpicker .file-row:has-text("${name}")`).first();
      if (await row.count()) {
        await row.evaluate((el) => el.click());
        await page.locator(".sh, .md-doc, .viewer-msg").first().waitFor({ timeout: 20000 });
        return;
      }
      await sleep(500);
    }
    const seen = await page.$$eval(".dirpicker .file-row", (els) => els.map((e) => e.textContent).slice(0, 20));
    assert(false, `文件列表里没有 ${name}（看到：${seen.join(" / ")}）`);
  };

  // ---------------------------------------------------------------- xlsx
  await openFile("plain.xlsx");
  await page.locator(".sh-cell").first().waitFor({ timeout: 15000 });

  // D117: 表格开在浮窗里，不是 760px 的侧栏
  await page.locator(".viewer.dock").waitFor({ timeout: 10000 });
  const vw = await page.evaluate(() => window.innerWidth);
  const dockBox = await page.locator(".viewer.dock").boundingBox();
  assert(dockBox.width > vw * 0.7, `浮窗宽度接近 80% 屏（got ${dockBox.width} / ${vw}）`);
  assert(dockBox.height > 500, `浮窗高度按 80% 屏算（got ${dockBox.height}）`);
  if (process.env.XLSX_DEBUG) {
    log("layout:", await page.evaluate(() => {
      const q = (sel) => [...document.querySelectorAll(sel)].map((e) => `${e.className}:${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
      const v = document.querySelector(".viewer");
      const b = document.querySelector(".viewer-body");
      const cs = (e) => { const c = getComputedStyle(e); return `${c.display}/${c.width}/cols=${c.gridTemplateColumns}/flex=${c.flex}/justify=${c.justifyItems}`; };
      return JSON.stringify({ viewers: q(".viewer"), bodies: q(".viewer-body"), shs: q(".sh"), views: q(".sh-view"), heads: q(".viewer-head"), vcs: cs(v), bcs: cs(b), shcs: cs(document.querySelector(".sh")) });
    }));
  }
  const gridW = await page.locator(".sh-view").evaluate((e) => e.clientWidth);
  assert(gridW > 800, `网格可用宽度远大于侧栏时代（got ${gridW}px）`);

  const cols = await page.$$eval(".sh-colcell", (els) => els.map((e) => e.textContent).slice(0, 8));
  assert(cols[0] === "A" && cols[1] === "B", `列头是 A/B/C（got ${cols.join(",")}）`);
  const rowNums = await page.$$eval(".sh-rowcell", (els) => els.map((e) => e.textContent).slice(0, 4));
  assert(rowNums[0] === "1" && rowNums[1] === "2", `行头从 1 开始（got ${rowNums.join(",")}）`);

  const title = page.locator(".sh-cell", { hasText: "◆変更履歴" }).first();
  assert(await title.count(), "合并的标题显示出来了");
  const titleBox = await title.boundingBox();
  assert(titleBox && titleBox.width > 300, `合并单元格跨了好几列（width=${titleBox?.width}）`);
  assert((await title.evaluate((e) => getComputedStyle(e).fontWeight)) >= "600", "标题是加粗的");

  const headerCell = page.locator(".sh-cell", { hasText: "変更内容" }).first();
  const headerBg = await headerCell.evaluate((e) => getComputedStyle(e).backgroundColor);
  assert(headerBg === "rgb(68, 84, 106)", `表头底色来自文件（got ${headerBg}）`);
  const headerColor = await headerCell.evaluate((e) => getComputedStyle(e).color);
  assert(headerColor === "rgb(255, 255, 255)", `表头是白字（got ${headerColor}）`);
  const headerBorder = await headerCell.evaluate((e) => getComputedStyle(e).borderTopWidth + " " + getComputedStyle(e).borderTopStyle);
  assert(headerBorder === "1px solid", `表头有边框（got ${headerBorder}）`);

  const dateCell = page.locator(".sh-cell", { hasText: "2026/8/27" }).first();
  assert(await dateCell.count(), "日期按 yyyy/m/d 显示（不是 Date.toString）");

  // 面板宽度有限，F 列在屏幕外：横着滚过去再验格式和条件格式。
  await page.locator(".sh-view").evaluate((e) => {
    e.scrollLeft = 620;
  });
  await sleep(400);
  if (process.env.XLSX_DEBUG) {
    const texts = await page.$$eval(".sh-cell", (els) => els.map((e) => `${e.style.left},${e.style.top}=${e.textContent}`));
    log("cells total:", texts.length, "| 含2的:", texts.filter((t) => /2/.test(t)).slice(0, 20).join(" | "));
    log("scrollLeft:", await page.locator(".sh-view").evaluate((e) => e.scrollLeft));
    log("view width:", await page.locator(".sh-view").evaluate((e) => `${e.clientWidth}x${e.clientHeight} scroll=${e.scrollWidth}`));
  }
  const numCell = page.locator(".sh-cell", { hasText: /2\.0$/ }).first();
  assert(await numCell.count(), "0.0 格式的 2 显示成 2.0");

  const tabs = await page.$$eval(".sh-tab", (els) => els.map((e) => e.textContent));
  assert(tabs.join(",") === "変更履歴,目次", `底部 sheet 标签只有可见的两张（got ${tabs.join(",")}）`);

  // 条件格式：色阶把 F 列涂了色
  const scaleCell = page.locator(".sh-cell", { hasText: /2\.0$/ }).first();
  const scaleBg = await scaleCell.evaluate((e) => getComputedStyle(e).backgroundColor);
  assert(scaleBg !== "rgb(255, 255, 255)", `色阶给 F4 上了底色（got ${scaleBg}）`);

  // 冻结：横向先回到 A 列，再只滚表体 —— 标题应该还在原位
  await page.locator(".sh-view").evaluate((e) => {
    e.scrollLeft = 0;
  });
  await sleep(300);
  const beforeTop = (await title.boundingBox()).y;
  const headerBefore = (await page.locator(".sh-cell", { hasText: "行20" }).boundingBox())?.y ?? 0;
  await page.locator(".sh-view").evaluate((e) => {
    e.scrollTop = 160;
  });
  await sleep(400);
  if (process.env.XLSX_DEBUG) {
    const probe = await page.evaluate(() => {
      const v = document.querySelector(".sh-view");
      const cells = [...document.querySelectorAll(".sh-cell.frozen")];
      const before = cells[0]?.style.top;
      v.scrollTop = 90;
      v.dispatchEvent(new Event("scroll"));
      return { hasOnscroll: typeof v.onscroll, views: document.querySelectorAll(".sh-view").length, cells: cells.length, before, scrollTop: v.scrollTop };
    });
    log("probe:", JSON.stringify(probe));
    await sleep(300);
    log("after dispatch:", await page.locator(".sh-cell", { hasText: "◆変更履歴" }).first().evaluate((e) => `top=${e.style.top}`));
    log("after scroll:", await page.locator(".sh-cell", { hasText: "◆変更履歴" }).first().evaluate((e) => `top=${e.style.top} class=${e.className} viewScroll=${e.closest(".sh-view").scrollTop} tag=${e.textContent}`));
  }
  const afterTop = (await title.boundingBox()).y;
  const headerAfter = (await page.locator(".sh-cell", { hasText: "行20" }).boundingBox())?.y ?? 0;
  assert(Math.abs(afterTop - beforeTop) < 2, `冻结的前 3 行不随滚动移动（${beforeTop} → ${afterTop}）`);
  assert(Math.abs(headerAfter - headerBefore) > 100, `普通行确实滚走了（${headerBefore} → ${headerAfter}）`);
  await page.locator(".sh-view").evaluate((e) => {
    e.scrollTop = 0;
  });
  await sleep(200);

  // 浮窗可自己拉大小：拖右下角 −260/−140（缩小方向，不会撞到屏幕边被 clamp）
  const before = await page.locator(".viewer.dock").boundingBox();
  const gridBefore = await page.locator(".sh-view").evaluate((e) => e.clientWidth);
  const grip = await page.locator(".viewer-resize").boundingBox();
  await page.mouse.move(grip.x + 8, grip.y + 8);
  await page.mouse.down();
  await page.mouse.move(grip.x + 8 - 260, grip.y + 8 - 140, { steps: 10 });
  await page.mouse.up();
  await sleep(400);
  const after = await page.locator(".viewer.dock").boundingBox();
  const gridAfter = await page.locator(".sh-view").evaluate((e) => e.clientWidth);
  assert(after.width < before.width - 200 && after.height < before.height - 100, `拖右下角能改大小（${before.width}×${before.height} → ${after.width}×${after.height}）`);
  assert(gridAfter < gridBefore, `网格跟着窗口一起缩（${gridBefore} → ${gridAfter}）`);
  const geom = await page.evaluate(() => localStorage.getItem("pi.sheetGeom"));
  assert(/\{"l":/.test(geom) && /"w":/.test(geom), `几何存进 pi.sheetGeom（got ${geom}）`);
  await page.locator(".sh-view").evaluate((e) => {
    e.scrollLeft = 0;
  });
  await page.locator(".viewer-title").dblclick();
  await sleep(400);
  const reset = await page.locator(".viewer.dock").boundingBox();
  assert(Math.abs(reset.width - 1152) < 30, `双击标题栏复原到 80% 屏（got ${reset.width}）`);

  // 引用给 pi：选区写成「文件 的 sheet!A1:C5」插进输入框（让 agent 改表的那条路）
  await page.locator(".sh-quote").click();
  const composer = await page.locator(".composer-input textarea").inputValue();
  assert(/plain\.xlsx/.test(composer) && /変更履歴!A1/.test(composer), `引用给 pi 插进了输入框（got ${composer}）`);
  await page.locator(".composer-input textarea").fill("");
  await page.screenshot({ path: path.join(OUT, "xlsx-preview.png") });

  // md 不走浮窗（侧栏读得动），顺便验「两种宿主各自归位」
  // 用数组 join 拼 markdown，避免在字符串里塞真换行
  fs.writeFileSync(path.join(WORK, "notes.md"), ["# 标题", "", "正文一行。", ""].join(String.fromCharCode(10)), "utf8");
  await openFile("notes.md");
  await page.locator(".md-doc").first().waitFor({ timeout: 15000 });
  assert((await page.locator(".viewer.dock").count()) === 0, "md 还是开在侧栏里，没被表格的浮窗带走");

  // ---------------------------------------------------------------- 图表占位
  await openFile("chart.xlsx");
  await page.locator(".sh-chart").first().waitFor({ timeout: 15000 });
  assert((await page.locator(".viewer.dock").count()) === 1, "图表页同样是浮窗");
  const chartLabel = await page.locator(".sh-chart-t").first().textContent();
  assert(/柱形图/.test(chartLabel), `图表占位写的是柱形图（got ${chartLabel}）`);
  await page.screenshot({ path: path.join(OUT, "xlsx-chart.png") });

  // ---------------------------------------------------------------- 改一格并覆盖原件
  await openFile("plain.xlsx");
  await page.locator(".sh-cell").first().waitFor({ timeout: 15000 });
  await page.locator(".viewer-head .pane-seg button", { hasText: "编辑" }).click();
  await page.locator(".sh.readonly").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  await page.locator(".sh-view").evaluate((e) => {
    e.scrollLeft = 620;
  });
  await sleep(400);
  const target = page.locator(".sh-cell", { hasText: /2\.0$/ }).first();
  await target.click();
  await page.locator(".sh-fxinput").fill("=SUM(F5:F7)");
  await page.locator(".sh-fxinput").press("Enter");
  await sleep(200);
  const dirtyMark = await page.locator(".sh-cell.dirty").count();
  assert(dirtyMark >= 1, "改过的格子标了脏（右上角三角）");

  await page.locator(".viewer-head .viewer-btn", { hasText: "💾" }).click();
  await page.locator(".choose-row .btn", { hasText: "覆盖原件" }).click();
  await until(async () => (await page.locator(".sh-cell.dirty").count()) === 0, 15000, "save to finish");
  await page.screenshot({ path: path.join(OUT, "xlsx-edited.png") });

  // 保存后的重载：没缓存值的公式显示公式本身，而不是空白
  await page.locator(".sh-fxinput").waitFor({ timeout: 10000 });
  await page.locator('.sh-cell:has-text("=SUM(F5:F7)")').first().waitFor({ timeout: 10000 });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(WORK, "plain.xlsx"));
  const ws = wb.getWorksheet("変更履歴");
  assert(FString(ws.getCell("F4").value) === "SUM(F5:F7)", `公式写进去了（got ${FString(ws.getCell("F4").value)}）`);
  assert(ws.getCell("A3").fill?.fgColor?.argb === "FF44546A", "写回之后表头样式还在");
  assert(ws.getCell("A1").isMerged === true, "写回之后合并单元格还在");

  const chartWb = new ExcelJS.Workbook();
  await chartWb.xlsx.readFile(path.join(WORK, "chart.xlsx"));

  // ---------------------------------------------------------------- csv（GBK + 分号）
  await openFile("data.csv");
  await page.locator(".sh-cell", { hasText: "日付" }).first().waitFor({ timeout: 15000 });
  assert((await page.locator(".sh-tab").first().textContent()) === "data", "csv 的 sheet 名取自文件名");
  await page.locator(".viewer-head .pane-seg button", { hasText: "编辑" }).click();
  const csvCell = page.locator(".sh-cell", { hasText: "媒体項目マッピング" }).first();
  await csvCell.click();
  await page.locator(".sh-fxinput").fill("媒体項目マッピング改");
  await page.locator(".sh-fxinput").press("Enter");
  await page.locator(".viewer-head .viewer-btn", { hasText: "💾" }).click();
  await page.locator(".choose-row .btn", { hasText: "覆盖原件" }).click();
  await until(async () => (await page.locator(".sh-cell.dirty").count()) === 0, 15000, "csv save");
  await page.screenshot({ path: path.join(OUT, "xlsx-csv.png") });
  const csvBytes = fs.readFileSync(path.join(WORK, "data.csv"));
  assert(!(csvBytes[0] === 0xef && csvBytes[1] === 0xbb), "没有偷偷加 BOM");
  const csvText = iconv.decode(csvBytes, "gbk");
  assert(csvText.startsWith("日付;担当;内容;金額;備考"), "还是分号表头");
  assert(csvText.includes("媒体項目マッピング改"), "改的那格写回 GBK 文件了");

  // ---------------------------------------------------------------- 32 万格 → 只读轻量
  await openFile("big.xlsx");
  await page.locator(".sh-cell", { hasText: "列1" }).first().waitFor({ timeout: 30000 });
  const status = await page.locator(".sh-status").first().textContent();
  assert(/20000/.test(status), `大表报出了行数（got ${status}）`);
  await page.screenshot({ path: path.join(OUT, "xlsx-big.png") });

  log("all good; shots in .scratch/xlsx/shots");
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
}

function FString(v) {
  if (v && typeof v === "object" && "formula" in v) return v.formula;
  return String(v);
}
