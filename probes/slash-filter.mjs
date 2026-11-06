/**
 * 探针：`/` 菜单在真浏览器里到底留下哪几行（D152 的回归，2026-11-06 用户报障）。
 *
 * 起法 —— **在本仓库/本 worktree 里跑**，`--dir` 指自己，别指到别的 checkout，否则测的是
 * 那边旧的 `web/dist`，这里的断言只会怪代码：
 *   node .pi/skills/pi-web-client-test-dev/bin/env.mjs start --dir "$PWD" --name hand --build
 *   PI_WEB_BASE=http://127.0.0.1:<启动输出里的端口> node probes/slash-filter.mjs
 *
 * 断言按 D152「验证」那一节写：四条查询逐条判，`/hand` 还要判顺序（排序整体退化也得被抓到）。
 */
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const BASE = process.env.PI_WEB_BASE ?? "http://127.0.0.1:17874";
const PASS = "test";
const OUT = path.join(REPO, ".scratch/hand-filter");
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (!process.env.PI_WEB_BASE) log(`PI_WEB_BASE 未设置，按默认 ${BASE} 连 —— 确认那是这次起的实例`);
log("base", BASE);

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: PASS }),
});
if (login.status !== 200) throw new Error(`login ${login.status}`);
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

const sessionId = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie } });
  ws.on("open", () => ws.send(JSON.stringify({ type: "create", cwd: REPO, name: "补全探针" })));
  ws.on("message", (b) => {
    let m;
    try {
      m = JSON.parse(b.toString());
    } catch {
      return; // 不是 JSON 的帧跟这里无关
    }
    if (m.type === "session.state" && m.session?.name === "补全探针") {
      resolve(m.session.id);
      ws.close();
    }
    if (m.type === "error") reject(new Error(m.message));
  });
  setTimeout(() => reject(new Error("create timeout")), 90000);
});
log("session", sessionId);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, locale: "zh-CN" });
const page = await ctx.newPage();
page.on("pageerror", (e) => log("pageerror:", e.message));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', PASS);
  await page.click('button:has-text("进入")');
}
await page.waitForSelector(".session-list", { timeout: 30000 });
await page.evaluate((id) => (location.hash = `#/s/${id}`), sessionId);
await page.waitForSelector(".composer textarea", { timeout: 30000 });
await page.waitForTimeout(1500); // 命令列表要等 bridge 问完 pi / 扫完磁盘

const field = page.locator(".composer textarea");
async function rowsAfter(text) {
  await field.click();
  await field.fill("");
  await page.waitForTimeout(120);
  await field.pressSequentially(text, { delay: 60 });
  await page.waitForTimeout(600);
  const rows = await page.$$eval(".complete-pop .complete-row", (els) =>
    els.map((r) => {
      const label = r.querySelector(".complete-label")?.textContent ?? "";
      const tag = r.querySelector(".complete-tag")?.textContent ?? "";
      return { label, tag: tag ? `[${tag}]` : "" };
    }),
  );
  const empty = await page.$$eval(".complete-pop .complete-empty", (els) => els.map((e) => e.textContent ?? ""));
  return { rows, empty };
}

// 每条查询各自的判定：`want` 就按整份列表比（顺序也算），`check` 留给依赖本机装了哪些技能的用例。
const cases = [
  {
    q: "/hand",
    want: ["/skill:handoff", "/skill:claude-handoff"],
    why: "只留名字里带 hand 的两个，且 handoff 在前（尾巴前缀压过词前缀）",
    shot: "hand.png",
  },
  { q: "/skill:hand", want: ["/skill:handoff", "/skill:claude-handoff"], why: "敲了命名空间也一样" },
  {
    q: "/kill",
    why: "命名空间不参与子串匹配：六个 skill: 里只有尾巴真含 kill 的才中",
    check: (got) => got.every((l) => l.slice(1).split(":").slice(1).join(":").includes("kill")),
  },
  { q: "/zzzqqq", want: [], why: "没有匹配的命令" },
  {
    q: "/claude",
    why: "只剩 claude 那一族",
    check: (got) => got.includes("/skill:claude-handoff") && got.every((l) => l.includes("claude")),
  },
  {
    q: "/skill:",
    why: "只敲命名空间照旧列出全部技能",
    check: (got) => got.length > 3 && got.every((l) => l.startsWith("/skill:")),
  },
];

let bad = 0;
for (const c of cases) {
  const { rows, empty } = await rowsAfter(c.q);
  const got = rows.map((r) => r.label);
  const shown = rows.map((r) => `${r.label}${r.tag}`).join("  ");
  log(c.q, "→", shown || `空：${empty.join("")}`);
  const ok = c.want ? JSON.stringify(got) === JSON.stringify(c.want) : c.check(got);
  if (!ok) bad++;
  log(ok ? `✔ ${c.why}` : `✖ ${c.why}（期望 ${c.want ? c.want.join(" ") : c.why}）`);
  if (c.shot) await page.screenshot({ path: path.join(OUT, c.shot) });
}

await browser.close();
log(bad ? `FAIL (${bad})` : "PASS");
process.exit(bad ? 1 : 0);
