/**
 * #397 网页图标红点探针：页面不在前台（document.hidden）且有未读、免打扰没开时，标签页的 <link rel=icon>
 * 换成「原图标 + 右上角红点」的画布图；切回前台立即还原原 href；标题文字不随未读变化。
 * 主界面（/）测红点、切回恢复、免打扰；独立内网通页面（/peer）不换标签图标、不画标签红点（用户决定），只看组件上的圆点与列表数字。
 *
 * 真 bridge（PI_PEER=0，不拉起 peer 子进程），页面里 page.route 假造 /api/peer、/api/peer/unread、
 * /api/peer/threads 等。「离开页面」用 init script 覆盖 document.hidden / visibilityState，再派发 visibilitychange。
 *
 *   npm run build:bridge && npm run build:web && node bridge/tests/peer-favicon-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const PORT = 7934;
const ROOT = path.join(REPO, ".scratch", "peer-favicon-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const BASE = `http://127.0.0.1:${PORT}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });

const out = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_PEER: "0", PI_AGENT_DIR: AGENT, PI_CODING_AGENT_DIR: AGENT },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", (b) => out.push(b.toString()));
bridge.stderr.on("data", (b) => out.push(b.toString()));

const until = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
};

// 页面「在不在前台」由这个变量决定；init script 在每次页面加载前覆盖 document.hidden / visibilityState。
const hiddenInit = (hidden) => `window.__hidden = ${hidden};
Object.defineProperty(Document.prototype, "hidden", { configurable: true, get() { return window.__hidden; } });
Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get() { return window.__hidden ? "hidden" : "visible"; } });`;
const setHidden = (page, hidden) =>
  page.evaluate((h) => {
    window.__hidden = h;
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

// 当前标签图标：href 原样返回；red 表示图标右上角区域里有红色像素（把图标画到 64×64 画布上取样）。
const iconState = (page) =>
  page.evaluate(async () => {
    const link = document.querySelector('link[rel~="icon"]');
    const href = link ? link.getAttribute("href") ?? "" : "";
    if (!href) return { href, red: false };
    const img = new Image();
    img.src = href;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, 64, 64);
    const px = ctx.getImageData(40, 0, 24, 24).data;
    let red = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] < 80 && px[i + 2] < 80 && px[i + 3] > 200) red++;
    return { href, red: red > 20 };
  });

const ME = "99999999-8888-4777-8666-555555555555";
const ZHANG = "aaaaaaaa-1111-4111-8111-111111111111";
// 假的内网通状态：running 决定 /api/peer 说不说在跑；total 是 /api/peer/unread 的总数；unread 是对话列表里小张那一行的数；dnd 是免打扰。
const peer = { running: true, total: 2, unread: 2, dnd: false };
const peerStatus = () => ({
  nodeId: ME,
  nickname: "我",
  hostname: "test-host",
  port: 7865,
  online: [],
  config: { hidden: false, pauseFiles: false, dnd: peer.dnd, inbox: "", manual: [] },
});
const zhangThread = () => ({
  nodeId: ZHANG,
  nickname: "小张",
  hostname: "test-host",
  port: 7865,
  last: { id: "00000000-0000-4000-8000-00000000000a", at: Date.now() - 60_000, from: { nodeId: ZHANG, nickname: "小张" }, to: { kind: "node", id: ME }, kind: "text", text: "在吗" },
  count: 1,
  unread: peer.unread,
  online: true,
});
const peerRoute = async (route) => {
  const url = new URL(route.request().url());
  const p = url.pathname;
  let body = {};
  if (p === "/api/peer") body = { enabled: true, running: peer.running, reason: "", status: peerStatus() };
  else if (p === "/api/peer/unread") body = { ok: true, total: peer.total, threads: peer.total ? [{ nodeId: ZHANG, unread: peer.total }] : [] };
  else if (p === "/api/peer/threads") body = { threads: [zhangThread()] };
  else if (p === "/api/peer/read") {
    peer.unread = 0;
    peer.total = 0;
  } else if (p === "/api/peer/contacts") body = { contacts: [] };
  else if (p === "/api/peer/transfers") body = { transfers: [], free: 1e12 };
  else if (p === "/api/peer/messages") body = { entries: [] };
  else if (p === "/api/peer/ignored") body = { ok: true, nodeIds: [] };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
};

let browser;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
  const pageErrors = [];
  await ctx.route("**/api/peer**", peerRoute);

  // ---- 主界面 ----
  const main = await ctx.newPage();
  main.on("pageerror", (e) => pageErrors.push(`主界面: ${e.message}`));
  await main.addInitScript(hiddenInit(false));
  await main.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await main.locator('input[type="password"]').count()) {
    await main.fill('input[type="password"]', pass);
    await main.click('button:has-text("进入")');
  }
  await main.locator('.topbar [data-act="peer"]').waitFor({ state: "visible", timeout: 20000 });
  const mainBase = await main.getAttribute('link[rel~="icon"]', "href", { timeout: 5000 }).catch(() => null);
  const mainTitle = await main.title();

  // 前台有未读：不画红点（轮询完成后再看一次）。
  await until(async () => (await main.locator('.topbar [data-act="peer"] .dot').count()) === 1, 7000, "主界面顶栏圆点");
  check("前台有未读时主界面不画红点", !(await iconState(main)).red, `href 是否原样=${(await iconState(main)).href === mainBase}`);

  // 切到后台：红点出现，标题不变。
  await setHidden(main, true);
  await until(async () => (await iconState(main)).red, 4000, "主界面后台红点");
  check("后台有未读时主界面网页图标出现红点", true);
  check("主界面标题文字不随未读变化", (await main.title()) === mainTitle, `标题=「${await main.title()}」`);

  // 切回前台：立即恢复原 href。
  await setHidden(main, false);
  await until(async () => (await iconState(main)).href === mainBase && !(await iconState(main)).red, 2000, "主界面恢复");
  check("切回前台后主界面恢复原图标", (await main.getAttribute('link[rel~="icon"]', "href")) === mainBase);

  // 后台 + 读完：红点消失。
  await setHidden(main, true);
  await until(async () => (await iconState(main)).red, 4000, "主界面后台红点（再次）");
  peer.total = 0;
  await until(async () => !(await iconState(main)).red, 9000, "主界面读完后红点消失");
  check("后台读完后主界面红点消失", true);

  // 又有未读：红点回来；免打扰开启：红点不出现，顶栏圆点照常。
  peer.total = 2;
  await until(async () => (await iconState(main)).red, 9000, "主界面新未读红点");
  check("后台又有未读时主界面红点回来", true);
  peer.dnd = true;
  await until(async () => !(await iconState(main)).red, 9000, "主界面免打扰下红点消失");
  check("免打扰开启时主界面不出现红点", true);
  const mainDotsDnd = await main.locator('.topbar [data-act="peer"] .dot.unread').count();
  check("免打扰开启时主界面顶栏圆点照常", mainDotsDnd === 1, `圆点=${mainDotsDnd}`);
  peer.dnd = false;
  await until(async () => (await iconState(main)).red, 9000, "主界面关免打扰后红点回来");
  await setHidden(main, false);
  await until(async () => !(await iconState(main)).red, 2000, "主界面切回前台");
  await main.close();

  // ---- 独立内网通页面（/peer）：一开始就在后台，模拟「后台标签页里有未读」 ----
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`内网通页面: ${e.message}`));
  await page.addInitScript(hiddenInit(true));
  await page.goto(`${BASE}/peer`, { waitUntil: "domcontentloaded" });
  // 独立页不换标签图标（用户决定）：没有 <link rel=icon>，后台有未读也不画标签红点；未读只看组件上的圆点。
  await until(async () => (await page.locator("#rail .dot.unread, #mobnav .dot.unread").count()) >= 1, 9000, "内网通页面消息圆点");
  const peerIconLinks = await page.locator('link[rel~="icon"]').count();
  check("独立内网通页面没有标签图标", peerIconLinks === 0, `link=${peerIconLinks}`);
  const peerIcon = await iconState(page);
  check("后台有未读时独立内网通页面不画标签红点", !peerIcon.red, `href=「${peerIcon.href}」`);
  check("内网通页面标题文字不随未读变化", (await page.title()) === "内网通 · pi", `标题=「${await page.title()}」`);

  const pill = await page.locator(".pill.unread").first().textContent().catch(() => "");
  check("未读时内网通页面列表数字照常", pill.trim() === "2", `列表数字=「${pill.trim()}」`);

  check("两个页面都没有运行时错误", pageErrors.length === 0, pageErrors.join(" | "));

  const bad = results.filter((r) => !r.ok);
  if (bad.length) throw new Error(`${bad.length} 项失败`);
} catch (err) {
  check("脚本跑完", false, err?.message ?? String(err));
  console.error(out.join("").slice(-3000));
} finally {
  if (browser) await browser.close().catch(() => {});
  bridge.kill();
}

const bad = results.filter((r) => !r.ok);
if (bad.length) {
  console.error(`\npeer-favicon-ui：${bad.length} 项失败`);
  process.exit(1);
}
log("peer-favicon-ui 全过");
process.exit(0);
