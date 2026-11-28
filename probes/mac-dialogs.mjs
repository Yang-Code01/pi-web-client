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

/**
 * 量一扇浮层：材质现在由 `data-mac-surface` 挑（#644），面板就是 window 根的**直接子元素**，
 * 其余材质级（menu / toast / dock / paper）节点自己就是面板。不再按类名认面板 ——
 * 那正是这次要消灭的东西（panel 名单抄漏一个就静默通过）。
 */
const MEASURE = (sel) => {
  const back = document.querySelector(sel);
  if (!back) return null;
  const kind = back.dataset.macSurface ?? null;
  const panel = kind === "window" ? back.firstElementChild : back;
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
  return {
    kind,
    enter: back.dataset.macEnter ?? null,
    inApp: Boolean(back.closest("#app")),
    // D450：`.st-console`（设置 / 模型 / 产物 / 本机管理…）是**量尺**，故意 1:1 挂在 body 上、
    // 不跟字号缩放。「必须挂在 #app 里」这条对它们不成立 —— 别把 D450 判成回归。
    measuring: Boolean(back.querySelector(":scope > .st-console")),
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
          blur: cs(panel, "backdropFilter"),
          radius: cs(panel, "borderRadius"),
          shadow: cs(panel, "boxShadow"),
          anim: cs(panel, "animationName"),
        }
      : null,
  };
};

/**
 * 全局扫描（#644）：页面上任何「可见 + fixed/absolute + z-index ≥ 40」的块，要么自己带
 * `data-mac-surface`，要么有一个带了标记的祖先（它是那扇窗里的零件），要么登记在豁免表里。
 * 这条是「下次漏项会红」的那张网：新面板忘了打标记，这里当场抓到，不用等用户半年后发现。
 */
// 现在没有需要豁免的东西：例外一律走 `paper` 标记（登记在案、不套材质），
// 所以这一层不需要一张「可以不遵守」的名单 —— 表空着比填满更难腐烂。
const SCAN_EXEMPT = [];
const SCAN = (exempt) => {
  const hits = [];
  for (const el of document.querySelectorAll("#app *, body > *")) {
    if (el.hasAttribute("data-mac-surface")) continue;
    if (el.closest("[data-mac-surface]")) continue;      // 已归属某扇浮层的零件
    if (exempt.some((x) => el.matches(x))) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    if (cs.position !== "fixed" && cs.position !== "absolute") continue;
    if (!(parseInt(cs.zIndex, 10) >= 40)) continue;
    hits.push({ cls: typeof el.className === "string" ? el.className : el.tagName, z: cs.zIndex });
  }
  return hits;
};

const results = [];
const fails = [];
const measure = async (page, label, sel) => {
  const r = await page.evaluate(MEASURE, sel);
  results.push(r ? { label, sel, ...r } : { label, sel, missing: true });
  return r;
};

const SKELETONS = [
  // 每条骨架自己带 `data-mac-surface` —— 与真组件走的是同一个属性、同一张材质表。
  ["系统管理 sysmanage", `<div class="sys-back" data-mac-surface="window"><section class="sys-console"></section></div>`],
  ["文件管理器 fileconsole", `<div class="sys-back fc-back" data-mac-surface="window"><section class="sys-console fc-console"></section></div>`],
  ["热部署 hotdeploy", `<div class="sys-back hot-back" data-mac-surface="window"><section class="sys-console hot"></section></div>`],
  ["Jira 面板", `<div class="jc-back" data-mac-surface="window"><section class="jc-console"></section></div>`],
  ["Jira 确认层", `<div class="jira-ask-back" data-mac-surface="window"><div class="jira-ask"></div></div>`],
  ["Jira 附件根目录", `<div class="jira-picker" data-mac-surface="window"><div class="jira-picker-box"></div></div>`],
  ["邮箱", `<div class="mc-back" data-mac-surface="window"><section class="mc-console"></section></div>`],
  ["邮箱确认框 mc-confirm", `<div class="mc-back mc-back--confirm" data-mac-surface="window"><section class="mc-confirm"></section></div>`],
  ["笔记（sheet 家族）", `<div class="sheet-back notes-back" data-mac-surface="window" data-mac-enter="none"><div class="sheet notes-sheet"></div></div>`],
  ["分支面板 branch-sheet", `<div class="sheet-back center branch-back" data-mac-surface="window"><div class="branch-sheet go-sheet"></div></div>`],
  ["仓库面板 repos-sheet", `<div class="sheet-back center repos-back" data-mac-surface="window"><div class="repos-sheet"></div></div>`],
  ["子弹层 sheet-sub", `<div class="sheet-sub-back" data-mac-surface="window"><div class="sheet sub-sheet"></div></div>`],
  ["选择器 choose", `<div class="choose-back" data-mac-surface="window" data-mac-enter="alert"><div class="choose"></div></div>`],
  ["图片灯箱 image-view", `<div class="image-view" data-mac-surface="window" data-mac-dim="dark"><img class="image-view-img" alt=""></div>`],
  ["笔记选人 peer-pick", `<div class="peer-pick" data-mac-surface="window"><div class="peer-pick-panel"></div></div>`],
  ["新建会话（骨架对照）", `<div class="sheet-back center" data-mac-surface="window"><div class="sheet new-sheet"></div></div>`],
  ["底部抽屉（手机 sheet）", `<div class="sheet-back" data-mac-surface="window" data-mac-enter="drawer"><div class="sheet"></div></div>`],
  ["随手问（右侧抽屉）", `<div class="sheet-back scratch-back" data-mac-surface="window" data-mac-enter="side"><div class="sheet"></div></div>`],
  // ---- 这次补的四个面（#644）：以前它们根本不在任何名单里。
  ["预览右栏 viewer", `<aside class="viewer" data-mac-surface="dock"><div class="viewer-head"></div><div class="viewer-body"></div></aside>`],
  ["提醒清单 remind-pop", `<div class="remind-pop" data-mac-surface="menu"></div>`],
  ["提醒吐司 remind-toast", `<div class="remind-toast" data-mac-surface="toast"></div>`],
  ["笔记工具条弹层 tb-pop", `<div class="tb-pop" data-mac-surface="menu"></div>`],
  ["交给 agent note-handoff", `<div class="note-handoff" data-mac-surface="menu"></div>`],
  // `paper`：登记在案、故意不套材质。
  ["表格浮窗（纸）", `<section class="sd" data-mac-surface="paper"></section>`],
];

/**
 * 点遮罩（D437 / #721）：带遮罩的窗口点遮罩**不关**、面板轻弹一下；只有灯箱照旧关。
 * 在遮罩上找一个「elementFromPoint 就是遮罩本身」的点，用真鼠标点下去，再看：
 *  - 窗口还在（没被摘掉、也没进 `.mac-leaving` 退场）；
 *  - 面板演了 id 为 `backdrop-nudge` 的 WAAPI 动画（录 Element.prototype.animate 的调用）；
 *  - 窗口里有一颗看得见的 ✕ / 关闭 / 取消（手机上没有 Esc，不能把人困在里面）。
 */
const backdropChecks = [];
const backdropCheck = async (page, label, backSel, expectClose = false) => {
  const pt = await page.evaluate((sel) => {
    if (!window.__nudges) {
      window.__nudges = [];
      const orig = Element.prototype.animate;
      Element.prototype.animate = function (k, o) {
        if (o && typeof o === "object" && o.id) window.__nudges.push(o.id);
        return orig.call(this, k, o);
      };
    }
    window.__nudges.length = 0;
    const all = [...document.querySelectorAll(sel)].filter((n) => !n.classList.contains("mac-leaving"));
    const root = all[all.length - 1];
    if (!root) return null;
    root.dataset.backdropProbe = "1";
    const r = root.getBoundingClientRect();
    // 先试贴边的几个点（面板一般居中、四周留白），再退到网格。
    const pts = [
      [r.left + 4, r.top + r.height / 2],
      [r.right - 4, r.top + r.height / 2],
      [r.left + r.width / 2, r.bottom - 4],
      [r.left + 4, r.top + 4],
    ];
    for (let i = 1; i < 12; i += 1) for (let j = 1; j < 12; j += 1) pts.push([r.left + (r.width * i) / 12, r.top + (r.height * j) / 12]);
    for (const [x, y] of pts) if (document.elementFromPoint(x, y) === root) return { x, y };
    const hit = document.elementFromPoint(r.left + 4, r.top + r.height / 2);
    return { none: true, n: all.length, same: hit === root, hit: hit ? `${hit.tagName}.${hit.className}` : null };
  }, backSel);
  if (!pt) return backdropChecks.push({ label, err: `没找到 ${backSel}` });
  if (pt.none) return backdropChecks.push({ label, err: `遮罩上找不到能点的空白（面板铺满了？）n=${pt.n} same=${pt.same} hit=${pt.hit}` });
  await page.mouse.click(pt.x, pt.y);
  await sleep(250);
  const r = await page.evaluate(() => {
    const root = document.querySelector('[data-backdrop-probe="1"]');
    const open = Boolean(root && root.isConnected && !root.classList.contains("mac-leaving"));
    const closeBtn = root
      ? [...root.querySelectorAll("button")].some((b) => {
          const t = `${b.textContent ?? ""} ${b.getAttribute("aria-label") ?? ""} ${b.title ?? ""}`;
          const box = b.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && /[✕×]|关闭|取消|不发/.test(t);
        })
      : false;
    root?.removeAttribute("data-backdrop-probe");
    return { open, nudged: window.__nudges.includes("backdrop-nudge"), closeBtn };
  });
  backdropChecks.push({ label, expectClose, ...r });
  log(`点遮罩 ${label}:`, JSON.stringify(r));
};

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
  // 这一轮 dist 是刚建出来的，`checkBuild()` 会冒一条「服务已更新，刷新后生效」的 toast 压住顶栏按钮。
  // 它跟弹层的壳无关（`data-mac-surface="toast"`，本探针也不量它），藏掉免得点击被它截走。
  await page.addStyleTag({ content: ".update-bar { display: none !important; }" });
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
  await backdropCheck(page, "Everything（真开）", ".fse-back");

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
      const hits = await page.evaluate(SCAN, SCAN_EXEMPT.map((x) => x.sel));
      for (const h of hits) scanHits.push({ where: label, ...h });
      await page.screenshot({ path: path.join(OUT, shot) });
      await backdropCheck(page, label, backSel);
      await page.keyboard.press("Escape");
      await sleep(400);
    } catch (e) {
      log(`${label} 没打开:`, e.message.slice(0, 80));
    }
  }

  // ---- 2b. 点遮罩：灯箱是唯一例外，点黑底就关（D437）。
  await page.evaluate(() => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='30'><rect width='40' height='30' fill='red'/></svg>";
    window.dispatchEvent(new CustomEvent("pi-image", { detail: { src: `data:image/svg+xml,${encodeURIComponent(svg)}`, alt: "probe" } }));
  });
  try {
    await page.locator(".image-view").first().waitFor({ timeout: 5000 });
    await sleep(300);
    await backdropCheck(page, "图片灯箱（真开）", ".image-view", true);
  } catch (e) {
    backdropChecks.push({ label: "图片灯箱（真开）", err: `没打开: ${e.message.slice(0, 60)}` });
  }
  await sleep(400);

  // ---- 2c. 浮层菜单不受影响（D115）：技能面板点外面照旧收起。
  const skillBtn = page.locator('.composer button:has-text("技能")').first();
  if (await skillBtn.count()) {
    await skillBtn.click();
    try {
      await page.locator(".skill-pop").first().waitFor({ timeout: 4000 });
      const vp = page.viewportSize();
      await page.mouse.click((vp?.width ?? 1280) / 2, 140);
      await sleep(250);
      const still = await page.locator(".skill-pop").count();
      log("技能面板点外面后还剩:", still);
      if (still) fails.push("技能面板（浮层菜单）点外面没收起 —— D115 被误伤");
    } catch (e) {
      log("技能面板没打开，跳过 D115 那条:", e.message.slice(0, 60));
    }
  } else {
    log("没有「技能」按钮，跳过 D115 那条");
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
      // 与材质同一套判据：window 的面板是直接子元素，其余材质级节点自己就是面板。
      const back = document.querySelector('[data-mac-probe="leave"]');
      const p = back?.dataset.macSurface === "window" ? back.firstElementChild : back;
      const a = p ? getComputedStyle(p).animationName : "";
      back?.remove();
      return a;
    });
    return anim;
  };
  const leaves = [];
  for (const [label, frag] of [
    ["系统管理 sysmanage", `<div class="sys-back" data-mac-surface="window"><section class="sys-console"></section></div>`],
    ["Jira 面板", `<div class="jc-back" data-mac-surface="window"><section class="jc-console"></section></div>`],
    ["邮箱", `<div class="mc-back" data-mac-surface="window"><section class="mc-console"></section></div>`],
    ["邮箱确认框", `<div class="mc-back mc-back--confirm" data-mac-surface="window"><section class="mc-confirm"></section></div>`],
    ["笔记选人 peer-pick", `<div class="peer-pick" data-mac-surface="window"><div class="peer-pick-panel"></div></div>`],
    ["选择器 choose", `<div class="choose-back" data-mac-surface="window" data-mac-enter="alert"><div class="choose"></div></div>`],
    ["子弹层 sheet-sub", `<div class="sheet-sub-back" data-mac-surface="window"><div class="sheet sub-sheet"></div></div>`],
    ["分支面板", `<div class="sheet-back center branch-back" data-mac-surface="window"><div class="branch-sheet go-sheet"></div></div>`],
    ["仓库面板", `<div class="sheet-back center repos-back" data-mac-surface="window"><div class="repos-sheet"></div></div>`],
    ["Jira 附件根目录", `<div class="jira-picker" data-mac-surface="window"><div class="jira-picker-box"></div></div>`],
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
      document.createRange().createContextualFragment(`<div class="sheet-back center repos-back" data-mac-surface="window"><div class="repos-sheet"></div></div>`),
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

  // ---- 6. 三套主题各跑一遍：材质与入场是按标记挑的，不跟主题走；换个底再量一遍，防止某套
  // 主题里的覆盖把圆角 / 动画写没了。
  const themes = [];
  for (const t of ["mac-light", "mac-dark", "mac-midnight"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      const host = document.getElementById("app") ?? document.body;
      const box = document.createElement("div");
      box.append(
        document.createRange().createContextualFragment(
          `<div class="sheet-back center" data-mac-surface="window"><div class="sheet"></div></div>`,
        ),
      );
      box.firstElementChild.dataset.macProbe = "theme";
      host.append(box.firstElementChild);
    }, t);
    const m = await page.evaluate(() => {
      const back = document.querySelector('[data-mac-probe="theme"]');
      const panel = back?.firstElementChild;
      const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
      const out = {
        scrimBlur: cs(back, "backdropFilter"),
        scrimAnim: cs(back, "animationName"),
        panelAnim: cs(panel, "animationName"),
        radius: cs(panel, "borderRadius"),
        shadow: cs(panel, "boxShadow") !== "none",
        panelBg: cs(panel, "backgroundColor"),
      };
      back?.remove();
      return out;
    });
    themes.push({ theme: t, ...m });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "mac-light";
  });
  for (const t of themes) {
    if (t.panelAnim !== "mac-window-in") fails.push(`主题 ${t.theme}: 面板动画 ${t.panelAnim}`);
    if (t.radius !== "14px") fails.push(`主题 ${t.theme}: 圆角 ${t.radius}`);
    if (!t.scrimBlur || t.scrimBlur === "none") fails.push(`主题 ${t.theme}: 遮罩没有毛玻璃`);
    if (!t.shadow) fails.push(`主题 ${t.theme}: 没有窗影`);
  }
  log("三套主题的窗口材质:", themes.map((t) => `${t.theme} ${t.radius} ${t.panelAnim}`).join(" / "));

  // ---- 7. 搬进 #app 的三个浮层：把字号调到 150%，双击一颗标签改名，量输入框是不是真的跟着缩放。
  // 这一条验的是 D390 §6 的 `appZoom()`：坐标与宽度都要先除一次缩放。
  let zoomCheck = { skipped: true };
  const tab = page.locator(".ws-tab").first();
  if (await tab.count()) {
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--ui-scale", "1.5");
      document.getElementById("app")?.style.setProperty("--ui-scale", "1.5");
    });
    await tab.dblclick();
    await sleep(200);
    zoomCheck = await page.evaluate(() => {
      const el = document.querySelector(".ws-tab-rename-input");
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const t = document.querySelector(".ws-tab")?.getBoundingClientRect();
      return { found: true, inApp: Boolean(el.closest("#app")), w: Math.round(r.width), tabW: t ? Math.round(t.width) : null };
    });
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("--ui-scale");
      document.getElementById("app")?.style.removeProperty("--ui-scale");
    });
    await sleep(100);
    if (zoomCheck.found) {
      if (!zoomCheck.inApp) fails.push("改名输入框没挂进 #app（字号缩放时它会比周围小一号）");
      if (zoomCheck.tabW && Math.abs(zoomCheck.w - zoomCheck.tabW) > 3) {
        fails.push(`字号 150% 下改名输入框宽 ${zoomCheck.w} ≠ 标签宽 ${zoomCheck.tabW} —— 坐标没除 appZoom()`);
      }
      log(`字号 150% 改名输入框: ${zoomCheck.w}px / 标签 ${zoomCheck.tabW}px, inApp=${zoomCheck.inApp}`);
    } else {
      log("字号 150% 改名输入框: 没打开（跳过这一条）");
    }
  } else {
    log("没有 .ws-tab，跳过「搬进 #app 后按 zoom 换算」这条");
  }

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

  // ---- 断言：材质由标记挑（#644）。
  // 每一行按它自己的 data-mac-surface 去比一张「材质级 → 期望值」的表；不再拿某一层当对照组 ——
  // 对照组本身也可能被改坏，而这张表是决策日志里写下的值。例外只剩灯箱的圆角（图不是窗口）。
  const MATERIAL = {
    window: { scrimBlur: true, scrimAnim: "mac-fade-in", anim: "mac-window-in", radius: "14px", shadow: true },
    menu: { scrimBlur: false, scrimAnim: "none", anim: "mac-menu-in", radius: "12px", shadow: true },
    toast: { scrimBlur: false, scrimAnim: "none", anim: "mac-toast-in", radius: "14px", shadow: true },
    dock: { scrimBlur: true, scrimAnim: null, anim: null, radius: "14px", shadow: true },
    paper: { scrimBlur: false, scrimAnim: null, anim: null, radius: null, shadow: null },
  };
  const ENTER = {
    drawer: { anim: "mac-drawer-in", radius: "16px 16px 0px 0px" },
    side: { anim: "mac-side-in", radius: "14px 0px 0px 14px" },
    alert: { anim: "mac-menu-in", radius: "14px" },
    none: { anim: "none", radius: "14px" },
  };
  // 只写「它确实不同、而且应该不同」的两条：灯箱的图圆角小一档；预览右栏有自己的入场（D111 那扇窗）。
  const OVERRIDE = {
    "注入：图片灯箱 image-view": { radius: "12px" },
    "注入：预览右栏 viewer": { anim: "viewer-in", radius: "14px 0px 0px 14px" },
  };
  if (!results.length) fails.push("一行都没量到 —— 探针自己坏了");
  for (const r of results) {
    if (r.missing || !r.back) {
      fails.push(`${r.label}: 没找到 ${r.sel}`);
      continue;
    }
    if (!r.kind) {
      fails.push(`${r.label}: 根上没有 data-mac-surface —— 材质不会被认出来`);
      continue;
    }
    if (!r.panel) {
      fails.push(`${r.label}: 里面没找到面板`);
      continue;
    }
    const want = MATERIAL[r.kind];
    const enter = r.enter ? ENTER[r.enter] : null;
    const ov = OVERRIDE[r.label] ?? {};
    if (r.kind === "window") {
      if (want.scrimBlur && (!r.back.blur || r.back.blur === "none")) fails.push(`${r.label}: 遮罩没有毛玻璃`);
      if (want.scrimAnim && r.back.anim !== want.scrimAnim) fails.push(`${r.label}: 遮罩动画 ${r.back.anim} ≠ ${want.scrimAnim}`);
    }
    const anim = ov.anim ?? enter?.anim ?? want.anim;
    if (anim && r.panel.anim !== anim) fails.push(`${r.label}: 面板动画 ${r.panel.anim} ≠ ${anim}`);
    const radius = ov.radius ?? enter?.radius ?? want.radius;
    if (radius && r.panel.radius !== radius) fails.push(`${r.label}: 圆角 ${r.panel.radius} ≠ ${radius}`);
    if (want.shadow === true && r.panel.shadow === "none") fails.push(`${r.label}: 面板没阴影`);
    if (!r.inApp && !r.measuring) fails.push(`${r.label}: 没挂在 #app 里 —— 字号缩放时它会跟别人两套尺寸`);
  }
  // ---- 断言：点遮罩（D437）。
  if (!backdropChecks.length) fails.push("点遮罩一条都没量到 —— 探针自己坏了");
  for (const c of backdropChecks) {
    if (c.err) {
      fails.push(`点遮罩 ${c.label}: ${c.err}`);
      continue;
    }
    if (c.expectClose) {
      if (c.open) fails.push(`点遮罩 ${c.label}: 灯箱应该点外面就关，结果还开着`);
      continue;
    }
    if (!c.open) fails.push(`点遮罩 ${c.label}: 窗口被关掉了（D437：点遮罩不关）`);
    if (!c.nudged) fails.push(`点遮罩 ${c.label}: 面板没有轻弹（backdrop-nudge）`);
    if (!c.closeBtn) fails.push(`点遮罩 ${c.label}: 窗口里找不到看得见的 ✕ / 关闭 / 取消`);
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
