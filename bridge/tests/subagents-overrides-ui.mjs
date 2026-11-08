/**
 * 设置 → 子代理 的右半边（#214）：agent 表的 model / thinking 可编辑，保存只写
 * `subagents.agentOverrides.<name>.model|thinking`，清空 = 删键。
 *
 * 桩 pi 只用来建一个会话（拿 cwd），agent 定义是项目里现放的 `.pi/agents/researcher.md`；
 * frontmatter 列必须一直显示 agent 自己钉的值 —— 覆盖改的是 settings.json，不碰 `.md`。
 *
 *   npm run build:bridge && npm run build:web && node bridge/tests/subagents-overrides-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { loadPlaywright } from "../../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_WEB_PORT ?? 7906);
const ROOT = path.join(REPO, ".scratch", "subagents-overrides-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PROJECT = path.join(ROOT, "project");
const SHOTS = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const GLOBAL_FILE = path.join(AGENT, "settings.json");
const PROJECT_FILE = path.join(PROJECT, ".pi", "settings.json");
const AGENT_MD = path.join(PROJECT, ".pi", "agents", "researcher.md");
const AGENT_MD_TEXT = "---\nname: researcher\ndescription: test fixture\nmodel: stub/own-model\nthinking: low\n---\n\nRead things.\n";

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
fs.mkdirSync(path.join(PROJECT, ".pi", "agents"), { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(AGENT_MD, AGENT_MD_TEXT);
fs.writeFileSync(PROJECT_FILE, "{}\n");

const env = { ...process.env };
for (const k of Object.keys(env)) if (/_API_KEY$|_TOKEN$/.test(k)) delete env[k];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
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

/** 先建会话（拿 cwd）并信任项目 —— 项目 scope 的 settings.json 只有被信任才可写。 */
async function prepareSession(cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const seen = [];
  ws.on("message", (buf) => seen.push(JSON.parse(buf.toString())));
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  await until(() => seen.some((m) => m.type === "hello"), 10000, "hello");
  ws.send(JSON.stringify({ type: "create", cwd: PROJECT, name: "subagents-214" }));
  const created = await until(() => seen.find((m) => m.type === "session" && m.sessionId), 20000, "create");
  ws.send(JSON.stringify({ type: "trust.set", cwd: PROJECT, option: 0 }));
  const trust = await until(() => seen.find((m) => m.type === "trust" && m.saved), 10000, "trust.set");
  ws.close();
  return { sid: created.sessionId, trusted: Boolean(trust.trust?.effective) };
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

  const { sid, trusted } = await prepareSession(cookie);
  check(Boolean(sid) && trusted, `会话 + 项目信任（${sid}）`);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
  await ctx.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    failed = true;
    console.error("  FAIL pageerror:", e.message);
  });

  /** 开设置面板 → 子代理 → 等表出来。 */
  const openSubagents = async () => {
    if (!(await page.locator(".settings-sheet").count())) {
      await page.locator(".composer textarea").fill("/settings");
      await page.keyboard.press("Enter");
      await until(() => page.locator(".settings-sheet").count(), 10000, "settings sheet");
    }
    await page.locator(".settings-tabs .chip", { hasText: "子代理" }).click();
    await until(async () => (await page.locator(".subagents-agents tr", { hasText: "researcher" }).count()) > 0, 20000, "agent row");
    await sleep(400);
  };
  const row = () => page.locator(".subagents-agents tr", { hasText: "researcher" });
  const modelInput = () => row().locator('input[list="subagents-models"]');
  const thinkingSelect = () => row().locator("select.ns-input");
  const clearButton = () => row().locator("button.subagents-clear");
  const hint = () => page.textContent(".subagents-sec#subagents-agents h3 .subagents-hint");
  const saveButton = () => page.locator(".subagents-foot button.btn.primary");
  const rowIsChanged = async () => (await row().getAttribute("class"))?.includes("changed") ?? false;

  await page.goto(`${BASE}/#/s/${sid}`, { waitUntil: "domcontentloaded" });
  await page.locator(".composer textarea").waitFor({ timeout: 20000 });
  await openSubagents();

  // ---------------------------------------------------------------- A. 只读事实 + 初态
  log("A. 表里有这个 agent，右半边初态是空（= 继承）");
  check(/个，0 处已覆盖/.test((await hint()) ?? ""), `标题给数量（${await hint()}）`);
  check((await row().textContent()).includes("stub/own-model") && (await row().textContent()).includes("low"), "frontmatter 列显示 agent 自己钉的值");
  check((await modelInput().inputValue()) === "", "覆盖 model 空 = 继承");
  check((await thinkingSelect().inputValue()) === "", "覆盖 thinking 空 = 继承");
  check(!(await rowIsChanged()), "没改过的行不高亮");
  check(!(await row().locator(".subagents-badge.changed").isVisible()), "没改过的行没有「改」标记");
  check(await saveButton().isDisabled(), "没改过时保存按不动");
  await page.screenshot({ path: path.join(SHOTS, "1-initial.png") });

  // ---------------------------------------------------------------- B. 改 model
  log("B. 改一行的 model：整行高亮 + 「改」+ 计数动");
  await modelInput().fill("stub/fake-model");
  check(await rowIsChanged(), "改过的行整行高亮");
  check(await row().locator(".subagents-badge.changed").isVisible(), "改过的行带「改」标记");
  check(/个，1 处已覆盖/.test((await hint()) ?? ""), `计数跟着动（${await hint()}）`);
  check(!(await saveButton().isDisabled()), "有脏键时保存可点");
  await page.screenshot({ path: path.join(SHOTS, "2-edited.png") });

  // ---------------------------------------------------------------- C. 不认识的模型只标红
  log("C. 手输不认识的模型 id：只标红，不拦保存");
  await modelInput().fill("made-up/no-such-model");
  check((await modelInput().getAttribute("class")).includes("bad"), "不认识的 id 标红");
  check(!(await saveButton().isDisabled()), "标红不妨碍保存");
  await modelInput().fill("stub/fake-model");
  check(!(await modelInput().getAttribute("class")).includes("bad"), "改回会话模型清单里的 id 就不红了");

  // ---------------------------------------------------------------- D. 清空这一行
  log("D. 「清空这一行的覆盖」= 两个键都回到 null");
  await thinkingSelect().selectOption("high");
  check(/个，1 处已覆盖/.test((await hint()) ?? ""), "同一行改两列仍然只算一处");
  await clearButton().click();
  check((await modelInput().inputValue()) === "" && (await thinkingSelect().inputValue()) === "", "清空后两列都回到继承");
  check(!(await rowIsChanged()), "清空后不再高亮");
  check(await saveButton().isDisabled(), "两列都没改回去时保存又按不动");

  // ---------------------------------------------------------------- E. 保存：只写改过的键
  log("E. 保存到全局 settings.json：只写改过的那一个键");
  await modelInput().fill("stub/fake-model");
  await saveButton().click();
  await until(() => fs.existsSync(GLOBAL_FILE) && readJson(GLOBAL_FILE).subagents?.agentOverrides?.researcher?.model === "stub/fake-model", 10000, "global write");
  let disk = readJson(GLOBAL_FILE);
  check(disk.subagents.agentOverrides.researcher.model === "stub/fake-model", `model 落盘（${JSON.stringify(disk.subagents.agentOverrides)}）`);
  check(!("thinking" in disk.subagents.agentOverrides.researcher), "没改的 thinking 不写");
  check(fs.readFileSync(AGENT_MD, "utf8") === AGENT_MD_TEXT, "agent 的 .md 一个字节没动");
  await sleep(400);
  check(await rowIsChanged(), "保存后重画的行仍然算「改过」");
  check((await modelInput().inputValue()) === "stub/fake-model", "保存后输入框读的是磁盘值");

  await thinkingSelect().selectOption("high");
  await saveButton().click();
  await until(() => readJson(GLOBAL_FILE).subagents?.agentOverrides?.researcher?.thinking === "high", 10000, "global thinking");
  disk = readJson(GLOBAL_FILE);
  check(disk.subagents.agentOverrides.researcher.model === "stub/fake-model" && disk.subagents.agentOverrides.researcher.thinking === "high", "两列都改过就都写");

  // ---------------------------------------------------------------- F. 项目 scope
  log("F. 项目 scope 用同一张表，写到 <cwd>/.pi/settings.json");
  await page.locator(".subagents-bar .subagents-seg", { hasText: "项目" }).click();
  await until(async () => {
    await sleep(200);
    return ((await page.textContent(".subagents-path")) ?? "").includes(PROJECT.replace(/\\/g, path.sep));
  }, 10000, "project view");
  await sleep(400);
  check((await modelInput().inputValue()) === "", "项目 scope 没有覆盖 → 空");
  await modelInput().fill("stub/project-model");
  await saveButton().click();
  await until(() => readJson(PROJECT_FILE).subagents?.agentOverrides?.researcher?.model === "stub/project-model", 10000, "project write");
  check(readJson(PROJECT_FILE).subagents.agentOverrides.researcher.model === "stub/project-model", "项目 scope 落盘到项目文件");
  check(readJson(GLOBAL_FILE).subagents.agentOverrides.researcher.model === "stub/fake-model", "项目保存不碰全局文件");

  // ---------------------------------------------------------------- G. 刷新后仍然在
  log("G. 刷新后覆盖还在（磁盘是唯一真相）");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".composer textarea").waitFor({ timeout: 20000 });
  await openSubagents();
  check(await rowIsChanged(), "刷新后重开面板，行仍是「改过」的样子");
  check((await modelInput().inputValue()) === "stub/fake-model", "刷新后输入框还是覆盖值");

  // ---------------------------------------------------------------- H. 清空后删键
  log("H. 清空这一行再保存：settings.json 里不留空壳");
  await clearButton().click();
  await saveButton().click();
  await until(() => !readJson(GLOBAL_FILE).subagents, 10000, "override removed");
  check(!("subagents" in readJson(GLOBAL_FILE)), `清空后 agentOverrides / subagents 空壳都不留（${fs.readFileSync(GLOBAL_FILE, "utf8").replace(/\s+/g, "")}）`);
  await sleep(400);
  check(!(await rowIsChanged()), "清空保存后行回到不高亮");

  await page.screenshot({ path: path.join(SHOTS, "3-cleared.png") });
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
  console.error("\nsubagents-overrides-ui: FAILED");
  process.exit(1);
}
console.log(`\nsubagents-overrides-ui: ok — 截图在 ${SHOTS}`);
