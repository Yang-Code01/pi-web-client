/**
 * Probe: the file explorer (D50) in a real browser — browse a directory, open a file, edit it,
 * save it, hit a 409 conflict and take the "另存副本" way out, then reference the path.
 *
 * Runs a throwaway bridge on its own port with a temp agent dir + temp work dir, so it never
 * touches the real ~/.pi/agent sessions or the real project files.
 *
 * Run: node probes/fs-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const PORT = 7881;
const ROOT = "F:/pi-web-client/.scratch/fs-ui";
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "zz-fs-ui";

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

const dir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(dir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "文件浏览器验证" }] } },
  { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name: "文件浏览器" },
];
fs.writeFileSync(path.join(dir, `${SID}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// The work directory the picker will start in.
fs.mkdirSync(path.join(WORK, "sub"), { recursive: true });
const DOC = path.join(WORK, "笔记.md");
fs.writeFileSync(DOC, "# 笔记\n\n第一行。\n第二行。\n", "utf8");
fs.writeFileSync(path.join(WORK, "page.html"), "<!doctype html><html><body><h1>示例页</h1></body></html>", "utf8");
fs.writeFileSync(path.join(WORK, "plain.txt"), "纯文本\n", "utf8");
fs.writeFileSync(path.join(WORK, "sub", "inside.md"), "# 子目录里的文件\n", "utf8");

// A crashed earlier run leaves its bridge holding the port, and then this probe would silently
// test the OLD dist. Clear the port first.
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
    if (pids.size) console.log(`cleared stale bridge on :${port} (pid ${[...pids].join(",")})`);
  } catch {}
}
killPort(PORT);

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: "F:/pi-web-client",
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });

  // Open the session (the sidebar card carries the name we set).
  await until(async () => (await page.locator(".session-card").count()) >= 1, 10000, "one card");
  await page.locator(".session-card").first().click();
  await page.locator(".topbar .icon-btn", { hasText: "文件" }).waitFor({ timeout: 10000 });

  // ---- 1. 📁 文件 opens the viewer in browse mode, already inside the session cwd
  await page.locator(".topbar .icon-btn", { hasText: "文件" }).click();
  await page.locator(".viewer-browse .dirpicker").waitFor({ timeout: 10000 });
  const heads = await page.$$eval(".viewer-head .pane-seg button", (els) => els.map((e) => e.textContent));
  assert(heads.join() === "浏览,预览,编辑", `pane seg is 浏览/预览/编辑 (got ${heads.join()})`);
  assert((await page.locator(".viewer-head .pane-seg button.on").textContent()) === "浏览", "浏览 is active");
  await until(async () => (await page.locator(".dirpicker .file-row").count()) >= 3, 10000, "files listed");
  const crumbs = await page.locator(".dirpicker .dir-path").textContent();
  assert(crumbs.includes("work"), `path shows the cwd (got ${crumbs})`);
  const shown = await page.$$eval(".dirpicker .file-row .nm", (els) => els.map((e) => e.textContent));
  assert(shown.includes("笔记.md") && shown.includes("page.html") && shown.includes("plain.txt"), `files shown (got ${shown.join(",")})`);
  log("1 browse ok:", shown.join(","));
  await page.screenshot({ path: path.join(OUT, "1-browse.png"), animations: "disabled" });

  // ---- 2. 走子目录再回来（面包屑 = 上一级）
  await page.locator(".dirpicker .dir-row", { hasText: "sub" }).click();
  await until(async () => (await page.locator(".dirpicker .file-row").count()) === 1, 8000, "sub listed");
  await page.locator(".dirpicker .dir-row", { hasText: "上一级" }).click();
  await until(async () => (await page.locator(".dirpicker .file-row").count()) >= 3, 8000, "back in work");
  log("2 drill down + 上一级 ok");

  // ---- 3. 点开 md → 预览态渲染 markdown，编辑按钮可用
  await page.locator(".dirpicker .file-row", { hasText: "笔记.md" }).click();
  await page.locator(".viewer-body .md-doc").waitFor({ timeout: 10000 });
  assert((await page.locator(".viewer-head .pane-seg button.on").textContent()) === "预览", "preview is active");
  const editBtn = page.locator(".viewer-head .pane-seg button", { hasText: "编辑" });
  assert(!(await editBtn.isDisabled()), "编辑 enabled for a small md");
  await page.screenshot({ path: path.join(OUT, "2-preview.png"), animations: "disabled" });

  // ---- 4. 编辑 → 改内容 → Ctrl+S 保存
  await editBtn.click();
  await page.locator(".viewer-body .ed-ta").waitFor({ timeout: 8000 });
  const before = await page.locator(".viewer-body .ed-ta").inputValue();
  assert(before.includes("第一行。"), "editor seeded from disk");
  await page.locator(".viewer-body .ed-ta").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("浏览器里加的一行。\n");
  await page.keyboard.press("Control+s");
  await until(async () => (await page.locator(".ed-msg.ok").count()) === 1, 8000, "saved message");
  assert(fs.readFileSync(DOC, "utf8").includes("浏览器里加的一行。"), "file on disk has the new line");
  await page.screenshot({ path: path.join(OUT, "3-edited.png"), animations: "disabled" });
  log("4 edit + Ctrl+S ok");

  // ---- 5. 磁盘上的文件在编辑期间被改 → 409 冲突条 → 另存副本
  fs.writeFileSync(DOC, "# 笔记\n\npi 在我编辑时改的。\n", "utf8");
  await page.locator(".viewer-body .ed-ta").click();
  await page.keyboard.type("我的版本。\n");
  await page.keyboard.press("Control+s");
  await page.locator(".ed-conflict").waitFor({ timeout: 8000 });
  const ways = await page.$$eval(".ed-conflict-row .btn", (els) => els.map((e) => e.textContent));
  assert(ways.length === 3, `three ways out (got ${ways.join(" / ")})`);
  await page.screenshot({ path: path.join(OUT, "4-conflict.png"), animations: "disabled" });
  await page.locator(".ed-conflict-row .btn", { hasText: "另存副本" }).click();
  await until(() => fs.existsSync(path.join(WORK, "笔记.copy.md")), 8000, "copy file");
  assert(fs.readFileSync(DOC, "utf8").includes("pi 在我编辑时改的"), "original still pi's version");
  await until(async () => (await page.locator(".viewer-name").textContent()) === "笔记.copy.md", 8000, "viewer shows the copy");
  log("5 conflict → 另存副本 ok");

  // ---- 6. 引用按钮把路径塞进输入框
  await page.locator(".viewer-head .viewer-btn", { hasText: "📎" }).click();
  const composer = await page.locator(".composer textarea").first().inputValue();
  assert(composer.includes("笔记.copy.md"), `composer got the path (got ${composer})`);
  log("6 📎 reference ok");

  // ---- 7. 未保存就切走 → 拦住问一句
  await page.locator(".viewer-head .pane-seg button", { hasText: "编辑" }).click();
  await page.locator(".viewer-body .ed-ta").waitFor({ timeout: 8000 });
  await page.locator(".viewer-body .ed-ta").click();
  await page.keyboard.type("没保存的内容。\n");
  await page.locator(".viewer-head .pane-seg button", { hasText: "预览" }).click();
  await page.locator(".choose-back").waitFor({ timeout: 8000 });
  const choices = await page.$$eval(".choose-row .btn", (els) => els.map((e) => e.textContent));
  assert(choices.join() === "保存,放弃改动,取消", `dirty-leave dialog (got ${choices.join()})`);
  await page.screenshot({ path: path.join(OUT, "5-dirty.png"), animations: "disabled" });
  await page.locator(".choose-row .btn", { hasText: "放弃改动" }).click();
  await until(async () => (await page.locator(".viewer-body .md-doc").count()) === 1, 8000, "back to preview");
  log("7 dirty guard ok");

  // ---- 8. 手机：viewer 占满、编辑整屏
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const mp = await phone.newPage();
  mp.on("pageerror", (e) => log("mobile page error:", e.message));
  await mp.goto(`${BASE}/#/s/${SID}`, { waitUntil: "networkidle" });
  await mp.locator(".topbar .icon-btn", { hasText: "文件" }).click();
  await mp.locator(".viewer-browse .dirpicker").waitFor({ timeout: 10000 });
  const mw = await mp.locator(".viewer").evaluate((e) => e.getBoundingClientRect().width);
  assert(mw >= 380, `viewer fills the phone (got ${mw})`);
  await mp.screenshot({ path: path.join(OUT, "6-mobile-browse.png"), animations: "disabled" });
  await mp.locator(".dirpicker .file-row", { hasText: "笔记.md" }).click();
  await mp.locator(".viewer-body .md-doc").waitFor({ timeout: 10000 });
  await mp.locator(".viewer-head .pane-seg button", { hasText: "编辑" }).click();
  await mp.locator(".viewer-body .ed-ta").waitFor({ timeout: 8000 });
  await mp.screenshot({ path: path.join(OUT, "7-mobile-edit.png"), animations: "disabled" });
  log("8 mobile ok");

  // ---- 9. 抽出来的一份浏览组件：新建会话的「📁 浏览」和输入框的「文件」都回归一遍
  await page.locator(".viewer-head .viewer-btn", { hasText: "✕" }).click();
  await page.locator(".new-session .btn.primary").click();
  await page.locator(".sheet .btn.ghost", { hasText: "浏览" }).click();
  await page.locator(".ns-browser .dirpicker .dir-row").first().waitFor({ timeout: 10000 });
  const nsRows = await page.locator(".ns-browser .dirpicker .dir-row").count();
  assert(nsRows >= 1, `new-session picker lists entries (got ${nsRows})`);
  await page.locator(".new-sheet .sheet-head .btn.ghost", { hasText: "取消" }).click();
  log("9a new-session picker ok");

  // 9c. 目录多的时候不许把弹层撑破：列表自己滚，弹层边界不动
  await page.locator(".new-session .btn.primary").click();
  await page.locator(".new-sheet .sheet-head").waitFor();
  // 弹层里有两个 .ns-input.mono（工作目录 + 隐藏的「新建文件夹」），必须指名 .ns-row 里那个
  await page.getByPlaceholder("例如 E:\\yqm\\pi-web-client").fill("F:\\");
  await page.locator(".sheet .btn.ghost", { hasText: "浏览" }).click();
  await page.locator(".ns-browser .dirpicker .dir-row").first().waitFor({ timeout: 10000 });
  // 行是陆续到的：等列表真的溢出再量，否则量到的是还没填满时的样子
  let scrolled = false;
  try {
    await page.waitForFunction(
      () => {
        const l = document.querySelector(".ns-browser .dir-list");
        return !!l && l.scrollHeight > l.clientHeight + 8;
      },
      null,
      { timeout: 8000 },
    );
    scrolled = true;
  } catch {
    scrolled = false;
  }
  if (!scrolled) {
    const dbg = await page.evaluate(() => {
      const l = document.querySelector(".ns-browser .dir-list");
      const dp = document.querySelector(".ns-browser .dirpicker");
      return {
        rows: document.querySelectorAll(".ns-browser .dirpicker .dir-row").length,
        list: l ? { sh: l.scrollHeight, ch: l.clientHeight, css: getComputedStyle(l).maxHeight, ov: getComputedStyle(l).overflowY } : null,
        path: dp?.querySelector(".dir-path")?.textContent ?? null,
        input: document.querySelector(".ns-input.mono")?.value ?? null,
      };
    });
    log("9c debug:", JSON.stringify(dbg));
  }
  assert(scrolled, "long folder list scrolls inside the sheet instead of stretching it");
  await page.screenshot({ path: path.join(OUT, "8-new-sheet.png"), animations: "disabled" });
  const box = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
    const list = document.querySelector(".ns-browser .dir-list");
    return {
      vh: window.innerHeight,
      sheet: r(".new-sheet")?.bottom ?? 0,
      browser: r(".ns-browser")?.bottom ?? 0,
      scroll: list?.scrollHeight ?? 0,
      client: list?.clientHeight ?? 0,
    };
  });
  assert(box.sheet <= box.vh, `sheet stays inside the viewport (${Math.round(box.sheet)} <= ${box.vh})`);
  assert(box.browser <= box.sheet + 1, `ns-browser does not spill out of the sheet (${Math.round(box.browser)} <= ${Math.round(box.sheet)})`);
  assert(box.scroll > box.client, `long dir list scrolls inside its box (${box.scroll} > ${box.client})`);
  await page.locator(".new-sheet .sheet-head .btn.ghost", { hasText: "取消" }).click();
  log(`9c sheet picker scrolls ok (${Math.round(box.scroll)} > ${Math.round(box.client)})`);

  await page.locator(".hint-tools .btn.ghost", { hasText: "文件" }).click();
  await page.locator(".file-picker-body .dirpicker .file-row").first().waitFor({ timeout: 10000 });
  const fpRows = await page.locator(".file-picker-body .dirpicker .file-row").count();
  assert(fpRows >= 1, `attachment picker lists files (got ${fpRows})`);
  await page.locator(".file-picker .btn.ghost", { hasText: "关闭" }).click();
  log("9b attachment picker ok");

  log("ALL PASS · shots in", OUT);
} catch (err) {
  console.error(bridgeOut.join("").slice(-3000));
  throw err;
} finally {
  await browser?.close();
  bridge.kill();
}
