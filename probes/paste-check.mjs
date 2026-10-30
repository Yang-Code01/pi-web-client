/**
 * 粘贴图片的浏览器验证：截图粘贴（Ctrl+V / ⌘V）应当落到待发图片里。
 * 用真实的 Chromium + 真实 paste 事件（DataTransfer 带 File），不是 mock。
 *
 * 需要：隔离桥在 7867（PI_WEB_STATE=F:/pi-web-client/.scratch/test-state）
 * 跑：node probes/paste-check.mjs
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const STATE = process.env.PI_WEB_STATE ?? "F:/pi-web-client/.scratch/test-state";
const BASE = process.env.PI_WEB_BASE ?? "http://127.0.0.1:7867";
const pass = fs.readFileSync(`${STATE}/passphrase.txt`, "utf8").trim();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const { sessions } = await (await fetch(`${BASE}/api/sessions`, { headers: { cookie } })).json();
if (!sessions?.length) throw new Error("测试状态目录里没有会话，先跑一次 e2e");
const sessionId = sessions[0].id;
log("使用会话", sessionId.slice(0, 8), "| 共", sessions.length);

const browser = await chromium.launch();

/** 在页面里构造一次真实粘贴（clipboardData 里放 File / 文本）。 */
const paste = (page, { text = "", files = 1 }) =>
  page.evaluate(
    ({ text, files }) => {
      const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      if (text) dt.setData("text/plain", text);
      for (let i = 0; i < files; i++) dt.items.add(new File([bytes], `image-${i}.png`, { type: "image/png" }));
      const ta = document.querySelector("textarea");
      ta?.focus();
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, focused: document.activeElement?.tagName };
    },
    { text, files },
  );

const badge = (page) => page.evaluate(() => document.querySelector(".row .badge")?.textContent?.trim() ?? "");

const open = async (tag, userAgent) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", ...(userAgent ? { userAgent } : {}) });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    failures++;
    log(`[${tag}] pageerror:`, e.message);
  });
  await page.goto(`${BASE}/#/s/${sessionId}`, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', pass);
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector("textarea", { timeout: 20000 });
  return { ctx, page };
};

// ---------------------------------------------------------------- 1) 桌面：纯图片粘贴
{
  const { ctx, page } = await open("desktop");
  const hint = await page.locator(".hint").first().innerText();
  check("提示条里写了粘贴键", /Ctrl\+V|⌘V/.test(hint), JSON.stringify(hint.replace(/\s+/g, " ").slice(0, 80)));
  const before = await page.locator("textarea").inputValue();

  const r1 = await paste(page, { files: 1 });
  await page.waitForTimeout(300);
  check("纯图片粘贴：拦下默认行为", r1.prevented === true, `prevented=${r1.prevented}`);
  check("纯图片粘贴：出现 +1 图", (await badge(page)) === "+1 图", await badge(page));
  check("纯图片粘贴：输入框仍是焦点", (await page.evaluate(() => document.activeElement?.tagName)) === "TEXTAREA");
  check("纯图片粘贴：文字没被污染", (await page.locator("textarea").inputValue()) === before);

  // 再贴两张：同一会话里累加
  const r2 = await paste(page, { files: 2 });
  await page.waitForTimeout(300);
  check("多张图片：累加到 +3 图", (await badge(page)) === "+3 图", `${await badge(page)} prevented=${r2.prevented}`);

  // 纯文本粘贴不接管
  const r3 = await paste(page, { text: "hello", files: 0 });
  await page.waitForTimeout(200);
  check("纯文本粘贴：不拦默认行为", r3.prevented === false, `prevented=${r3.prevented}`);
  check("纯文本粘贴：图片数不变", (await badge(page)) === "+3 图", await badge(page));

  // 图文混合：文字走默认插入，图片另存
  const r4 = await paste(page, { text: "配图说明", files: 1 });
  await page.waitForTimeout(300);
  check("图文混合：不拦默认行为", r4.prevented === false, `prevented=${r4.prevented}`);
  check("图文混合：图片再加一张", (await badge(page)) === "+4 图", await badge(page));

  await page.screenshot({ path: "F:/pi-web-client/.scratch/shots/paste-desktop.png" });
  await ctx.close();
}

// ---------------------------------------------------------------- 2) 手机上（iPhone UA）：提示键位 + 粘贴仍可用
{
  const iPhone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const { ctx, page } = await open("mobile", iPhone);
  const hint = await page.locator(".hint").first().innerText();
  check("iPhone：提示条显示 ⌘V", hint.includes("⌘V"), JSON.stringify(hint.replace(/\s+/g, " ").slice(0, 80)));
  await paste(page, { files: 1 });
  await page.waitForTimeout(300);
  check("iPhone：粘贴图片生效", (await badge(page)) === "+1 图", await badge(page));
  await ctx.close();
}

// ---------------------------------------------------------------- 3) 焦点在别的输入框时不抢
{
  const { ctx, page } = await open("rename");
  await page.evaluate(() => {
    const other = document.createElement("input");
    other.id = "probe-input";
    document.body.append(other);
    other.focus();
  });
  const r = await page.evaluate(() => {
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "x.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById("probe-input").dispatchEvent(ev);
    return { prevented: ev.defaultPrevented };
  });
  await page.waitForTimeout(200);
  check("别的输入框粘贴：不接管", r.prevented === false, `prevented=${r.prevented}`);
  check("别的输入框粘贴：没有加图", (await badge(page)) === "", await badge(page));
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
