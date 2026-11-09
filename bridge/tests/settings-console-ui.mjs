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
const GLOBAL_FILE = path.join(AGENT, "settings.json");
const PROJECT_FILE = path.join(PROJECT, ".pi", "settings.json");

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
// 两份都不是白纸：保存后要能看出「只动了改过的键」。项目里有 .pi/settings.json 才谈得上信任。
fs.mkdirSync(path.dirname(PROJECT_FILE), { recursive: true });
fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ theme: "dark" }));
fs.writeFileSync(PROJECT_FILE, JSON.stringify({ theme: "dark" }));

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
  const ask = async (msg, pred, what, timeout = 20000) => {
    const from = seen.length;
    ws.send(JSON.stringify(msg));
    return until(() => seen.slice(from).find(pred), timeout, what);
  };
  ws.send(JSON.stringify({ type: "create", cwd: PROJECT, name: "settings-console-ui" }));
  const created = await until(() => seen.find((m) => m.type === "session" && m.sessionId), 20000, "create");
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
  check(title === "设置 · 全局", `标题跟着作用域（${title}）`);

  const groups = (await page.locator(".st-nav__group").allInnerTexts()).map((s) => s.trim());
  check(groups.length === 2 && groups[0] === "设置" && groups[1] === "系统", `左栏两组（${groups.join(" / ")}）`);
  const navCount = await page.locator(".st-nav__item").count();
  check(navCount === 9, `左栏 9 项（${navCount}）`);
  const labels = (await page.locator(".st-nav__label").allInnerTexts()).map((s) => s.trim());
  check(
    labels.join("/") === "全局与项目/项目信任/登录·凭据/口令/扩展与 MCP/子代理/通知/运行时/更新日志",
    `九项文案（${labels.join(" / ")}）`,
  );

  // ---------------------------------------------------------------- G. C3 双作用域表单
  log("G1. 全局：改默认思考档位，只写这一个键");
  const scopeButtons = page.locator(".st-head__scope .st-seg__btn");
  check((await scopeButtons.allInnerTexts()).map((s) => s.trim()).join("/") === "全局/项目", "头部 scope 分段两项");
  check((await page.locator(".st-head__scope .st-seg__btn.on").innerText()).trim() === "全局", "默认亮在全局");
  const thinkRow = () => page.locator(".settings-row").filter({ hasText: "默认思考档位" });
  await thinkRow().locator("select").selectOption("max");
  await page.locator('[data-role="settings-save"]').click();
  await until(
    () => {
      try {
        return JSON.parse(fs.readFileSync(GLOBAL_FILE, "utf8")).defaultThinkingLevel === "max";
      } catch {
        return false;
      }
    },
    15000,
    "global settings saved",
  );
  const globalAfter = JSON.parse(fs.readFileSync(GLOBAL_FILE, "utf8"));
  check(
    globalAfter.theme === "dark" &&
      globalAfter.defaultThinkingLevel === "max" &&
      Object.keys(globalAfter).sort().join(",") === "defaultThinkingLevel,theme",
    `全局文件只多了改过的键（${JSON.stringify(globalAfter)}）`,
  );
  await until(async () => (await thinkRow().locator(".settings-src").innerText()).trim() === "已设置", 15000, "global chip");
  check(true, "全局已设置 chip 更新");

  log("G4. 项目未信任：黄条 + 保存/输入 disabled");
  await page.locator('.st-head__scope .st-seg__btn[data-scope="project"]').click();
  await until(async () => (await page.locator(".st-title").innerText()).trim() === "设置 · pi-web-client", 15000, "project title");
  const untrusted = page.locator(".takeover.warn", { hasText: "没有被信任" });
  await untrusted.waitFor({ timeout: 15000 });
  check((await untrusted.innerText()).includes("去项目信任"), "黄条带「去项目信任」");
  check(await page.locator('[data-role="settings-save"]').isDisabled(), "未信任时保存 disabled");
  const projectInputs = page.locator(".settings-row input, .settings-row select");
  check(
    (await projectInputs.count()) > 0 && (await projectInputs.evaluateAll((nodes) => nodes.every((n) => n.disabled))),
    `未信任时输入 disabled（${await projectInputs.count()} 个）`,
  );
  log("G4b. 未信任也能看对照，回表单仍只读");
  await page.locator('[data-role="settings-compare"]').click();
  await page.locator(".st-cmp").waitFor({ timeout: 15000 });
  check((await page.locator(".st-cmp-row").count()) > 0, "未信任时对照表可看");
  check((await page.locator(".st-cmp-cell.win").count()) > 0, "未信任时生效格仍标出");
  await page.locator('.st-cmp-row[data-key="defaultModel"]').click();
  await until(async () => (await page.locator(".st-cmp").count()) === 0, 15000, "compare closed untrusted");
  check(await page.locator('[data-role="settings-save"]').isDisabled(), "回表单保存仍 disabled");
  check(
    (await page.locator(".settings-row input, .settings-row select").evaluateAll((nodes) => nodes.every((n) => n.disabled))),
    "回表单输入仍 disabled",
  );
  await page.screenshot({ path: path.join(SHOTS, "settings-console-project-untrusted.png") });

  log("G2. 信任后切项目：继承 placeholder、模型写一对键");
  await ask({ type: "trust.set", cwd: PROJECT, option: 0 }, (m) => m.type === "trust" && m.saved, "trust.set");
  await page.locator(".st-head__actions button", { hasText: "刷新" }).click();
  await until(async () => (await page.locator(".takeover.warn", { hasText: "没有被信任" }).count()) === 0, 20000, "trusted repaint");
  await until(async () => !(await page.locator('[data-role="settings-save"]').isDisabled()), 15000, "save enabled");
  const projectThink = thinkRow();
  check((await projectThink.locator(".settings-src").innerText()).trim() === "未设置", "项目行 chip「未设置」");
  const inherited = (await projectThink.locator('select option[value=""]').textContent()).trim();
  check(inherited === "继承全局 · max", `项目 placeholder 继承全局（${inherited}）`);
  const modelRow = () => page.locator(".settings-row").filter({ hasText: "默认模型" });
  await modelRow().locator("select").selectOption("stub/fake-model-2");
  await page.locator('[data-role="settings-save"]').click();
  await until(
    () => {
      try {
        const j = JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8"));
        return j.defaultProvider === "stub" && j.defaultModel === "fake-model-2";
      } catch {
        return false;
      }
    },
    15000,
    "project settings saved",
  );
  const projectAfter = JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8"));
  check(
    projectAfter.theme === "dark" && projectAfter.defaultProvider === "stub" && projectAfter.defaultModel === "fake-model-2",
    `项目文件写到 defaultProvider + defaultModel（${JSON.stringify(projectAfter)}）`,
  );
  await until(async () => (await modelRow().locator(".settings-src").innerText()).trim() === "覆盖", 15000, "project chip");
  check(true, "项目已覆盖 chip 更新");

  log("G3. 切 scope 保留草稿");
  const dirRow = () => page.locator(".settings-row").filter({ hasText: "会话目录" });
  await dirRow().locator("input").fill("草稿目录");
  await page.locator('.st-head__scope .st-seg__btn[data-scope="global"]').click();
  await until(async () => (await page.locator(".st-title").innerText()).trim() === "设置 · 全局", 15000, "back to global");
  await page.locator('.st-head__scope .st-seg__btn[data-scope="project"]').click();
  await until(async () => (await page.locator(".st-title").innerText()).trim() === "设置 · pi-web-client", 15000, "back to project");
  check((await dirRow().locator("input").inputValue()) === "草稿目录", `草稿还在（${await dirRow().locator("input").inputValue()}）`);
  await dirRow().locator("input").fill("");

  log("G5. 坏 JSON：红条，只留 JSON 编辑器");
  fs.writeFileSync(GLOBAL_FILE, "{ nope");
  await page.locator('.st-head__scope .st-seg__btn[data-scope="global"]').click();
  await page.locator(".st-head__actions button", { hasText: "刷新" }).click();
  const broken = page.locator(".takeover.warn", { hasText: "不是合法的 JSON" });
  await broken.waitFor({ timeout: 15000 });
  check(await page.locator("textarea.settings-json").isVisible(), "坏 JSON 时只剩 JSON 编辑器");
  check((await page.locator(".settings-row input, .settings-row select").count()) === 0, "坏 JSON 时表单不可编辑（没有输入框）");
  await page.screenshot({ path: path.join(SHOTS, "settings-console-broken-json.png") });
  fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ theme: "dark", defaultThinkingLevel: "max" }, null, 2));
  await page.locator(".st-head__actions button", { hasText: "刷新" }).click();
  await until(async () => (await page.locator("textarea.settings-json").count()) === 0, 20000, "form back after fix");
  check(Boolean(await thinkRow().count()), "修好文件后回到表单");

  // ---------------------------------------------------------------- H. #286 对照表
  log("H. 「对照」：三列只读表 + 生效标记");
  const compareBtn = () => page.locator('[data-role="settings-compare"]');
  check((await compareBtn().innerText()).trim() === "对照", "头部有「对照」");
  await compareBtn().click();
  await page.locator(".st-cmp").waitFor({ timeout: 15000 });
  const cmpHead = (await page.locator(".st-cmp-head > span").allInnerTexts()).map((s) => s.trim());
  check(cmpHead.join("/") === "设置/全局/项目", `对照表三列（${cmpHead.join("/")}）`);
  check((await page.locator(".st-cmp input, .st-cmp select").count()) === 0, "对照表只读（没有输入）");
  const cmpNote = (await page.locator(".st-cmp-note").innerText()).trim();
  check(cmpNote.includes("表格只读") && cmpNote.includes("只写你改过的键"), `顶部说明（${cmpNote}）`);
  check((await compareBtn().innerText()).trim() === "回到表单", "进入对照后按钮变「回到表单」");
  const cmpRow = (key) => page.locator(`.st-cmp-row[data-key="${key}"]`);
  const cmpCell = (key, scope) => cmpRow(key).locator(`.st-cmp-cell[data-scope="${scope}"]`);
  const modelGlobal = (await cmpCell("defaultModel", "global").innerText()).trim();
  check(modelGlobal.includes("默认 · 自动，挑一个能用的"), `模型全局格「默认 · X」（${modelGlobal}）`);
  const modelProject = (await cmpCell("defaultModel", "project").innerText()).trim();
  check(modelProject.includes("项目生效"), `模型项目格「项目生效」（${modelProject}）`);
  const thinkInherit = (await cmpCell("defaultThinkingLevel", "project").innerText()).trim();
  check(thinkInherit.includes("继承全局 · max"), `未设置项目格「继承全局」（${thinkInherit}）`);

  log("H2. globalOnly 行项目列「仅全局」");
  const onlyGlobal = (await cmpCell("cacheWarming", "project").innerText()).trim();
  check(onlyGlobal === "仅全局", `globalOnly 项目格（${onlyGlobal}）`);

  log("H3. 「只看项目覆盖」只影响视图");
  const opacity = async (key) => Number(await cmpRow(key).evaluate((n) => getComputedStyle(n).opacity));
  const filterBtn = () => page.locator('[data-role="settings-filter"]');
  check((await opacity("defaultThinkingLevel")) === 1, "未过滤时无覆盖行正常显示");
  await filterBtn().click();
  await until(async () => (await opacity("defaultThinkingLevel")) < 0.5, 15000, "rows without project override dim");
  check((await opacity("defaultThinkingLevel")) < 0.5, "无项目覆盖的行变暗");
  check((await opacity("defaultModel")) === 1, "有项目覆盖的行不变暗");
  check((await filterBtn().innerText()).trim() === "显示全部", "过滤后按钮变「显示全部」");
  await filterBtn().click();
  await until(async () => (await opacity("defaultThinkingLevel")) === 1, 15000, "dim restored");
  check((await filterBtn().innerText()).trim() === "只看项目覆盖", "再点恢复全部行");

  log("H4. 点行回表单、聚焦、高亮");
  await cmpRow("defaultModel").click();
  await until(async () => (await page.locator(".st-cmp").count()) === 0, 15000, "compare closed");
  check((await compareBtn().innerText()).trim() === "对照", "按钮变回「对照」");
  check(
    await page.locator('.settings-row[data-key="defaultModel"] select').evaluate((n) => n === document.activeElement),
    "默认模型的输入获得焦点",
  );
  check((await page.locator('.settings-row[data-key="defaultModel"].flash').count()) === 1, "对应行短暂高亮");

  log("H5. 换页退出对照，回设置页默认表单");
  await compareBtn().click();
  await page.locator(".st-cmp").waitFor({ timeout: 15000 });
  await page.locator('.st-nav__item[data-tab="trust"]').click();
  await until(async () => (await page.locator(".st-cmp").count()) === 0, 15000, "compare reset on nav");
  await page.locator('.st-nav__item[data-tab="global"]').click();
  await until(async () => (await page.locator(".settings-form").count()) > 0, 15000, "form back");
  check((await compareBtn().innerText()).trim() === "对照", "换页后对照关闭");

  // ---------------------------------------------------------------- B. 每一页都能打开、都有内容
  log("B. 逐个点开九项");
  const pages = [
    ["global", "设置 · 全局", "全局与项目", "settings"],
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
    const on = (await page.locator(".st-nav__item.on .st-nav__label").innerText()).trim();
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
  const segs = (await page.locator(".st-pane .st-seg .st-seg__btn").allInnerTexts()).map((s) => s.trim());
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
  await page.locator('.st-pane .st-seg__btn[data-tab="whatsnew"]').click();
  const selfText = await until(
    async () => {
      const t = await page.locator(".st-pane").innerText();
      return t.includes("当前版本") ? t : null;
    },
    25000,
    "self changelog",
  );
  check(!selfText.includes("当前 pi"), "切到「本项目」是另一份正文");
  check((await page.locator(".st-pane .st-seg .st-seg__btn.on").innerText()).trim() === "本项目", "分段亮在「本项目」");
  // 深链仍按 tab id 落：/whatsnew 直接停在这一段。
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".st-console").count()) === 0, 5000, "escape");
  await page.locator(".composer textarea").fill("/whatsnew");
  await page.keyboard.press("Enter");
  await page.locator(".st-console").waitFor({ timeout: 20000 });
  check(
    (await page.locator(".st-pane .st-seg__btn.on").innerText()).trim() === "本项目",
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
  log("F. Escape 关闭；重新打开默认表单");
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.locator('.st-nav__item[data-tab="global"]').click();
  await until(async () => (await page.locator(".settings-form").count()) > 0, 15000, "settings form");
  await page.locator('[data-role="settings-compare"]').click();
  await page.locator(".st-cmp").waitFor({ timeout: 15000 });
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".st-console").count()) === 0, 5000, "escape close");
  check((await page.locator(".st-console").count()) === 0, "Escape 关掉控制台");
  await page.locator(".composer textarea").fill("/settings");
  await page.keyboard.press("Enter");
  await page.locator(".st-console").waitFor({ timeout: 20000 });
  await until(async () => (await page.locator(".settings-form").count()) > 0, 20000, "form on reopen");
  check((await page.locator(".st-cmp").count()) === 0, "重新打开设置默认是表单");
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
