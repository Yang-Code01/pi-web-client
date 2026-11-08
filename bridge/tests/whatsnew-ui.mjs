/**
 * D190 在真界面里跑一遍：设置页现在有**两本账** —— 「pi 更新日志」还是装机里 pi 包那份，
 * 「本项目更新日志」是检出根的 `CHANGELOG.md`，`/whatsnew` 直达后者。自带丢弃式 bridge，
 * 不花模型 turn，也不碰 7864。
 *
 *   node bridge/tests/whatsnew-ui.mjs
 *
 * 验的是只有真 DOM 才知道的三件事：
 *   A. `/settings` 打开后两个 tab 都在；切到「本项目」能看到我们自己写的批次标题与「当前版本 x」；
 *   B. 切回「pi」是另一份文档（pi 的 Changelog），两页内容不串味；
 *   C. 敲 `/whatsnew` 直接落在这一页，不用再点 tab。
 *
 * 端口默认 7887（其余探针占 7888、7891–7899），可用 WHATSNEW_UI_PORT 改。
 * 截图落在 .scratch/shots/whatsnew-*.png。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.WHATSNEW_UI_PORT ?? 7887);
const ROOT = path.join(REPO, ".scratch", "whatsnew-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PROJECT = path.join(ROOT, "project");
const SHOTS = path.join(REPO, ".scratch", "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "whatsnew-ui-pass";

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

  // 设置页的入口在聊天里，先建一个会话（设置本身只写全局文件，不需要项目信任）。
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const seen = [];
  ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  await until(() => seen.some((m) => m.type === "hello"), 10000, "hello");
  ws.send(JSON.stringify({ type: "create", cwd: PROJECT, name: "whatsnew-ui" }));
  const created = await until(() => seen.find((m) => m.type === "session" && m.sessionId), 20000, "create");
  ws.close();
  check(Boolean(created), `会话（${created.sessionId}）`);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
  await ctx.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    failed = true;
    console.error("  FAIL pageerror:", e.message);
  });
  await page.goto(`${BASE}/#/s/${created.sessionId}`, { waitUntil: "domcontentloaded" });
  await page.locator(".composer textarea").waitFor({ timeout: 20000 });

  const bodyText = () => page.locator(".settings-body").innerText();

  // ---------------------------------------------------------------- A. 两个 tab 都在
  log("A. /settings → 切到「本项目更新日志」");
  await page.locator(".composer textarea").fill("/settings");
  await page.keyboard.press("Enter");
  await until(() => page.locator(".settings-sheet").count(), 10000, "settings sheet");
  const labels = await page.locator(".settings-tabs .chip").allInnerTexts();
  check(labels.includes("pi 更新日志") && labels.includes("本项目更新日志"), `两个 tab（${labels.join(" / ")}）`);

  await page.locator(".settings-tabs .chip", { hasText: "本项目更新日志" }).click();
  const ours = await until(async () => {
    const t = await bodyText();
    return t.includes("当前版本") && t.length > 200 ? t : null;
  }, 15000, "self changelog");
  check(ours.includes("当前版本 0.1.0"), "顶部显示项目的版本");
  check(ours.includes("历史分页与子代理设置"), "正文是我们自己的批次标题");
  check(ours.includes("#228") || ours.includes("#229"), "条目带 PR 锚点");
  check(!ours.includes("<!--") && !ours.includes("写到 10f96a0"), "HTML 注释没漏到页面上");
  const title = await page.locator(".settings-sheet .sheet-title").innerText();
  check(title === "本项目更新日志", `面板标题跟着 tab 走（${title}）`);
  await page.screenshot({ path: path.join(SHOTS, "whatsnew-self.png") });

  // ---------------------------------------------------------------- B. 切回 pi 那份
  log("B. 切回「pi 更新日志」");
  await page.locator(".settings-tabs .chip", { hasText: "pi 更新日志" }).click();
  const pi = await until(async () => {
    const t = await bodyText();
    return t.includes("Changelog") && t.length > 200 ? t : null;
  }, 15000, "pi changelog");
  check(!pi.includes("历史分页与子代理设置"), "pi 那页没有我们的批次（两份不串味）");
  check((await page.locator(".settings-sheet .sheet-title").innerText()) === "pi 更新日志", "pi 那页标题也换了");

  // ---------------------------------------------------------------- C. /whatsnew 直达
  log("C. 关掉面板，敲 /whatsnew");
  await page.locator(".settings-sheet .sheet-head button", { hasText: "关闭" }).click();
  await until(async () => (await page.locator(".settings-sheet").count()) === 0, 5000, "sheet closed");
  await page.locator(".composer textarea").fill("/whatsnew");
  await page.keyboard.press("Enter");
  await until(() => page.locator(".settings-sheet").count(), 10000, "sheet again");
  await until(async () => (await bodyText()).includes("当前版本"), 15000, "self tab by command");
  const active = await page.locator(".settings-tabs .chip.on").innerText();
  check(active === "本项目更新日志", `/whatsnew 落在这一页（激活 ${active}）`);

  // ---------------------------------------------------------------- D. 正文里的路径能点开
  log("D. 点正文里的 docs/DECISIONS.md");
  await page.locator(".settings-body a.file-link", { hasText: "docs/DECISIONS.md" }).first().click();
  await until(async () => (await page.locator(".settings-sheet").count()) === 0, 5000, "sheet closed by link");
  const shown = await until(async () => {
    const n = page.locator(".viewer .viewer-path");
    return (await n.count()) ? n.first().innerText() : null;
  }, 10000, "viewer opened");
  check(shown.includes("DECISIONS.md"), `预览里打开的是 ${shown}`);
} catch (e) {
  failed = true;
  console.error("  FAIL", e.message);
  console.error(bridgeLog.join("").slice(-2000));
} finally {
  await browser?.close();
  bridge.kill();
}

console.log(failed ? "whatsnew-ui: FAILED" : "whatsnew-ui: ok");
process.exit(failed ? 1 : 0);
