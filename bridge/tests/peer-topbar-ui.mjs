/**
 * #396 主界面探针：顶栏「🌐 内网通」在有未读时画一颗圆点（不写数字），读完后消失；
 * 内网通没在跑时不画、不发 /api/peer/unread、控制台不报错。
 *
 * 真 bridge（PI_PEER=0，不拉起 peer 子进程）+ 页面里用 page.route 假造 /api/peer 与 /api/peer/unread，
 * 其余接口走真 bridge。主界面约每 5 秒查一次未读，这里顺带量相邻两次查询的间隔。
 *
 *   npm run build:bridge && npm run build:web && node bridge/tests/peer-topbar-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const PORT = 7933;
const ROOT = path.join(REPO, ".scratch", "peer-topbar-ui");
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
      if (await fn()) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
};

// 假的内网通状态：running 决定 /api/peer 说不说在跑，total 是 /api/peer/unread 回的未读总数。
const peer = { running: true, total: 2, unreadAt: [] };
const dotSel = '.topbar [data-act="peer"] .dot';

let browser;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.route("**/api/peer**", async (route) => {
    const url = new URL(route.request().url());
    let body = {};
    if (url.pathname === "/api/peer") body = { enabled: true, running: peer.running, reason: "", status: null };
    else if (url.pathname === "/api/peer/unread") {
      peer.unreadAt.push(Date.now());
      body = { ok: true, total: peer.total, threads: peer.total ? [{ nodeId: "aaaaaaaa-1111-4111-8111-111111111111", unread: peer.total }] : [] };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', pass);
    await page.click('button:has-text("进入")');
  }
  await page.locator('.topbar [data-act="peer"]').waitFor({ state: "visible", timeout: 20000 });

  // ---- 有未读：画一颗圆点，不写数字 ----
  await page.locator(dotSel).waitFor({ state: "attached", timeout: 7000 }).catch(() => {});
  const dots = await page.locator(dotSel).count();
  const dotText = dots ? (await page.locator(dotSel).first().textContent()).trim() : "";
  check("有未读时顶栏「内网通」出现圆点，且不写数字", dots === 1 && dotText === "", `圆点=${dots}，文字=「${dotText}」`);

  // ---- 查询节奏：约每 5 秒一次 ----
  await until(() => peer.unreadAt.length >= 3, 16000, "3 次未读查询");
  const gaps = peer.unreadAt.slice(1).map((t, i) => t - peer.unreadAt[i]);
  check("主界面约每 5 秒查一次未读", gaps.every((g) => g >= 3500 && g <= 6500), `间隔 ms=${gaps.join(", ")}`);

  // ---- 读完：圆点消失 ----
  peer.total = 0;
  await page.locator(dotSel).waitFor({ state: "detached", timeout: 7000 }).catch(() => {});
  const cleared = await page.locator(dotSel).count();
  check("全部读完后圆点消失", cleared === 0, `圆点=${cleared}`);

  // ---- 内网通没在跑：不画、不查未读、控制台不报错 ----
  peer.running = false;
  peer.total = 3;
  await sleep(300);
  const errorsBefore = errors.length;
  const queriesBefore = peer.unreadAt.length;
  await sleep(6000);
  const offDots = await page.locator(dotSel).count();
  check("内网通没在跑时不显示圆点", offDots === 0, `圆点=${offDots}`);
  check("内网通没在跑时不查未读", peer.unreadAt.length === queriesBefore, `查询次数增量=${peer.unreadAt.length - queriesBefore}`);
  const newErrors = errors.slice(errorsBefore);
  check("内网通没在跑时控制台不报错", newErrors.length === 0, newErrors.join(" | "));

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
  console.error(`\npeer-topbar-ui：${bad.length} 项失败`);
  process.exit(1);
}
log("peer-topbar-ui 全过");
process.exit(0);
