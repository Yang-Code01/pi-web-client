import fs from "node:fs";
import { pathToFileURL } from "node:url";
const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const STATE = "F:/pi-web-client/.scratch/test-state";
const BASE = "http://127.0.0.1:7867";
const pass = fs.readFileSync(`${STATE}/passphrase.txt`, "utf8").trim();
const login = await fetch(`${BASE}/api/login`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({passphrase:pass})});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const sid = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{width:390,height:844} });
const page = await ctx.newPage();
page.on("websocket", (ws) => {
  ws.on("framereceived", (f) => {
    try { const m = JSON.parse(f.payload.toString()); if (["item.add","item.replace","delta","items","session","tool","pi.status"].includes(m.type)) console.log("<<", m.type, m.id ?? "", JSON.stringify(m).slice(0,150)); } catch {}
  });
  ws.on("framesent", (f) => { try { const m = JSON.parse(f.payload.toString()); console.log(">>", m.type, JSON.stringify(m).slice(0,120)); } catch {} });
});
await page.goto(BASE + "/#/s/" + sid, { waitUntil: "domcontentloaded" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', pass);
  await page.click('button:has-text("进入")');
  await page.waitForTimeout(500);
  await page.goto(BASE + "/#/s/" + sid, { waitUntil: "domcontentloaded" });
}
await page.waitForSelector(".composer textarea", {timeout:20000});
await page.waitForTimeout(500);
const ta = page.locator(".composer textarea");
await ta.fill("说一句：测试一下");
await ta.press("Enter");
await page.waitForTimeout(12000);
console.log("=== chat children ===");
console.log(await page.evaluate(() => [...document.querySelectorAll(".chat-scroll > *")].map(n => n.className + " :: " + (n.textContent||"").slice(0,60)).join("\n")));
await browser.close();
