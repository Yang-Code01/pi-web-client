/**
 * 技能面板的两枚按钮（issue #462）：每行右边追加「使用」「查看」。
 *
 *  · 每行都有两枚按钮；「使用」= 整行点击的老行为（往输入框插 `/skill:<名字> `）；
 *  · 「查看」把技能的 `SKILL.md` 开在 viewer 里，面板随即关掉；**看不算用**（uses 不动）；
 *  · 桥报了、盘上没有文件的技能（扩展自带的）：查看置灰，行里给出说明，使用照常；
 *  · 技能商店「已安装」行也能查看，同名时打开的是**项目里的那一份**（pi 的遮蔽规则）。
 *
 * 面板的查看把名字交给桥（`skill:<名字>`），由桥按 pi 的目录顺序解析成文件；商店行用自己的
 * 绝对路径 —— 两条来源故意不同，所以这里按名字撞车的场景单独看一眼。
 *
 *   npm run build:bridge && npm run build:web && node bridge/tests/skill-view-ui.mjs
 *
 * 截图落在 `.scratch/skill-view-shots/`。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { loadPlaywright } from "../../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PI_WEB_PORT ?? 7801);
const ROOT = path.join(REPO, ".scratch", "skill-view-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const HOME = path.join(ROOT, "home");
const PROJECT = path.join(ROOT, "project");
const SHOTS = path.join(REPO, ".scratch", "skill-view-shots");
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION_NAME = "技能面板测试";

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
    let v = false;
    try {
      v = await fn();
    } catch {
      /* not yet */
    }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(120);
  }
}

delete process.env.PI_BIN;
const { resolvePi } = await import("../dist/pi.js");
const realPkg = path.dirname(path.dirname(path.dirname(resolvePi().cli)));

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
for (const dir of [STATE, path.join(AGENT, "skills"), path.join(HOME, ".agents", "skills"), PROJECT, SHOTS]) fs.mkdirSync(dir, { recursive: true });

/** 一个技能目录：frontmatter + 正文里带一句只有它自己才有的标记。 */
function skillDir(dir, name, description, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${marker}\n`);
}

// 面板里的那个技能：项目里，盘上真的有文件。
skillDir(path.join(PROJECT, ".pi", "skills", "panel-skill"), "panel-skill", "面板里的那个", "面板正文标记-PANEL");
// 同名撞车：用户目录一份、项目里一份 —— pi 的规则是项目那份先被看见。
skillDir(path.join(AGENT, "skills", "shadowed"), "shadowed", "用户目录里的同名技能", "用户版本-USER");
skillDir(path.join(PROJECT, ".pi", "skills", "shadowed"), "shadowed", "项目里的同名技能", "项目版本-PROJECT");

// fake-pi 一个技能都不报，桥就会退回磁盘扫描（全都「可查看」）。这里让它像扩展那样多报一个
// 盘上没有的技能，好让「查看置灰」这条路也有得测。
const FAKE_COMMANDS = JSON.stringify([
  { name: "skill:panel-skill", description: "面板里的那个", source: "skill" },
  { name: "skill:phantom-skill", description: "扩展报上来的那个", source: "skill" },
]);

const env = { ...process.env };
for (const k of Object.keys(env)) if (/_API_KEY$|_TOKEN$/.test(k)) delete env[k];
const bridgeOut = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_CODING_AGENT_DIR: AGENT,
    PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
    PI_WEB_PI_PKG: realPkg,
    PI_OFFLINE: "1",
    USERPROFILE: HOME,
    HOME,
    FAKE_PI_COMMANDS: FAKE_COMMANDS,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

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

  // 会话自己建（像 browser.mjs 那样走 WS `create`）：pi 立刻被拉起来，`get_commands` 才有个活的
  // 回答 —— 「置灰」那条路要的正是 pi 报了、盘上没有。cwd 指向临时工程，项目里的技能才找得到。
  const SID = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie } });
    ws.on("open", () => ws.send(JSON.stringify({ type: "create", cwd: PROJECT, name: SESSION_NAME })));
    ws.on("message", (b) => {
      const m = JSON.parse(b.toString());
      if (m.type === "session.state" && m.session?.name === SESSION_NAME) {
        resolve(m.session.id);
        ws.close();
      }
      if (m.type === "error") reject(new Error(m.message));
    });
    setTimeout(() => reject(new Error("create timeout")), 60000);
  });
  log("会话已建", SID);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 880 }, locale: "zh-CN" });
  await ctx.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    failed = true;
    console.error("  FAIL pageerror:", e.message, "\n", e.stack);
  });
  await page.goto(`${BASE}/#/s/${SID}`, { waitUntil: "domcontentloaded" });

  const composer = page.locator(".composer");
  const textarea = composer.locator("textarea");
  const skillsBtn = composer.locator('[data-act="skills"]');
  const palette = page.locator(".skill-pop");
  const row = (name) => page.locator(".skill-row").filter({ has: page.locator(".sk-name", { hasText: name }) });
  const rowNames = async () => page.locator(".skill-row .sk-name").allInnerTexts();
  const viewerName = page.locator(".viewer .viewer-name");
  const viewerBody = page.locator(".viewer .viewer-body");

  await until(async () => (await skillsBtn.count()) === 1, 20000, "composer 里的技能按钮");
  check(true, "会话打开，输入框在");

  // 先说一句：`get_commands` 的回答带缓存，pi 得真跑过一轮才稳。
  await textarea.fill("你好");
  await textarea.press("Enter");
  await until(async () => (await page.locator(".msg.assistant").count()) > 0, 60000, "pi 回话");

  // ---- A. 每行两枚按钮 ---------------------------------------------------
  log("A. 每行「使用」「查看」");
  await skillsBtn.click();
  await until(async () => (await palette.count()) === 1, 5000, "面板打开");
  await until(async () => (await rowNames()).length >= 2, 10000, "技能列表到齐");
  check((await rowNames()).sort().join(",") === "panel-skill,phantom-skill", `列出桥给的两条：${JSON.stringify(await rowNames())}`);
  for (const name of await rowNames()) {
    const r = row(name);
    check((await r.locator("button.sk-use").count()) === 1, `${name}：有「使用」`);
    check((await r.locator("button.sk-view").count()) === 1, `${name}：有「查看」`);
    check((await r.locator("button.sk-use").innerText()).trim() === "使用", `${name}：使用按钮写着使用`);
    check((await r.locator("button.sk-view").innerText()).trim() === "查看", `${name}：查看按钮写着查看`);
  }
  await page.screenshot({ path: path.join(SHOTS, "1-panel.png") });

  // ---- B. 使用 = 老行为（插 /skill:） -----------------------------------
  log("B. 「使用」插 /skill:<名字>");
  await row("panel-skill").locator("button.sk-use").click();
  await until(async () => (await palette.count()) === 0, 3000, "面板关掉");
  check((await textarea.inputValue()) === "/skill:panel-skill ", `输入框插入了命令：${JSON.stringify(await textarea.inputValue())}`);
  check((await palette.count()) === 0, "用完之后面板关掉");

  // ---- C. 查看：SKILL.md 开在 viewer 里，面板关掉，看不算用 -----------------
  log("C. 「查看」开 SKILL.md");
  await textarea.fill("");
  await skillsBtn.click();
  await until(async () => (await palette.count()) === 1, 5000, "面板再开");
  await row("panel-skill").locator("button.sk-view").click();
  await until(async () => (await viewerName.count()) === 1, 8000, "viewer 打开");
  await until(async () => ((await viewerBody.innerText().catch(() => "")) || "").includes("面板正文标记-PANEL"), 10000, "SKILL.md 渲染出来");
  check((await viewerName.innerText()).trim() === "SKILL.md", `viewer 标题是 SKILL.md：${JSON.stringify(await viewerName.innerText())}`);
  check((await viewerBody.innerText()).includes("panel-skill"), "viewer 里是那个技能的正文");
  check((await palette.count()) === 0, "查看之后面板关掉");
  const usageFile = path.join(STATE, "skill-usage.json");
  const usage = fs.existsSync(usageFile) ? JSON.parse(fs.readFileSync(usageFile, "utf8")) : {};
  check(!usage["panel-skill"] || (Number(usage["panel-skill"].count) || 0) === 0, `看不算用：${JSON.stringify(usage["panel-skill"] ?? null)}`);
  await page.screenshot({ path: path.join(SHOTS, "2-view.png") });
  // viewer 是盖在对话上的；不先关掉，后面点不到输入框那排按钮。
  await page.locator('.viewer .viewer-btn[title*="关闭"]').click();
  await until(async () => (await page.locator(".viewer").count()) === 0, 5000, "viewer 关掉");

  // ---- D. 盘上没有文件的技能：查看置灰、有说明、使用照常 -------------------
  log("D. 扩展技能：置灰 + 说明");
  await skillsBtn.click();
  await until(async () => (await palette.count()) === 1, 5000, "面板再开");
  const phantom = row("phantom-skill");
  check(await phantom.locator("button.sk-view").isDisabled(), "phantom-skill 的查看是置灰的");
  check(!(await row("panel-skill").locator("button.sk-view").isDisabled()), "panel-skill 的查看可以点");
  const note = (await phantom.locator(".sk-note").count()) ? await phantom.locator(".sk-note").innerText() : "";
  check(note.trim().length > 0, `行里有说明：${JSON.stringify(note)}`);
  await page.screenshot({ path: path.join(SHOTS, "3-grey.png") });
  await phantom.locator("button.sk-use").click();
  await until(async () => (await textarea.inputValue()) === "/skill:phantom-skill ", 3000, "扩展技能仍可使用");
  check((await textarea.inputValue()) === "/skill:phantom-skill ", "置灰只挡查看，不挡使用");

  // ---- E. 商店「已安装」也能查看；同名打开项目那一份 ----------------------
  log("E. 商店已安装行「查看」");
  await textarea.fill("");
  await skillsBtn.click();
  await until(async () => (await palette.count()) === 1, 5000, "面板再开");
  await page.locator(".skill-store-open").click();
  await until(async () => (await page.locator(".skill-sheet").count()) === 1, 8000, "商店打开");
  await page.locator(".skill-sheet .settings-tabs .chip", { hasText: "已安装" }).click();
  const shopRow = page.locator(".skill-sheet .login-row").filter({ has: page.locator(".login-name", { hasText: "shadowed" }) });
  await until(async () => (await shopRow.count()) === 1, 8000, "已安装里出现 shadowed");
  await shopRow.locator("button.sk-view").click();
  await until(async () => ((await viewerBody.innerText().catch(() => "")) || "").includes("项目版本-PROJECT"), 10000, "打开项目那一份");
  const shopText = await viewerBody.innerText();
  check(shopText.includes("项目版本-PROJECT"), "同名技能打开的是项目里的那一份（pi 的遮蔽规则）");
  check(!shopText.includes("用户版本-USER"), "没有打开用户目录里的另一份");
  check((await page.locator(".skill-sheet").count()) === 0, "查看之后商店关掉");
  await page.screenshot({ path: path.join(SHOTS, "4-store.png") });

  await ctx.close();
} catch (e) {
  failed = true;
  console.error("  FAIL", e?.message ?? e);
  if (bridgeOut.length) console.error(bridgeOut.join("").slice(-2000));
} finally {
  await browser?.close();
  bridge.kill();
}

if (failed) {
  console.error("\nskill-view-ui: FAILED");
  process.exit(1);
}
console.log(`\nskill-view-ui: ok — 截图在 ${SHOTS}`);
