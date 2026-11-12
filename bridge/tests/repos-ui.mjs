/**
 * #392: 非 git 工作目录（伞形目录）里，路径 chip 不再只复制，而是打开「目录与仓库」。
 *
 * 这个测试自己起一份 bridge（临时口令 / 临时 state / fake pi），造一棵伞形目录：
 * 根不是仓库，下面 api、ui 是两个真仓库，docs 不是，node_modules / .git 要被藏掉。
 * 然后按用户路径点一遍：收起左栏 → 点路径 chip → 树里找仓库 → 选中 → 内嵌工作台 →
 * 分支浮层 → 折叠竖条 → Esc 层叠 → 重开回原位 → 窄屏抽屉 → 仓库会话仍然只复制。
 *
 * 先 `npm run build`（bridge/dist + web/dist 都是这里的输入），再：
 *   npm run test:repos:ui
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-repos-ui-"));
const STATE = path.join(ROOT, "state");
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const PORT = Number(process.env.REPOS_UI_PORT ?? 7928);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "repos-ui-pass";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok   " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`repos-ui failed: ${name}${detail ? ` — ${detail}` : ""}`);
};

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "core.fsmonitor=false", "-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8" },
  ).trim();

const put = (cwd, file, text) => {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `ui: ${file}`);
};

// 桥端与界面统一用正斜杠，Windows 的 path.join 结果要转一下再比。
const posix = (p) => p.split("\\").join("/");
const umbrella = path.join(ROOT, "umbrella");
const api = path.join(umbrella, "api");
const ui = path.join(umbrella, "ui");
fs.mkdirSync(umbrella, { recursive: true });
for (const repo of [api, ui]) {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf8" });
}
put(api, "a.txt", "one");
put(api, "b.txt", "two");
// 工作台的「对照列」要求有远程分支：给 api 造一个 bare origin，否则历史 tab 只会显示 base_unknown。
const apiBare = path.join(ROOT, "api-origin.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", apiBare], { encoding: "utf8" });
git(api, "remote", "add", "origin", apiBare);
git(api, "push", "-q", "-u", "origin", "main");
git(api, "remote", "set-head", "origin", "-a");
git(api, "checkout", "-q", "-b", "feat/x");
put(api, "a.txt", "from-feat");
git(api, "checkout", "-q", "main");
fs.writeFileSync(path.join(api, "dirty.txt"), "dirty\n");
put(ui, "u.txt", "ui");
for (const dir of ["docs", "scripts", "node_modules", ".cache"]) fs.mkdirSync(path.join(umbrella, dir), { recursive: true });
fs.writeFileSync(path.join(umbrella, "docs", "readme.md"), "docs\n");
check("伞形目录不是仓库", (() => {
  try {
    git(umbrella, "rev-parse", "--show-toplevel");
    return false;
  } catch {
    return true;
  }
})());

fs.mkdirSync(STATE, { recursive: true });
const env = {
  ...process.env,
  PI_WEB_STATE: STATE,
  PI_AGENT_DIR: path.join(ROOT, "agent"),
  PI_WEB_PORT: String(PORT),
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_TUNNEL: "0",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_BIN: FAKE_PI,
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (chunk) => (bridgeLog += chunk.toString()));
bridge.stderr.on("data", (chunk) => (bridgeLog += chunk.toString()));
let browser;
let socket;

try {
  let healthy = false;
  for (let i = 0; i < 100; i += 1) {
    try {
      healthy = (await fetch(`${BASE}/healthz`)).ok;
      if (healthy) break;
    } catch {
      /* starting */
    }
    await sleep(200);
  }
  check("自建 bridge 起来了", healthy);

  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  check("登录成功", login.ok, `HTTP ${login.status}`);
  const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");
  const cookie = `${cookieName}=${cookieValue}`;

  socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const frames = [];
  socket.on("message", (chunk) => frames.push(JSON.parse(chunk.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const create = (cwd, name) => socket.send(JSON.stringify({ type: "create", cwd, name }));
  create(umbrella, "umbrella-ui");
  create(api, "api-ui");
  let umbrellaId = null;
  let apiId = null;
  for (let i = 0; i < 120 && (!umbrellaId || !apiId); i += 1) {
    for (const f of frames) {
      if (f.type !== "session" || !f.state?.id) continue;
      if (f.state.cwd === umbrella) umbrellaId = f.state.id;
      if (f.state.cwd === api) apiId = f.state.id;
    }
    if (!umbrellaId || !apiId) await sleep(100);
  }
  check("两个临时会话都建好了", Boolean(umbrellaId && apiId));

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  await page.goto(`${BASE}/#/s/${umbrellaId}`);
  await page.waitForSelector(".app", { timeout: 20000 });
  // cwd chip 只在左栏收起时出现（#15523 的既有行为，不改）。
  await page.click('.side-toggle[data-act="sessions"]');
  await page.waitForSelector(".cwd-chip:not([hidden])", { timeout: 10000 });
  check(
    "非仓库 cwd 的 chip 提示改成「浏览子仓库」",
    (await page.getAttribute(".cwd-chip", "title"))?.includes("浏览子仓库") === true,
  );
  check("打开前没有「目录与仓库」", (await page.locator(".repos-sheet").count()) === 0);

  await page.click(".cwd-chip");
  await page.waitForSelector(".repos-sheet", { timeout: 10000 });
  check("chip 点开「目录与仓库」", (await page.locator(".repos-sheet").count()) === 1);
  check("标题与根目录", (await page.locator(".repos-title").innerText()) === "目录与仓库");

  // 第一层：api / ui 是仓库；docs、scripts 不是；node_modules 与点目录不出现。
  await page.waitForFunction(
    (dir) => [...document.querySelectorAll(".repos-row")].some((row) => row.dataset.dir === dir && row.querySelector(".repos-git")),
    posix(api),
    { timeout: 20000 },
  );
  const names = await page.$$eval(".repos-row .repos-name", (els) => els.map((e) => e.textContent));
  check("只列目录、藏掉点目录与 node_modules", names.includes("api") && names.includes("ui") && names.includes("docs") && !names.includes("node_modules") && !names.some((n) => n?.startsWith(".")), names.join(","));
  const apiRowText = await page.locator(`.repos-row[data-dir="${api.replace(/\\/g, "/")}"]`).innerText();
  check("子仓库行标了分支", apiRowText.includes("main"), apiRowText);
  const uiRowText = await page.locator(`.repos-row[data-dir="${ui.replace(/\\/g, "/")}"]`).innerText();
  check("第二个子仓库也标了分支", uiRowText.includes("main"), uiRowText);

  // 选中 api → 内嵌工作台，而不是另起一层遮罩。
  await page.click(`.repos-row[data-dir="${api.replace(/\\/g, "/")}"]`);
  await page.waitForSelector(".branch-sheet.go-embedded", { timeout: 20000 });
  check("右栏内嵌工作台", (await page.locator(".repos-sheet .branch-back").count()) === 0);
  check("内嵌时不再画自己的标题和 ✕", (await page.locator(".branch-sheet.go-embedded .branch-title").isHidden()) === true && (await page.locator(".branch-sheet.go-embedded .branch-x").isHidden()) === true);
  const crumb = await page.locator(".repos-crumb").innerText();
  check("头部显示仓库与分支", crumb.includes("api") && crumb.includes("main"), crumb.replace(/\n/g, " "));
  await page.waitForSelector(".branch-sheet.go-embedded .go-tabs", { timeout: 20000 });
  await page.waitForSelector(".branch-sheet.go-embedded .go-tabs button[data-tab=\"history\"]", { timeout: 20000 });
  const tabButtons = await page.$$eval(".branch-sheet.go-embedded .go-tabs button", (els) => els.map((e) => e.getAttribute("data-tab")));
  check("三个 tab 都在", tabButtons.length === 3, tabButtons.join("/"));

  // 分支 aside 收进面板头部下拉。
  check("分支浮层默认收起", (await page.locator(".go-side-pop").isHidden()) === true);
  await page.click(".go-side-toggle");
  check("点开浮层能看到分支列表", (await page.locator(".go-side-pop").isVisible()) === true);
  check("浮层里仍有两颗 CTA", (await page.locator(".go-side-pop .go-side-cta").count()) === 2);
  check("浮层里有分支分组标题", (await page.locator(".go-side-pop .go-side-title").innerText()).includes("分支"));
  check("历史占满宽：aside 不在列里，只在下拉里", (await page.locator(".branch-sheet.go-embedded .go-history aside.go-branch-side").count()) === 0 && (await page.locator(".go-side-pop aside.go-branch-side").count()) === 1);

  // 竖条折叠：折叠后树只剩 26px 的竖条，点它回来。
  await page.click(".repos-tree .repos-fold");
  check("目录列折叠成竖条", (await page.locator(".repos-strip-tree").isVisible()) === true && (await page.locator(".repos-tree").isHidden()) === true);
  const stripLabel = await page.locator(".repos-strip-tree .repos-strip-label").innerText();
  check("竖条上写着「目录」", stripLabel === "目录", stripLabel);
  await page.click(".repos-strip-tree");
  check("点竖条展开回来", (await page.locator(".repos-tree").isVisible()) === true);

  // Esc 层叠：先关分支浮层，再关窗；不是一把把窗关了。
  await page.keyboard.press("Escape");
  check("第一次 Esc 只关浮层", (await page.locator(".go-side-pop").isHidden()) === true && (await page.locator(".repos-sheet").count()) === 1);
  await page.keyboard.press("Escape");
  check("第二次 Esc 关窗", (await page.locator(".repos-sheet").count()) === 0);

  // 重开：按 cwd 记住选中与展开。
  await page.click(".cwd-chip");
  await page.waitForSelector(".repos-sheet", { timeout: 10000 });
  await page.waitForSelector(".branch-sheet.go-embedded", { timeout: 20000 });
  check("重开回到上次选中的仓库", (await page.locator(".repos-crumb").innerText()).includes("api"));

  // 窄屏：目录列变抽屉，选中后自动收起。
  await page.setViewportSize({ width: 620, height: 860 });
  await page.waitForTimeout(200);
  check("窄屏出现「目录」按钮", (await page.locator(".repos-drawerbtn").isVisible()) === true);
  check("窄屏目录默认收起", (await page.locator(".repos-tree").isHidden()) === true);
  await page.click(".repos-drawerbtn");
  check("点「目录」拉出抽屉", (await page.locator(".repos-tree").isVisible()) === true);
  await page.click(`.repos-row[data-dir="${ui.replace(/\\/g, "/")}"]`);
  check("选中后抽屉自动收起", (await page.locator(".repos-tree").isHidden()) === true);
  check("右栏换到 ui", (await page.locator(".repos-crumb").innerText()).includes("ui"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.keyboard.press("Escape");

  // 仓库会话：chip 还是复制，不弹窗。
  await page.goto(`${BASE}/#/s/${apiId}`);
  await page.waitForSelector(".git-chip", { timeout: 20000 });
  if (await page.locator(".cwd-chip[hidden]").count()) await page.click('.side-toggle[data-act="sessions"]');
  await page.waitForSelector(".cwd-chip:not([hidden])", { timeout: 10000 });
  check("仓库 cwd 的 chip 仍是复制提示", (await page.getAttribute(".cwd-chip", "title"))?.includes("点一下复制路径") === true);
  await page.click(".cwd-chip");
  await page.waitForTimeout(150);
  check("仓库会话点 chip 不弹窗", (await page.locator(".repos-sheet").count()) === 0);

  check("控制台没有 error", consoleErrors.length === 0, consoleErrors.join(" | "));
} catch (err) {
  console.error("\n--- bridge log ---\n" + bridgeLog.slice(-4000));
  throw err;
} finally {
  await browser?.close();
  socket?.close();
  bridge.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
}
