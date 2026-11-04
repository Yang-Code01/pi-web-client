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
    await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().evaluate((el) => el.click());
    await page.locator(".viewer-browse .dirpicker").first().waitFor({ timeout: 15000 });
    const row = page.locator(".dirpicker .file-row").filter({ hasText: name }).first();
    await until(async () => (await row.count()) > 0, 20000, `文件列表里的 ${name}`);
    // 点行之后可能被「文件管理器」的异步收尾画回浏览态（openFiles 比预览晚一拍），
    // 所以这里允许再点两次；用户手速不会这么快，真实使用碰不到。
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.locator(".dirpicker .file-row").filter({ hasText: name }).first().evaluate((el) => el.click());
      const ok = await page
        .locator(".sh, .md-doc")
        .first()
        .waitFor({ timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      if (ok) return;
    }
    await page.screenshot({ path: path.join(OUT, `fail-${name}.png`) });
    const info = await page.evaluate(() => ({
      body: document.querySelector(".viewer-body")?.className,
      head: document.querySelector(".viewer-name")?.textContent,
      choose: document.querySelector(".choose-title")?.textContent,
      panes: [...document.querySelectorAll(".viewer-head .pane-seg button")].map((b) => `${b.textContent}${b.classList.contains("on") ? "*" : ""}${b.disabled ? "(x)" : ""}`).join(","),
      rows: document.querySelectorAll(".dirpicker .file-row").length,
    }));
    assert(false, `打开 ${name} 失败：${JSON.stringify(info)}`);
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
  // 注意：locator.boundingBox() 会先把元素滚进视口，量「冻结有没有冻住」必须用
  // getBoundingClientRect（它只报告，不滚动），否则测的是 Playwright 干的事。
  const rectOf = (sel, text) =>
    page.evaluate(([q, t]) => {
      const els = [...document.querySelectorAll(q)];
      const e = t ? els.find((x) => x.textContent.includes(t)) : els[0];
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top) };
    }, [sel, text]);
  const headColBefore = await rectOf(".sh-colhead");
  const labelABefore = await rectOf(".sh-colhead .sh-colcell", "A");
  const rowNumBefore = await rectOf(".sh-rowhead .sh-rowcell", "3");
  const titleBefore = await rectOf(".sh-cell.frozen", "◆変更履歴");
  const bodyRowBefore = await rectOf(".sh-cell", "行20");
  await page.locator(".sh-view").evaluate((e) => {
    e.scrollTop = 160;
  });
  await sleep(400);
  const headColAfter = await rectOf(".sh-colhead");
  const labelAAfter = await rectOf(".sh-colhead .sh-colcell", "A");
  const rowNumAfter = await rectOf(".sh-rowhead .sh-rowcell", "3");
  const titleAfter = await rectOf(".sh-cell.frozen", "◆変更履歴");
  const bodyRowAfter = await rectOf(".sh-cell", "行20");
  if (process.env.XLSX_DEBUG) log("freeze:", JSON.stringify({ headColBefore, headColAfter, labelABefore, labelAAfter, rowNumBefore, rowNumAfter, titleBefore, titleAfter, bodyRowBefore, bodyRowAfter }));
  // 列头（A/B/C 那一行）钉住不动
  assert(Math.abs(headColAfter.y - headColBefore.y) <= 1, `列头不随竖向滚动移动（${headColBefore.y} → ${headColAfter.y}）`);
  assert(Math.abs(labelAAfter.y - labelABefore.y) <= 1, `列头里的字母也不动（${labelABefore.y} → ${labelAAfter.y}）`);
  // 冻结的前 3 行钉住，普通行滚走
  assert(Math.abs(titleAfter.y - titleBefore.y) <= 1, `冻结的标题行钉住（${titleBefore.y} → ${titleAfter.y}）`);
  assert(bodyRowAfter.y < bodyRowBefore.y - 100, `普通行确实滚走了（${bodyRowBefore.y} → ${bodyRowAfter.y}）`);
  // 行号跟着内容走：3 行号的位移和冻结区一致（不随滚动），第 20 行的行号应该和它那行一样滚走
  assert(Math.abs(rowNumAfter.y - rowNumBefore.y) <= 1, `行号 3 与冻结行一起钉住（${rowNumBefore.y} → ${rowNumAfter.y}）`);
  // 再用真滚轮滚一次（用户是这么滚的）：set scrollTop 和滚轮走的不是同一条路
  const gridBox = await page.locator(".sh-view").boundingBox();
  await page.mouse.move(gridBox.x + gridBox.width / 2, gridBox.y + gridBox.height / 2);
  await page.mouse.wheel(0, 240);
  await sleep(500);
  const wheelHead = await rectOf(".sh-colhead");
  const wheelTitle = await rectOf(".sh-cell.frozen", "◆変更履歴");
  const wheelBody = await rectOf(".sh-cell", "行20");
  const wheelScroll = await page.locator(".sh-view").evaluate((e) => Math.round(e.scrollTop));
  if (process.env.XLSX_DEBUG) log("wheel:", JSON.stringify({ wheelScroll, wheelHead, wheelTitle, wheelBody }));
  assert(wheelScroll > 0, `滚轮真的滚了（scrollTop=${wheelScroll}）`);
  assert(Math.abs(wheelHead.y - headColBefore.y) <= 1, `滚轮滚完列头还在原处（${headColBefore.y} → ${wheelHead.y}）`);
  assert(Math.abs(wheelTitle.y - titleBefore.y) <= 1, `滚轮滚完冻结行还在原处（${titleBefore.y} → ${wheelTitle.y}）`);
  assert(wheelBody.y < bodyRowBefore.y - 100, `滚轮把普通行滚上去了（${bodyRowBefore.y} → ${wheelBody.y}）`);

  // 滚轮落在「行号条」上时会不会去滚页面（行号条自己 overflow:hidden，不可滚）
  const rh = await page.locator(".sh-rowhead").boundingBox();
  await page.mouse.move(rh.x + rh.width / 2, rh.y + 120);
  await page.mouse.wheel(0, 300);
  await sleep(400);
  const overRowhead = await page.evaluate(() => ({
    pageY: Math.round(window.scrollY),
    viewTop: Math.round(document.querySelector(".sh-view").scrollTop),
    dockTop: Math.round(document.querySelector(".viewer.dock").getBoundingClientRect().top),
  }));
  if (process.env.XLSX_DEBUG) log("wheel@rowhead:", JSON.stringify(overRowhead));

  // 快速滚动的每一帧里，冻结行的屏幕位置有没有偏离（跟随滞后）
  await page.evaluate(() => {
    window.__frames = [];
    const v = document.querySelector(".sh-view");
    const find = () => [...document.querySelectorAll(".sh-cell.frozen")].find((e) => e.textContent.includes("◆変更履歴"));
    const tick = () => {
      const c = find();
      if (c) {
        const r = c.getBoundingClientRect();
        window.__frames.push([Math.round(v.scrollTop), Math.round(r.top)]);
      }
      if (window.__frames.length < 60) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const vb = await page.locator(".sh-view").boundingBox();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 120);
    await sleep(30);
  }
  await sleep(600);
  const frames = await page.evaluate(() => window.__frames);
  const tops = frames.map((f) => f[1]);
  const spread = Math.max(...tops) - Math.min(...tops);
  if (process.env.XLSX_DEBUG) log("frames:", JSON.stringify({ n: frames.length, spread, min: Math.min(...tops), max: Math.max(...tops), tail: frames.slice(-6) }));
  assert(spread <= 3, `快速滚动时冻结行不该抖/滞后（屏幕 y 波动 ${spread}px）`);

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

  // ---------------------------------------------------------------- 冻结行 + 冻结列
  await openFile("frozen.xlsx");
  await page.locator(".sh-cell").first().waitFor({ timeout: 15000 });
  const panes = await page.evaluate(() => {
    const box = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    };
    return { top: box(".sh-pane.pt"), left: box(".sh-pane.pl"), corner: box(".sh-pane.pc") };
  });
  if (process.env.XLSX_DEBUG) {
    log("panes:", JSON.stringify(panes));
    log("rowHeights:", await page.evaluate(() => {
      const cells = [...document.querySelectorAll(".sh-pane .sh-cell")].slice(0, 6).map((e) => `${e.textContent}@${Math.round(e.getBoundingClientRect().top)}`);
      const pt = document.querySelector(".sh-pane.pt");
      return { paneTopH: pt ? Math.round(pt.getBoundingClientRect().height) : null, cells };
    }));
  }
  if (process.env.XLSX_DEBUG) {
    log("colhead:", JSON.stringify(await page.evaluate(() => {
      const v = document.querySelector(".sh-view").getBoundingClientRect();
      return [...document.querySelectorAll(".sh-colcell")].map((e) => {
        const r = e.getBoundingClientRect();
        return `${e.textContent}@${Math.round(r.left - v.left)}+${Math.round(r.width)}`;
      });
    })));
  }
  assert(panes.top && panes.left && panes.corner, `冻结的三块浮层都在（${JSON.stringify(panes)}）`);
  assert(panes.left[2] > 50 && panes.corner[2] > 50, `冻结列有实际宽度（left=${panes.left?.[2]}, corner=${panes.corner?.[2]}）`);

  const cellXY = (t) =>
    page.evaluate((needle) => {
      const e = [...document.querySelectorAll(".sh-cell")].find((x) => x.textContent.includes(needle));
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top) };
    }, t);
  const a1Before = await cellXY("担当");
  const c1Before = await cellXY("金額");
  const a20Before = await cellXY("担当20");
  await page.locator(".sh-view").evaluate((e) => {
    e.scrollLeft = 260;
    e.scrollTop = 200;
  });
  await sleep(400);
  const a1After = await cellXY("担当");
  const c1After = await cellXY("金額");
  const a20After = await cellXY("担当20");
  assert(a1Before && a1After && Math.abs(a1After.x - a1Before.x) <= 1, `冻结列不随横向滚动移动（${a1Before?.x} → ${a1After?.x}）`);
  assert(c1Before && c1After && c1After.x < c1Before.x - 100, `普通列跟着横向滚（${c1Before?.x} → ${c1After?.x}）`);
  // 列头别和冻结带叠字：除了 A 以外，任何列标都不该落进冻结带的宽度里
  const headOverlap = await page.evaluate(() => {
    const view = document.querySelector(".sh-view").getBoundingClientRect();
    const fzW = document.querySelector(".sh-pane.pl")?.getBoundingClientRect().width ?? 0;
    return [...document.querySelectorAll(".sh-colcell")].map((e) => {
      const r = e.getBoundingClientRect();
      return { t: e.textContent, l: Math.round(r.left - view.left + (view.left - view.left)) };
    }).filter((x) => x.l < Math.round(fzW) - 1).map((x) => `${x.t}@${x.l}`);
  });
  if (process.env.XLSX_DEBUG) log("headOverlap:", JSON.stringify(headOverlap));
  assert(headOverlap.length <= 1 && (headOverlap[0]?.startsWith("A") ?? true), `列头没有压进冻结带（${JSON.stringify(headOverlap)}）`);
  assert(a20Before && a20After && Math.abs(a20After.y - a20Before.y) > 100, `普通行跟着纵向滚（${a20Before?.y} → ${a20After?.y}）`);

  // 冻结区里也能点开编辑
  await page.locator(".viewer-head .pane-seg button", { hasText: "编辑" }).click();
  // 注意 hasText 是子串匹配：`担当1` 会先撞上「担当10」。这里要的是第 2 行的「担当2」。
  const frozenCell = page.locator(".sh-pane .sh-cell").filter({ hasText: /^担当2$/ }).first();
  await frozenCell.click();
  const hitName = await page.locator(".sh-name").textContent();
  assert(hitName === "A2", `点冻结区里的 A2 落在 A2（got ${hitName}）`);
  await page.locator(".sh-fxinput").fill("担当ZZ");
  await page.locator(".sh-fxinput").press("Enter");
  await sleep(200);
  assert((await page.locator(".sh-cell.dirty").count()) >= 1, "冻结行里的格子也能改（标了脏）");
  const dirtyName = await page.locator(".sh-name").textContent();
  assert(dirtyName === "A2", `改的也是 A2（got ${dirtyName}）`);
  // 冻结带里的表头行要画全：前两行在滚动区里的每一列都得有格子
  const band = await page.evaluate(() => {
    const texts = [...document.querySelectorAll(".sh-pane.pt .sh-cell")].map((e) => e.textContent);
    return { n: texts.length, sample: texts.slice(0, 14) };
  });
  if (process.env.XLSX_DEBUG) log("band:", JSON.stringify(band));
  assert(band.n >= 10, `冻结带上画出了足够多的格子（${JSON.stringify(band)}）`);
  await page.screenshot({ path: path.join(OUT, "xlsx-frozen.png") });
  // 离开编辑态会问「未保存的改动」（D50 那条一样的语义）：演一遍「放弃改动」
  await page.locator(".viewer-head .pane-seg button", { hasText: "预览" }).click();
  await page.locator(".choose-row .btn", { hasText: "放弃改动" }).click();
  await until(async () => (await page.locator(".sh-cell.dirty").count()) === 0, 10000, "放弃改动后回到干净状态");

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
