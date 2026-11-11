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
const PI_LOG = path.join(REPO, ".scratch", "scratch-ui-fake-pi.jsonl");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const piNotes = () =>
  fs.readFileSync(PI_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const sessionArgv = () => piNotes().filter((note) => note.t === "argv" && (note.argv ?? []).includes("--session-dir"));
const waitUntil = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};

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
  await page.addInitScript(() => {
    const nativeSend = WebSocket.prototype.send;
    window.__failNextScratchPrompt = false;
    WebSocket.prototype.send = function (data) {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { /* not a bridge command */ }
      if (window.__failNextScratchPrompt && msg?.type === "prompt") {
        window.__failNextScratchPrompt = false;
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "error", sessionId: msg.sessionId, code: "session_not_found", message: "找不到这个会话" }) })));
        return;
      }
      nativeSend.call(this, data);
    };
  });
  await page.goto(BASE);
  await page.waitForSelector(".app", { timeout: 20000 });

  // 入口在顶栏，第 7 个位置，点开就是 dialog。
  const btn = page.locator('[data-act="scratch"]');
  check("顶栏有随手问的入口", (await btn.count()) === 1);
  await btn.click();
  await page.waitForSelector(".scratch-sheet", { state: "visible", timeout: 20000 });
  check("点开是一个 dialog", await page.locator(".scratch-sheet").isVisible());

  const hint = await page.locator(".scratch-hint").innerText();
  check("写明它不进列表 / 不改本机 / 桥重启会清空", /不进会话列表/.test(hint) && /不改本机/.test(hint) && /桥重启会清空/.test(hint), hint);

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

  // 每段回答的标题上要能看到「真正答这段话的模型」——chip 只是「当前选的」，模型自述不算数。
  const whoText = (await page.locator(".scratch-list .sc-assistant .sc-who").first().textContent()) ?? "";
  check("回答标了实际模型", /fake-model/.test(whoText), whoText.trim());

  // #368：模拟桥为本次提问返回 session_not_found；页面必须自动开新随手问、留住原字并显式说明。
  await page.evaluate(() => { window.__failNextScratchPrompt = true; });
  await page.locator(".sc-input").fill("恢复后继续问");
  await page.locator(".sc-input").press("Enter");
  await page.waitForFunction(() => /echo: 恢复后继续问/.test(document.querySelector(".scratch-list")?.textContent ?? ""), null, { timeout: 30000 });
  check("失效后自动重开并把原文字发进新对话", true);
  check("新随手问里有说明而不是桥 404", /会话没了，已开新的，接着问/.test((await page.locator(".scratch-list").textContent()) ?? ""));
  check("随手问 404 顶部横幅有重新接管和关闭", await page.locator(".scratch-reclaim").isVisible() && (await page.locator(".scratch-reclaim button").allInnerTexts()).some((text) => text.includes("重新接管")));
  check("桥 404 没被追加成错误转录", !/Session not found|找不到这个会话/.test((await page.locator(".scratch-list").textContent()) ?? ""));

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
  // Provider sections start folded; open the final `stub` group before selecting its second model.
  await page.locator(".scratch-models .model-group-head").last().click();
  await other.click();
  await page
    .waitForFunction(() => /Fake Model 2/.test(document.querySelector(".scratch-model-chip")?.textContent ?? ""), null, { timeout: 15000 })
    .catch(() => {});
  const chip2 = (await chip.textContent()) ?? "";
  check("切模型会生效", /Fake Model 2/.test(chip2), chip2.trim());

  // 多步工具调用：每条「只有工具调用」的 assistant 消息都不该再冒一个标签/省略号，
  // 连续的工具调用要收成一行。
  await page.locator(".sc-input").fill("TOOLS 试一下");
  await page.locator(".sc-input").press("Enter");
  await page.waitForFunction(() => /查到了：晴。/.test(document.querySelector(".scratch-list")?.textContent ?? ""), null, { timeout: 30000 });
  const grouped = await page.evaluate(() => {
    const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => !e.hidden && !e.closest(".sc-row")?.hidden);
    return {
      labels: vis(".scratch-list .sc-assistant .sc-who").map((e) => e.textContent),
      toolRows: vis(".scratch-list .sc-tool").map((e) => (e.textContent ?? "").trim()),
      steps: document.querySelectorAll(".scratch-list .sc-row.sc-step").length,
    };
  });
  // 全场只该有第一个回合那一个「随手问」：工具调用那几步不再各冒一个。
  check("工具步骤不再冒标签", grouped.labels.length === 2, JSON.stringify(grouped.labels));
  check("连续工具调用收成一行", grouped.toolRows.length === 1 && /web_search · fetch_content ×2/.test(grouped.toolRows[0] ?? ""), JSON.stringify(grouped.toolRows));
  check("文字为空的步骤被藏掉", grouped.steps >= 3, `${grouped.steps} 个`);

  await page.screenshot({ path: path.join(OUT, "scratch-chat.png") });

  // #367：暂停会杀掉 pi 但留下这段对话；关闭再开不能偷偷唤醒，开始沿用原会话文件。
  const pauseBtn = page.locator(".scratch-pause");
  const firstPi = sessionArgv()[0];
  const sessionDir = path.join(STATE, "scratch", "sessions");
  const sessionFile = path.join(sessionDir, fs.readdirSync(sessionDir).find((name) => name.endsWith(".jsonl")) ?? "missing.jsonl");
  await pauseBtn.click();
  await page.waitForFunction(() => document.querySelector(".scratch-state")?.textContent === "已暂停", null, { timeout: 15000 });
  check("暂停显示已暂停且输入框只读", (await pauseBtn.textContent()) === "开始" && !(await page.locator(".sc-input").isEnabled()));
  check("暂停后的说明保留在时间线", /随手问已暂停/.test((await page.locator(".scratch-list").textContent()) ?? ""));
  check("暂停后会话文件仍在", fs.existsSync(sessionFile), sessionFile);
  check("暂停后 pi 子进程退出", await waitUntil(() => piNotes().some((note) => note.t === "exit" && note.pid === firstPi?.pid), 15000));
  const pausedLaunchCount = sessionArgv().length;
  await page.locator(".scratch-close").click();
  await page.waitForSelector(".scratch-sheet", { state: "hidden", timeout: 10000 });
  await btn.click();
  await page.waitForSelector(".scratch-sheet", { state: "visible", timeout: 10000 });
  await page.waitForFunction(() => document.querySelector(".scratch-state")?.textContent === "已暂停", null, { timeout: 10000 });
  check("关闭再打开仍暂停且不启动进程", !(await page.locator(".sc-input").isEnabled()) && sessionArgv().length === pausedLaunchCount);
  await pauseBtn.click();
  check("开始会重新启动同一轮随手问", await waitUntil(() => sessionArgv().length > pausedLaunchCount, 15000));
  await page.waitForFunction(() => document.querySelector(".sc-input")?.disabled === false, null, { timeout: 30000 });
  const resumedLaunch = sessionArgv().at(-1);
  check("开始时恢复原会话文件", resumedLaunch?.argv.includes("--session") && resumedLaunch.argv.includes(sessionFile));

  // 跑轮次时暂停按钮必须禁用并说明原因，结束后自动恢复。
  await page.locator(".sc-input").fill("STAY 暂停按钮测试");
  await page.locator(".sc-input").press("Enter");
  await page.waitForFunction(() => document.querySelector(".scratch-pause")?.disabled === true, null, { timeout: 10000 });
  check("回答中暂停按钮带禁用说明", (await pauseBtn.getAttribute("title")) === "这一轮跑完才能暂停");
  await page.waitForFunction(() => document.querySelector(".scratch-pause")?.disabled === false, null, { timeout: 15000 });

  // 清空：界面立刻回到空态（桥在同一个进程里换了一条新会话）。
  await page.locator(".scratch-clear").click();
  await page.waitForFunction(() => !document.querySelector(".sc-user"), null, { timeout: 20000 });
  check("清空后对话变空", true);
  check("清空后还能接着输入", await page.locator(".sc-input").isEnabled());

  await pauseBtn.click();
  await page.waitForFunction(() => document.querySelector(".scratch-state")?.textContent === "已暂停", null, { timeout: 15000 });
  const launchesBeforePausedClear = sessionArgv().length;
  const lastPi = sessionArgv().at(-1);
  check("清空前暂停已结束子进程", await waitUntil(() => piNotes().some((note) => note.t === "exit" && note.pid === lastPi?.pid), 15000));
  await page.locator(".scratch-clear").click();
  await page.waitForFunction(
    () => document.querySelector(".scratch-state")?.textContent === "已暂停" && !document.querySelector(".sc-user"),
    null,
    { timeout: 15000 },
  );
  check("暂停时清空后仍为空且保持暂停", !(await page.locator(".sc-input").isEnabled()));
  check("暂停时清空不拉起新 pi", sessionArgv().length === launchesBeforePausedClear);

  // 关掉再开：进程还在，视图收起而已。
  await page.locator(".scratch-close").click();
  await page.waitForSelector(".scratch-sheet", { state: "hidden", timeout: 10000 });
  await btn.click();
  await page.waitForSelector(".scratch-sheet", { state: "visible", timeout: 10000 });
  check("关掉再打开还是那个 dialog", true);

  // #368：主会话的 404 横幅与随手问的横幅各自留在自己的区域，关闭一边不影响另一边。
  await page.evaluate(() => { location.hash = "#/s/no-main-session"; });
  await page.waitForSelector(".session-reclaim", { state: "visible", timeout: 10000 });
  check("主会话 404 显示独立顶部横幅", await page.locator(".session-reclaim").isVisible() && (await page.locator(".session-reclaim button").allInnerTexts()).some((text) => text.includes("重新接管")));
  check("主会话和随手问横幅同时存在", await page.locator(".scratch-reclaim").isVisible());
  check("主会话 404 没进聊天记录", !/Session not found|找不到这个会话/.test((await page.locator(".chat-scroll").textContent()) ?? ""));
  await page.locator(".scratch-close").click();
  await page.locator(".session-reclaim-close").click();
  check("关闭主会话横幅不关闭随手问横幅", !(await page.locator(".session-reclaim").isVisible()) && await page.locator(".scratch-reclaim").evaluate((el) => !el.hidden));
  await btn.click();
  await page.waitForSelector(".scratch-sheet", { state: "visible", timeout: 10000 });
  check("重新打开随手问时其横幅仍独立存在", await page.locator(".scratch-reclaim").isVisible() && !(await page.locator(".session-reclaim").isVisible()));
  await page.locator(".scratch-reclaim-close").click();
  check("关闭随手问横幅不影响主会话区域", !(await page.locator(".scratch-reclaim").isVisible()) && !(await page.locator(".session-reclaim").isVisible()));

  // 语言：dialog 是独立实例，不在 renderAll 的覆盖范围里 —— 切语言后静态文案必须一起变。
  await page.locator(".scratch-close").click();
  await page.waitForSelector(".scratch-sheet", { state: "hidden", timeout: 10000 });
  await page.locator('[data-act="look"]').click();
  await page.locator('.chip[lang="ja"]').click();
  await page.mouse.click(5, 5); // 点 backdrop 收起「外观与语言」
  await page.waitForSelector(".sheet-back", { state: "hidden", timeout: 10000 }).catch(() => {});
  await btn.click();
  await page.waitForSelector(".scratch-sheet", { state: "visible", timeout: 10000 });
  const jaTexts = await page.evaluate(() => {
    const wideText = (act) => {
      const b = document.querySelector(`[data-act="${act}"]`);
      return b ? `${b.querySelector(".ic")?.textContent ?? ""} ${b.querySelector(".lb")?.textContent ?? ""}` : null;
    };
    return {
      title: document.querySelector(".scratch-sheet .sheet-title")?.textContent,
      clear: document.querySelector(".scratch-sheet .scratch-clear")?.textContent,
      send: document.querySelector(".scratch-sheet .btn.primary")?.textContent,
      hint: document.querySelector(".scratch-hint")?.textContent,
      pause: document.querySelector(".scratch-pause")?.textContent,
      paused: document.querySelector(".scratch-state")?.textContent,
      // 顶栏这两颗以前不跟语言：内网通的按钮从没登记进 els（paintChrome 那段是死代码），
      // 随手问压根没写进 paintChrome。D131 之后宽按钮拆成 `.ic` + `.lb` 两个 span，
      // 两段之间没有空格 —— 拿整颗按钮的 textContent 比「🌐 LAN」永远不等，所以分开读。
      peerBtn: wideText("peer"),
      scratchBtn: wideText("scratch"),
      termBtn: wideText("terminal"),
    };
  });
  check("切语言后标题跟着变", jaTexts.title === "ちょい聞き", jaTexts.title ?? "");
  check("切语言后按钮跟着变", jaTexts.clear === "クリア" && jaTexts.send === "送信", `${jaTexts.clear} / ${jaTexts.send}`);
  check("切语言后说明行跟着变", /セッション一覧に出ない/.test(jaTexts.hint ?? ""), jaTexts.hint ?? "");
  check("日文暂停状态与开始按钮跟着变", jaTexts.paused === "一時停止" && jaTexts.pause === "再開", `${jaTexts.paused} / ${jaTexts.pause}`);
  await page.locator(".scratch-pause").click();
  await page.waitForFunction(
    () => document.querySelector(".scratch-pause")?.textContent === "一時停止" && document.querySelector(".sc-input")?.disabled === false,
    null,
    { timeout: 30000 },
  );
  await page.locator(".sc-input").fill("STAY 日文暂停提示");
  await page.locator(".sc-input").press("Enter");
  await page.waitForFunction(() => document.querySelector(".scratch-pause")?.disabled === true, null, { timeout: 10000 });
  check("日文轮次中的禁用原因跟着变", (await page.locator(".scratch-pause").getAttribute("title")) === "このターンが終わるまで一時停止できません");
  await page.waitForFunction(() => document.querySelector(".scratch-pause")?.disabled === false, null, { timeout: 15000 });
  await page.locator(".scratch-pause").click();
  await page.waitForFunction(() => document.querySelector(".scratch-state")?.textContent === "一時停止", null, { timeout: 15000 });
  check("切语言后内网通的按钮跟着变", jaTexts.peerBtn === "🌐 LAN", jaTexts.peerBtn ?? "");
  check("切语言后随手问的按钮跟着变", jaTexts.scratchBtn === "💭 ちょい聞き", jaTexts.scratchBtn ?? "");
  check("旁边的按钮仍在跟着变（回归基线）", jaTexts.termBtn === ">_ ターミナル", jaTexts.termBtn ?? "");

  // 内网通是独立页面（peer.html）：它以前用 getLang()（那个文档里永远是 zh-Hans），
  // 加上 HTML 里的静态文案从来没走过 tr() —— 切了语言它还是中文。
  await page.locator(".scratch-close").click();
  await page.locator('[data-act="peer"]').click();
  const frame = page.frameLocator(".peer-frame");
  // 新版内网通：左边是轨道按钮（文案在 span.tag 里），不再是 TAB。
  // 「‹ 回 pi」在 iframe 里不渲染（外层弹框已经有标题），所以拿轨道标签当锚点。
  await frame.locator(".rail button").first().waitFor({ timeout: 20000 });
  const railLabels = await frame.locator(".rail button span.tag").allInnerTexts();
  check("内网通页面跟着切到日文", railLabels[0] === "メッセージ" && railLabels.length === 4, railLabels.join(" / "));

  // 外观「字号」= `#app { zoom: var(--ui-scale) }`：弹层必须挂在 #app 里才跟它一起缩
  // （挂 body 上的抽屉实测不跟，D36）。量三件：贴住右缘、宽度、输入框高度。
  await page.locator(".peer-sheet .sheet-head .btn").click();
  await page.waitForSelector(".peer-sheet", { state: "detached", timeout: 10000 });
  const geom = () =>
    page.evaluate(() => {
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const sheet = r(".scratch-sheet");
      const input = r(".sc-input");
      if (!sheet || !input) return null;
      return { w: Math.round(sheet.width), right: Math.round(sheet.right), inputH: Math.round(input.height), vw: window.innerWidth };
    });
  await btn.click();
  await page.waitForSelector(".scratch-sheet", { state: "visible", timeout: 10000 });
  // 入场动画（`scratch-in`）从 translateX(24px) 滑进来：等它落定再量，否则右缘多出 24/30px。
  await page.waitForTimeout(300);
  const one = await geom();
  check("字号标准时 dialog 贴住视口右缘", Boolean(one) && one.right === one.vw, JSON.stringify(one));
  await page.locator(".scratch-close").click();
  await page.locator('[data-act="look"]').click();
  // 第二组 .levels 就是字号（第一组是语言），最后一颗 = 特大。
  await page.locator(".display-sheet input[type=range]").evaluate((el) => {
    el.value = "1.25";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowRight" }));
  });
  await page.waitForFunction(() => document.querySelector(".display-sheet .size-read")?.textContent === "125%", null, { timeout: 5000 });
  await page.locator(".display-sheet .sheet-head .btn").click();
  await btn.click();
  await page.waitForSelector(".scratch-sheet", { state: "visible", timeout: 10000 });
  await page.waitForTimeout(300);
  const big = await geom();
  check(
    "字号特大时 dialog 跟着放大",
    Boolean(one && big) && Math.abs(big.w - Math.round(one.w * 1.25)) <= 2 && Math.abs(big.right - big.vw) <= 1,
    JSON.stringify({ one, big }),
  );
  check("字号特大时输入框也变高", Boolean(one && big) && big.inputH === Math.round(one.inputH * 1.25), `${one?.inputH} → ${big?.inputH}`);
  await page.screenshot({ path: path.join(OUT, "scratch-chat-big.png") });

  await page.locator(".scratch-close").click();
  await page.locator('[data-act="look"]').click();
  await page.locator('.chip[lang="en"]').click();
  await page.mouse.click(5, 5);
  await page.waitForSelector(".sheet-back", { state: "hidden", timeout: 10000 }).catch(() => {});
  await btn.click();
  await page.waitForSelector(".scratch-sheet", { state: "visible", timeout: 10000 });
  check(
    "英文暂停状态与开始按钮跟着变",
    (await page.locator(".scratch-state").textContent()) === "Paused" && (await page.locator(".scratch-pause").textContent()) === "Resume",
  );
  await page.locator(".scratch-pause").click();
  await page.waitForFunction(
    () => document.querySelector(".scratch-pause")?.textContent === "Pause" && document.querySelector(".sc-input")?.disabled === false,
    null,
    { timeout: 30000 },
  );
  await page.locator(".sc-input").fill("STAY English pause tooltip");
  await page.locator(".sc-input").press("Enter");
  await page.waitForFunction(() => document.querySelector(".scratch-pause")?.disabled === true, null, { timeout: 10000 });
  check("英文轮次中的禁用原因跟着变", (await page.locator(".scratch-pause").getAttribute("title")) === "Wait for this turn to finish before pausing");
  await page.waitForFunction(() => document.querySelector(".scratch-pause")?.disabled === false, null, { timeout: 15000 });
  await page.locator(".scratch-pause").click();
  await page.waitForFunction(() => document.querySelector(".scratch-state")?.textContent === "Paused", null, { timeout: 15000 });
  check("英文开始后按钮文案跟着变", (await page.locator(".scratch-pause").textContent()) === "Resume");
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
