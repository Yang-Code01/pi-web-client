/** Browser smoke test: create a fresh session over WS, then drive the real UI in Chromium. */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const STATE = process.env.PI_WEB_STATE ?? "F:/pi-web-client/.scratch/test-state";
const BASE = process.env.PI_WEB_BASE ?? "http://127.0.0.1:7867";
const OUT = "F:/pi-web-client/.scratch/shots";
fs.mkdirSync(OUT, { recursive: true });
const pass = fs.readFileSync(`${STATE}/passphrase.txt`, "utf8").trim();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --- create a dedicated session so the test never pokes a real terminal session
const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const sessionId = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie } });
  ws.on("open", () => ws.send(JSON.stringify({ type: "create", cwd: "F:/pi-web-client", name: "ui 测试" })));
  ws.on("message", (b) => {
    const m = JSON.parse(b.toString());
    if (m.type === "session.state" && m.session?.name === "ui 测试") {
      resolve(m.session.id);
      ws.close();
    }
    if (m.type === "error") reject(new Error(m.message));
  });
  setTimeout(() => reject(new Error("create timeout")), 60000);
});
log("created session", sessionId);

const browser = await chromium.launch();

async function openAt(width, height, tag) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: "zh-CN" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log(`[${tag}] pageerror:`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error") log(`[${tag}] console:`, m.text().slice(0, 200));
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', pass);
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector(".session-list", { timeout: 20000 });
  return { ctx, page };
}

const { page, ctx } = await openAt(390, 844, "mobile");
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/ui-mobile-sessions.png` });
log("mobile: session list rendered, cards =", await page.locator(".session-card").count());

await page.goto(`${BASE}/#/s/${sessionId}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".composer textarea", { timeout: 20000 });
await page.waitForTimeout(600);

const ta = page.locator(".composer textarea");
await ta.fill("只回复三个字：收到了");
await ta.press("Enter");
await page.waitForFunction(
  () => [...document.querySelectorAll(".msg.assistant")].some((n) => (n.textContent ?? "").includes("收到了")),
  null,
  { timeout: 120000 },
);
log("mobile: reply rendered");
await page.waitForFunction(
  () => {
    const t = document.querySelector(".composer textarea");
    return Boolean(t && t.placeholder.includes("说点什么"));
  },
  null,
  { timeout: 120000 },
);
await page.screenshot({ path: `${OUT}/ui-mobile-chat.png` });

await ta.fill("用 bash 工具执行：rm -rf F:/pi-web-client/.scratch/ui-nonexistent");
await ta.press("Enter");
await page.waitForSelector(".approval", { timeout: 120000 });
log("mobile: approval card:", (await page.locator(".approval .t").first().innerText()).slice(0, 50));
await page.screenshot({ path: `${OUT}/ui-mobile-approval.png` });

await page.click('.approval button:has-text("拒绝")');
await page.waitForTimeout(1200);
log("mobile: approvals left =", await page.locator(".approval").count());
await page.screenshot({ path: `${OUT}/ui-mobile-after-reject.png` });

await page.click('.tabs button:has-text("需要你")');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/ui-mobile-queue.png` });
await ctx.close();

const d = await openAt(1440, 900, "desktop");
await d.page.goto(`${BASE}/#/s/${sessionId}`, { waitUntil: "domcontentloaded" });
await d.page.waitForSelector(".composer textarea", { timeout: 20000 });
await d.page.waitForTimeout(800);
await d.page.screenshot({ path: `${OUT}/ui-desktop.png` });
log("desktop: rendered");
await d.ctx.close();

await browser.close();
log("DONE");
