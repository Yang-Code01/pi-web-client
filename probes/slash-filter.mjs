/**
 * 探针：`/hand` 这类输入在真浏览器里到底留下哪几行（2026-11-06 用户报障的回归）。
 *
 * 起法：先 `node .pi/skills/pi-web-client-test-dev/bin/env.mjs start --dir F:/pi-web-client --name hand`，
 * 再 `PI_WEB_BASE=http://127.0.0.1:17874 node probes/slash-filter.mjs`（截图落 `.scratch/hand-filter/`）。
 */
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const BASE = process.env.PI_WEB_BASE ?? "http://127.0.0.1:17874";
const PASS = "test";
const OUT = path.join(REPO, ".scratch/hand-filter");
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
  ws.on("open", () => ws.send(JSON.stringify({ type: "create", cwd: REPO, name: "补全探针" })));
  ws.on("message", (b) => {
    let m;
    try {
      m = JSON.parse(b.toString());
    } catch {
      return; // 不是 JSON 的帧跟这里无关
    }
    if (m.type === "session.state" && m.session?.name === "补全探针") {
      resolve(m.session.id);
      ws.close();
    }
    if (m.type === "error") reject(new Error(m.message));
  });
  setTimeout(() => reject(new Error("create timeout")), 90000);
});
log("session", sessionId);

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
await page.waitForTimeout(1500); // 命令列表要等 bridge 问完 pi / 扫完磁盘

const field = page.locator(".composer textarea");
async function rowsAfter(text) {
  await field.click();
  await field.fill("");
  await page.waitForTimeout(120);
  await field.pressSequentially(text, { delay: 60 });
  await page.waitForTimeout(600);
  const rows = await page.$$eval(".complete-pop .complete-row", (els) =>
    els.map((r) => {
      const label = r.querySelector(".complete-label")?.textContent ?? "";
      const tag = r.querySelector(".complete-tag")?.textContent ?? "";
      return { label, tag: tag ? `[${tag}]` : "" };
    }),
  );
  const empty = await page.$$eval(".complete-pop .complete-empty", (els) => els.map((e) => e.textContent ?? ""));
  return { rows, empty };
}

let bad = 0;
for (const q of ["/hand", "/skill:hand", "/claude", "/zzzqqq"]) {
  const { rows, empty } = await rowsAfter(q);
  const shown = rows.map((r) => `${r.label}${r.tag}`).join("  ");
  log(q, "→", shown || `空：${empty.join("")}`);
  if (q === "/hand") {
    const labels = rows.map((r) => r.label);
    const ok = labels.includes("/skill:handoff") && labels.includes("/skill:claude-handoff") && !labels.some((l) => /anatomy|postman|full-output|webhook/.test(l));
    if (!ok) bad++;
    log(ok ? "✔ /hand 只剩 handoff 那一族" : "✖ /hand 还在混进不相干的技能");
    await page.screenshot({ path: path.join(OUT, "hand.png") });
  }
}

await browser.close();
log(bad ? `FAIL (${bad})` : "PASS");
process.exit(bad ? 1 : 0);
