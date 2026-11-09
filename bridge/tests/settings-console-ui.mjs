/**
 * #283 设置控制台壳：真界面里验的是「壳」本身，不是哪一页的字段 ——
 * 左栏两组九项、标题跟着页走、更新日志两本账合成一页用分段切、每个 nav 都有内容、
 * 900px 横排、Escape 关闭。自带丢弃式 bridge（fake pi，不花模型 turn），不碰 7864。
 *
 *   npm run build && node bridge/tests/settings-console-ui.mjs
 *
 * 端口默认 7918，可用 SETTINGS_CONSOLE_UI_PORT 改。截图落在 .scratch/shots/settings-console-*.png。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.SETTINGS_CONSOLE_UI_PORT ?? 7918);
const ROOT = path.join(REPO, ".scratch", "settings-console-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PROJECT = path.join(ROOT, "project");
const SHOTS = path.join(REPO, ".scratch", "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "settings-console-ui-pass";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed = true;
    console.error("  FAIL", msg);
  }
};
async function until(fn, ms = 20000, what = "") {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(150);
  }
}

// pi 的更新日志要真包：`changelog(pi.cli)` 从安装目录读 `CHANGELOG.md`。
delete process.env.PI_BIN;
const { resolvePi } = await import("../dist/pi.js");
const realPkg = path.dirname(path.dirname(path.dirname(resolvePi().cli)));

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(AGENT, { recursive: true });
fs.mkdirSync(PROJECT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const env = { ...process.env };
for (const k of Object.keys(env)) if (/_API_KEY$|_TOKEN$/.test(k)) delete env[k];
Object.assign(env, {
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  PI_WEB_PI_PKG: realPkg,
  PI_OFFLINE: "1",
  PI_PEER: "0",
});
// 第一遍只把口令写下来，长驻的那份读回去。
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
const bridgeLog = [];
bridge.stdout.on("data", (b) => bridgeLog.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeLog.push(b.toString()));

let browser;
try {
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  check(login.status === 200 && cookie, "登录");

  // 设置页要有 cwd 才谈得上「项目」那份与项目信任：先经 WS 建一个会话，再按它的地址打开网页。
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const seen = [];
  ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  await until(() => seen.some((m) => m.type === "hello"), 10000, "hello");
  ws.send(JSON.stringify({ type: "create", cwd: PROJECT, name: "settings-console-ui" }));
  const created = await until(() => seen.find((m) => m.type === "session" && m.sessionId), 20000, "create");
  ws.close();
  check(Boolean(created), `会话（${created.sessionId}）`);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 940 } });
  await ctx.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${BASE}/#/s/${created.sessionId}`, { waitUntil: "domcontentloaded" });
  await page.locator(".composer textarea").waitFor({ timeout: 20000 });

  // ---------------------------------------------------------------- A. 壳
  log("A. /settings 打开控制台壳");
  await page.locator(".composer textarea").fill("/settings");
  await page.keyboard.press("Enter");
  await page.locator(".st-console").waitFor({ timeout: 20000 });
  check((await page.locator(".st-console").count()) === 1, "控制台壳在");
  check((await page.locator(".st-head").count()) === 1 && (await page.locator(".st-main").count()) === 1, "head + main");
  check((await page.locator(".st-foot").count()) === 1, "foot");
  // innerText 会被 text-transform: uppercase 改掉，这里要的是原文。
  const eyebrow = (await page.locator(".st-eyebrow").evaluate((n) => n.textContent ?? "")).trim();
  check(eyebrow === "pi 设置", `eyebrow「pi 设置」（${eyebrow}）`);
  const title = (await page.locator(".st-title").innerText()).trim();
  check(title === "设置", `标题跟着页走（${title}）`);

  const groups = (await page.locator(".st-nav__group").allInnerTexts()).map((s) => s.trim());
  check(groups.length === 2 && groups[0] === "设置" && groups[1] === "系统", `左栏两组（${groups.join(" / ")}）`);
  const navCount = await page.locator(".st-nav__item").count();
  check(navCount === 9, `左栏 9 项（${navCount}）`);
  const labels = (await page.locator(".st-nav__label").allInnerTexts()).map((s) => s.trim());
  check(
    labels.join("/") === "全局与项目/项目信任/登录·凭据/口令/扩展与 MCP/子代理/通知/运行时/更新日志",
    `九项文案（${labels.join(" / ")}）`,
  );

  // ---------------------------------------------------------------- B. 每一页都能打开、都有内容
  log("B. 逐个点开九项");
  const pages = [
    ["global", "设置", "全局与项目", "settings"],
    ["trust", "项目信任", "项目信任", "信任"],
    ["login", "登录·凭据", "登录·凭据", ""],
    ["passphrase", "口令", "口令", "口令"],
    ["ext", "扩展与 MCP", "扩展与 MCP", ""],
    ["subagents", "子代理", "子代理", "子代理"],
    ["notify", "通知", "通知", "通知"],
    ["runtime", "运行时", "运行时", "运行"],
    ["changelog", "更新日志", "更新日志", ""],
  ];
  for (const [tab, wantTitle, wantNav, keyword] of pages) {
    await page.locator(`.st-nav__item[data-tab="${tab}"]`).click();
    const text = await until(
      async () => {
        const t = (await page.locator(".st-pane").innerText()).trim();
        return t.length > 30 ? t : null;
      },
      25000,
      `pane ${tab}`,
    );
    const heading = (await page.locator(".st-title").innerText()).trim();
    check(heading === wantTitle, `${tab}：标题「${wantTitle}」（${heading}）`);
    check(!keyword || text.includes(keyword), `${tab}：正文有内容（${text.length} 字）`);
    const on = (await page.locator(".st-nav__item.on").innerText()).trim();
    check(on === wantNav, `${tab}：左栏亮着这一项（${on}）`);
    if (tab === "global" || tab === "subagents") {
      await page.screenshot({ path: path.join(SHOTS, `settings-console-${tab}.png`) });
    }
  }

  // ---------------------------------------------------------------- C. 刷新只重读、不关面板
  log("C. 刷新按钮");
  await page.locator(".st-head__actions button", { hasText: "刷新" }).click();
  const refreshed = await until(
    async () => {
      const t = (await page.locator(".st-pane").innerText()).trim();
      return t.length > 200 ? t : null;
    },
    25000,
    "pane after refresh",
  );
  check((await page.locator(".st-console").count()) === 1, "刷新后面板还开着");
  check(refreshed.length > 200, `刷新后这一页还有正文（${refreshed.length} 字）`);

  // ---------------------------------------------------------------- D. 更新日志两本账合成一页
  log("D. 更新日志：页内分段切 pi / 本项目");
  const segs = (await page.locator(".st-seg .st-seg__btn").allInnerTexts()).map((s) => s.trim());
  check(segs.join("/") === "pi/本项目", `分段两项（${segs.join(" / ")}）`);
  const piText = await until(
    async () => {
      const t = await page.locator(".st-pane").innerText();
      return t.includes("当前 pi") ? t : null;
    },
    25000,
    "pi changelog",
  );
  check(piText.includes("Changelog") || piText.length > 200, `pi 那份有正文（${piText.length} 字）`);
  await page.locator('.st-seg__btn[data-tab="whatsnew"]').click();
  const selfText = await until(
    async () => {
      const t = await page.locator(".st-pane").innerText();
      return t.includes("当前版本") ? t : null;
    },
    25000,
    "self changelog",
  );
  check(!selfText.includes("当前 pi"), "切到「本项目」是另一份正文");
  check((await page.locator(".st-seg__btn.on").innerText()).trim() === "本项目", "分段亮在「本项目」");
  // 深链仍按 tab id 落：/whatsnew 直接停在这一段。
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".st-console").count()) === 0, 5000, "escape");
  await page.locator(".composer textarea").fill("/whatsnew");
  await page.keyboard.press("Enter");
  await page.locator(".st-console").waitFor({ timeout: 20000 });
  check(
    (await page.locator(".st-seg__btn.on").innerText()).trim() === "本项目",
    "/whatsnew 落在同一页的「本项目」段",
  );
  await page.screenshot({ path: path.join(SHOTS, "settings-console-1440.png") });

  // ---------------------------------------------------------------- E. 900px 左栏横排
  log("E. 900px：左栏横排");
  await page.setViewportSize({ width: 900, height: 940 });
  await page.waitForTimeout(300);
  const dir = await page.locator(".st-nav").evaluate((n) => getComputedStyle(n).flexDirection);
  check(dir === "row", `900px 左栏 flex-direction: row（${dir}）`);
  const navBox = await page.locator(".st-nav").boundingBox();
  const paneBox = await page.locator(".st-pane").boundingBox();
  check(Boolean(navBox && paneBox) && paneBox.y >= navBox.y + navBox.height - 1, "左栏在正文上方（单列）");
  const overflow = await page.locator(".st-console").evaluate((n) => n.scrollWidth - n.clientWidth);
  check(overflow <= 1, `900px 不横向溢出（${overflow}px）`);
  await page.screenshot({ path: path.join(SHOTS, "settings-console-900.png") });

  // ---------------------------------------------------------------- F. Escape
  log("F. Escape 关闭");
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".st-console").count()) === 0, 5000, "escape close");
  check((await page.locator(".st-console").count()) === 0, "Escape 关掉控制台");
  check(pageErrors.length === 0, `没有 pageerror${pageErrors.length ? `：${pageErrors.slice(0, 3).join(" | ")}` : ""}`);
  if (pageErrors.length) failed = true;
} catch (e) {
  failed = true;
  console.error("  FAIL", e.message);
  console.error(bridgeLog.join("").slice(-3000));
} finally {
  await browser?.close();
  bridge.kill();
}

console.log(failed ? "settings-console-ui: FAILED" : "settings-console-ui: ok");
process.exit(failed ? 1 : 0);
