/**
 * 文件管理器的控制台版式（D312）：顶栏 📁 打开的浏览页与下沿「文件」的附件弹层现在是同一份实现，
 * 只差一层壳与行语义。这个探针在真桥 + 真浏览器里把两边的骨架、行语义、状态栏和窄版走一遍。
 *
 * 自带丢弃式 bridge + 临时工作目录（不碰 7864，也不碰真实会话目录）。
 *
 *   node probes/fs-console-ui.mjs
 *   PW_HEADFUL=1 node probes/fs-console-ui.mjs     # 想看着它跑
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const PORT = Number(process.env.FSCONSOLE_UI_PORT ?? 7893);
const ROOT = path.join(REPO, ".scratch", "fs-console-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "fs-console-ui-pass";
const SID = crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const fail = (msg) => {
  throw new Error(msg);
};

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, OUT]) fs.mkdirSync(d, { recursive: true });

// ---- 一个像样的工作目录：几层子目录 + 各种扩展名 + 一个长名字
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "pwc-fs-console-"));
const mk = (rel, body = "x") => {
  const full = path.join(WORK, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};
for (const d of ["sub", "docs"]) fs.mkdirSync(path.join(WORK, d), { recursive: true });
mk("笔记.md", "# 笔记\n\n第一行。\n");
mk("plain.txt", "纯文本\n");
mk("sub/inside.md", "# 子目录里的文件\n");
mk("docs/设计.md", "# 设计\n");
mk(`docs/${"很长的文件名".repeat(6)}.md`, "# 长名字\n");

// ---- 会话文件（pi 的默认布局）
const enc = `--${WORK.replace(/^\/+/, "").replace(/[\\/]/g, "-")}--`;
const dir = path.join(AGENT, "sessions", enc);
fs.mkdirSync(dir, { recursive: true });
const at = (s) => `2026-11-18T10:00:${String(s).padStart(2, "0")}.000Z`;
const entries = [
  { type: "session", version: 3, id: SID, cwd: WORK, timestamp: at(0) },
  { type: "message", id: "e1", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "看看这个目录" }] } },
  { type: "message", id: "e2", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "好。" }] } },
];
fs.writeFileSync(path.join(dir, `${at(0).replace(/[:.]/g, "-")}_${SID}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

/** 上一轮崩掉的 bridge 会占着端口，先清掉（否则跑在旧 dist 上）。 */
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
execFileSync(process.execPath, [path.join(REPO, "bridge", "dist", "index.js"), "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [path.join(REPO, "bridge", "dist", "index.js")], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
const log = [];
bridge.stdout.on("data", (b) => log.push(b.toString()));
bridge.stderr.on("data", (b) => log.push(b.toString()));

let browser = null;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    await sleep(200);
  }
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");

  browser = await chromium.launch({ headless: !process.env.PW_HEADFUL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(`${BASE}/#/s/${SID}`, { waitUntil: "networkidle" });

  // ---- 1. 顶栏 📁 → 控制台式浏览页：左栏（或横标签）+ 表格 + 状态栏
  await page.locator('.topbar [data-act="files"]').click();
  await page.locator(".viewer-browse .fc-console.fc-pane-shell").waitFor({ timeout: 15000 });
  await page.locator(".fc-pane .fc-table tbody tr.file-row").first().waitFor({ timeout: 15000 });
  const shell = await page.evaluate(() => ({
    nav: document.querySelectorAll(".viewer-browse .fc-nav").length,
    railItems: [...document.querySelectorAll(".viewer-browse .fc-nav .sys-nav__label")].map((e) => e.textContent),
    cols: [...document.querySelectorAll(".fc-pane .fc-table thead th")].map((e) => e.textContent.replace(/\s*[↑↓]\s*$/, "")),
    foot: document.querySelector(".fc-pane .dir-pagefoot .dir-footpath")?.textContent ?? "",
    head: Boolean(document.querySelector(".viewer-browse .sys-head")),
  }));
  check("浏览页是控制台壳：有左栏", shell.nav === 1, `nav=${shell.nav} items=${shell.railItems.join("/")}`);
  check("左栏有工作目录 / 此电脑 / 最近", ["工作目录", "此电脑", "最近"].every((t) => shell.railItems.some((x) => x.includes(t))), shell.railItems.join("/"));
  check("表头是四列", shell.cols.join(",") === "名称,大小,修改时间,操作", shell.cols.join(","));
  check("状态栏写着当前目录", shell.foot.endsWith(fileName(WORK)), shell.foot);
  check("浏览页没有重复的标题栏", shell.head === false);
  await page.screenshot({ path: path.join(OUT, "1-browse.png"), animations: "disabled" });

  // ---- 2. 行 = 打开预览
  await page.locator(".fc-pane .fc-table tbody tr.file-row", { hasText: "笔记.md" }).click();
  await page.locator(".viewer-body .md-doc").waitFor({ timeout: 10000 });
  check("点文件行 = 打开预览", true);
  await page.screenshot({ path: path.join(OUT, "2-preview.png"), animations: "disabled" });

  // ---- 3. 回到浏览 → 行内「引用」插进输入框
  await page.locator(".viewer-head .pane-seg button", { hasText: "浏览" }).click();
  await page.locator(".fc-pane .fc-table tbody tr.file-row").first().waitFor({ timeout: 10000 });
  await page.locator(".fc-pane .fc-table tbody tr.file-row", { hasText: "plain.txt" }).locator(".fc-act", { hasText: "引用" }).click();
  const composer = await page.locator(".composer textarea").first().inputValue();
  check("行内「引用」把路径插进输入框", composer.includes("plain.txt"), composer.trim());
  await page.locator(".composer textarea").first().fill("");

  // ---- 4. 右键菜单：打开 / 复制路径
  await page.locator('.topbar [data-act="files"]').click();
  await page.locator(".fc-pane .fc-table tbody tr.file-row").first().waitFor({ timeout: 10000 });
  await page.locator(".fc-pane .fc-table tbody tr.file-row", { hasText: "plain.txt" }).click({ button: "right" });
  await page.locator(".ctx-menu").waitFor({ timeout: 5000 });
  const menu = await page.$$eval(".ctx-menu .ctx-item", (els) => els.map((e) => e.textContent));
  check("右键菜单有「打开」与「复制路径」", menu.includes("打开") && menu.includes("复制路径"), menu.join("/"));
  // 菜单自己收起来（不在窗口里乱点：Esc 会把 viewer 关掉，点行会打开预览）
  await page.evaluate(() => document.querySelector(".ctx-menu")?.remove());

  // ---- 5. 跳到路径：文件 = 父目录 + 标出那一行
  const jump = page.locator(".fc-pane .dir-jump-input");
  await jump.fill(path.join(WORK, "sub", "inside.md"));
  await jump.press("Enter");
  await page.locator(".fc-pane .fc-table tbody tr.file-row.hit").waitFor({ timeout: 10000 });
  const jumped = await page.evaluate(() => ({
    path: document.querySelector(".fc-pane .dir-footpath")?.textContent ?? "",
    hit: document.querySelector(".fc-pane tbody tr.file-row.hit")?.textContent ?? "",
  }));
  check("跳到文件：落在父目录并标出该行", jumped.path.endsWith("sub") && jumped.hit.includes("inside.md"), `${jumped.path} · ${jumped.hit}`);
  await page.screenshot({ path: path.join(OUT, "3-jump.png"), animations: "disabled" });

  // ---- 6. 面包屑：既有段、点了真跳
  const crumbs = await page.$$eval(".fc-pane .dir-path .crumb", (els) => els.map((e) => e.textContent));
  check("面包屑是分段按钮", crumbs.length >= 3, crumbs.join(" / "));
  await page.locator(".fc-pane .dir-path .crumb", { hasText: "此电脑" }).click();
  // 「此电脑」页在各平台的形态不一样（Windows 是盘符行，POSIX 上多半是空的根）：只看面包屑收回一段。
  // 面包屑收回到只剩「此电脑」就算到位（POSIX 上它就是根，Windows 上是盘符行）。
  await page.waitForFunction(() => document.querySelectorAll(".fc-pane .dir-path .crumb").length === 1, null, { timeout: 10000 });
  check("点「此电脑」回到盘符页", true);

  // ---- 7. ＋文件夹：建完停在原地并标出新建的那一行
  await page.locator(".fc-pane .dir-head .dir-home").click();
  await page.locator(".fc-pane .fc-table tbody tr.file-row").first().waitFor({ timeout: 10000 });
  await page.locator(".fc-pane .dir-head button", { hasText: "文件夹" }).click();
  const mkInput = page.locator(".fc-pane .dir-mkrow .ns-input");
  await mkInput.waitFor({ timeout: 5000 });
  await mkInput.fill("zz-new-dir");
  await mkInput.press("Enter");
  await page.locator(".fc-pane .fc-table tbody tr.dir-row.hit", { hasText: "zz-new-dir" }).waitFor({ timeout: 10000 });
  const afterMk = await page.evaluate(() => document.querySelector(".fc-pane .dir-footpath")?.textContent ?? "");
  check("＋文件夹：建完停在原地并标出新行", afterMk.endsWith(fileName(WORK)), afterMk);
  await page.screenshot({ path: path.join(OUT, "4-mkdir.png"), animations: "disabled" });

  // ---- 8. 窄版：面板自己的宽度不够时收左栏，页面不许横向溢出
  for (const [w, h] of [[900, 780], [560, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(350);
    const near = await page.evaluate(() => {
      const shell = document.querySelector(".viewer-browse .fc-console");
      const nav = document.querySelector(".viewer-browse .fc-nav");
      const navStyle = nav ? getComputedStyle(nav) : null;
      const table = document.querySelector(".fc-pane .fc-table");
      return {
        cls: String(shell?.className ?? ""),
        navDir: navStyle?.flexDirection ?? "",
        navVisible: (nav?.getBoundingClientRect().height ?? 0) > 4,
        tableOverflow: table ? table.scrollWidth > table.clientWidth + 1 : false,
        docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });
    check(`${w}px：页面不横向溢出、表格不出框`, !near.docOverflow && !near.tableOverflow, JSON.stringify(near));
    if (w === 560) check("560px：左栏折成横标签", near.navDir === "row" || !near.navVisible, JSON.stringify(near));
    await page.screenshot({ path: path.join(OUT, `5-narrow-${w}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(300);
  await page.locator(".viewer-head .viewer-btn", { hasText: "✕" }).click();

  // ---- 9. 附件弹层：同一份实现的另一种壳（有标题栏与页脚、行 = 引用）
  await page.locator(".hint-tools button", { hasText: "文件" }).click();
  await page.locator(".fc-back .fc-console.fc-dialog").waitFor({ timeout: 10000 });
  await page.locator(".fc-back .fc-table tbody tr.file-row").first().waitFor({ timeout: 10000 });
  const dialog = await page.evaluate(() => ({
    head: document.querySelector(".fc-back .sys-head")?.textContent.includes("选择文件") ?? false,
    foot: Boolean(document.querySelector(".fc-back .sys-foot")),
    footPath: document.querySelector(".fc-back .dir-pagefoot .dir-footpath")?.textContent ?? "",
    cols: document.querySelectorAll(".fc-back .fc-table thead th").length,
  }));
  check("附件弹层仍是标题栏 + 页脚", dialog.head && dialog.foot);
  check("附件弹层不在状态栏重复写路径", dialog.footPath === "", `"${dialog.footPath}"`);
  check("附件弹层也是四列表格", dialog.cols === 4);
  await page.screenshot({ path: path.join(OUT, "6-attach.png"), animations: "disabled" });
  await page.locator(".fc-back tbody tr.file-row", { hasText: "plain.txt" }).click();
  const quoted = await page.locator(".composer textarea").first().inputValue();
  const closed = (await page.locator(".fc-back").count()) === 0;
  check("附件弹层点行 = 引用并关闭", closed && quoted.includes("plain.txt"), quoted.trim());

  await context.close();
} catch (err) {
  console.error(log.join("").slice(-2500));
  await browser?.close();
  bridge.kill("SIGKILL");
  console.error("FAILED:", err.message);
  process.exit(1);
}
await browser?.close();
bridge.kill("SIGKILL");

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} 项没过` : `\n全部通过（${results.length} 项），截图在 ${OUT}`);
if (bad.length) process.exit(1);

/** 路径最后一段（不管分隔符）。 */
function fileName(p) {
  return p.split(/[\\/]+/).filter(Boolean).pop() ?? p;
}
