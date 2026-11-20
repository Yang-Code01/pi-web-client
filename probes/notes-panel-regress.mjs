/**
 * 记录面板三个回归（2026-11-20 用户报的 bug）：
 *   1. 中文输入法上屏的最后一句：Chrome 最后一次 input 带 isComposing，之后只有 compositionend，
 *      以前不算「改过」，停手自动保存 / 关面板都不存 → 最后一句丢。
 *   2. 记忆：关掉再开，上次选中的那条要原样选中（以前 focusComposer 先开了新草稿，把记忆里的 sel 冲成 null）。
 *   3. 进了「⚡ AI 出错记录」以后，左侧分区栏还在，点 bug 能回去。
 *
 * 跑：node probes/notes-panel-regress.mjs（先 npm run build:bridge && npm run build:web）
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
const PORT = Number(process.env.PI_WEB_PORT ?? 7893);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notes-regress-"));
const AGENT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notes-regress-agent-"));

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

const child = spawn(process.execPath, [BRIDGE], {
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_AGENT_DIR: AGENT, PI_WEB_ROOT: DIST, PI_WEB_NO_EXT: "1" },
});
child.stderr.on("data", () => {});
process.on("exit", () => {
  try {
    child.kill();
  } catch {
    /* gone */
  }
});

const notesOnDisk = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE, "notes", "bug-notes.json"), "utf8")).notes ?? [];
  } catch {
    return [];
  }
};

let browser;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok, 20000, "healthz");
  const passphrase = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 880 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', passphrase);
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector('[data-act="notes"]', { timeout: 20000 });
  const openPanel = async () => {
    await page.locator('[data-act="notes"]').click();
    await page.waitForSelector(".notes-sheet", { timeout: 5000 });
  };
  const closePanel = async () => {
    await page.keyboard.press("Escape");
    await until(async () => (await page.locator(".notes-sheet").count()) === 0, 4000, "面板关掉");
  };

  // ---- 1. 输入法上屏的最后一句要存上
  await openPanel();
  await page.fill(".nc-title", "第一条");
  const cdp = await ctx.newCDPSession(page);
  await page.click(".nc-body");
  await page.keyboard.type("abc ");
  await sleep(1300); // 先落一次盘
  await until(async () => notesOnDisk().length === 1, 5000, "第一条落盘");
  // 输入法：组字 → 上屏（Chrome 里只剩 compositionend，没有 isComposing=false 的 input）
  await cdp.send("Input.imeSetComposition", { text: "zui", selectionStart: 3, selectionEnd: 3 });
  await cdp.send("Input.insertText", { text: "最后一句" });
  await sleep(1400);
  const body1 = notesOnDisk()[0]?.body ?? "";
  check("输入法上屏的最后一句自动保存了", body1.includes("最后一句"), body1);

  // 再上屏一句后立刻关面板：flush 也得带上它
  await cdp.send("Input.imeSetComposition", { text: "ye", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "也要在" });
  await closePanel();
  await sleep(800);
  const body2 = notesOnDisk()[0]?.body ?? "";
  check("上屏后马上关面板也存上了", body2.includes("也要在"), body2);

  // ---- 2. 记忆：再记一条、选回第一条，关掉再开，还是第一条
  await openPanel();
  await page.locator(".notes-head-new").click();
  await page.fill(".nc-title", "第二条");
  await page.click(".nc-body");
  await page.keyboard.type("second");
  await until(async () => notesOnDisk().length === 2, 5000, "第二条落盘");
  const firstId = notesOnDisk().find((n) => n.title === "第一条")?.id;
  await page.locator(`.nc-row[data-id="${firstId}"]`).click();
  await closePanel();
  await openPanel();
  await until(async () => (await page.locator(".nc-row").count()) === 2, 4000, "列表回来");
  await sleep(300);
  const onId = await page.locator(".nc-row.on").getAttribute("data-id").catch(() => null);
  check("重开面板后选中的还是上次那条", onId === firstId, `on=${onId} want=${firstId}`);
  check("正文区填的就是那条", (await page.locator(".nc-title").inputValue()) === "第一条", await page.locator(".nc-title").inputValue());
  check("没有多出一条空草稿", notesOnDisk().length === 2, String(notesOnDisk().length));

  // ---- 3. 进 AI 出错记录，再回 bug
  await page.locator('.nc-nav-item[data-key="failures"]').click();
  await sleep(300);
  check("出错记录：账本亮出来", await page.locator(".fail-wrap").isVisible());
  check("出错记录：分区栏还在", await page.locator(".nc-nav").isVisible());
  check("出错记录：列表 / 正文让位", !(await page.locator(".nc-list").isVisible()) && !(await page.locator(".nc-doc").isVisible()));
  await page.locator('.nc-nav-item[data-key="bug"]').click();
  await sleep(300);
  check("点 bug 回到记录列表", (await page.locator(".nc-list").isVisible()) && !(await page.locator(".fail-wrap").isVisible()));

  // 记在出错记录里关掉，再开也能回去
  await page.locator('.nc-nav-item[data-key="failures"]').click();
  await closePanel();
  await openPanel();
  await sleep(300);
  check("重开停在出错记录，分区栏照样在", (await page.locator(".fail-wrap").isVisible()) && (await page.locator(".nc-nav").isVisible()));
  await page.locator('.nc-nav-item[data-key="bug"]').click();
  await sleep(300);
  check("重开后也能点回 bug", await page.locator(".nc-list").isVisible());

  check("页面没抛错", errors.length === 0, errors.join(" | "));
} catch (e) {
  failures++;
  console.log("FAIL", e?.message ?? e);
} finally {
  await browser?.close();
}
console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
child.kill();
process.exit(failures ? 1 : 0);
