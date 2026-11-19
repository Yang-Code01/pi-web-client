/**
 * Context 面板（chat 框下「上下文」按钮）的浏览器回归：不起 bridge，直接把 ContextPanel 打包进
 * 一张静态页，喂一份合成的 ctxlog，再用 Playwright 量。守的是这几处曾经的 bug：
 *
 *  1. 「当前上下文」进度条：已用部分的宽度要等于上下文占窗口的比例（曾经只有几个 1px，39.6% 画成 7px）。
 *  2. 浏览器下拉只列最近 40 次请求；从趋势图点了更早的柱子，下拉要显示那一步，而不是别的。
 *  3. 选中某一步后切到「轮次」粒度，包含它的那一轮要高亮，详情也是那一轮。
 *  4. 过滤框在输入法组字期间不能重画（否则半截拼音被提交：「wenwenj文件」）。
 *  5. 旧日志 seq 撞号：经 `renumberCtxLog` 后轮次接着数，「第 1 轮」只出现一次。
 *
 * Run: node probes/context-panel.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const esbuild = createRequire(path.join(REPO, "web", "package.json"))("esbuild");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-panel-"));

// ---- 合成日志：3 段（模拟旧扩展重启两次清零），共 60 次请求 ----
const lines = [];
const seg = (turns, stepsPerTurn) => {
  let seq = 0;
  let last = 0;
  for (let t = 1; t <= turns; t++) {
    for (let s = 1; s <= stepsPerTurn; s++) {
      const k = lines.length + 1;
      const cats = { sys: 600, tools: 12000, user: 100 + k, inject: 2900, skill: 5700, asst: 400 * k, toolr: 600 * k };
      const total = Object.values(cats).reduce((a, b) => a + b, 0);
      last = ++seq;
      lines.push({ v: 3, seq: last, ts: 1_795_000_000_000 + k * 1000, kind: "request", turn: t, step: s, total, cats, items: [] });
      lines.push({ v: 3, seq: ++seq, ts: 1_795_000_000_000 + k * 1000 + 500, kind: "usage", atSeq: last, durationMs: 800, waitMs: 100, usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 1050 }, out: { reasoning: 10, answer: 20, calls: 5 } });
      lines.push({ v: 3, seq: ++seq, ts: 1_795_000_000_000 + k * 1000 + 700, kind: "activity", activity: "file", tool: "read", op: "read", path: `src/f${k}.ts`, added: 0, removed: 0, status: "ok", atSeq: last, durationMs: 5 });
    }
  }
};
seg(2, 20);
seg(1, 15);
seg(1, 5);

const panelSrc = path.join(REPO, "web", "src", "context-panel.ts").replace(/\\/g, "/");
const stylesSrc = path.join(REPO, "web", "src", "styles.css").replace(/\\/g, "/");
const seqSrc = path.join(REPO, "bridge", "src", "ctxlog-seq.ts").replace(/\\/g, "/");
fs.writeFileSync(
  path.join(tmp, "entry.ts"),
  `import ${JSON.stringify(stylesSrc)};
import { ContextPanel } from ${JSON.stringify(panelSrc)};
import { renumberCtxLog } from ${JSON.stringify(seqSrc)};
const lines = renumberCtxLog((window as any).LINES);
const sheet = document.createElement("div"); sheet.className = "sheet settings-sheet context-sheet";
const body = document.createElement("div"); body.className = "settings-body";
const host = document.createElement("div"); host.className = "ctx-host";
body.append(host); sheet.append(body); document.querySelector("#app")!.append(sheet);
const p = new ContextPanel(host);
const data = () => ({ lines, contextWindow: 400000, measured: null, policy: null, model: "m", tokens: null, cost: 0, owned: true });
(window as any).repaint = () => p.update(data());
p.update(data());
`,
);
fs.writeFileSync(path.join(tmp, "lines.js"), `window.LINES=${JSON.stringify(lines)};`);
fs.writeFileSync(
  path.join(tmp, "index.html"),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="out/entry.css"></head><body><div id="app"></div><script src="lines.js"></script><script src="out/entry.js"></script></body></html>`,
);
await esbuild.build({
  entryPoints: [path.join(tmp, "entry.ts")],
  bundle: true,
  outdir: path.join(tmp, "out"),
  loader: { ".woff2": "file", ".woff": "file", ".svg": "file", ".png": "file" },
  logLevel: "error",
});

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ locale: "zh-CN", viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(path.join(tmp, "index.html")).href);
  await page.waitForSelector(".cx-bar");

  // 1. 进度条
  const bar = await page.evaluate(() => {
    const outer = document.querySelector(".cx-progress").getBoundingClientRect().width;
    const used = document.querySelector(".cx-progress-used").getBoundingClientRect().width;
    const pct = parseFloat(document.querySelector(".cx-current-pct span").textContent);
    return { ratio: (used / outer) * 100, pct };
  });
  check(Math.abs(bar.ratio - bar.pct) < 1.5, `进度条已用 ${bar.ratio.toFixed(1)}% ≈ 文字 ${bar.pct}%`);

  // 5. 撞号修复后的轮次
  const kpiTurns = await page.evaluate(() => document.querySelector(".cx-kpi .cx-kpi-v").textContent);
  check(kpiTurns === "4", `轮次 KPI = 4（三段日志接着数），实际 ${kpiTurns}`);

  // 2. 点最早的柱子：下拉跟着显示 T1 · S1
  await page.click(".cx-bar >> nth=0");
  const sel = await page.evaluate(() => ({
    opt: document.querySelector(".cx-select").selectedOptions[0]?.textContent,
    title: document.querySelector(".cx-browser-title")?.textContent,
  }));
  check(sel.opt === "T1 · S1" && sel.title === "第 1 轮 · 第 1 步", `下拉 ${sel.opt} / 浏览器 ${sel.title}`);

  // 3. 选第 5 步再切「轮次」：第 1 轮那根柱子高亮
  await page.click(".cx-bar >> nth=4");
  await page.click(".cx-trend-controls button >> text=轮次");
  const turn = await page.evaluate(() => ({
    picked: [...document.querySelectorAll(".cx-bar")].findIndex((b) => b.classList.contains("picked")),
    detail: document.querySelector(".cx-detail-title span")?.textContent,
  }));
  check(turn.picked === 0 && turn.detail?.startsWith("第 1 轮"), `轮次粒度高亮第 ${turn.picked} 根 · ${turn.detail}`);

  // 4. 输入法组字：组字中途来一次重画（模拟 ctxlog 到达），上屏后只剩上屏的字
  const input = page.locator(".cx-tools-row input.cx-search").first();
  await input.click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "wen", selectionStart: 3, selectionEnd: 3 });
  await page.evaluate(() => window.repaint());
  await cdp.send("Input.imeSetComposition", { text: "wenj", selectionStart: 4, selectionEnd: 4 });
  await cdp.send("Input.insertText", { text: "文件" });
  await page.waitForTimeout(50);
  const typed = await page.evaluate(() => document.querySelector(".cx-tools-row input.cx-search").value);
  check(typed === "文件", `组字后过滤框 = ${JSON.stringify(typed)}`);

  check(errors.length === 0, `页面无报错 ${errors.join(" | ")}`);
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
