/**
 * 「本项目需要」那一块（设置 → 扩展最上面）：把 `/api/deps` 的说法原样摆出来，缺了给命令。
 *
 *   npm run build:bridge && npm run build:web && node bridge/tests/deps-ui.mjs
 *
 * 验的是只有真 DOM 才知道的三件事：① 这一块在扩展清单**上面**（pi 本体之下）；② 三个包的名字
 * 都在，✓/✗ 跟 `/api/deps` 一致（不自己编结论）；③ 缺东西时有一行可复制的命令、不缺时没有。
 *
 * 用本机真装的 pi（`pi list` 是本地命令，不联网），所以断言对「装齐了」和「没装齐」两种机器都成立：
 * 期望值一律从 `/api/deps` 取，不从写死的清单取。端口 7886（7893–7899 都已有主人，7896 归 lessons-spawn / tunnel-ui），可用 DEPS_UI_PORT 改。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.DEPS_UI_PORT ?? 7886);
const ROOT = path.join(REPO, ".scratch", "deps-ui");
const STATE = path.join(ROOT, "state");
const PROJECT = path.join(ROOT, "project");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "deps-ui-pass";

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(PROJECT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
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

const env = { ...process.env, PI_WEB_STATE: STATE, PI_WEB_PORT: String(PORT), PI_WEB_HOST: "127.0.0.1", PI_WEB_TUNNEL: "0" };
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

let browser = null;
let page = null;
try {
  await until(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok, 20000, "healthz");

  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const report = await (await fetch(`${BASE}/api/deps`, { headers: { cookie } })).json();
  log("api/deps:", JSON.stringify({ pi: report.pi, missing: report.missing, ready: report.ready, optional: report.optional }));
  check("后端说得清 pi 版本", typeof report.pi.version === "string" && /^\d+\.\d+\.\d+$/.test(report.pi.min), `${report.pi.version} ≥ ${report.pi.min}`);
  check("三个包都在清单里", Array.isArray(report.packages) && report.packages.length === 3);

  // 设置页的入口在聊天里，先建一个会话。
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const seen = [];
  ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  await until(() => seen.some((m) => m.type === "hello"), 10000, "hello");
  ws.send(JSON.stringify({ type: "create", cwd: PROJECT, name: "deps-ui" }));
  const created = await until(() => seen.find((m) => m.type === "session" && m.sessionId), 30000, "create");
  ws.close();

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
  await ctx.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  page = await ctx.newPage();
  page.on("pageerror", (e) => {
    failed += 1;
    console.error("  FAIL pageerror:", e.message);
  });
  await page.goto(`${BASE}/#/s/${created.sessionId}`, { waitUntil: "domcontentloaded" });
  await page.locator(".composer textarea").waitFor({ timeout: 20000 });
  await page.locator(".composer textarea").fill("/settings");
  await page.keyboard.press("Enter");
  await until(() => page.locator(".settings-sheet").count(), 10000, "settings sheet");
  await page.locator(".settings-tabs .chip", { hasText: "扩展" }).first().click();
  const box = page.locator(".ext-pi", { hasText: "本项目需要" }).first();
  await box.waitFor({ timeout: 15000 });
  // 第一次进这一页会顺手问 /api/deps：问的那一下不能把整页画成两份（以前会：同步重画一遍，
  // 外层再追加一次开关行与扩展列表）。要在答案回来之前数，回来以后重画会把多的那份抹掉。
  const hosts = await page.locator(".settings-body .ext-host").count();
  check("第一次进扩展页：只画一份", hosts === 1, String(hosts));
  // 等那一块自己问完（问不到时上面会写「检查中…」）。`pi list` 在 Windows 上要跑 10 秒上下，给足 45 秒。
  await until(async () => !(await box.innerText()).includes("检查中…"), 45000, "deps loaded");

  const text = await box.innerText();
  check("标题是「本项目需要」", text.includes("本项目需要"));
  check("写着 pi 的版本", text.includes(`pi ${report.pi.version}`) || report.pi.version === null, report.pi.version ?? "");
  for (const pkg of report.packages) {
    check(`列了 ${pkg.name}`, text.includes(pkg.name));
    if (pkg.installed) check(`  ${pkg.name} 是 ✓`, text.includes(`✓ ${pkg.name}`));
    else check(`  ${pkg.name} 是 ✗`, text.includes(`✗ ${pkg.name}`));
  }
  check("装了的三条都有版本号或说明", report.packages.every((p) => !p.installed || text.includes(p.name)));

  const copy = box.locator("button", { hasText: "复制命令" });
  if (report.ready) check("都齐了：不出「复制命令」", (await copy.count()) === 0);
  else {
    check("缺东西：出「复制命令」", (await copy.count()) === 1);
    check("命令是 npm install 那条路", text.includes(report.command), report.command);
  }

  const shot = path.join(REPO, ".scratch", "shots", report.ready ? "deps-needed.png" : "deps-needed-missing.png");
  await page.screenshot({ path: shot, fullPage: false });
  log(`截图：${path.relative(REPO, shot)}`);

  // 位置：pi 本体之下、扩展清单之上（这两块都在 .ext-pi 里）。
  const piBox = await page.locator(".ext-pi", { hasText: "pi 本体" }).first().boundingBox();
  const needBox = await box.boundingBox();
  check("在「pi 本体」下面", Boolean(piBox && needBox && needBox.y > piBox.y), `${piBox?.y} → ${needBox?.y}`);

  // 设置 → 子代理 → acp_delegate：billion-context 没装时整片灰掉、保存不可用。
  const bc = report.optional?.find((o) => o.name === "billion-context");
  await page.locator(".settings-tabs .chip", { hasText: "子代理" }).first().click();
  await page.locator("#subagents-acp .settings-foot").waitFor({ timeout: 15000 });
  const acpText = await page.locator("#subagents-acp").innerText();
  if (bc && !bc.installed) {
    check("没装 billion-context：说清原因", /没有装 billion-context/.test(acpText));
    check("没装 billion-context：保存不可用", await page.locator("#subagents-acp .btn.primary").isDisabled());
  } else {
    check("装了 billion-context：不灰", !/没有装 billion-context/.test(acpText));
  }

  // 直接进「子代理」、不经过「扩展与 MCP」：这一页自己也得拉 /api/deps，灰化不能靠上一次的残留。
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".composer textarea").waitFor({ timeout: 20000 });
  await page.locator(".composer textarea").fill("/settings");
  await page.keyboard.press("Enter");
  await until(() => page.locator(".settings-sheet").count(), 10000, "settings sheet (again)");
  await page.locator(".settings-tabs .chip", { hasText: "子代理" }).first().click();
  await page.locator("#subagents-acp .settings-foot").waitFor({ timeout: 15000 });
  const acpFirst = page.locator("#subagents-acp");
  if (bc && !bc.installed) {
    await until(async () => /没有装 billion-context/.test(await acpFirst.innerText()), 45000, "deps on subagents tab");
    check("先点子代理也灰：说清原因", true);
    check("先点子代理也灰：保存不可用", await page.locator("#subagents-acp .btn.primary").isDisabled());
  } else {
    check("先点子代理不误灰", !/没有装 billion-context/.test(await acpFirst.innerText()));
  }

  await page.screenshot({ path: path.join(REPO, ".scratch", "shots", "deps-acp.png"), fullPage: false });
} catch (err) {
  failed += 1;
  console.error("FAIL", err?.message ?? err);
  // 失败现场：截图 + 页面上第一段文字，避免下次只能猜。
  await page?.screenshot({ path: path.join(REPO, ".scratch", "shots", "deps-ui-fail.png") }).catch(() => {});
  console.error("  sheet:", await page?.locator(".settings-sheet").count().catch(() => -1));
  console.error("  body:", (await page?.locator("body").innerText().catch(() => "")).slice(0, 300));
  if (bridgeLog) console.error(bridgeLog.slice(-2000));
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
}

console.log(failed ? `deps-ui: ${failed} 项失败` : "deps-ui: ok");
process.exit(failed ? 1 : 0);
