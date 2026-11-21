/**
 * 这一轮的产物收成一张卡（D353）：12 个以上写入不再铺三四行药丸。
 *
 * 自带丢弃式 bridge + 一个手写会话文件（不花模型 turn、不碰 7864）：一轮里写了 14 个文件
 * （其中一个写两次）。断言：
 *   - 消息流里只有一张 `.artcard`，没有留任何 `.file-chip`；
 *   - 默认收起：`data-open="0"`、aria-expanded="false"、身体高度 0；
 *   - 点开后按类型分组（样式 / 脚本 / 图片 / 文档），只画前 12 块，脚注说「还有 2 个」；
 *   - 动作平时透明，悬停才浮出来；点「引用」把路径带进输入框；
 *   - 卡片不撑破消息区宽度。
 *
 *   npm run build && node probes/artifact-card.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.ARTCARD_PORT ?? 7898);
const ROOT = path.join(REPO, ".scratch", "artifact-card", "probe");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "artifact-card-pass";
const SID = crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, OUT]) fs.mkdirSync(d, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "pwc-artcard-"));

/** 一轮里写 14 个文件，其中 mac.css 再写一次（同一路径只算一块）。 */
const FILES = [
  "src/mac.css",
  "src/mac-base.css",
  "src/modal.ts",
  "src/app.ts",
  "src/sysmanage.ts",
  "src/jira.ts",
  "src/mail.ts",
  "src/mailconfirm.ts",
  "src/notesheet.ts",
  "src/translateview.ts",
  ".scratch/shots/03-notes.png",
  "docs/artifacts.md",
  "src/theme-tokens.css",
  "src/palette.ts",
  "src/mac.css",
];
const calls = FILES.map((f) => f.endsWith(".ts") ? "edit" : "write");

const enc = `--${WORK.replace(/^\/+/, "").replace(/[\\/:]/g, "-")}--`;
const dir = path.join(AGENT, "sessions", enc);
fs.mkdirSync(dir, { recursive: true });
const at = (s) => `2026-11-21T09:00:${String(s).padStart(2, "0")}.000Z`;
const entries = [
  { type: "session", id: SID, cwd: WORK, timestamp: at(0) },
  { type: "message", id: "u1", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "把三套控制台并进 mac 白名单" }] } },
];
FILES.forEach((f, i) => {
  entries.push({
    type: "message",
    id: `w${i}`,
    timestamp: at(i + 2),
    message: { role: "assistant", content: [{ type: "toolCall", id: `call_${i}`, name: calls[i], arguments: { path: f } }] },
  });
});
entries.push({
  type: "message",
  id: "a1",
  timestamp: at(21),
  message: { role: "assistant", content: [{ type: "text", text: "并进白名单了，截图在上面。" }] },
});
fs.writeFileSync(path.join(dir, `${at(0).replace(/[:.]/g, "-")}_${SID}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

/** 上次崩掉留下的 bridge 会占着端口：先清掉，免得跑在旧 dist 上。 */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const pid of pids) {
      try {
        execFileSync("kill", ["-9", pid.trim()], { stdio: "ignore" });
      } catch {}
    }
  } catch {}
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
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
const log = [];
bridge.stdout.on("data", (b) => log.push(b.toString()));
bridge.stderr.on("data", (b) => log.push(b.toString()));

let browser = null;
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

  browser = await chromium.launch({ headless: !process.env.PW_HEADFUL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(`${BASE}/#/s/${SID}`, { waitUntil: "networkidle" });
  await page.locator(".artcard").first().waitFor({ timeout: 20000 });
  // 截图与「毛玻璃」那条按 Mac 浅色看；这条断言用的都是卡片自己的骨架。
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "mac-light";
    document.documentElement.dataset.ui = "mac";
  });
  await sleep(200);

  const shape = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".artcard")];
    const card = cards[0];
    const body = card?.querySelector(".ac-body");
    return {
      cards: cards.length,
      chips: document.querySelectorAll(".file-chip").length,
      open: card?.getAttribute("data-open"),
      expanded: card?.querySelector(".artcard-head")?.getAttribute("aria-expanded"),
      bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : -1,
      inert: body ? body.inert : null,
      title: card?.querySelector(".ac-title")?.textContent ?? "",
      sub: card?.querySelector(".ac-sub")?.textContent ?? "",
      recent: card?.querySelector(".ac-recent")?.textContent ?? "",
    };
  });
  check("一轮只有一张产物卡，旧药丸一颗不留", shape.cards === 1 && shape.chips === 0, JSON.stringify(shape));
  check(
    "默认收起（data-open=0 / aria-expanded=false / 身体高度 0 / inert）",
    shape.open === "0" && shape.expanded === "false" && shape.bodyHeight <= 1 && shape.inert === true,
    `open=${shape.open} h=${shape.bodyHeight} inert=${shape.inert}`,
  );
  check("标题报总数，重复写入不重复计数", shape.title === "14 个产物", shape.title);
  check("类型小结只数画出来的 12 块", shape.sub === "样式 2 · 脚本 8 · 图片 1 · 文档 1", shape.sub);
  check("收起时给最近两个新文件", shape.recent.includes("palette.ts") && shape.recent.includes("theme-tokens.css"), shape.recent);
  await page.screenshot({ path: path.join(OUT, "1-collapsed.png"), animations: "disabled" });

  await page.locator(".artcard-head").click();
  await sleep(420);
  const opened = await page.evaluate(() => {
    const card = document.querySelector(".artcard");
    const labels = [...card.querySelectorAll(".ac-gl b")].map((b) => b.textContent);
    return {
      open: card.getAttribute("data-open"),
      labels,
      tiles: card.querySelectorAll(".ac-tile").length,
      more: card.querySelector(".ac-more span")?.textContent ?? "",
      jump: card.querySelector(".ac-link")?.textContent ?? "",
      bodyHeight: Math.round(card.querySelector(".ac-body").getBoundingClientRect().height),
      inert: card.querySelector(".ac-body").inert,
    };
  });
  check("点开后展开，身体不再 inert", opened.open === "1" && opened.bodyHeight > 120 && opened.inert === false, `h=${opened.bodyHeight} inert=${opened.inert}`);
  check("按类型分组（样式 / 脚本 / 图片 / 文档）", JSON.stringify(opened.labels) === JSON.stringify(["样式", "脚本", "图片", "文档"]), JSON.stringify(opened.labels));
  check("只画 12 块，脚注说还有 2 个", opened.tiles === 12 && opened.more === "还有 2 个", `${opened.tiles} / ${opened.more}`);
  check("脚注给「在产物面板中打开」", opened.jump === "在产物面板中打开", opened.jump);
  await page.screenshot({ path: path.join(OUT, "2-open.png"), animations: "disabled" });

  const tile = page.locator(".ac-tile").first();
  const acts = tile.locator(".ac-acts");
  const before = await acts.evaluate((n) => getComputedStyle(n).opacity);
  await tile.hover();
  await sleep(260);
  const after = await acts.evaluate((n) => getComputedStyle(n).opacity);
  check("动作平时透明，悬停才浮出来", Number(before) < 0.05 && Number(after) > 0.9, `${before} → ${after}`);
  await page.screenshot({ path: path.join(OUT, "3-hover.png"), animations: "disabled" });

  await tile.locator('.fc-chip-act.quote').click();
  await sleep(200);
  const quoted = await page.evaluate(() => document.querySelector(".composer-input textarea")?.value ?? "");
  check("点「引用」把路径带进输入框", quoted.includes("mac.css"), quoted.slice(0, 80));

  const fit = await page.evaluate(() => {
    const card = document.querySelector(".artcard");
    const body = card.closest(".msg")?.querySelector(".body") ?? card.parentElement;
    const c = card.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    return { ok: c.right <= b.right + 1 && c.width > 200, card: Math.round(c.width), body: Math.round(b.width) };
  });
  check("卡片不撑破消息区", fit.ok === true, JSON.stringify(fit));

  // 窄栏：最近那行要让位（@container 判的是卡片自己的宽度，不是视口宽度）
  await page.setViewportSize({ width: 560, height: 900 });
  await sleep(300);
  const narrow = await page.evaluate(() => {
    const recent = document.querySelector(".artcard .ac-recent");
    const card = document.querySelector(".artcard");
    return { recent: recent ? getComputedStyle(recent).display : "missing", right: Math.round(card.getBoundingClientRect().right) };
  });
  check("窄栏收起时隐藏「最近」", narrow.recent === "none", JSON.stringify(narrow));
  await page.screenshot({ path: path.join(OUT, "4-narrow.png"), animations: "disabled" });
} catch (err) {
  console.log("FAIL — 探针抛错：", err?.message ?? err);
  results.push({ name: "探针跑完", ok: false });
  console.log(log.join("").slice(-3000));
} finally {
  await browser?.close().catch(() => {});
  bridge.kill("SIGTERM");
  fs.rmSync(WORK, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\nartifact-card: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
