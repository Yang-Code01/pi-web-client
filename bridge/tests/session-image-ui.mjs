/**
 * #269：图片点开大图（UI）。
 *
 * 两个入口，各自要能点开、能关：
 *   A. 会话记录里的用户气泡 —— 画布是 `/api/session/image`，点开灯箱看原图；
 *   B. 待发图片弹层 —— 缩略图整块可点，灯箱里是本地 data URL。
 *
 * 会话文件手写、pi 用假实现，不花模型 turn。端口默认 7894，`IMAGE_UI_PORT` 可改。
 *
 *   node bridge/tests/session-image-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.IMAGE_UI_PORT ?? 7894);
const ROOT = path.join(REPO, ".scratch", "session-image-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const BASE = `http://127.0.0.1:${PORT}`;

const SID = "0190cccc-0000-7000-8000-0000000000f1";
const ENTRY = "0190cccc-0000-7000-8000-0000000000f2";
const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

const encode = (cwd) => `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const DIR = path.join(AGENT, "sessions", encode(WORK));
fs.mkdirSync(DIR, { recursive: true });

const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-01T00:00:01.000Z";
const file = path.join(DIR, `2026-01-01T00-00-00-000Z_${SID}.jsonl`);
fs.writeFileSync(
  file,
  [
    JSON.stringify({ type: "session", version: 3, id: SID, timestamp: t0, cwd: WORK }),
    JSON.stringify({
      type: "message",
      id: ENTRY,
      parentId: null,
      timestamp: t1,
      message: {
        role: "user",
        content: [
          { type: "text", text: "看这张" },
          { type: "image", mimeType: "image/png", data: PNG_A.toString("base64") },
        ],
        timestamp: Date.parse(t1),
      },
    }),
  ].join("\n") + "\n",
);

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
};
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

let browser;
try {
  for (let i = 0; i < 150; i++) {
    try {
      if (fs.existsSync(path.join(STATE, "passphrase.txt")) && (await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* wait */
    }
    await sleep(200);
  }

  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/#/s/${SID}`);
  await page.waitForSelector(".msg.user .msg-image img", { timeout: 30000 });
  const thumb = page.locator(".msg.user .msg-image img").first();
  const src = await thumb.getAttribute("src");
  check("气泡里画出了缩略图，源头是桥的图片接口", Boolean(src && src.includes(`/api/session/image?id=${SID}`)), String(src));
  check("缩略图有可点提示", (await page.locator(".msg.user .msg-image").first().getAttribute("title")) === "点击查看大图");

  await page.locator(".msg.user .msg-image").first().click();
  await page.waitForSelector(".image-view .image-view-img", { timeout: 5000 });
  const big = await page.locator(".image-view-img").getAttribute("src");
  const natural = await page.locator(".image-view-img").evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight, complete: img.complete }));
  check("点开灯箱，图是原图（1×1 PNG 解码成功）", Boolean(big === src) && natural.complete && natural.w === 1 && natural.h === 1, JSON.stringify(natural));
  await page.keyboard.press("Escape");
  await page.waitForSelector(".image-view", { state: "detached", timeout: 5000 });
  check("Escape 关掉灯箱", (await page.locator(".image-view").count()) === 0);

  // 待发区：用合成 paste 塞一张图，走真实 addImages → 弹层。
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "pasted.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_A.toString("base64"));
  await page.waitForSelector(".composer .image-badge", { timeout: 10000 });
  check("粘贴后出现待发角标 +1 图", (await page.locator(".composer .image-badge").innerText()).includes("1"));

  await page.locator(".composer .image-badge").click();
  await page.waitForSelector(".image-sheet .image-open", { timeout: 5000 });
  check("弹层里缩略图包在按钮里", (await page.locator(".image-sheet .image-open").count()) === 1);
  await page.locator(".image-sheet .image-open").click();
  await page.waitForSelector(".image-view .image-view-img", { timeout: 5000 });
  const pendingSrc = await page.locator(".image-view-img").getAttribute("src");
  check("待发缩略图点开灯箱（本地 data URL）", Boolean(pendingSrc?.startsWith("data:image/")), String(pendingSrc?.slice(0, 24)));
  await page.locator(".image-view-x").click();
  await page.waitForSelector(".image-view", { state: "detached", timeout: 5000 });
  check("× 关掉灯箱", (await page.locator(".image-view").count()) === 0);

  // 真发出去：桥内存里的 `user:N` 原图也要能点开（pi 还没把它写进会话文件）。
  await page.locator(".image-sheet .btn.ghost").click();
  await page.waitForSelector(".image-sheet", { state: "detached", timeout: 5000 });
  await page.locator(".composer textarea").click();
  await page.keyboard.press("Enter");
  const live = page.locator('.msg.user .msg-image img[src*="item=user"]').last();
  await live.waitFor({ timeout: 20000 });
  const liveSrc = await live.getAttribute("src");
  const liveOk = await live.evaluate((img) => img.complete && img.naturalWidth > 0);
  check("刚发出的图片走桥内存，也能点开", Boolean(liveSrc?.includes("item=user")) && liveOk, String(liveSrc?.slice(0, 80)));
  await page.locator('.msg.user .msg-image').last().click();
  await page.waitForSelector(".image-view .image-view-img", { timeout: 5000 });
  check("发出的图片灯箱解码成功", (await page.locator(".image-view-img").evaluate((img) => img.naturalWidth)) > 0);
  await page.keyboard.press("Escape");

  check("过程中没有页面异常", errors.length === 0, errors.join(" | "));
} catch (err) {
  check(`用例未跑完：${String(err?.message ?? err)}`, false);
} finally {
  await browser?.close().catch(() => {});
  try {
    bridge.kill();
  } catch {
    /* already gone */
  }
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n${failed.length} 项失败；bridge 日志尾巴：\n${bridgeLog.split("\n").slice(-40).join("\n")}`);
  process.exit(1);
}
console.log("\n全部通过");
