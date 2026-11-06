/**
 * Probe: 文件管理器顶部那条「输入路径」——文件夹进去、文件跳到父目录并高亮那一行、没有的路径原地报错。
 *
 * 用一个一次性 bridge（自己的端口 / state / 工作目录），不碰正式实例和真会话。
 * 覆盖单测覆盖不到的那半：/api/stat → navigate → 高亮 → 焦点，以及 Esc / 盘符页 / 弹层里不该有它。
 *
 * Run: node probes/fs-path-jump.mjs        （先 npm run build，探针跑的是 dist）
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const PORT = Number(process.env.PI_WEB_PORT ?? 7882);
const ROOT = path.join(REPO, ".scratch/fs-jump");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "zz-fs-jump";

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK, OUT]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixture: one session whose cwd is WORK
const sdir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(sdir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "输入路径跳转验证" }] } },
  { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name: "路径跳转" },
];
fs.writeFileSync(path.join(sdir, `${SID}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

fs.mkdirSync(path.join(WORK, "sub"), { recursive: true });
fs.writeFileSync(path.join(WORK, "笔记.md"), "# 笔记\n", "utf8");
fs.writeFileSync(path.join(WORK, "page.html"), "<!doctype html><html><body>x</body></html>", "utf8");
fs.writeFileSync(path.join(WORK, "plain.txt"), "纯文本\n", "utf8");
fs.writeFileSync(path.join(WORK, "sub", "inside.md"), "# 子目录\n", "utf8");

function killPort(port) {
  try {
    const pids = new Set();
    const out = execSync("netstat -ano", { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+(\S+)\s+\S+\s+(\d+)$/);
      if (m && Number(m[1]) === port && /:0$/.test(m[2])) pids.add(Number(m[3]));
    }
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" }); } catch {}
    }
    if (pids.size) console.log(`cleared stale bridge on :${port}`);
  } catch {}
}
killPort(PORT);

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(200);
  }
  console.error(bridgeOut.join("").slice(-3000));
  assert(false, `timeout waiting for ${label}`);
}

let browser = null;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 15000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 10000, "one card");
  await page.locator(".session-card").first().click();
  await page.locator(".topbar .icon-btn", { hasText: "文件" }).click();
  await page.locator(".viewer-browse .dirpicker").waitFor({ timeout: 10000 });
  await until(async () => (await page.locator(".dirpicker .file-row").count()) >= 3, 10000, "files listed");

  const input = page.locator(".dir-jump-input");
  const err = page.locator(".dir-jump-err");
  const jump = async (text) => {
    await input.fill(text);
    await input.press("Enter");
  };
  const hit = () => page.locator(".dirpicker .file-row.hit .nm");
  const rows = () => page.locator(".dirpicker .file-row").count();

  // ---- 1. 框在，提示语在，页面上没有多余的东西
  await input.waitFor({ timeout: 5000 });
  assert((await input.getAttribute("placeholder")) === "输入路径，回车定位到文件夹或文件", `placeholder (got ${await input.getAttribute("placeholder")})`);
  assert((await page.locator(".dir-jump").count()) === 1, "one jump row");
  log("1 jump box mounted");

  // ---- 2. 绝对路径指向文件夹 → 进去（不是高亮）
  await jump(path.join(WORK, "sub"));
  await until(async () => (await page.locator(".dir-path").textContent()).includes("sub"), 8000, "entered sub");
  await until(async () => (await rows()) === 1, 8000, "sub listed");
  assert((await page.locator(".dirpicker .file-row .nm").textContent()) === "inside.md", "sub lists inside.md");
  assert((await input.inputValue()) === "", "input cleared after a folder jump");
  assert((await page.locator(".dirpicker .file-row.hit").count()) === 0, "a folder jump highlights nothing");
  log("2 folder → 进入 ok");

  // ---- 3. 绝对路径指向文件 → 回到父目录并把那一行标出来，焦点也在那一行上
  await jump(path.join(WORK, "page.html"));
  await until(async () => (await hit().textContent()) === "page.html", 8000, "page.html hit");
  assert((await rows()) >= 3, "parent folder listed");
  const focusName = await page.evaluate(() => document.activeElement?.textContent ?? "");
  assert(focusName.includes("page.html"), `focus moved to the row (got ${focusName})`);
  assert((await page.locator(".viewer-head .pane-seg button.on").textContent()) === "浏览", "still on 浏览 — a jump locates, it does not open");
  await page.screenshot({ path: path.join(OUT, "1-file-hit.png"), animations: "disabled" });
  log("3 file → 父目录 + 高亮 ok");

  // ---- 4. Explorer 的「复制为路径」带引号：照样认
  await jump(`"${path.join(WORK, "plain.txt")}"`);
  await until(async () => (await hit().textContent()) === "plain.txt", 8000, "plain.txt hit");
  assert(/plain\.txt$/.test(await input.inputValue()) === false, "quoted path cleared");
  log("4 quoted path ok");

  // ---- 5. 相对路径按当前目录算
  await jump("笔记.md");
  await until(async () => (await hit().textContent()) === "笔记.md", 8000, "笔记.md hit");
  log("5 relative path ok");

  // ---- 6. 没有这个路径 → 原地报错，列表不动，输入留着等人改
  const before = await rows();
  await jump(path.join(WORK, "nope.txt"));
  await until(async () => (await err.textContent()).includes("没有这个路径"), 8000, "missing-path error");
  assert((await rows()) === before, "list untouched on a miss");
  assert((await page.locator(".dirpicker .file-row.hit").count()) === 0, "a miss clears the previous highlight");
  assert((await input.inputValue()).endsWith("nope.txt"), "input keeps the typo to fix");
  await page.screenshot({ path: path.join(OUT, "2-missing.png"), animations: "disabled" });
  await input.fill("");
  log("6 missing path ok:", await err.textContent());

  // ---- 7. Esc 只清这一格，不关面板；第二下离开输入框
  await input.fill("C:\\");
  await input.press("Escape");
  assert((await input.inputValue()) === "", "Esc clears the box");
  assert((await page.locator(".viewer").count()) === 1, "Esc must not close the viewer");
  assert((await page.evaluate(() => document.activeElement?.className ?? "")).includes("dir-jump-input"), "first Esc keeps focus");
  await input.press("Escape");
  assert(!(await page.evaluate(() => document.activeElement?.className ?? "")).includes("dir-jump-input"), "second Esc leaves the box");
  assert((await page.locator(".viewer").count()) === 1, "viewer still open");
  log("7 Esc ok");

  // ---- 8. 盘符页没有「当前目录」可拼：相对路径要说清楚，而不是落到 bridge 的 cwd
  await page.locator(".dir-path .crumb", { hasText: "此电脑" }).click();
  await until(async () => (await page.locator(".vol-row").count()) >= 1, 8000, "drives listed");
  await jump("work");
  await until(async () => (await err.textContent()).includes("完整路径"), 8000, "drive-page relative error");
  assert((await page.locator(".vol-row").count()) >= 1, "still on the drive list");
  await input.fill("");
  log("8 drive page ok:", await err.textContent());

  // ---- 9. 只给文件管理器：新会话 / 附件的 picker 里不该多出这一行
  await page.locator(".viewer-head .viewer-btn", { hasText: "✕" }).click();
  await page.locator(".new-session .btn.primary").click();
  await page.locator(".sheet .btn.ghost", { hasText: "浏览" }).click();
  await page.locator(".ns-browser .dirpicker .dir-row").first().waitFor({ timeout: 10000 });
  assert((await page.locator(".ns-browser .dir-jump").count()) === 0, "new-session picker has no jump box");
  await page.locator(".new-sheet .sheet-head .btn.ghost", { hasText: "取消" }).click();
  await page.locator(".hint-tools .btn.ghost", { hasText: "文件" }).click();
  await page.locator(".file-picker-body .dirpicker .file-row").first().waitFor({ timeout: 10000 });
  assert((await page.locator(".file-picker-body .dir-jump").count()) === 0, "attachment picker has no jump box");
  log("9 scoped to the file manager ok");

  log("ALL PASS · shots in", OUT);
} catch (err) {
  console.error(bridgeOut.join("").slice(-3000));
  throw err;
} finally {
  await browser?.close();
  bridge.kill();
}
