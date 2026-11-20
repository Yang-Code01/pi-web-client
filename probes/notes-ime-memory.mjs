/**
 * 记录面板（D108 / #486 / #514）三处回归：IME 丢字、重开不接回选中、账本里出不来。
 *
 * 隔离桥（临时状态目录、端口 7899）+ 真 Chromium：
 *  - 用 CDP 的 Input.imeSetComposition 模拟中文输入法组字：900ms 自动保存正好落在组字中间时，
 *    落盘的不是半截拼音；上屏（Input.insertText）之后补存一次，存储正文里有那个字。
 *  - 关掉面板再打开：还是选中同一条，标题 / 正文都在，localStorage 里的 notes.memory.sel 也还在。
 *  - 切到「AI 出错记录」：头上有「← 记录」，「＋ 记一条」也在；返回回到列表，记一条会切回列表落草稿。
 *
 * 跑：node probes/notes-ime-memory.mjs（先 npm run build:bridge && npm run build:web）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const BRIDGE = path.join(REPO, "bridge", "dist", "index.js");
const DIST = path.join(REPO, "web", "dist");
const PORT = Number(process.env.PI_WEB_PORT ?? 7899);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notes-ime-"));
const AGENT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notes-ime-agent-"));
const NOTES = path.join(STATE, "notes", "bug-notes.json");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(120);
  }
  throw new Error(`超时：${what}`);
};
const notes = () => {
  try {
    return JSON.parse(fs.readFileSync(NOTES, "utf8")).notes;
  } catch {
    return [];
  }
};
const memory = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("notes.memory") ?? "null"));

const child = spawn(process.execPath, [BRIDGE], {
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_AGENT_DIR: AGENT, PI_WEB_ROOT: DIST, PI_WEB_NO_EXT: "1" },
});
child.stderr.on("data", (b) => {
  const line = String(b).trim();
  if (line) log("bridge:", line.slice(0, 200));
});
const stop = () => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
};
process.on("exit", stop);

let browser;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => {
    try {
      return (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 20000, "healthz");
  const passphrase = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', passphrase);
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector('[data-act="notes"]', { timeout: 20000 });
  await page.click('[data-act="notes"]');
  await page.waitForSelector(".notes-sheet", { timeout: 5000 });
  // 一条都没有 → 列表回来后落到草稿，光标在标题上
  await until(async () => (await page.locator(".nc-title").count()) > 0, 5000, "草稿出现");
  check("空面板打开就落草稿", await page.evaluate(() => document.activeElement?.classList.contains("nc-title")));

  const body = page.locator(".nc-body");
  const cdp = await ctx.newCDPSession(page);

  // ---- 1. 中文输入法组字：不许把拼音写盘，上屏后补存
  await body.click();
  await page.keyboard.type("第一句。");
  await until(() => notes().length === 1, 8000, "首条落盘");
  await page.keyboard.type(" ");
  await cdp.send("Input.imeSetComposition", { text: "diu", selectionStart: 3, selectionEnd: 3 });
  await sleep(1300); // 900ms 的自动保存正好落在组字中间
  const mid = notes()[0].body;
  check("组字期间不把拼音写盘", !/diu/.test(mid), `存的是 ${JSON.stringify(mid)}`);
  await cdp.send("Input.insertText", { text: "丢" });
  await sleep(1600);
  const after = notes()[0].body;
  check("上屏的字补存进正文", /丢/.test(after), `存的是 ${JSON.stringify(after)}`);

  // ---- 2. 记忆：关掉再开，还是选中同一条
  const savedId = notes()[0].id;
  await page.keyboard.press("Escape");
  await sleep(300);
  check("关闭前记下了选中", (await memory(page))?.sel === savedId, JSON.stringify(await memory(page)));
  await page.click('[data-act="notes"]');
  await page.waitForSelector(".notes-sheet", { timeout: 5000 });
  await sleep(1000);
  const onId = await page.evaluate(() => document.querySelector(".nc-row.on")?.dataset.id ?? null);
  check("重开还是选中同一条", onId === savedId, `on=${onId}`);
  check("重开 memory.sel 没被清掉", (await memory(page))?.sel === savedId, JSON.stringify(await memory(page)));
  check("重开正文是那一条", /丢/.test(await body.innerHTML()), JSON.stringify(await body.innerHTML()));
  check("重开标题不是空的", ((await page.locator(".nc-title").inputValue()) ?? "").trim().length > 0);

  // ---- 3. AI 出错记录：能回去，也能直接记一条
  await page.click('.nc-nav-item[data-key="failures"]');
  await sleep(400);
  check("账本里有「← 记录」", await page.locator(".notes-head-back").isVisible());
  check("账本里能「＋ 记一条」", await page.locator(".notes-head-new").isVisible());
  await page.click(".notes-head-back");
  await sleep(400);
  check("返回后回到记录列表", (await page.locator(".nc-nav").isVisible()) && (await page.locator(".fail-body").isHidden()));
  await page.click('.nc-nav-item[data-key="failures"]');
  await sleep(300);
  await page.click(".notes-head-new");
  await sleep(400);
  check("账本里记一条：切回列表并落在标题上", (await page.locator(".nc-title").isVisible()) && (await page.evaluate(() => document.activeElement?.classList.contains("nc-title"))));

  check("没有页面报错", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
} finally {
  await browser?.close().catch(() => {});
  stop();
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exitCode = failures ? 1 : 0;
