/**
 * #588 D368 守卫：设置 → 更新日志「本项目」那一页（vibe-hub 模板：左栏月份 + 时间线 + 筛选）。
 *
 * 要守的是「这一页真的读得下去」，不是「元素存在」：
 *  1. 阅读态：控制台的 `.st-nav` / `.st-head` / `.st-foot` 全部收掉，pane 自己滚，页头有标题与 ✕。
 *  2. 数据对得上：统计卡三个数与 `.cl-batch` 条数，都跟探针自己解析 CHANGELOG.md 的结果一致。
 *  3. 左栏月份：第一格是「未发布」（若确有未发布批次），计数之和 = 批次数。
 *  4. 引用：`#N` 是指向 GitHub PR 的 `<a href>`；`D365` 是 `<button>`（不导航）。
 *  5. 筛选**按批**：点「修复」后留下的每一批都含修复，且批内新增条目仍在（批内全留）。
 *  6. 点月份真的滚过去，且高亮跟着走。
 *  7. 「上次看到这里」画在已读那一批下面。
 *  8. 页底「启动时的提示」还在，滚到底时它在 pane 里，且是横条不是竖条（D367）。
 *  9. 字号 150%：pane 不横向溢出，✕ 与页底那块都还在 pane 里。
 * 10. 切到「pi」那一侧仍是阅读态，正文是 markdown。
 *
 * Run: npm run build && node probes/changelog-page.mjs
 * （自起一份 bridge（临时状态目录 + 桩会话），不碰 7864，不花模型调用。）
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge/dist/index.js");
if (!fs.existsSync(DIST)) {
  console.error("bridge/dist/index.js 不存在：先 npm run build");
  process.exit(2);
}

const PORT = Number(process.env.PI_WEB_PORT ?? 7938);
const ROOT = path.join(REPO, ".scratch/changelog-page");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "zz-changelog";
const STATE_FILE = path.join(STATE, "whatsnew.json");

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK, OUT]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 桩会话：桥要有一个能开的会话，`/whatsnew` 命令才有输入框可用。
const dir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(dir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "更新日志页探针" }] } },
  { type: "message", id: "m2", parentId: "m1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "好。" }] } },
  { type: "session_info", id: "n1", parentId: "m2", timestamp: at, name: "更新日志页探针" },
];
fs.writeFileSync(path.join(dir, `${SID}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

const PASS = "changelog-probe";
const salt = crypto.randomBytes(16).toString("hex");
fs.writeFileSync(path.join(STATE, "passphrase.hash"), `scrypt$${salt}$${crypto.scryptSync(PASS, salt, 32).toString("hex")}`);
fs.writeFileSync(path.join(STATE, "passphrase.txt"), `${PASS}\n`);

/**
 * 期望值全从 CHANGELOG.md 现算 —— 抄一份固定数字，改一批日志这个探针就红。
 * 批次：`## [YYYY-MM-DD · ]标题`；组：`### 新增|修复|设计决定`；条目：组内 `- ` 开头的行。
 */
const LOG_TEXT = fs.readFileSync(path.join(REPO, "CHANGELOG.md"), "utf8");
const batches = [];
{
  let cur = null;
  let group = null;
  for (const line of LOG_TEXT.split(/\r?\n/)) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      const raw = h2[1];
      const cut = raw.indexOf(" · ");
      const date = /^\d{4}-\d{2}-\d{2}$/.test(cut > 0 ? raw.slice(0, cut) : "") ? raw.slice(0, cut) : null;
      cur = { title: cut > 0 ? raw.slice(cut + 3) : raw, date, unpublished: !date, groups: {}, items: 0 };
      batches.push(cur);
      group = null;
      continue;
    }
    if (!cur) continue;
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      group = h3[1] === "修复" ? "fix" : h3[1] === "设计决定" ? "design" : "new";
      continue;
    }
    if (group && /^\s*- /.test(line)) {
      cur.groups[group] = (cur.groups[group] ?? 0) + 1;
      cur.items += 1;
    }
  }
}
const TOTAL = batches.length;
const ITEMS = batches.reduce((n, b) => n + b.items, 0);
const PRS = new Set([...LOG_TEXT.matchAll(/(?:^|\s)#(\d+)(?=\s|$)/gm)].map((m) => m[1])).size;
const withKind = (k) => batches.filter((b) => b.groups[k]).length;
// 一条既含修复又含新增的批次：验「按批筛」就靠它。优先要有标题的（`## 未发布` 那一批没标题，
// 页面上也就不画 h3，拿它比对标题比不出来）。
const MIXED = batches.find((b) => b.date && b.groups.fix && b.groups.new) ?? batches.find((b) => b.groups.fix && b.groups.new);
const SEEN = batches[1]?.title ?? "";
if (TOTAL < 3 || !MIXED) {
  console.error("CHANGELOG.md 里批次太少，或找不到同时含修复与新增的一批，这个探针验不了");
  process.exit(2);
}

let bridge = null;
let bridgeOut = [];
function startBridge() {
  bridge = spawn(process.execPath, [DIST], {
    cwd: REPO,
    env: {
      ...process.env,
      PI_WEB_PORT: String(PORT),
      PI_WEB_STATE: STATE,
      PI_WEB_TUNNEL: "0",
      PI_AGENT_DIR: AGENT,
      PI_PEER: "0",
      PI_WEB_FILEINDEX_ROOTS: WORK,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeOut = [];
  bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
  bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));
}
async function stopBridge() {
  if (!bridge) return;
  bridge.kill();
  bridge = null;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/healthz`);
      await sleep(80);
    } catch {
      return;
    }
  }
}
async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(120);
  }
  console.error(bridgeOut.join("").slice(-3000));
  throw new Error(`timeout: ${label}`);
}

const fails = [];
const ok = (cond, label) => {
  console.log(`  ${cond ? "✔" : "✖"} ${label}`);
  if (!cond) fails.push(label);
};

/** 「上次看到」= 第二新那一批：下面画分隔线，别把弹窗闸门也打开（enabled=false 免弹）。 */
fs.writeFileSync(STATE_FILE, JSON.stringify({ seenTitle: SEEN, lastShownAt: Date.now(), enabled: false }, null, 2));

let browser = null;
let page = null;
let context = null;
try {
  startBridge();
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 15000, "bridge up");
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(`${BASE}/#/s/${SID}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".composer textarea", { timeout: 20000 });

  log("1) /whatsnew → 阅读态");
  await page.fill(".composer textarea", "/whatsnew");
  await page.press(".composer textarea", "Enter");
  await page.waitForSelector('.st-console[data-reader="true"] .cl-page', { timeout: 20000 });
  await page.waitForSelector(".cl-timeline .cl-batch", { timeout: 20000 });

  const shell = await page.evaluate(() => {
    const vis = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return "missing";
      const cs = getComputedStyle(n);
      return cs.display === "none" || cs.visibility === "hidden" ? "hidden" : (n.offsetWidth > 0 ? "shown" : "zero");
    };
    const pane = document.querySelector(".st-pane");
    const console_ = document.querySelector(".st-console");
    return {
      nav: vis(".st-console .st-nav"),
      head: vis(".st-console .st-head"),
      foot: vis(".st-console .st-foot"),
      cols: getComputedStyle(document.querySelector(".st-main")).gridTemplateColumns.split(" ").length,
      rows: console_ ? getComputedStyle(console_).gridTemplateRows : "",
      paneScrolls: pane ? pane.scrollHeight > pane.clientHeight + 8 : false,
      panePadding: pane ? getComputedStyle(pane).paddingTop : "",
      title: document.querySelector(".cl-title")?.textContent ?? "",
      sub: document.querySelector(".cl-sub")?.textContent ?? "",
      close: Boolean(document.querySelector(".cl-close")),
      back: Boolean(document.querySelector(".cl-back")),
      seg: document.querySelector(".st-seg__btn.on")?.textContent?.trim() ?? "",
    };
  });
  ok(shell.nav === "hidden", `左栏设置导航在阅读态收掉了（${shell.nav}）`);
  ok(shell.head === "hidden" && shell.foot === "hidden", `控制台头部与底栏都收掉（head=${shell.head} foot=${shell.foot}）`);
  ok(shell.cols === 1, `主体只剩一列（${shell.cols}）`);
  ok(shell.paneScrolls && shell.panePadding === "0px", `滚动交给 pane 自己，且 pane 不留内边距（${shell.panePadding}）`);
  ok(shell.title === "更新日志" && shell.sub.includes("每一批改动"), `页头有标题与一行说明（${shell.title}）`);
  ok(shell.back && shell.close, "页头有「‹ 设置」与右上 ✕");
  ok(shell.seg === "本项目", `分段切在「本项目」（${shell.seg}）`);

  log("2) 统计卡与批次数");
  const nums = await page.evaluate(() => ({
    stats: [...document.querySelectorAll(".cl-stats .cl-stat b")].map((b) => Number(b.textContent)),
    batchCount: document.querySelectorAll(".cl-timeline .cl-batch").length,
    monthCount: document.querySelectorAll(".cl-rail .cl-month").length,
    months: [...document.querySelectorAll(".cl-rail .cl-month")].map((m) => ({
      key: m.dataset.month,
      label: m.querySelector("span")?.textContent ?? "",
      n: Number(m.querySelector("em")?.textContent ?? "0"),
    })),
  }));
  ok(nums.stats.length === 3, `统计卡三行（${nums.stats.length}）`);
  ok(nums.stats[0] === TOTAL, `批数 ${nums.stats[0]} = CHANGELOG 里 ${TOTAL} 批`);
  ok(nums.stats[1] === ITEMS, `条数 ${nums.stats[1]} = 解析出的 ${ITEMS} 条`);
  ok(Math.abs(nums.stats[2] - PRS) <= 2, `PR 数 ${nums.stats[2]} ≈ 解析出的 ${PRS} 个`);
  ok(nums.batchCount === TOTAL, `时间线画了 ${nums.batchCount} 批（期望 ${TOTAL}）`);
  const unpub = batches.filter((b) => b.unpublished).length;
  if (unpub) ok(nums.months[0].label === "未发布" && nums.months[0].n === unpub, `第一格是「未发布」×${unpub}（${nums.months[0]?.label} ${nums.months[0]?.n}）`);
  ok(nums.months.reduce((n, m) => n + m.n, 0) === TOTAL, `月份计数之和 = 批数（${nums.months.reduce((n, m) => n + m.n, 0)}）`);

  log("3) 引用 chip");
  const chips = await page.evaluate(() => {
    const pr = document.querySelector(".cl-timeline a.ref--pr");
    const d = document.querySelector(".cl-timeline .ref--d");
    return {
      prHref: pr?.getAttribute("href") ?? "",
      prTarget: pr?.getAttribute("target") ?? "",
      dTag: d?.tagName ?? "",
      dText: d?.textContent ?? "",
    };
  });
  ok(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(chips.prHref), `PR chip 指向仓库的 PR（${chips.prHref}）`);
  ok(chips.prTarget === "_blank", "PR 新开标签");
  ok(chips.dTag === "BUTTON" && /^D\d+$/.test(chips.dText), `D chip 是按钮不是链接（${chips.dTag} ${chips.dText}）`);

  log("4) 按批筛：点「修复」");
  const beforeFix = await page.evaluate(() => document.querySelectorAll(".cl-timeline .cl-batch").length);
  await page.locator(".cl-filter", { hasText: "修复" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".cl-timeline .cl-batch, .cl-empty").length > 0);
  const afterFix = await page.evaluate(() => ({
    batches: [...document.querySelectorAll(".cl-timeline .cl-batch")].map((b) => ({
      title: b.querySelector("h3")?.textContent ?? "",
      fix: b.querySelectorAll(".ico--fix").length,
      other: b.querySelectorAll(".ico--new, .ico--decide").length,
    })),
    months: [...document.querySelectorAll(".cl-rail .cl-month")].map((m) => Number(m.querySelector("em")?.textContent ?? "0")),
  }));
  ok(afterFix.batches.length === withKind("fix"), `只剩含修复的 ${withKind("fix")} 批（${afterFix.batches.length}）`);
  ok(afterFix.batches.every((b) => b.fix > 0), "留下的每一批都真有修复条目");
  ok(afterFix.batches.some((b) => b.other > 0), "批内的新增/决定条目没被筛掉（按批筛）");
  ok(afterFix.batches.some((b) => b.title === MIXED.title), `混合那一批还在（${MIXED.title.slice(0, 18)}…）`);
  ok(afterFix.months.reduce((n, m) => n + m, 0) === afterFix.batches.length, "月份计数跟着筛选走");
  await page.screenshot({ path: path.join(OUT, "01-filter-fix.png") });
  ok(beforeFix === TOTAL, `筛前是全部 ${TOTAL} 批`);

  log("5) 点月份滚过去");
  await page.locator(".cl-filter", { hasText: "全部" }).click();
  await page.waitForFunction((n) => document.querySelectorAll(".cl-timeline .cl-batch").length === n, TOTAL);
  const target = await page.evaluate(() => {
    const ms = [...document.querySelectorAll(".cl-rail .cl-month")];
    // 挑倒数第二个月份：一定需要滚动才看得到。
    const m = ms[Math.max(0, ms.length - 2)];
    return { key: m.dataset.month, label: m.querySelector("span")?.textContent ?? "" };
  });
  await page.locator(`.cl-rail .cl-month[data-month="${target.key}"]`).click();
  // 平滑滚动在无头浏览器里也可能要一秒多：等 scrollTop 连续两次采样不变再断言，不然量到的是半路。
  await until(
    async () => {
      const a = await page.evaluate(() => document.querySelector(".st-pane").scrollTop);
      await sleep(220);
      const b = await page.evaluate(() => document.querySelector(".st-pane").scrollTop);
      return a === b && a > 0;
    },
    5000,
    "月份滚动停下来",
  );
  const jumped = await page.evaluate((key) => {
    const pane = document.querySelector(".st-pane");
    const batch = document.querySelector(`.cl-timeline .cl-batch[data-month="${key}"]`);
    return {
      onKey: document.querySelector(".cl-rail .cl-month.on")?.dataset.month ?? "",
      top: batch ? Math.round(batch.getBoundingClientRect().top - pane.getBoundingClientRect().top) : -1,
      scrollTop: Math.round(pane.scrollTop),
    };
  }, target.key);
  ok(jumped.onKey === target.key, `高亮跟到 ${target.label}（${jumped.onKey}）`);
  ok(jumped.scrollTop > 40 && Math.abs(jumped.top) <= 40, `真的滚到了那一批（scrollTop=${jumped.scrollTop} top=${jumped.top}）`);

  log("6)「上次看到这里」与页底设置块");
  const seen = await page.evaluate((t) => {
    const line = document.querySelector(".cl-unseen");
    const prev = line?.previousElementSibling;
    const row = [...document.querySelectorAll(".cl-settings .settings-row")].find((r) => (r.textContent ?? "").includes("启动时自动打开更新日志"));
    return {
      text: line?.textContent ?? "",
      prevTitle: prev?.querySelector("h3")?.textContent ?? "",
      hasRow: Boolean(row),
      hasSeen: [...document.querySelectorAll(".cl-settings .settings-row .settings-name")].some((n) => (n.textContent ?? "").includes("上次看到")),
      inPane: Boolean(document.querySelector(".cl-settings")),
    };
  }, SEEN);
  ok(seen.text === "上次看到这里", `画了「上次看到这里」（${seen.text || "没画"}）`);
  ok(seen.prevTitle === SEEN, `分隔线紧跟已读那一批（${seen.prevTitle.slice(0, 18)}…）`);
  ok(seen.inPane && seen.hasRow && seen.hasSeen, "页底有「启动时的提示」开关与「上次看到」");

  // 滚到页面最下方：设置块应当在 pane 的可视范围里，而且是横条不是一列竖字（D367）。
  await page.evaluate(() => {
    const pane = document.querySelector(".st-pane");
    pane.scrollTo({ top: pane.scrollHeight, behavior: "instant" });
  });
  await sleep(400);
  const bottom = await page.evaluate(() => {
    const pane = document.querySelector(".st-pane").getBoundingClientRect();
    const row = [...document.querySelectorAll(".cl-settings .settings-row")].find((r) => (r.textContent ?? "").includes("启动时自动打开更新日志"));
    if (!row) return null;
    const box = row.getBoundingClientRect();
    const name = row.querySelector(".settings-name");
    const cs = name ? getComputedStyle(name) : null;
    const lh = cs ? parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 : 0;
    return {
      inside: box.top >= pane.top - 2 && box.bottom <= pane.bottom + 2,
      tall: box.height > box.width || (name ? name.getBoundingClientRect().height > lh * 2.5 : false),
      height: Math.round(box.height),
    };
  });
  ok(Boolean(bottom), "滚到底还能找到那一行");
  ok(bottom?.inside, `滚到底时开关行在 pane 里（${bottom?.inside}）`);
  ok(bottom && !bottom.tall, `开关行是横条（高 ${bottom?.height}px）`);
  await page.screenshot({ path: path.join(OUT, "02-bottom.png") });

  log("7) 字号 150%");
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "1.5"));
  // 量 ✕ 之前先把 pane 滚回顶部：上一步为了验页底设置块停在最下面。
  await page.evaluate(() => document.querySelector(".st-pane").scrollTo({ top: 0, behavior: "instant" }));
  await sleep(300);
  const zoom = await page.evaluate(() => {
    const pane = document.querySelector(".st-pane");
    const page_ = document.querySelector(".cl-page");
    const paneBox = pane.getBoundingClientRect();
    const close = document.querySelector(".cl-close")?.getBoundingClientRect();
    const row = [...document.querySelectorAll(".cl-settings .settings-row")].find((r) => (r.textContent ?? "").includes("启动时自动打开更新日志"));
    row?.scrollIntoView({ block: "center" });
    const rowBox = row?.getBoundingClientRect();
    return {
      hOverflow: Math.max(page_.scrollWidth - pane.clientWidth, pane.scrollWidth - pane.clientWidth),
      closeInside: close ? close.right <= paneBox.right + 1 && close.top >= paneBox.top - 1 : false,
      rowInside: rowBox ? rowBox.top >= paneBox.top - 2 && rowBox.bottom <= paneBox.bottom + 2 : false,
    };
  });
  ok(zoom.hOverflow <= 1, `150% 下没有横向溢出（+${zoom.hOverflow}px）`);
  ok(zoom.closeInside, "150% 下 ✕ 还在 pane 里");
  ok(zoom.rowInside, "150% 下页底开关行还在 pane 里");
  await page.screenshot({ path: path.join(OUT, "03-zoom150.png") });

  log("8) 切到「pi」那一侧");
  await page.evaluate(() => document.documentElement.style.removeProperty("--ui-scale"));
  await page.locator(".st-seg__btn", { hasText: "pi" }).click();
  await page.waitForSelector(".cl-markdown", { timeout: 15000 });
  await sleep(800);
  const piSide = await page.evaluate(() => ({
    reader: Boolean(document.querySelector('.st-console[data-reader="true"]')),
    title: document.querySelector(".cl-title")?.textContent ?? "",
    nav: getComputedStyle(document.querySelector(".st-console .st-nav")).display,
    md: document.querySelector(".cl-markdown")?.textContent?.trim().length ?? 0,
    hasTimeline: Boolean(document.querySelector(".cl-timeline")),
    // 页头与正文要共用一条中线（150% 字号、窄窗口下也成立）：差 2px 以上就说明有一边在贴左。
    headLeft: Math.round(document.querySelector(".cl-title")?.getBoundingClientRect().left ?? -1),
    mdLeft: Math.round(document.querySelector(".cl-markdown")?.getBoundingClientRect().left ?? -1),
  }));
  ok(piSide.reader && piSide.title === "更新日志", "pi 那侧首页仍是阅读态、标题还在");
  ok(piSide.nav === "none", "pi 那侧也没有左栏");
  ok(piSide.md > 20, `pi 那侧正文是 markdown（${piSide.md} 字）`);
  ok(!piSide.hasTimeline, "pi 那侧不画时间线");
  ok(Math.abs(piSide.headLeft - piSide.mdLeft) <= 2, `pi 那侧页头与正文对齐（${piSide.headLeft} / ${piSide.mdLeft}）`);
  await page.screenshot({ path: path.join(OUT, "04-pi-side.png") });

  log("9) 「‹ 设置」回到进来之前那一格");
  await page.locator(".cl-back").click();
  await page.waitForSelector(".st-console", { timeout: 10000 });
  await sleep(500);
  const back = await page.evaluate(() => ({
    reader: document.querySelector(".st-console")?.dataset.reader ?? "",
    nav: getComputedStyle(document.querySelector(".st-console .st-nav")).display,
    head: getComputedStyle(document.querySelector(".st-console .st-head")).display,
    on: document.querySelector(".st-nav__item.on")?.textContent ?? "",
  }));
  ok(!back.reader, "返回后不再挂 data-reader");
  ok(back.nav !== "none" && back.head !== "none", "左栏与头部都回来了");
  ok(back.on.trim().length > 0, `落在某一格上（${back.on.trim()}）`);

  await page.waitForSelector(".cl-close", { timeout: 5000 }).catch(() => {});
} catch (err) {
  console.error(err);
  fails.push(String(err?.message ?? err));
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopBridge();
  console.log(`\n截图在 ${OUT}`);
  if (fails.length) {
    console.log(`✖ ${fails.length} 项没过：\n - ${fails.join("\n - ")}`);
    process.exit(1);
  }
  console.log("✔ 全部通过");
}
