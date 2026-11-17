/**
 * 探针：「已经在输入框里写了一段话，光标回到最前面敲 `/`，再选一个技能」——
 * 选完后那段话必须还在（2026-11-17 用户报障：内容被清空）。
 *
 * 起法（在本次 worktree 里跑，别指到别的 checkout）：
 *   node .pi/skills/pi-web-client-test-dev/bin/env.mjs start --dir "$PWD" --name keeps --build
 *   PI_WEB_BASE=http://127.0.0.1:17876 node probes/complete-insert-keeps-text.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const BASE = process.env.PI_WEB_BASE ?? "http://127.0.0.1:17876";
const PASS = "test";
const OUT = path.join(REPO, ".scratch/complete-insert");
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: PASS }),
});
if (login.status !== 200) throw new Error(`login ${login.status}`);
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

const sessionId = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie } });
  ws.on("open", () => ws.send(JSON.stringify({ type: "create", cwd: REPO, name: "补全插入探针" })));
  ws.on("message", (b) => {
    let m;
    try {
      m = JSON.parse(b.toString());
    } catch {
      return;
    }
    if (m.type === "session.state" && m.session?.name === "补全插入探针") {
      resolve(m.session.id);
      ws.close();
    }
    if (m.type === "error") reject(new Error(m.message));
  });
  setTimeout(() => reject(new Error("create timeout")), 90000);
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, locale: "zh-CN" });
const page = await ctx.newPage();
page.on("pageerror", (e) => log("pageerror:", e.message));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', PASS);
  await page.click('button:has-text("进入")');
}
await page.waitForSelector(".session-list", { timeout: 30000 });
await page.evaluate((id) => (location.hash = `#/s/${id}`), sessionId);
await page.waitForSelector(".composer textarea", { timeout: 30000 });
await page.waitForTimeout(1500); // 等 bridge 问完 pi 的命令/技能表

const field = page.locator(".composer textarea");

/** 输入 `text`，光标回到最前面，敲 `/`，然后挑中一行补全项（有技能优先挑技能）。 */
async function scenario(text) {
  await field.click();
  await field.fill(text);
  await page.waitForTimeout(120);
  const typed = await field.inputValue();
  await field.evaluate((el) => {
    el.focus();
    el.setSelectionRange(0, 0);
  });
  await page.keyboard.press("/");
  const shown = await page.locator(".composer textarea").inputValue();
  const anyRow = page.locator(".complete-pop .complete-row");
  await anyRow.first().waitFor({ timeout: 20000 }).catch(() => {});
  const rows = await page.$$eval(".complete-pop .complete-row", (els) =>
    els.map((e) => [e.querySelector(".complete-label")?.textContent ?? "", e.querySelector(".complete-tag")?.textContent ?? ""]),
  );
  const at = rows.findIndex(([, tag]) => tag === "技能");
  const index = at >= 0 ? at : rows.findIndex(([label]) => label === "/new");
  const picked = index >= 0 ? rows[index][0] : null;
  log(`rows=${rows.length} 选中=${JSON.stringify(picked)}${at >= 0 ? "（技能）" : "（内建兜底）"}`);
  let after = shown;
  if (picked !== null) {
    await anyRow.nth(index).click();
    await page.waitForTimeout(300);
    after = await field.inputValue();
  }
  log(`场景 ${JSON.stringify(text)} 光标在 0 敲 / → ${JSON.stringify(shown)}`);
  log(`选 ${JSON.stringify(picked)} → ${JSON.stringify(after)}`);
  const want = picked === null ? null : `${picked} ${typed}`;
  log(`期望 ${JSON.stringify(want)}`);
  const ok = picked !== null && after === want;
  log(ok ? "✔ 原内容还在" : "✖ 原内容丢了");
  log("");
  return ok;
}

let bad = 0;
// 没有空格的整段：tokenEnd 会一路吃到结尾，内容全没（最短复现）。
if (!(await scenario("帮我看看这个bug"))) bad++;
// 带空格的：tokenEnd 停在第一个空格，空格之后的内容幸存、前面被吃。
if (!(await scenario("帮我看看这个 bug"))) bad++;

await browser.close();
log(bad ? `FAIL (${bad})` : "PASS");
process.exit(bad ? 1 : 0);
