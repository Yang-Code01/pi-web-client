/**
 * 设置 → 子代理 → 高级（#216）：在真 Chromium 里改一条**按 provider 覆盖**的 model，然后看磁盘。
 *
 * 钉的是这一块的验收：预置一份 settings.json，里面有
 *   · `subagents.agentOverridesByProvider.wb2api.reviewer.model`（要改的那条），
 *   · 同一行的 `thinking` 与隔壁的 `subagents.agentOverrides.reviewer.thinking`（不许动），
 *   · `subagents.watchdog.*` 与顶层的 `theme`（别的分支，不许被写回）。
 * 走一遍「展开高级 → 改 model → 保存」，断言磁盘上只有那一个叶子变了。
 *
 * 顺带看一眼进「子代理」tab 时会不会重问 `settings.get`：面板先停在「全局」页，这期间往磁盘上
 * 加一个 `maxThinking`，再切到「子代理」—— 只有切 tab 时重问，默认节里的那个下拉才会读出新值。
 *
 *   npm run build:bridge && npm run build:web && node bridge/tests/subagents-advanced-ui.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { loadPlaywright } from "../../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_WEB_PORT ?? 7912);
const ROOT = path.join(REPO, ".scratch", "subagents-advanced-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PROJECT = path.join(ROOT, "project");
const SHOTS = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const GLOBAL_FILE = path.join(AGENT, "settings.json");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = false;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed = true;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

delete process.env.PI_BIN;
const { resolvePi } = await import("../dist/pi.js");
const realPkg = path.dirname(path.dirname(path.dirname(resolvePi().cli)));

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });
fs.mkdirSync(PROJECT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

/** 预置的 settings.json：要改的那条 + 三个「不许动」的邻居。 */
const SEED = {
  theme: "dark",
  subagents: {
    agentOverrides: { reviewer: { thinking: "high" } },
    agentOverridesByProvider: { wb2api: { reviewer: { model: "wb2api/old-model", thinking: "low" } } },
    watchdog: { enabled: true, children: { model: "stub/watch-model", overrides: { reviewer: { model: "stub/wd-model" } } } },
  },
};
fs.writeFileSync(GLOBAL_FILE, `${JSON.stringify(SEED, null, 2)}\n`);

/** 两个 agent：一个 frontmatter 没钉 model/thinking，一个名字里带「.」（点号键会插错层）。 */
fs.mkdirSync(path.join(AGENT, "agents"), { recursive: true });
fs.writeFileSync(path.join(AGENT, "agents", "plain.md"), "---\ndescription: 没钉 model 与 thinking\n---\n做点什么。\n");
fs.writeFileSync(
  path.join(AGENT, "agents", "dotted.one.md"),
  "---\nname: dotted.one\ndescription: 名字里带点\ntools: read\n---\n做点什么。\n",
);

const env = { ...process.env };
for (const k of Object.keys(env)) if (/_API_KEY$|_TOKEN$/.test(k)) delete env[k];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_WEB_ROOT: path.join(REPO, "web", "dist"),
    PI_AGENT_DIR: AGENT,
    PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
    PI_WEB_PI_PKG: realPkg,
    PI_OFFLINE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

/** 先建会话（拿 cwd）；这一页只写全局 settings.json，项目不用信任。 */
async function prepareSession(cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const seen = [];
  ws.on("message", (buf) => seen.push(JSON.parse(buf.toString())));
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  await until(() => seen.some((m) => m.type === "hello"), 10000, "hello");
  ws.send(JSON.stringify({ type: "create", cwd: PROJECT, name: "subagents-216" }));
  const created = await until(() => seen.find((m) => m.type === "session" && m.sessionId), 20000, "create");
  ws.close();
  return created.sessionId;
}

const { chromium } = await loadPlaywright();
let browser;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  check(login.status === 200 && cookie, "登录");

  const sid = await prepareSession(cookie);
  check(Boolean(sid), `会话（${sid}）`);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
  await ctx.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    failed = true;
    console.error("  FAIL pageerror:", e.message);
  });

  await page.goto(`${BASE}/#/s/${sid}`, { waitUntil: "domcontentloaded" });
  await page.locator(".composer textarea").waitFor({ timeout: 20000 });

  // ---------------------------------------------------------------- A. 开设置，停在「全局」页
  log("A. 开设置面板，先在「全局」页等它把 settings.json 读回来");
  await page.locator(".composer textarea").fill("/settings");
  await page.keyboard.press("Enter");
  await until(() => page.locator(".settings-sheet").count(), 10000, "settings sheet");
  await until(async () => (await page.locator(".settings-body .settings-row").count()) > 0, 20000, "global form");

  // ---------------------------------------------------------------- B. 进 tab 重问 settings.json
  log("B. 面板开着的时候往磁盘上加 maxThinking，再切到「子代理」");
  const late = readJson(GLOBAL_FILE);
  late.subagents.maxThinking = "low";
  fs.writeFileSync(GLOBAL_FILE, `${JSON.stringify(late, null, 2)}\n`);
  await page.locator(".settings-tabs .chip", { hasText: "子代理" }).click();
  await until(() => page.locator(".subagents-page").count(), 20000, "subagents page");
  const maxThinking = page.locator("#subagents-default label.settings-row", { hasText: "maxThinking" }).locator("select");
  await until(async () => (await maxThinking.inputValue()) === "low", 20000, "maxThinking reloaded on tab entry");
  check((await maxThinking.inputValue()) === "low", "进 tab 重问了 settings.get：磁盘上新加的 maxThinking 直接出现");

  // ---------------------------------------------------------------- C. 高级默认折叠，展开后有那条 provider 覆盖
  log("C. 「高级」默认折叠，展开后有预置的 provider 覆盖");
  const details = page.locator("details.subagents-advanced");
  check(!(await details.evaluate((el) => el.open)), "高级组默认折叠");
  await details.locator("summary").click();
  check(await details.evaluate((el) => el.open), "点一下标题就展开");

  const providerBlock = page.locator(".subagents-adv-block", { hasText: "按 provider 覆盖" });
  const providerRow = providerBlock.locator("tr", { hasText: "wb2api / reviewer" });
  await until(async () => (await providerRow.count()) > 0, 20000, "provider row");
  const providerModel = providerRow.locator('input[list="subagents-models"]');
  const providerThinking = providerRow.locator("select.ns-input");
  check((await providerModel.inputValue()) === "wb2api/old-model", "provider 覆盖的 model 读的是磁盘值");
  check((await providerThinking.inputValue()) === "low", "同一行的 thinking 读的是磁盘值");
  const watchdogRow = page.locator(".subagents-adv-block", { hasText: "看门狗" }).locator("tr", { hasText: "reviewer" });
  check((await watchdogRow.locator('input[list="subagents-models"]').inputValue()) === "stub/wd-model", "看门狗按 agent 的覆盖也在");
  await page.screenshot({ path: path.join(SHOTS, "1-advanced-open.png") });

  // ---------------------------------------------------------------- D. 改 model 并保存
  log("D. 改 provider 覆盖的 model，保存");
  const saveButton = page.locator(".subagents-foot button.btn.primary");
  check(await saveButton.isDisabled(), "没改之前保存按不动");
  await providerModel.fill("wb2api/new-model");
  check(!(await saveButton.isDisabled()), "改了之后保存可点");
  await saveButton.click();
  await until(() => readJson(GLOBAL_FILE).subagents?.agentOverridesByProvider?.wb2api?.reviewer?.model === "wb2api/new-model", 10000, "save");
  await sleep(400);
  check((await providerModel.inputValue()) === "wb2api/new-model", "保存后重画仍是磁盘上的新值");
  await page.screenshot({ path: path.join(SHOTS, "2-saved.png") });

  // ---------------------------------------------------------------- E. 磁盘上只有那一个叶子变了
  log("E. 磁盘：只有那一个叶子变了");
  const expected = JSON.parse(JSON.stringify(SEED));
  expected.subagents.maxThinking = "low";
  expected.subagents.agentOverridesByProvider.wb2api.reviewer.model = "wb2api/new-model";
  const disk = readJson(GLOBAL_FILE);
  check(
    disk.subagents.agentOverridesByProvider.wb2api.reviewer.model === "wb2api/new-model",
    `provider 覆盖的 model 落盘（${JSON.stringify(disk.subagents.agentOverridesByProvider)}）`,
  );
  check(disk.subagents.agentOverridesByProvider.wb2api.reviewer.thinking === "low", "同一行的 thinking 一字未动");
  check(disk.subagents.agentOverrides.reviewer.thinking === "high", "相邻的 agentOverrides.reviewer.thinking 一字未动");
  check(
    JSON.stringify(disk.subagents.watchdog) === JSON.stringify(SEED.subagents.watchdog),
    "watchdog 那一支没被写回",
  );
  check(disk.theme === "dark", "settings.json 别的顶层键原样");
  try {
    assert.deepEqual(disk, expected);
    check(true, "整份文件 = 预置内容 + 改过的那一个叶子（没有别的新键 / 空壳）");
  } catch (e) {
    check(false, `整份文件对不上：${e.message}`);
  }

  // ---------------------------------------------------------------- F. 刷新后还是磁盘值
  log("F. 刷新后仍然在");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".composer textarea").waitFor({ timeout: 20000 });
  await page.locator(".composer textarea").fill("/settings");
  await page.keyboard.press("Enter");
  await until(() => page.locator(".settings-sheet").count(), 10000, "settings sheet");
  await page.locator(".settings-tabs .chip", { hasText: "子代理" }).click();
  await until(() => page.locator(".subagents-page").count(), 20000, "subagents page");
  await page.locator("details.subagents-advanced summary").click();
  const providerRow2 = page.locator(".subagents-adv-block", { hasText: "按 provider 覆盖" }).locator("tr", { hasText: "wb2api / reviewer" });
  await until(async () => (await providerRow2.count()) > 0, 20000, "provider row after reload");
  check(
    (await providerRow2.locator('input[list="subagents-models"]').inputValue()) === "wb2api/new-model",
    "刷新后输入框读的还是磁盘上的新值",
  );

  // ---------------------------------------------------------------- G. agent 表：未钉 / 点名只读
  log("G. agent 表：frontmatter 没钉写「未钉」；名字带「.」的行只读");
  const agentsSec = page.locator("#subagents-agents");
  await until(async () => (await agentsSec.locator("tbody tr").count()) === 2, 20000, "agent rows");
  const plainRow = agentsSec.locator("tbody tr", { hasText: "plain" });
  const dottedRow = agentsSec.locator("tbody tr", { hasText: "dotted.one" });
  const plainFm = (await plainRow.locator("td.fm").innerText()).trim();
  check(plainFm.split("未钉").length - 1 === 2, `两列都没钉时都写「未钉」（${plainFm.replace(/\s+/g, " ")}）`);
  check(!plainFm.includes("—"), "不再是破折号");
  check(await plainRow.locator("input").isEnabled(), "没点号的普通 agent 仍可编辑 model");
  check(await dottedRow.locator("input").isDisabled(), "名字带「.」：model 覆盖只读");
  check(await dottedRow.locator("select").isDisabled(), "名字带「.」：thinking 覆盖只读");
  check(
    (await dottedRow.innerText()).includes("点号键会插错层"),
    "名字带「.」：行里写明为什么只读",
  );
  check(await dottedRow.locator("button.subagents-clear").isDisabled(), "名字带「.」：清空也按不动");
  check(await saveButton.isDisabled(), "整页没有脏键 —— 只读行不会悄悄生成 patch");
  await page.screenshot({ path: path.join(SHOTS, "3-agents.png") });

  await ctx.close();
} catch (e) {
  failed = true;
  console.error("  FAIL", e?.message ?? e);
  console.error(bridgeOut.join("").slice(-3000));
} finally {
  await browser?.close();
  bridge.kill();
}

if (failed) {
  console.error("\nsubagents-advanced-ui: FAILED");
  process.exit(1);
}
console.log(`\nsubagents-advanced-ui: ok — 截图在 ${SHOTS}`);
