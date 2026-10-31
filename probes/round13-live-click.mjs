/**
 * 在**活着的**应用上，精确复现「点纯文件名链接」这件事，记录三样东西：
 *   1) 链接自身的 title（渲染层真正携带的路径）
 *   2) 客户端发出的每一次 /api/preview 请求体（第一跳、兜底跳都在这里）
 *   3) 右侧面板最终显示的路径
 *
 * 不改代码、不重启，只读。
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const STATE = "C:/Users/GG_Bond/AppData/Local/pi-web-client";
const pass = fs.readFileSync(STATE + "/passphrase.txt", "utf8").trim();
const HOST = "http://127.0.0.1:7864";
const NAME = process.env.SESSION_NAME || "追加开发";

const login = await fetch(HOST + "/api/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: pass }),
});
const setCookie = (login.headers.getSetCookie?.() ?? [])[0] ?? "";
const [name0, value] = setCookie.split(";")[0].split("=");
let host = "127.0.0.1";
try {
  host = new URL(HOST).hostname;
} catch {
  host = "127.0.0.1";
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addCookies([{ name: name0, value, domain: host, path: "/" }]);
const page = await ctx.newPage();

const posts = [];
page.on("request", (req) => {
  if (req.url().includes("/api/preview") && req.method() === "POST") posts.push(req.postData());
});
const previews = [];
page.on("response", async (res) => {
  if (!res.url().includes("/api/preview")) return;
  let body = "";
  try {
    body = (await res.text()).slice(0, 160);
  } catch {
    body = "(no body)";
  }
  previews.push({ status: res.status(), body });
});

await page.goto(HOST + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const bodyText = (await page.locator("body").innerText()).slice(0, 400).split(/\s+/).join(" ");
console.log("页面文本前 400 字:", bodyText);
console.log("会话卡数量:", await page.locator(".session-card").count());
await page.screenshot({ path: ".scratch/round13-live.png" });

// 找到名字匹配的会话并打开
const card = page.locator(".session-card", { hasText: NAME }).first();
await card.click();
await page.waitForTimeout(2500);

const cwdLine = await page.locator(".session-card.active .cwd").first().textContent().catch(() => null);
console.log("当前会话卡 class:", await page.locator(".session-card.active").first().getAttribute("class").catch(() => "?"));
console.log("当前会话:", NAME, "| 左栏 cwd 文本:", cwdLine);

// 找正文里文字正好是「问题记录.md」的链接
const links = page.locator(".msg a");
const n = await links.count();
const found = [];
for (let i = 0; i < n; i++) {
  const t = (await links.nth(i).textContent())?.trim();
  if (t === "问题记录.md") {
    found.push({ i, title: await links.nth(i).getAttribute("title") });
  }
}
console.log("正文里文字为「问题记录.md」的链接:", JSON.stringify(found));

if (!found.length) {
  console.log("没找到该链接 —— 先看正文里有哪些链接：");
  for (let i = 0; i < Math.min(n, 20); i++) {
    const t = (await links.nth(i).textContent())?.trim();
    console.log("  ", JSON.stringify(t), "title=", await links.nth(i).getAttribute("title"));
  }
} else {
  const target = links.nth(found[found.length - 1].i);
  await target.click();
  await page.waitForTimeout(2500);
  console.log("发出的 /api/preview 请求体:");
  for (const p of posts) console.log("  ", p);
  console.log("对应响应:");
  for (const r of previews) console.log("  ", r.status, r.body.replace(/\n/g, " "));
  const shown = await page.locator(".viewer-path").first().textContent().catch(() => null);
  console.log("面板标题行:", shown);
}

await browser.close();
