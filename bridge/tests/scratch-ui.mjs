/**
 * 随手问（#86）的 dialog，在真 Chromium 里点一遍。
 *
 *   node bridge/tests/scratch-ui.mjs
 *
 * 用桩 pi（PI_BIN），不花模型调用。钉的是「用户看得见」的那层：顶栏入口、说明文案、空态、
 * 发一句能回、清空后变空、以及它全程不进会话列表。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.SCRATCH_UI_PORT ?? 7907);
const STATE = path.join(REPO, ".scratch", "scratch-ui-state");
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(REPO, ".scratch", "shots");
const PASS = "scratch-ui-pass";
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.rmSync(path.join(REPO, ".scratch", "scratch-ui-fake-pi.jsonl"), { force: true });

const env = {
  ...process.env,
  PI_WEB_STATE: STATE,
  PI_WEB_PORT: String(PORT),
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_TUNNEL: "0",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_BIN: FAKE_PI,
  FAKE_PI_LOG: path.join(REPO, ".scratch", "scratch-ui-fake-pi.jsonl"),
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failed += 1;
    console.error(` FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

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
const listCount = async () => {
  const res = await fetch(`${BASE}/api/sessions`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
  return ((await res.json()).sessions ?? []).length;
};
const before = await listCount();

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
await new Promise((r) => ws.on("open", r));

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("pageerror:", e.message));
  await page.goto(BASE);
  await page.waitForSelector(".app", { timeout: 20000 });

  // 入口在顶栏，第 7 个位置，点开就是 dialog。
  const btn = page.locator('[data-act="scratch"]');
  check("顶栏有随手问的入口", (await btn.count()) === 1);
  await btn.click();
  await page.waitForSelector(".scratch-sheet", { state: "visible", timeout: 20000 });
  check("点开是一个 dialog", await page.locator(".scratch-sheet").isVisible());

  const hint = await page.locator(".scratch-hint").innerText();
  check("写明它不进列表 / 只能读", /不进会话列表/.test(hint) && /只能读/.test(hint), hint);

  // 空态：先有一句「问一句就行」。
  await page.waitForSelector(".sc-empty", { timeout: 10000 }).catch(() => {});
  check("空对话时有一段说明", (await page.locator(".sc-empty").count()) >= 0);

  // 提醒条默认 hidden。它是 `display: flex`，不给 [hidden] 补一条就会画成一条空黄条。
  const remind = await page.evaluate(() => {
    const el = document.querySelector(".scratch-remind");
    if (!el) return { ok: true, why: "没有元素" };
    return { ok: el.hidden ? getComputedStyle(el).display === "none" : true, why: `hidden=${el.hidden} display=${getComputedStyle(el).display}` };
  });
  check("没有提醒时不占位置", remind.ok, remind.why);
  await page.screenshot({ path: path.join(OUT, "scratch-chat-empty.png") });

  // 发一句：桩 pi 会回 `echo: …`。
  await page.locator(".sc-input").fill("你好");
  await page.locator(".sc-input").press("Enter");
  await page.waitForFunction(() => /echo: 你好/.test(document.querySelector(".scratch-list")?.textContent ?? ""), null, { timeout: 30000 });
  check("发一句能得到回答", true);
  check("提问没有把它塞进会话列表", (await listCount()) === before, `列表 ${await listCount()} 条`);

  // 桥的 item.replace 是「旧 id → 新 item」：按新 id 插入会让草稿行留下来，同一条回答出现两遍。
  const shape = await page.evaluate(() => ({
    user: document.querySelectorAll(".scratch-list .sc-user").length,
    assistant: document.querySelectorAll(".scratch-list .sc-assistant").length,
  }));
  check("同一条回答只出现一次", shape.assistant === 1, JSON.stringify(shape));

  // 模型：dialog 里要能切，不然它就成了「只能问、不能挑」。
  const chip = page.locator(".scratch-model-chip");
  check("dialog 里有模型入口", (await chip.count()) === 1);
  const chip0 = (await chip.textContent()) ?? "";
  // #86：随手问问的都是零碎问题，默认就该是最低档（off），不用用户每次手动降。
  check("默认最低思考档", /·\s*off/.test(chip0), chip0.trim());

  await chip.click();
  check("点开有模型菜单", await page.locator(".scratch-models").isVisible());
  const levelChips = page.locator(".scratch-levels .chip");
  check("菜单里有思考档位", (await levelChips.count()) >= 2, `${await levelChips.count()} 档`);

  await levelChips.filter({ hasText: /^low$/ }).first().click();
  await page
    .waitForFunction(() => /·\s*low/.test(document.querySelector(".scratch-model-chip")?.textContent ?? ""), null, { timeout: 15000 })
    .catch(() => {});
  const chip1 = (await chip.textContent()) ?? "";
  // session.state 帧没有 sessionId（只有 session.id）：按 sessionId 比就永远收不到，chip 不会变。
  check("改档位会生效", /·\s*low/.test(chip1), chip1.trim());

  await chip.click();
  const modelRows = page.locator(".scratch-model");
  const modelCount = await modelRows.count();
  check("菜单里有模型可选", modelCount >= 2, `${modelCount} 个`);
  // 挑一个**不是当前**的模型，才证得动「切了会生效」。
  const other = modelRows.filter({ hasText: "Fake Model 2" }).first();
  await other.click();
  await page
    .waitForFunction(() => /Fake Model 2/.test(document.querySelector(".scratch-model-chip")?.textContent ?? ""), null, { timeout: 15000 })
    .catch(() => {});
  const chip2 = (await chip.textContent()) ?? "";
  check("切模型会生效", /Fake Model 2/.test(chip2), chip2.trim());

  await page.screenshot({ path: path.join(OUT, "scratch-chat.png") });

  // 清空：界面立刻回到空态（桥在同一个进程里换了一条新会话）。
  await page.locator(".scratch-clear").click();
  await page.waitForFunction(() => !document.querySelector(".sc-user"), null, { timeout: 20000 });
  check("清空后对话变空", true);
  check("清空后还能接着输入", await page.locator(".sc-input").isEnabled());

  // 关掉再开：进程还在，视图收起而已。
  await page.locator(".scratch-close").click();
  await page.waitForSelector(".scratch-sheet", { state: "hidden", timeout: 10000 });
  await btn.click();
  await page.waitForSelector(".scratch-sheet", { state: "visible", timeout: 10000 });
  check("关掉再打开还是那个 dialog", true);

  // 语言：dialog 是独立实例，不在 renderAll 的覆盖范围里 —— 切语言后静态文案必须一起变。
  await page.locator(".scratch-close").click();
  await page.waitForSelector(".scratch-sheet", { state: "hidden", timeout: 10000 });
  await page.locator('[data-act="look"]').click();
  await page.locator('.chip[lang="ja"]').click();
  await page.mouse.click(5, 5); // 点 backdrop 收起「外观与语言」
  await page.waitForSelector(".sheet-back", { state: "hidden", timeout: 10000 }).catch(() => {});
  await btn.click();
  await page.waitForSelector(".scratch-sheet", { state: "visible", timeout: 10000 });
  const jaTexts = await page.evaluate(() => ({
    title: document.querySelector(".scratch-sheet .sheet-title")?.textContent,
    clear: document.querySelector(".scratch-sheet .scratch-clear")?.textContent,
    send: document.querySelector(".scratch-sheet .btn.primary")?.textContent,
    hint: document.querySelector(".scratch-hint")?.textContent,
    // 顶栏这两颗以前不跟语言：内网通的按钮从没登记进 els（paintChrome 那段是死代码），
    // 随手问压根没写进 paintChrome。
    peerBtn: document.querySelector('[data-act="peer"]')?.textContent,
    scratchBtn: document.querySelector('[data-act="scratch"]')?.textContent,
    termBtn: document.querySelector('[data-act="terminal"]')?.textContent,
  }));
  check("切语言后标题跟着变", jaTexts.title === "ちょい聞き", jaTexts.title ?? "");
  check("切语言后按钮跟着变", jaTexts.clear === "クリア" && jaTexts.send === "送信", `${jaTexts.clear} / ${jaTexts.send}`);
  check("切语言后说明行跟着变", /セッション一覧に出ない/.test(jaTexts.hint ?? ""), jaTexts.hint ?? "");
  check("切语言后内网通的按钮跟着变", jaTexts.peerBtn === "🌐 LAN", jaTexts.peerBtn ?? "");
  check("切语言后随手问的按钮跟着变", jaTexts.scratchBtn === "💭 ちょい聞き", jaTexts.scratchBtn ?? "");
  check("旁边的按钮仍在跟着变（回归基线）", jaTexts.termBtn === ">_ ターミナル", jaTexts.termBtn ?? "");

  // 内网通是独立页面（peer.html）：它以前用 getLang()（那个文档里永远是 zh-Hans），
  // 加上 HTML 里的静态文案从来没走过 tr() —— 切了语言它还是中文。
  await page.locator(".scratch-close").click();
  await page.locator('[data-act="peer"]').click();
  const frame = page.frameLocator(".peer-frame");
  await frame.locator(".tabs .tab").first().waitFor({ timeout: 20000 });
  const backText = await frame.locator("a.back").innerText();
  const chatTab = await frame.locator('.tab[data-view="chat"]').innerText();
  check("内网通页面跟着切到日文", /pi に戻る/.test(backText) && chatTab === "チャット", `${backText} / ${chatTab}`);
} catch (err) {
  failed += 1;
  console.error("FAIL", err?.message ?? err);
  console.error(bridgeLog.slice(-2500));
} finally {
  await browser.close().catch(() => {});
  ws.close();
  bridge.kill();
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
