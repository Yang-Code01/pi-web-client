/** Verifies the model sheet: catalog arrives, switching changes the chip, thinking chips work. */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const STATE = process.env.PI_WEB_STATE ?? "F:/pi-web-client/.scratch/test-state";
const BASE = process.env.PI_WEB_BASE ?? "http://127.0.0.1:7867";
const OUT = "F:/pi-web-client/.scratch/shots";
const pass = fs.readFileSync(`${STATE}/passphrase.txt`, "utf8").trim();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const r = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: pass }) });
const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
const sid = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie } });
  ws.on("open", () => ws.send(JSON.stringify({ type: "create", cwd: "F:/pi-web-client", name: "模型测试" })));
  ws.on("message", (b) => {
    const m = JSON.parse(b.toString());
    const st = m.type === "session.state" ? m.session : m.type === "session" ? m.state : null;
    if (st?.name === "模型测试") { resolve(st.id); ws.close(); }
  });
  setTimeout(() => reject(new Error("create timeout")), 60000);
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => log("pageerror:", e.message));
await page.goto(`${BASE}/#/s/${sid}`, { waitUntil: "domcontentloaded" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', pass);
  await page.click('button:has-text("进入")');
  await page.waitForTimeout(600);
  await page.goto(`${BASE}/#/s/${sid}`, { waitUntil: "domcontentloaded" });
}
await page.waitForSelector(".model-chip", { state: "visible", timeout: 30000 });
log("chip before:", await page.innerText(".model-chip"));
await page.waitForTimeout(1500);
await page.click(".model-chip");
await page.waitForSelector(".sheet", { timeout: 10000 });
const rows = await page.locator(".model-row").count();
log("models in sheet:", rows);
await page.screenshot({ path: `${OUT}/ui-model-sheet.png` });

const second = page.locator(".model-row").nth(2);
const picked = (await second.locator(".m-name").innerText()).trim();
await second.click();
await page.waitForTimeout(2500);
log("picked:", picked, "| chip now:", await page.innerText(".model-chip"));

await page.click(".model-chip");
await page.waitForSelector(".sheet", { timeout: 10000 });
log("thinking chips:", await page.locator(".levels .chip").allInnerTexts());
const before = await page.innerText(".model-chip");
await page.locator(".levels .chip").last().click();
await page.waitForTimeout(2000);
log("after thinking chip:", before, "->", await page.innerText(".model-chip"));
await page.screenshot({ path: `${OUT}/ui-model-sheet-levels.png` });
await browser.close();
log("DONE");
