// 截图：已接管 bar 的两种文案（网页新建 = 停止运行 / 磁盘接管 = 让回终端）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "file:///F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs";
const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const PORT = 7867;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = "F:/pi-web-client/.scratch/test-state";
const OUT = "F:/pi-web-client/.scratch/shots";
const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie } });
const waiters = new Map();
ws.on("message", (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.type === "session") waiters.get("session")?.(msg.sessionId);
});
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "create", cwd: "F:/pi-web-client", name: "网页新建的会话" }));
const webId = await new Promise((resolve, reject) => {
  waiters.set("session", resolve);
  setTimeout(() => reject(new Error("create timeout")), 15000);
});
console.log("web-born session:", webId);

const { sessions } = await (await fetch(`${BASE}/api/sessions`, { headers: { cookie } })).json();
const disk = sessions.find((s) => s.id !== webId && !s.owned && Date.now() - s.updatedAt > 60000);
console.log("disk session:", disk?.id, disk?.name?.slice(0, 20));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(`${BASE}/`);
await page.fill("input[type=password], input[type=text]", pass).catch(() => {});
await page.keyboard.press("Enter");
await page.waitForSelector(".session-card", { timeout: 15000 });

for (const [name, id, pre] of [["web", webId, false], ["disk", disk.id, true]]) {
  if (pre) {
    ws.send(JSON.stringify({ type: "claim", sessionId: id }));
    await new Promise((r) => setTimeout(r, 3000));
  }
  await page.goto(`${BASE}/#/s/${id}`);
  await page.waitForSelector(".takeover", { timeout: 15000 });
  await page.waitForTimeout(700);
  const label = await page.locator(".takeover button").first().innerText();
  const text = await page.locator(".takeover span").first().innerText();
  const box = await page.locator(".composer, .chat-foot").first().boundingBox();
  await page.screenshot({ path: `${OUT}/owned-${name}.png`, clip: box });
  console.log(name, "| button:", label, "| text:", text);
}
await browser.close();
for (const id of [webId, disk.id]) ws.send(JSON.stringify({ type: "close", sessionId: id }));
await new Promise((r) => setTimeout(r, 800));
ws.close();
