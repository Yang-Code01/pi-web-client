/**
 * Mac 风格的弹层守卫：真 Chromium 里把每个 dialog 的「外壳三件套」量一遍 ——
 * 遮罩（毛玻璃 + 淡入）、面板（毛玻璃 + 窗口入场 + 14px 圆角）、退场（`.mac-leaving` → mac-window-out），
 * 并跟「产物」（`.st-back .art-sheet`，已知正确的那一层）逐项对齐。哪一行偏了这探针就红。
 *
 * 为什么要它：shell 不止一套。`sys` / `jc` / `mc` 是系统管理 / Jira / 邮箱各抄一份的控制台，
 * 外壳长得一样、类名不同；零散弹层（确认层、灯箱、笔记选人、子弹层、小选择器）又各是各的。
 * 2026-11-21 实测过：漏一个，那个弹层就退回「深黑遮罩 + 纯白面板 + 没有入场」。
 *
 * Run: npm --prefix web run build && node probes/mac-dialogs.mjs
 * （起自己的一份 bridge（临时 agent 目录 + 桩会话），不碰 7864，也不花模型调用。）
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

// 探针驱动的是构建产物：dist 比 src 旧的话，测的是上一个提交，失败原因会骗人。
const DIST = path.join(REPO, "bridge/dist/index.js");
if (!fs.existsSync(DIST)) {
  console.error("bridge/dist/index.js 不存在：先 npm run build");
  process.exit(2);
}

const PORT = Number(process.env.PI_WEB_PORT ?? 7924);
const ROOT = path.join(REPO, ".scratch/mac-dialogs");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "zz-mac-dialogs";

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK, OUT]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(dir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "mac 弹层诊断" }] } },
  { type: "message", id: "m2", parentId: "m1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "好。" }] } },
  { type: "session_info", id: "n1", parentId: "m2", timestamp: at, name: "mac 弹层诊断" },
];
fs.writeFileSync(path.join(dir, `${SID}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

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
      } catch {}
    }
  } catch {}
}
killPort(PORT);

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_WEB_FILEINDEX_ROOTS: WORK,
  },
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
  throw new Error(`timeout: ${label}`);
}

const MEASURE = (sel) => {
  const back = document.querySelector(sel);
  if (!back) return null;
  const PANELS =
    ".sys-console, .jc-console, .mc-console, .mc-confirm, .st-console, .argdialog-panel, .notes-sheet, .branch-sheet, .repos-sheet, .choose, .jira-ask, .jira-picker-box, .peer-pick-panel, .image-view-img, .sheet, form";
  const panel = back.matches(PANELS) ? back : back.querySelector(PANELS);
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
  return {
    back: {
      bg: cs(back, "backgroundColor"),
      blur: cs(back, "backdropFilter"),
      anim: cs(back, "animationName"),
      dur: cs(back, "animationDuration"),
    },
    panel: panel
      ? {
          tag: panel.tagName.toLowerCase() + "." + (panel.className || "").split(/\s+/).filter(Boolean).join("."),
          bg: cs(panel, "backgroundColor"),
          bgImg: cs(panel, "backgroundImage"),
          blur: cs(panel, "backdropFilter"),
          radius: cs(panel, "borderRadius"),
          shadow: cs(panel, "boxShadow"),
          anim: cs(panel, "animationName"),
          dur: cs(panel, "animationDuration"),
        }
      : null,
  };
};

const results = [];
const measure = async (page, label, sel) => {
  const r = await page.evaluate(MEASURE, sel);
  results.push(r ? { label, sel, ...r } : { label, sel, missing: true });
  return r;
};

const SKELETONS = [
  ["系统管理 sysmanage", `<div class="sys-back"><section class="sys-console"></section></div>`],
  ["文件管理器 fileconsole", `<div class="sys-back fc-back"><section class="sys-console fc-console"></section></div>`],
  ["热部署 hotdeploy", `<div class="sys-back hot-back"><section class="sys-console hot"></section></div>`],
  ["Jira 面板", `<div class="jc-back"><section class="jc-console"></section></div>`],
  ["Jira 确认层", `<div class="jira-ask-back"><div class="jira-ask"></div></div>`],
  ["Jira 附件根目录", `<div class="jira-picker"><div class="jira-picker-box"></div></div>`],
  ["邮箱", `<div class="mc-back"><section class="mc-console"></section></div>`],
  ["邮箱确认框 mc-confirm", `<div class="mc-back mc-back--confirm"><section class="mc-confirm"></section></div>`],
  ["笔记（sheet 家族）", `<div class="sheet-back notes-back"><div class="sheet notes-sheet"></div></div>`],
  ["分支面板 branch-sheet", `<div class="sheet-back center branch-back"><div class="branch-sheet go-sheet"></div></div>`],
  ["仓库面板 repos-sheet", `<div class="sheet-back center repos-back"><div class="repos-sheet"></div></div>`],
  ["子弹层 sheet-sub", `<div class="sheet-sub-back"><div class="sheet sub-sheet"></div></div>`],
  ["选择器 choose", `<div class="choose-back"><div class="choose"></div></div>`],
  ["图片灯箱 image-view", `<div class="image-view"><img class="image-view-img" alt=""></div>`],
  ["笔记选人 peer-pick", `<div class="peer-pick"><div class="peer-pick-panel"></div></div>`],
  ["新建会话（骨架对照）", `<div class="sheet-back center"><div class="sheet new-sheet"></div></div>`],
];

let browser = null;
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

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    prefs.theme = "mac-light";
    localStorage.setItem("pi.prefs", JSON.stringify(prefs));
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  log("theme:", await page.evaluate(() => `${document.documentElement.dataset.theme} / ui=${document.documentElement.dataset.ui}`));

  await until(async () => (await page.locator(".session-card").count()) >= 1, 15000, "session card");
  await page.locator(".session-card").first().click();
  await sleep(600);
  log("顶栏按钮:", await page.$$eval(".topbar .icon-btn", (els) => els.map((e) => e.dataset.act).join(",")));

  // ---- 1. Everything（真开）
  const fsearchBtn = page.locator('.topbar .icon-btn[data-act="filesearch"]');
  await until(() => fsearchBtn.isVisible(), 8000, "filesearch button");
  await fsearchBtn.click();
  await page.locator(".fse-back .fse-console").waitFor({ timeout: 10000 });
  await sleep(700);
  await measure(page, "Everything（真开）", ".fse-back");
  await page.screenshot({ path: path.join(OUT, "01-everything.png") });

  await page.keyboard.press("Escape");
  await sleep(60);
  const leaving = await page.evaluate(() => {
    const n = document.querySelector(".mac-leaving");
    if (!n) return { found: false };
    const panel = n.querySelector(".sys-console, .jc-console, .mc-console, .st-console, .sheet, form, .argdialog-panel");
    return {
      found: true,
      cls: n.className,
      panel: panel ? `${panel.className} anim=${getComputedStyle(panel).animationName}` : "no-panel",
      scrimAnim: getComputedStyle(n).animationName,
    };
  });
  log("退场（Everything）:", JSON.stringify(leaving));
  await sleep(400);

  // ---- 2. 产物 / bug 反馈 / 设置（st 与 sheet 家族，对照组）
  for (const [act, sel, backSel, label, shot] of [
    ["artifacts", ".st-back .art-sheet", ".st-back", "产物（真开）", "02-artifacts.png"],
    ["notes", ".sheet-back .notes-sheet", ".sheet-back", "bug 反馈（真开）", "03-notes.png"],
    ["look", ".st-back .st-console", ".st-back", "设置/外观（真开）", "04-look.png"],
  ]) {
    const btn = page.locator(`.topbar .icon-btn[data-act="${act}"]`);
    if (!(await btn.count())) {
      log(`没找到 ${act} 按钮`);
      continue;
    }
    await btn.first().click();
    try {
      await page.locator(sel).first().waitFor({ timeout: 8000 });
      await sleep(700);
      await measure(page, label, backSel);
      await page.screenshot({ path: path.join(OUT, shot) });
      await page.keyboard.press("Escape");
      await sleep(400);
    } catch (e) {
      log(`${label} 没打开:`, e.message.slice(0, 80));
    }
  }

  // ---- 3. 注入骨架量其余家族
  for (const [label, frag] of SKELETONS) {
    await page.evaluate((h) => {
      const host = document.getElementById("app") ?? document.body;
      const box = document.createElement("div");
      box.append(document.createRange().createContextualFragment(h));
      const node = box.firstElementChild;
      if (!node) throw new Error("骨架没解析出来: " + h.slice(0, 60));
      node.dataset.macProbe = "x";
      host.append(node);
    }, frag);
    const r = await measure(page, `注入：${label}`, '[data-mac-probe="x"]');
    if (!r) log("注入后量不到:", label);
    await page.evaluate(() => document.querySelector('[data-mac-probe="x"]')?.remove());
  }

  // ---- 4. 退场：每个外壳家族都要能被 `.mac-leaving` 叫出 mac-window-out。
  // 这一层只验证 CSS 白名单，不依赖哪个模块记得调 retireOverlay；JS 那条路靠 Everything 真开那条。
  const leaveProbe = async (frag) => {
    await page.evaluate((h) => {
      const host = document.getElementById("app") ?? document.body;
      const box = document.createElement("div");
      box.append(document.createRange().createContextualFragment(h));
      const node = box.firstElementChild;
      if (!node) throw new Error("退场骨架没解析出来: " + h.slice(0, 60));
      node.classList.add("mac-leaving");
      node.dataset.macProbe = "leave";
      host.append(node);
    }, frag);
    const anim = await page.evaluate(() => {
      const PANELS =
        ".sys-console, .jc-console, .mc-console, .mc-confirm, .st-console, .sheet, form, .argdialog-panel, .jira-ask, .peer-pick-panel, .branch-sheet, .repos-sheet, .jira-picker-box, .choose";
      const back = document.querySelector('[data-mac-probe="leave"]');
      const p = back?.matches(PANELS) ? back : back?.querySelector(PANELS);
      const a = p ? getComputedStyle(p).animationName : "";
      back?.remove();
      return a;
    });
    return anim;
  };
  const leaves = [];
  for (const [label, frag] of [
    ["系统管理 sysmanage", `<div class="sys-back"><section class="sys-console"></section></div>`],
    ["Jira 面板", `<div class="jc-back"><section class="jc-console"></section></div>`],
    ["邮箱", `<div class="mc-back"><section class="mc-console"></section></div>`],
    ["邮箱确认框", `<div class="mc-back mc-back--confirm"><section class="mc-confirm"></section></div>`],
    ["笔记选人 peer-pick", `<div class="peer-pick"><div class="peer-pick-panel"></div></div>`],
    ["选择器 choose", `<div class="choose-back"><div class="choose"></div></div>`],
    ["子弹层 sheet-sub", `<div class="sheet-sub-back"><div class="sheet sub-sheet"></div></div>`],
    ["分支面板", `<div class="sheet-back center branch-back"><div class="branch-sheet go-sheet"></div></div>`],
    ["仓库面板", `<div class="sheet-back center repos-back"><div class="repos-sheet"></div></div>`],
    ["Jira 附件根目录", `<div class="jira-picker"><div class="jira-picker-box"></div></div>`],
  ]) {
    const anim = await leaveProbe(frag);
    log(`退场（${label}）:`, anim || "—");
    leaves.push({ label, anim });
  }

  // ---- 3b. 窄屏（700）：铺满整屏的仓库面板不许带圆角与发丝线。styles.css 那条 `@media`
  // 比 `html[data-ui] :is(...)` 弱，mac.css 必须自己再把它们让回去，否则整屏四周浮出一圈边。
  await page.setViewportSize({ width: 700, height: 860 });
  await page.evaluate(() => {
    const host = document.getElementById("app") ?? document.body;
    const box = document.createElement("div");
    box.append(
      document.createRange().createContextualFragment(`<div class="sheet-back center repos-back"><div class="repos-sheet"></div></div>`),
    );
    box.firstElementChild.dataset.macProbe = "narrow";
    host.append(box.firstElementChild);
  });
  const narrow = await page.evaluate(() => {
    const p = document.querySelector('[data-mac-probe="narrow"] .repos-sheet');
    const cs = p ? getComputedStyle(p) : null;
    const v = cs ? { radius: cs.borderRadius, border: cs.borderTopWidth } : null;
    document.querySelector('[data-mac-probe="narrow"]')?.remove();
    return v;
  });
  await page.setViewportSize({ width: 1280, height: 860 });
  log("窄屏（700）仓库面板:", JSON.stringify(narrow));

  // ---- 汇总
  const pad = (s, n) => String(s ?? "—").padEnd(n).slice(0, n);
  console.log("\n" + pad("弹层", 30) + pad("遮罩blur", 26) + pad("遮罩动画", 22) + pad("面板动画", 24) + pad("圆角", 10) + "面板背景/阴影");
  for (const r of results) {
    if (r.missing || !r.back) {
      console.log(pad(r.label, 30) + "!! 没找到 " + r.sel);
      continue;
    }
    console.log(
      pad(r.label, 30) +
        pad(r.back.blur === "none" ? "none" : r.back.blur.split(" ").slice(0, 2).join(" "), 26) +
        pad(`${r.back.anim} ${r.back.dur}`, 22) +
        pad(r.panel ? `${r.panel.anim} ${r.panel.dur}` : "—", 24) +
        pad(r.panel?.radius ?? "—", 10) +
        (r.panel ? `${r.panel.bgImg !== "none" ? "img" : "flat"} ${r.panel.shadow === "none" ? "无阴影" : "有阴影"}` : ""),
    );
  }
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  log("写入", path.join(OUT, "results.json"));

  // ---- 断言：除白名单里的例外，每一行都要和「产物」对齐。
  // 例外只写「它确实不同而且应该不同」的：`.choose` 是 alert 形的小弹窗（缩放淡入更像），
  // 灯箱的图不是窗口（没有毛玻璃、圆角 12px）。写成表并反查：改了骨架名字而忘了同步这里，
  // 下面会直接红，不会静默失效。
  const EXEMPT = [
    { label: "注入：选择器 choose", anim: "mac-menu-in" },
    { label: "注入：图片灯箱 image-view", anim: "mac-window-in", radius: "12px" },
  ];
  const exemptOf = (label) => EXEMPT.find((e) => e.label === label) ?? {};
  const base = results.find((r) => r.label === "产物（真开）");
  const fails = [];
  if (!base?.panel) throw new Error("对照组「产物」没量到面板 —— 探针自己坏了，先看 02-artifacts.png");
  for (const e of EXEMPT) {
    if (!results.some((r) => r.label === e.label)) fails.push(`豁免表里的「${e.label}」在实测结果里不存在（骨架改名了？）`);
  }
  for (const r of results) {
    if (r.missing || !r.back) {
      fails.push(`${r.label}: 没找到 ${r.sel}`);
      continue;
    }
    const ex = exemptOf(r.label);
    if (r.back.blur !== base.back.blur) fails.push(`${r.label}: 遮罩 ${r.back.blur} ≠ ${base.back.blur}`);
    if (r.back.anim !== base.back.anim) fails.push(`${r.label}: 遮罩动画 ${r.back.anim} ≠ ${base.back.anim}`);
    if (!r.panel) {
      fails.push(`${r.label}: 里面没找到面板`);
      continue;
    }
    const anim = ex.anim ?? base.panel.anim;
    const radius = ex.radius ?? base.panel.radius;
    if (r.panel.anim !== anim) fails.push(`${r.label}: 面板动画 ${r.panel.anim} ≠ ${anim}`);
    if (r.panel.radius !== radius) fails.push(`${r.label}: 圆角 ${r.panel.radius} ≠ ${radius}`);
    if (r.panel.shadow === "none") fails.push(`${r.label}: 面板没阴影`);
  }
  if (!leaving.found) fails.push("退场：Esc 后没有 .mac-leaving");
  else if (!String(leaving.panel).includes("mac-window-out")) fails.push(`退场：面板动画 ${leaving.panel}`);
  for (const l of leaves) {
    if (!String(l.anim).includes("mac-window-out")) fails.push(`退场（${l.label}）: 面板动画 ${l.anim || "none"} ≠ mac-window-out`);
  }
  if (narrow?.radius !== "0px" || narrow?.border !== "0px") {
    fails.push(`窄屏仓库面板还带 radius=${narrow?.radius ?? "?"} border=${narrow?.border ?? "?"} —— 铺满整屏不该有圆角/边框`);
  }

  if (fails.length) {
    console.log(`\nFAIL — ${fails.length} 处没跟上 Mac 风格:`);
    for (const f of fails) console.log("  " + f);
    process.exitCode = 1;
  } else {
    console.log(`\nALL OK — ${results.length} 个弹层与产物对齐`);
  }
} finally {
  if (browser) await browser.close();
  bridge.kill();
}
