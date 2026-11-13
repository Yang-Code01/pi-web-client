/**
 * Probe: 预览里的翻译对照在真 Chromium 里走得通（D241 / D241）。
 *
 * 覆盖一条人眼能看见的路径：打开一个日文 md → 点「译」→ 选语言/模型 → 开始 →
 * 自动全屏、左原文右译文 → 改一句译文并保存 → 同步原文（看差异）→ 写回磁盘。
 *
 * 模型是桩（`bridge/tests/fixtures/fake-pi-translate.mjs`），所以不花模型 turn、不认网络。
 * 自带丢弃式 bridge + 状态目录，端口默认 7922（PREVIEW_TR_PORT 可改）。
 *
 *   node probes/translate-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync, spawn } from "node:child_process";
import { WebSocket } from "ws";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.PREVIEW_TR_PORT ?? 7922);
const ROOT = path.join(REPO, ".scratch", "translate-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "translate-ui-pass";
const NAME = "変更一覧.md";
const DOC = path.join(WORK, NAME);

const SRC = [
  "## 対象ツール",
  "",
  "対象は `jp.co.isid.cas3.onecas.purchaseorder.PurchaseOrderService` の 3 メソッドです。",
  "",
  "| 元のメッセージID | 変更後の文言 | 備考 |",
  "| --- | --- | --- |",
  "| msg_order_submitted | 連携種別が CAS、M システムのいずれかの場合、変更できません。 | なし |",
  "| msg_cooperation_type_cannot_from_offline_to_dias_by_delivery | オフラインで受領した納品書を中止してください。 | なし |",
  "",
  "```ts",
  "const label = msg_order_submitted;",
  "```",
  "",
  "## 発注単位",
  "",
  "発注単位は既存の採番処理を利用し、本修正で番号を生成しない。",
  "",
].join("\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, WORK, OUT]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(DOC, SRC, "utf8");

function killPort(port) {
  try {
    const pids = new Set();
    const out = execSync("netstat -ano", { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+(\S+)\s+\S+\s+(\d+)$/);
      if (m && Number(m[1]) === port && /:0$/.test(m[2])) pids.add(Number(m[3]));
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      } catch {
        /* 已经没了 */
      }
    }
  } catch {
    /* 没有 netstat 就算了 */
  }
}
killPort(PORT);

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi-translate.mjs"),
  FAKE_PI_LOG: PI_LOG,
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

const piLog = () =>
  fs.existsSync(PI_LOG)
    ? fs
        .readFileSync(PI_LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return {};
          }
        })
    : [];
const spawnLine = (sid) => piLog().find((l) => l.t === "argv" && (l.argv ?? []).includes(sid) && l.loopback);

const post = async (url, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

let browser = null;
let code = 1;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* wait */
    }
    await sleep(200);
  }
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
  const seen = [];
  ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "create", cwd: WORK, name: "translate-ui" }));
  let sid = null;
  for (let i = 0; i < 300 && !sid; i++) {
    sid = seen.find((m) => m.type === "session" && m.state?.id)?.state.id ?? null;
    if (!sid) await sleep(100);
  }
  if (!sid) throw new Error(`no session:\n${bridgeOut.join("").slice(-2000)}`);
  for (let i = 0; i < 100 && !spawnLine(sid); i++) await sleep(100);
  const token = spawnLine(sid)?.loopbackToken;
  if (!token) throw new Error("no loopback credential");

  browser = await chromium.launch({ headless: !process.env.PW_HEADFUL });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`${BASE}/#/s/${sid}`, { waitUntil: "networkidle" });
  await page.locator(".topbar .icon-btn", { hasText: "文件" }).waitFor({ timeout: 15000 });

  // 页面订阅和这条请求是两条线：页面还没到就再敲一次，最多 15 秒。
  let reply = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    reply = await post("/api/preview/open", { token, path: DOC });
    if (reply.data?.ok) break;
    await sleep(300);
  }
  check("桥说打开了（ok:true）", reply?.data?.ok === true, JSON.stringify(reply?.data));
  await page.waitForFunction((n) => document.querySelector(".viewer-name")?.textContent === n, NAME, {
    timeout: 15000,
  });

  const tools = page.locator(".viewer-tools");
  const tr = tools.locator("button.viewer-btn", { hasText: "译" }).first();
  check("预览头上有「译」按钮", (await tr.count()) === 1);
  check("对照页签可用", await tools.locator(".pane-seg button", { hasText: "对照" }).first().isEnabled());

  // ---- 1. 选择器：语言 + 模型
  await tr.click();
  const pick = page.locator(".tr-pick");
  await pick.waitFor({ timeout: 10000 });
  check("选语言/模型的弹层出来了", true);
  await pick.locator(".tr-langbtn", { hasText: "中文" }).click();
  check("选中的语言按钮高亮", (await pick.locator(".tr-langbtn.on").innerText()) === "中文");
  const optCount = await pick.locator("select.tr-modelsel option").count();
  check("模型下拉里有可选模型", optCount > 0, `${optCount} 个`);
  await pick.locator(".choose-row button.primary", { hasText: "开始" }).click();

  // ---- 2. 翻完：自动全屏、两节左右对照
  await page.locator(".tr-cmp .tr-row").first().waitFor({ timeout: 40000 });
  await page.waitForFunction(() => document.querySelectorAll(".tr-cmp .tr-row").length === 2, null, {
    timeout: 40000,
  });
  check("两节都排上了左右对照", true);
  check("开始翻译后自动全屏", (await page.locator(".viewer.full").count()) === 1);
  const srcText = await page.locator(".tr-cmp .tr-row").first().locator(".tr-src").innerText();
  const outText = await page.locator(".tr-cmp .tr-row").first().locator(".tr-out").innerText();
  check("左边是原文", srcText.includes("対象は") && srcText.includes("msg_order_submitted"));
  // 标题行照抄（"対象ツール" 里的「ー」也是假名），所以这里不查假名，查原文里的整句没了。
  check("右边是译文（桩加了「译」）", outText.includes("译") && !outText.includes("オフラインで受領した"));
  check("标题行左右对得上", outText.includes("対象ツール"));
  await page.screenshot({ path: path.join(OUT, "1-compare.png"), fullPage: false });

  // ---- 3. 改一句译文，只落缓存
  await page.locator(".tr-tools button", { hasText: "改译文" }).click();
  const ta = page.locator("textarea.tr-ed");
  await ta.waitFor({ timeout: 10000 });
  const draft = (await ta.inputValue()).replace("译 ", "译 改过 ");
  await ta.fill(draft);
  await page.keyboard.press("Control+s");
  await page.waitForFunction(
    () => (document.querySelector(".tr-brief")?.textContent ?? "").includes("译文已保存"),
    null,
    { timeout: 15000 },
  );
  check("改完保存有回执", true);
  check("保存没碰源文件", fs.readFileSync(DOC, "utf8") === SRC);

  // ---- 4. 同步原文：先看差异，再写盘
  await page.locator(".tr-tools button", { hasText: "同步原文" }).click();
  const review = page.locator(".tr-review");
  await review.waitFor({ timeout: 30000 });
  const diffs = await review.locator(".tr-diff").count();
  check("同步前给出改动块", diffs >= 1, `${diffs} 块`);
  check("差异里能看到改过的译文", (await review.locator(".tr-diff pre.del").first().innerText()).length > 0);
  check("还没点写回，源文件没动", fs.readFileSync(DOC, "utf8") === SRC);
  await page.screenshot({ path: path.join(OUT, "2-sync-review.png"), fullPage: false });
  await review.locator(".choose-row button.primary").click();

  await page.waitForFunction(
    () => (document.querySelector(".tr-brief")?.textContent ?? "").includes("已写回原文"),
    null,
    { timeout: 20000 },
  );
  const after = fs.readFileSync(DOC, "utf8");
  check("源文件里换成了改后的说法", after.includes("改过"));
  check("没动的地方原样留着", after.includes("## 発注単位") && after.includes("```ts"));

  // ---- 5. 设置 → 系统 → 预览与翻译：默认模型记住、恢复默认
  // 对照是全屏的，侧栏被盖住：先关掉预览再点设置。
  await page.locator('.viewer-tools button[title="关闭（Esc）"]').click();
  await page.waitForTimeout(400);
  await page.locator(".set-btn").click();
  await page.locator('.display-sheet .chip', { hasText: "连接与设置" }).click();
  await page.getByRole("button", { name: "pi 设置" }).click();
  await page.locator('.st-nav__item[data-tab="preview"]').click();
  const pane = page.locator(".st-pane");
  await pane.locator("select.tr-modelsel").waitFor({ timeout: 10000 });
  const headTitle = await page.locator('.st-console [data-role="title"]').innerText();
  check("设置页标题跟着切到「预览与翻译」", headTitle.includes("预览与翻译"), headTitle);
  const psel = pane.locator("select.tr-modelsel");
  const opts = await psel.locator("option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  // 偏好是异步读的（一进页面先画一遍，读到再重画）：等到下拉变成刚才翻译用的那个。
  const prefShown = await page
    .waitForFunction(() => document.querySelector(".st-pane select.tr-modelsel")?.value === "stub/fake-model", null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("设置页显示上次用的模型（翻一次就记住）", prefShown, await psel.inputValue());
  check("下拉退回目录里第一项", (await psel.inputValue()) === opts[0], await psel.inputValue());
  // 选一个别的 → 写进桥的偏好（prefs.json 在状态目录里，不是 settings.json）
  await psel.selectOption(opts[opts.length - 1]);
  const prefsFile = path.join(STATE, "translate", "prefs.json");
  await new Promise((r) => setTimeout(r, 800));
  let prefModel = "";
  try {
    prefModel = JSON.parse(fs.readFileSync(prefsFile, "utf8")).model;
  } catch {
    prefModel = "<没读到>";
  }
  check("选了就记住（写 prefs.json）", prefModel === opts[opts.length - 1], prefModel);
  await pane.getByRole("button", { name: /恢复默认/ }).click();
  await new Promise((r) => setTimeout(r, 800));
  check("恢复默认回到 copilot/gpt-6-luna", JSON.parse(fs.readFileSync(prefsFile, "utf8")).model === "copilot/gpt-6-luna");
  // 桩目录里没有 luna：正好验「默认模型找不到时让人重挑」那一行提示。
  const lunaWarn = await page
    .waitForFunction(() => (document.querySelector(".st-pane .hint.warn")?.textContent ?? "").includes("不在模型目录里"), null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("目录里没有默认模型时提示重挑", lunaWarn);
  await page.screenshot({ path: path.join(OUT, "4-settings.png"), fullPage: false });

  check("没有页面报错", errs.length === 0, errs.join(" | "));
  await page.screenshot({ path: path.join(OUT, "3-after-apply.png"), fullPage: false });
  code = 0;
} catch (e) {
  console.log(" FAIL ", e.message);
  if (bridgeOut.length) console.log(bridgeOut.join("").slice(-3000));
  code = 1;
} finally {
  try {
    await browser?.close();
  } catch {}
  try {
    bridge.kill();
  } catch {}
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? `${failed} 处失败` : "全部通过"}（${results.length} 项）`);
process.exit(failed ? 1 : code);
