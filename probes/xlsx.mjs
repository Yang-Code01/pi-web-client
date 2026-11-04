/**
 * Probe: 表格预览（D116 / D117 / D118 / D119）在真浏览器里跑一遍。
 *
 * 只读之后（D119）这里验的是：浮窗、样式/合并/日期/条件格式、冻结（含快速滚动的逐帧位移）、
 * 列头不压冻结带、点选区、「引用给 pi」、**pi 改了文件 3 秒内自动刷新**、md 仍走侧栏、
 * csv 也能当表看、32 万格降级。
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
const modp = (p) => pathToFileURL(p).href;
// 从 bridge 的 node_modules 里解析（probe 自己不装依赖）。
const bridgeRequire = createRequire(modp(path.join(REPO, "bridge/package.json")));
const ExcelJS = bridgeRequire("exceljs");

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
const { makeFixtures } = await import(modp(path.join(REPO, "bridge/tests/fixtures/make-xlsx.mjs")));
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
    if (m.text().startsWith("stopWatch")) log("ui:", m.text().slice(0, 260));
  });
  page.on("response", (r) => {
    if (r.url().endsWith("/api/sheet/open") && r.status() >= 400) log("sheet/open", r.status());
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 10000, "one card");
  await page.locator(".session-card").first().click();
  await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).waitFor({ timeout: 10000 });

  // 顶栏「📁 文件管理器」在 viewer 里开浏览态，起点就是会话 cwd（= WORK）。
  const openFile = async (name) => {
    await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().evaluate((el) => el.click());
    await page.locator(".viewer-browse .dirpicker").first().waitFor({ timeout: 15000 });
    await until(
      () => page.evaluate((n) => [...document.querySelectorAll(".dirpicker .file-row")].some((e) => e.textContent.includes(n)), name),
      20000,
      `文件列表里的 ${name}`,
    );
    // 点行之后可能被「文件管理器」的异步收尾画回浏览态，允许再点两次。
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.evaluate((n) => {
        const row = [...document.querySelectorAll(".dirpicker .file-row")].find((e) => e.textContent.includes(n));
        (row)?.click();
      }, name);
      const ok = await page
        .locator(".sh, .md-doc")
        .first()
        .waitFor({ timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      if (ok) return;
    }
    assert(false, `打开 ${name} 失败`);
  };

  const rectOf = (sel, text) =>
    page.evaluate(
      ([q, t]) => {
        const els = [...document.querySelectorAll(q)];
        const e = t ? els.find((x) => x.textContent.includes(t)) : els[0];
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top) };
      },
      [sel, text],
    );

  // ---------------------------------------------------------------- xlsx 预览
  await openFile("plain.xlsx");
  await page.locator(".sh-cell").first().waitFor({ timeout: 15000 });

  // D117：浮窗，不是 760px 的侧栏
  await page.locator(".viewer.dock").waitFor({ timeout: 10000 });
  const vw = await page.evaluate(() => window.innerWidth);
  const dockBox = await page.locator(".viewer.dock").boundingBox();
  assert(dockBox.width > vw * 0.7, `浮窗宽度接近 80% 屏（got ${dockBox.width} / ${vw}）`);
  const gridW = await page.locator(".sh-view").evaluate((e) => e.clientWidth);
  assert(gridW > 800, `网格可用宽度远大于侧栏时代（got ${gridW}px）`);

  // D119：只读 —— 没有「编辑」这一态
  const editBtn = page.locator(".viewer-head .pane-seg button", { hasText: "编辑" });
  assert(await editBtn.isDisabled(), "表格的「编辑」是禁用的（只读）");
  assert(/只读/.test(await editBtn.getAttribute("title") ?? ""), `禁用理由写明只读（got ${await editBtn.getAttribute("title")}）`);

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
  assert((await headerCell.evaluate((e) => getComputedStyle(e).backgroundColor)) === "rgb(68, 84, 106)", "表头底色来自文件");
  assert((await headerCell.evaluate((e) => getComputedStyle(e).color)) === "rgb(255, 255, 255)", "表头是白字");

  const dateCell = page.locator(".sh-cell", { hasText: "2026/8/27" }).first();
  assert(await dateCell.count(), "日期按 yyyy/m/d 显示（不是 Date.toString）");

  const tabs = await page.$$eval(".sh-tab", (els) => els.map((e) => e.textContent));
  assert(tabs.join(",") === "変更履歴,目次", `底部 sheet 标签只有可见的两张（got ${tabs.join(",")}）`);

  // 条件格式：色阶把 F 列涂了色
  await page.locator(".sh-view").evaluate((e) => {
    e.scrollLeft = 620;
  });
  await sleep(400);
  const scaleCell = page.locator(".sh-cell", { hasText: /2\.0$/ }).first();
  assert(await scaleCell.count(), "0.0 格式的 2 显示成 2.0");
  const scaleBg = await scaleCell.evaluate((e) => getComputedStyle(e).backgroundColor);
  assert(scaleBg !== "rgb(255, 255, 255)", `色阶给 F4 上了底色（got ${scaleBg}）`);

  // 冻结：横向先回 A 列，再只滚表体
  await page.locator(".sh-view").evaluate((e) => {
    e.scrollLeft = 0;
  });
  await sleep(300);
  const headColBefore = await rectOf(".sh-colhead");
  const titleBefore = await rectOf(".sh-cell.frozen", "◆変更履歴");
  const bodyRowBefore = await rectOf(".sh-cell", "行20");
  await page.locator(".sh-view").evaluate((e) => {
    e.scrollTop = 160;
  });
  await sleep(400);
  const headColAfter = await rectOf(".sh-colhead");
  const titleAfter = await rectOf(".sh-cell.frozen", "◆変更履歴");
  const bodyRowAfter = await rectOf(".sh-cell", "行20");
  assert(Math.abs(headColAfter.y - headColBefore.y) <= 1, `列头不随竖向滚动移动（${headColBefore.y} → ${headColAfter.y}）`);
  assert(Math.abs(titleAfter.y - titleBefore.y) <= 1, `冻结的标题行钉住（${titleBefore.y} → ${titleAfter.y}）`);
  assert(bodyRowAfter.y < bodyRowBefore.y - 100, `普通行确实滚走了（${bodyRowBefore.y} → ${bodyRowAfter.y}）`);

  // D118：快速滚动的每一帧，冻结行都不能抖
  await page.evaluate(() => {
    window.__frames = [];
    const v = document.querySelector(".sh-view");
    const find = () => [...document.querySelectorAll(".sh-cell.frozen")].find((e) => e.textContent.includes("◆変更履歴"));
    const tick = () => {
      const c = find();
      if (c) window.__frames.push([Math.round(v.scrollTop), Math.round(c.getBoundingClientRect().top)]);
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
  assert(spread <= 3, `快速滚动时冻结行不抖（屏幕 y 波动 ${spread}px）`);

  // 引用给 pi：选区写成「文件 的 sheet!A1:C5」插进输入框
  await page.locator(".sh-quote").click();
  const composer = await page.locator(".composer-input textarea").inputValue();
  assert(/plain\.xlsx/.test(composer) && /変更履歴!A1/.test(composer), `引用给 pi 插进了输入框（got ${composer}）`);
  await page.locator(".composer-input textarea").fill("");
  await page.screenshot({ path: path.join(OUT, "xlsx-preview.png") });

  // ---------------------------------------------------------------- pi 改了文件，预览自己跟上
  {
    // 先把滚动归零，改的格子（B4）才在可见窗口里 —— 看不见的格子本来就不会被画出来
    await page.locator(".sh-view").evaluate((e) => {
      e.scrollTop = 0;
      e.scrollLeft = 0;
    });
    await sleep(400);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(WORK, "plain.xlsx"));
    // 改一个滚动到 0 时也在屏幕上的格子（F 列在右边，看不见）
    wb.getWorksheet("変更履歴").getCell("B4").value = "媒体項目マッピング改";
    await wb.xlsx.writeFile(path.join(WORK, "plain.xlsx"));
    await until(async () => (await page.locator(".sh-cell", { hasText: "媒体項目マッピング改" }).count()) > 0, 15000, "外部修改后自动刷新");
    const stillFrozen = await rectOf(".sh-cell.frozen", "◆変更履歴");
    assert(stillFrozen, "重载之后冻结行还在");
    await page.screenshot({ path: path.join(OUT, "xlsx-reload.png") });
  }

  // ---------------------------------------------------------------- md 仍走侧栏
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
  assert(panes.top && panes.left && panes.corner, `冻结的三块浮层都在（${JSON.stringify(panes)}）`);
  assert(panes.left[2] > 50 && panes.corner[2] > 50, `冻结列有实际宽度（left=${panes.left?.[2]}）`);

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
  assert(a20Before && a20After && Math.abs(a20After.y - a20Before.y) > 100, `普通行跟着纵向滚（${a20Before?.y} → ${a20After?.y}）`);

  // 点冻结区里的 A2：选区落在 A2（只读也还能选、能复制、能引用给 pi）
  await page.locator(".sh-pane .sh-cell").filter({ hasText: /^担当2$/ }).first().click();
  assert((await page.locator(".sh-name").textContent()) === "A2", `点冻结区里的 A2 落在 A2（got ${await page.locator(".sh-name").textContent()}）`);
  const headOverlap = await page.evaluate(() => {
    const view = document.querySelector(".sh-view").getBoundingClientRect();
    const fzW = document.querySelector(".sh-pane.pl")?.getBoundingClientRect().width ?? 0;
    return [...document.querySelectorAll(".sh-colcell")]
      .map((e) => ({ t: e.textContent, l: Math.round(e.getBoundingClientRect().left - view.left) }))
      .filter((x) => x.l < Math.round(fzW) - 1)
      .map((x) => `${x.t}@${x.l}`);
  });
  assert(headOverlap.length <= 1 && (headOverlap[0]?.startsWith("A") ?? true), `列头没有压进冻结带（${JSON.stringify(headOverlap)}）`);
  await page.screenshot({ path: path.join(OUT, "xlsx-frozen.png") });

  // ---------------------------------------------------------------- 图表占位
  await openFile("chart.xlsx");
  await page.locator(".sh-chart").first().waitFor({ timeout: 15000 });
  assert((await page.locator(".viewer.dock").count()) === 1, "图表页同样是浮窗");
  assert(/柱形图/.test(await page.locator(".sh-chart-t").first().textContent()), "图表占位写的是柱形图");
  await page.screenshot({ path: path.join(OUT, "xlsx-chart.png") });

  // ---------------------------------------------------------------- csv 当表看（只读）
  await openFile("data.csv");
  await page.locator(".sh-cell", { hasText: "日付" }).first().waitFor({ timeout: 15000 });
  assert((await page.locator(".sh-tab").first().textContent()) === "data", "csv 的 sheet 名取自文件名");
  const csvCell = await page.locator(".sh-cell", { hasText: "媒体項目マッピング" }).first().textContent();
  assert(csvCell.includes("媒体項目マッピング"), `GBK 的 csv 正常解码（got ${csvCell}）`);
  assert((await page.locator(".sh-cell", { hasText: "12000" }).count()) > 0, "数字列右对齐（有 12000）");
  await page.screenshot({ path: path.join(OUT, "xlsx-csv.png") });

  // ---------------------------------------------------------------- 32 万格 → 只读轻量
  await openFile("big.xlsx");
  await page.locator(".sh-cell", { hasText: "列1" }).first().waitFor({ timeout: 30000 });
  const status = await page.locator(".sh-status").first().textContent();
  assert(/20000/.test(status), `大表报出了行数（got ${status}）`);
  await page.screenshot({ path: path.join(OUT, "xlsx-big.png") });

  // 文件本身没被预览改过：mtime/size 只该被上面那次 exceljs 写入改变
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.readFile(path.join(WORK, "plain.xlsx"));
  assert(wb2.getWorksheet("変更履歴").getCell("B4").value === "媒体項目マッピング改", "预览本身不写回文件");
  assert(wb2.getWorksheet("変更履歴").getCell("A1").isMerged === true, "合并单元格还在");

  log("all good; shots in .scratch/xlsx/shots");
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
}
