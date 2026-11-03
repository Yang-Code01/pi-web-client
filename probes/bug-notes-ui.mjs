/**
 * 顶栏 🐞 bug 记录（D101）：真 Chromium 里的那条链。
 *
 * 隔离桥（临时状态目录、端口 7892）+ 真页面：点 🐞 开面板 → 打字 Enter 存 → 左栏出现一条 →
 * 贴一张图（真 paste 事件，canvas 生成 PNG）→ 保存后缩略图出现在编辑器里 →
 * 点状态 pill 转「已处理」并从待处理列表消失 → 打开「显示已处理」又回来 →
 * 复制 Markdown 进剪贴板 → Escape 关面板 → 刷新后还在（落到 bug-notes.json）。
 *
 * 跑：node probes/bug-notes-ui.mjs（先 npm run build:bridge && npm run build:web）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const BRIDGE = path.join(REPO, "bridge", "dist", "index.js");
const DIST = path.join(REPO, "web", "dist");
const PORT = Number(process.env.PI_WEB_PORT ?? 7892);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notes-ui-"));
const AGENT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notes-ui-agent-"));
const SHOTS = path.join(REPO, ".scratch", "bug-notes", "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const until = async (fn, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`超时：${what}`);
};

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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
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

  // ---- 1. 有会话没会话都能开
  const btn = page.locator('[data-act="notes"]');
  check("顶栏有 🐞 按钮", (await btn.count()) === 1);
  check("没开会话也是可见的", await btn.isVisible());
  await btn.click();
  await page.waitForSelector(".notes-sheet", { timeout: 5000 });
  check("面板打开", (await page.locator(".notes-sheet").count()) === 1);
  check("四个类型 tab", (await page.locator(".notes-tab").count()) === 4, await page.locator(".notes-tab").allTextContents());
  check("开面板就把光标放进记一条", await page.evaluate(() => document.activeElement?.classList.contains("note-body")));

  // ---- 2. 打字 + Enter 存一条
  await page.fill(".note-body", "手机横屏时顶栏被挤出屏幕");
  await page.press(".note-body", "Enter");
  await until(async () => (await page.locator(".note-row").count()) === 1, 6000, "列表出现一条");
  check("左栏多一条", true, await page.locator(".note-row-title").first().textContent());
  check("按钮只有图标（没有小字）", ((await btn.textContent()) ?? "").trim() === "🐞", await btn.textContent());
  check("待处理计数挪到 title 里", /1 条待处理/.test((await btn.getAttribute("title")) ?? ""), await btn.getAttribute("title"));
  check("落盘的标题 = 正文首行", JSON.parse(fs.readFileSync(path.join(STATE, "notes", "bug-notes.json"), "utf8")).notes[0].title === "手机横屏时顶栏被挤出屏幕");

  // ---- 3. 贴一张图，保存后缩略图进来
  await page.evaluate(async () => {
    const dt = new DataTransfer();
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const g = canvas.getContext("2d");
    g.fillStyle = "#c0392b";
    g.fillRect(0, 0, 320, 200);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
    document.querySelector(".note-body").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await until(async () => (await page.locator(".note-shot img").count()) === 1, 6000, "待传缩略图");
  check("贴进来的图先挂成待传", true);
  await page.locator(".note-body").press("Control+Enter").catch(() => {});
  await page.click(".note-actions button.btn.primary");
  await until(() => {
    const file = path.join(STATE, "notes", "bug-notes.json");
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")).notes[0].shots.length === 1;
    } catch {
      return false;
    }
  }, 6000, "截图落盘");
  const shotPath = JSON.parse(fs.readFileSync(path.join(STATE, "notes", "bug-notes.json"), "utf8")).notes[0].shots[0];
  check("截图落到 assets/<id>/", fs.existsSync(shotPath), shotPath);
  await until(async () => (await page.locator(`.note-shot img[src*="${path.basename(shotPath)}"]`).count()) === 1, 6000, "缩略图回来");
  check("编辑器里看到缩略图", true);

  // ---- 4. 状态 pill：待处理 → 已处理，列表里消失
  await page.click(".note-meta .note-pill");
  await until(async () => (await page.locator(".note-row").count()) === 0, 6000, "待处理列表清空");
  check("转已处理后从待处理列表消失", true);
  await page.click(".notes-switch input");
  await until(async () => (await page.locator(".note-row").count()) === 1, 4000, "显示已处理后出现");
  check("显示已处理后回来且标着已处理", /已处理/.test((await page.locator(".note-pill").first().textContent()) ?? ""));

  // ---- 5. 复制 Markdown
  await page.locator(".note-row").first().click();
  await page.locator('.note-actions button:has-text("复制 Markdown")').click();
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check("复制出来是 Markdown 带标题", clip.includes("## 手机横屏时顶栏被挤出屏幕"), clip.slice(0, 60).replace(/\n/g, " ⏎ "));
  check("复制里带截图绝对路径", clip.includes(shotPath), clip.includes("assets") ? "含 assets 路径" : "缺路径");

  // ---- 5.5 归档 / 垃圾箱：列表里看不到，抽屉里能看到，复原 / 彻底删
  await page.click(".notes-new");
  await page.fill(".note-body", "临时：试试归档和垃圾箱");
  await page.press(".note-body", "Enter");
  await until(async () => (await page.locator(".note-row").count()) === 2, 6000, "第二条");
  const temp = page.locator(".note-row", { hasText: "临时：试试归档和垃圾箱" });
  await temp.hover();
  await temp.locator('.note-row-act[title="归档"]').click();
  await until(async () => (await page.locator(".note-row").count()) === 1, 5000, "归档后从列表消失");
  check("归档后不在列表里", true);
  await page.click('.notes-viewbtn:has-text("归档")');
  await until(async () => (await page.locator(".note-row").count()) === 1, 5000, "归档抽屉里出现");
  check("归档抽屉里能看到它", (await page.locator(".note-row-title").textContent()) === "临时：试试归档和垃圾箱");
  await page.locator(".note-row").first().hover();
  await page.locator('.note-row-act[title="复原：放回列表"]').click();
  await until(async () => (await page.locator(".note-row").count()) === 0, 5000, "复原后归档抽屉空了");
  await page.click('.notes-viewbtn:has-text("归档")');
  await until(async () => (await page.locator(".note-row").count()) === 2, 5000, "复原后回到列表");
  check("复原后回到列表", true);

  await temp.hover();
  await temp.locator('.note-row-act[title="删到垃圾箱"]').click();
  await until(async () => (await page.locator(".note-row").count()) === 1, 5000, "删到垃圾箱后从列表消失");
  check("删到垃圾箱后不在列表里", true);
  await page.click('.notes-viewbtn:has-text("垃圾箱")');
  await until(async () => (await page.locator(".note-row").count()) === 1, 5000, "垃圾箱里出现");
  await page.locator(".note-row").first().click();
  await page.waitForTimeout(200);
  check("垃圾箱里只读（没有编辑框、有提示条）", (await page.locator(".note-body-view").count()) === 1 && (await page.locator(".note-life-bar.trash").count()) === 1);
  check("垃圾箱里有「清空垃圾箱」", await page.locator(".notes-clear").isVisible());
  check("垃圾箱里那条带「彻底删除」图标", (await page.locator('.note-row-act[title="彻底删除（不能撤销）"]').count()) === 1);
  await page.locator(".note-row").first().hover();
  await page.locator('.note-row-act[title="复原：放回列表"]').click();
  await until(async () => (await page.locator(".note-row").count()) === 0, 5000, "复原后垃圾箱空了");
  await page.click('.notes-viewbtn:has-text("垃圾箱")');
  await until(async () => (await page.locator(".note-row").count()) === 2, 5000, "垃圾箱复原后回到列表");
  check("从垃圾箱复原也回到列表", true);

  await temp.hover();
  await temp.locator('.note-row-act[title="删到垃圾箱"]').click();
  await page.click('.notes-viewbtn:has-text("垃圾箱")');
  await until(async () => (await page.locator(".note-row").count()) === 1, 5000, "垃圾箱里又出现");
  await page.click(".notes-clear");
  await until(async () => (await page.locator(".note-row").count()) === 0, 5000, "清空后垃圾箱一条不剩");
  check("一键清空垃圾箱", true);
  const left = JSON.parse(fs.readFileSync(path.join(STATE, "notes", "bug-notes.json"), "utf8")).notes;
  check("清空后 JSON 里只剩没删的那条", left.length === 1 && left[0].title === "手机横屏时顶栏被挤出屏幕", `${left.length} 条`);
  await page.click('.notes-viewbtn:has-text("垃圾箱")');
  await page.locator(".note-row").first().click();

  // ---- 6. 「交给 agent」菜单两选一
  await page.locator('.note-actions button:has-text("交给 agent")').click();
  await page.waitForSelector(".note-handoff", { timeout: 3000 });
  check("菜单两项", (await page.locator(".note-handoff button").count()) === 2, await page.locator(".note-handoff .handoff-label").allTextContents());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("Escape 先关菜单、面板还在", (await page.locator(".note-handoff").count()) === 0 && (await page.locator(".notes-sheet").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("再 Escape 关面板", (await page.locator(".notes-sheet").count()) === 0);

  // ---- 7. 刷新后还在（落盘不是内存）
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-act="notes"]', { timeout: 20000 });
  await until(async () => !/1 条待处理/.test((await page.locator('[data-act="notes"]').getAttribute("title")) ?? ""), 5000, "刷新后计数归零");
  await page.click('[data-act="notes"]');
  await page.click(".notes-switch input");
  await until(async () => (await page.locator(".note-row").count()) === 1, 5000, "刷新后仍有那一条");
  check("刷新后记录还在", (await page.locator(".note-row-title").first().textContent()) === "手机横屏时顶栏被挤出屏幕");

  // 截图：面板开着、显示已处理，两条真数据（再补一条变更，四个 tab 的计数才不全是 1）
  await page.locator('.notes-tab:has-text("变更")').click();
  await page.click(".notes-new");
  await page.fill(".note-body", "bug 记录改成本地随手记");
  await page.press(".note-body", "Enter");
  await until(async () => (await page.locator(".note-row").count()) === 0, 6000, "变更 tab 只有待处理时为空").catch(() => {});
  await page.locator('.notes-tab:has-text("bug")').click();
  await page.locator(".note-row").first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, "desktop.png") });
  log("screenshot:", path.relative(REPO, path.join(SHOTS, "desktop.png")));

  // 手机宽度：两列得折成上下两段，面板得占满宽
  await page.setViewportSize({ width: 430, height: 900 });
  await page.waitForTimeout(300);
  const sideBox = await page.locator(".notes-side").boundingBox();
  const editorBox = await page.locator(".notes-editor").boundingBox();
  check("手机宽度下面板没把窗口顶宽", (await page.evaluate(() => document.documentElement.scrollWidth)) <= 431);
  check(
    "手机宽度下折成上下两段",
    !!sideBox && !!editorBox && Math.abs(sideBox.x - editorBox.x) < 2 && editorBox.y >= sideBox.y + sideBox.height - 2,
    `${JSON.stringify(sideBox)} vs ${JSON.stringify(editorBox)}`,
  );
  await page.screenshot({ path: path.join(SHOTS, "mobile.png") });
  log("screenshot:", path.relative(REPO, path.join(SHOTS, "mobile.png")));

  check("没有页面报错", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
} finally {
  await browser?.close();
  stop();
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exitCode = failures ? 1 : 0;
