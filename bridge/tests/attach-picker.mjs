/**
 * Probe: the attachment picker's drive list — click every drive row and see which ones actually
 * navigate, plus the /api/dirs answer behind each click. Written to chase the reported "点 F 盘符会
 * 闪一下，但没进 F 盘" bug (root cause: the `F:` crumb targeted the bare drive letter).
 *
 * D163 regressions kept here:
 *   1. 📎 引用当前文件夹 inserts the browsed folder once, and answers 已在输入框 the second time.
 *   2. clicking the `F:` crumb from a subfolder lands on F:\ (not the bridge's cwd on F:).
 *   3. the picker reopens where that session last was, instead of falling back to cwd.
 *   4. a folder with a space in it goes in quoted, as one path.
 *   5. the remembered-dir index keeps 30 entries, dropping the oldest.
 *
 * Runs a throwaway bridge on its own port with temp state, so the real one is never touched.
 * Port comes from ATTACH_UI_PORT (7880/7882/7883 belong to memory-cap, 7888 to continue-ui);
 * deliberately not PI_WEB_PORT, so an exported PI_WEB_PORT pointing at the real bridge can't be killed.
 *
 * Run: node bridge/tests/attach-picker.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const PORT = Number(process.env.ATTACH_UI_PORT ?? 7889);
const ROOT = path.join(REPO, ".scratch/attach-picker");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "zz-drive-click";

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(dir, { recursive: true });
const at = new Date().toISOString();
fs.writeFileSync(
  path.join(dir, `${SID}.jsonl`),
  [
    { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
    { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "drive click" }] } },
    { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name: "drive-click" },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
fs.mkdirSync(path.join(WORK, "sub"), { recursive: true });
fs.mkdirSync(path.join(WORK, "has space"), { recursive: true });

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
    await sleep(150);
  }
  console.error(bridgeOut.join("").slice(-3000));
  throw new Error(`timeout waiting for ${label}`);
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

  const seen = [];
  page.on("response", async (r) => {
    const u = r.url();
    if (!u.includes("/api/dirs")) return;
    let body = "";
    try { body = (await r.text()).slice(0, 300); } catch {}
    seen.push({ url: u, status: r.status(), body });
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 10000, "one card");
  await page.locator(".session-card").first().click();
  await page.locator(".hint-tools button", { hasText: "文件" }).waitFor({ timeout: 10000 });

  // ---- open the attachment picker: a fresh session should start at its cwd
  await page.locator(".hint-tools button", { hasText: "文件" }).click();
  await page.locator(".sheet.file-picker .dirpicker").waitFor({ timeout: 10000 });
  await page.locator(".sheet.file-picker .dir-row").first().waitFor({ timeout: 8000 });
  await sleep(300);

  const ta = page.locator(".composer-input textarea");
  const fail = (msg) => {
    throw new Error(msg);
  };

  // ---- D163: 引用当前文件夹 把正在浏览的目录插进输入框，重复点不插第二次
  const opened = ((await page.locator(".sheet.file-picker .dir-path").textContent()) ?? "").trim();
  console.log(`OPEN: "${opened}"`);
  if (!opened.includes("work")) fail(`弹层没有从会话工作目录打开（"${opened}"）`);
  await page.locator(".sheet.file-picker .dir-head .dir-ref").click();
  await sleep(250);
  const filled = await ta.inputValue();
  if (filled.split(WORK).length - 1 !== 1) fail(`引用当前文件夹插入了 ${filled.split(WORK).length - 1} 次，期望 1（"${filled}"）`);
  await page.locator(".sheet.file-picker .dir-head .dir-ref").click();
  await sleep(250);
  if ((await ta.inputValue()) !== filled) fail("重复点「引用当前文件夹」又插了一遍");
  const said = (await page.locator(".sheet.file-picker .dir-head .dir-ref").textContent()) ?? "";
  if (!said.includes("已在输入框")) fail(`重复点击的反馈是「${said}」，期望「已在输入框」`);
  console.log(`REF: ${WORK} → 输入框 ${filled.split(WORK).length - 1} 次，复点反馈「${said.trim()}」`);
  await ta.fill("");

  // ---- 含空格的目录：插进去必须包一对引号，否则桥端读成两个路径
  const spaced = path.join(WORK, "has space");
  await page.locator(".sheet.file-picker .dirpicker .model-row", { hasText: "has space" }).first().click();
  await sleep(700);
  const inSpaced = ((await page.locator(".sheet.file-picker .dir-path").textContent()) ?? "").trim();
  if (!inSpaced.endsWith("has space")) fail(`点 has space 没进去（"${inSpaced}"）`);
  await page.locator(".sheet.file-picker .dir-head .dir-ref").click();
  await sleep(250);
  const quoted = await ta.inputValue();
  console.log(`SPACE: "${quoted}"`);
  if (!quoted.includes(`"${spaced}"`)) fail(`含空格目录没包引号（"${quoted}"）`);
  await ta.fill("");

  // ---- D163: 面包屑里的盘符段必须跳到那颗盘的根
  const drive = WORK.split(":")[0] + ":";
  const crumb = page.locator(".sheet.file-picker .dir-path .crumb", { hasText: new RegExp(`^${drive}$`) });
  if (!(await crumb.count())) fail(`面包屑里没有 ${drive} 那一段`);
  const before = seen.length;
  await crumb.first().click();
  await sleep(1200);
  const where = ((await page.locator(".sheet.file-picker .dir-path").textContent()) ?? "").trim();
  const asked = seen.slice(before).map((s) => `${s.status} ${decodeURIComponent(s.url.split("?")[1] ?? "")}`);
  console.log(`CRUMB: 点 ${drive} → "${where}"  ${asked.join(" | ")}`);
  if (!where.endsWith(drive)) fail(`点 ${drive} 面包屑后停在 "${where}"，期望以 ${drive} 结尾`);
  if (!(await page.locator(".sheet.file-picker .dirpicker .model-row", { hasText: "pi-web-client" }).count())) {
    fail(`${drive} 根目录里没有 pi-web-client，说明没落到盘根`);
  }

  // ---- D163: 按会话记住上次浏览的目录
  await page.locator(".sheet.file-picker .sheet-head button", { hasText: /关闭/ }).click();
  await sleep(400);
  await page.locator(".hint-tools button", { hasText: "文件" }).click();
  await page.locator(".sheet.file-picker .dirpicker").waitFor({ timeout: 10000 });
  await sleep(800);
  const reopened = ((await page.locator(".sheet.file-picker .dir-path").textContent()) ?? "").trim();
  console.log(`MEMORY: 重开弹层 → "${reopened}"`);
  if (!reopened.endsWith(drive)) fail(`重开弹层落在 "${reopened}"，期望上次的 ${drive}\\`);

  // ---- 30 条上限：塞满假会话再换一次目录，最旧那条必须被清掉
  await page.evaluate(() => {
    const keys = Array.from({ length: 30 }, (_, i) => `pi.attachDir:fake-${i}`);
    for (const k of keys) localStorage.setItem(k, "F:\\");
    localStorage.setItem("pi.attachDir.index", keys.join("\n"));
  });
  await page.locator(".sheet.file-picker .dirpicker .model-row", { hasText: "pi-web-client" }).first().click();
  await sleep(800);
  const kept = await page.evaluate(() => (localStorage.getItem("pi.attachDir.index") ?? "").split("\n").filter(Boolean));
  console.log(`LRU: 保留 ${kept.length} 条，最旧 ${kept[0]}`);
  if (kept.length !== 30) fail(`LRU 应保留 30 条，实际 ${kept.length}`);
  if (kept.includes("pi.attachDir:fake-0")) fail("最旧的一条没被清掉");
  if (!kept.some((k) => k.startsWith("pi.attachDir:zz-drive-click"))) fail("当前会话没进索引");

  // ---- 记忆的目录没了（worktree 被删、换了机器）：退回会话 cwd，别停在盘符页
  await page.locator(".sheet.file-picker .sheet-head button", { hasText: /关闭/ }).click();
  await sleep(400);
  await page.evaluate(() => localStorage.setItem("pi.attachDir:zz-drive-click", "F:\\no-such-dir-xyz"));
  await page.locator(".hint-tools button", { hasText: "文件" }).click();
  await page.locator(".sheet.file-picker .dirpicker").waitFor({ timeout: 10000 });
  await sleep(1500);
  const stale = ((await page.locator(".sheet.file-picker .dir-path").textContent()) ?? "").trim();
  console.log(`STALE: 记忆指向不存在的目录 → "${stale}"`);
  if (!stale.includes("work")) fail(`记忆失效后落在 "${stale}"，期望退回会话 cwd（work）`);

  // ---- 此电脑：盘符列表
  await page.locator(".sheet.file-picker .dir-path .crumb.root", { hasText: "此电脑" }).click();
  await page.locator(".sheet.file-picker .vol-row").first().waitFor({ timeout: 8000 });
  await sleep(400);
  const rows = await page.$$eval(".sheet.file-picker .dirpicker .model-row", (els) =>
    els.map((e) => ({ text: e.textContent.trim().slice(0, 40), cls: e.className, disabled: e.disabled })),
  );
  console.log("DRIVE ROWS:", JSON.stringify(rows, null, 1));

  // ---- click every drive letter listed; each one must land on its own root
  const missed = [];
  for (const letter of "CDEFHI") {
    const row = page.locator(".sheet.file-picker .dirpicker .model-row", { hasText: new RegExp(`^${letter}:`) });
    if (!(await row.count())) {
      console.log(`${letter}: no row`);
      continue;
    }
    const before = seen.length;
    await row.first().click().catch(async () => {
      // 盘符行是按钮，可能被 vol-row 的整行点击拦住：退回用文字定位。
      await page.locator(".sheet.file-picker .dirpicker .model-row", { hasText: `${letter}:` }).first().click();
    });
    await sleep(1200);
    const crumbs = (await page.locator(".sheet.file-picker .dir-path").textContent()) ?? "";
    const n = await page.locator(".sheet.file-picker .dirpicker .model-row").count();
    const calls = seen.slice(before).map((s) => `${s.status} ${decodeURIComponent(s.url.split("?")[1] ?? "")} → ${s.body.replace(/\s+/g, " ").slice(0, 120)}`);
    console.log(`\n=== ${letter}: path="${crumbs.trim()}" rows=${n}`);
    for (const c of calls) console.log(`    ${c}`);
    if (!crumbs.trim().endsWith(`${letter}:`)) missed.push(letter);
    else if (!n) missed.push(`${letter}(空)`);
    // back to the drive list for the next letter
    await page.locator(".sheet.file-picker .dir-path .crumb.root", { hasText: "此电脑" }).click().catch(() => {});
    await sleep(500);
  }
  if (missed.length) fail(`这些盘没落到盘根：${missed.join(" ")}`);
} catch (err) {
  console.error("PROBE FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
  await sleep(300);
  killPort(PORT);
}
