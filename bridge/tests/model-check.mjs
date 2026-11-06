/** Verifies the model sheet: catalog arrives, switching changes the chip, thinking chips work. */
import path from "node:path";
import fs from "node:fs";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const STATE = process.env.PI_WEB_STATE ?? path.join(REPO, ".scratch/test-state");
const BASE = process.env.PI_WEB_BASE ?? "http://127.0.0.1:7867";
const OUT = path.join(REPO, ".scratch/shots");
const pass = fs.readFileSync(`${STATE}/passphrase.txt`, "utf8").trim();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const r = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: pass }) });
const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
const sid = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie } });
  ws.on("open", () => ws.send(JSON.stringify({ type: "create", cwd: REPO, name: "模型测试" })));
  ws.on("message", (b) => {
    const m = JSON.parse(b.toString());
    const st = m.type === "session.state" ? m.session : m.type === "session" ? m.state : null;
    if (st?.name === "模型测试") { resolve(st.id); ws.close(); }
  });
  setTimeout(() => reject(new Error("create timeout")), 60000);
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN" });
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
// 面板是「草稿 + 确认」式：挑一行不会自己关掉，也不会立刻生效。
await page.locator(".sheet .btn.primary").click();
await page.waitForSelector(".sheet", { state: "detached", timeout: 10000 });
await page.waitForTimeout(2500);
log("picked:", picked, "| chip now:", await page.innerText(".model-chip"));

await page.click(".model-chip");
await page.waitForSelector(".sheet", { timeout: 10000 });
// 最后一个 .levels 是「思考档位」；上面那个装的是上下文预算。
const levelChips = page.locator(".sheet .levels").last().locator(".chip");
log("thinking chips:", await levelChips.allInnerTexts());
const before = await page.innerText(".model-chip");
// 只有选了「跟现在不一样」的档位，确认按钮才会亮；全一样就没什么可验的。
let pick = -1;
for (let i = 0; i < (await levelChips.count()); i++) {
  if (!(await levelChips.nth(i).evaluate((e) => e.classList.contains("on")))) { pick = i; break; }
}
if (pick >= 0) {
  await levelChips.nth(pick).click();
  await page.locator(".sheet .btn.primary").click();
  await page.waitForSelector(".sheet", { state: "detached", timeout: 10000 });
  await page.waitForTimeout(2000);
} else {
  log("思考档位与当前一致，跳过这一步");
}
log("after thinking chip:", before, "->", await page.innerText(".model-chip"));
await page.screenshot({ path: `${OUT}/ui-model-sheet-levels.png` });
await browser.close();
log("DONE");
