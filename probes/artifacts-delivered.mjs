/**
 * 产物弹窗里看得见「脚本生成、open_preview 交付」的文件（#451 / D275）。
 *
 * 场景照用户报的那次：只在 `write` 里写过构建脚本，xlsx 是脚本跑出来的，最后用
 * `open_preview` 打开。旧行为只收 write 系工具，弹窗里只有 py、没有 xlsx。
 *
 * 自带丢弃式 bridge + 一个手写会话文件（不花模型 turn、不碰 7864），断言：
 *   - 两条都在列表里，xlsx 的工具列是 `open_preview×1`；
 *   - xlsx 的状态是「未知」，但说明是「脚本 / 程序生成」那条，不是「桥没在运行」；
 *   - 点 xlsx 那一行不弹空的 diff，而是直接开预览（这里只验它没有 diff 按钮）。
 *
 *   node probes/artifacts-delivered.mjs
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
const PORT = Number(process.env.ARTIFACTS_UI_PORT ?? 7897);
const ROOT = path.join(REPO, ".scratch", "artifacts-delivered");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "artifacts-delivered-pass";
const SID = crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, OUT]) fs.mkdirSync(d, { recursive: true });
// 工作目录放在仓库外：不是 git 仓库，才不会走「按 git 估算」那条兜底。
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "pwc-artifacts-ui-"));
const SCRIPT = path.join(WORK, "build_xlsx.py");
const BOOK = path.join(WORK, "期末成绩单.xlsx");
fs.writeFileSync(SCRIPT, "print('saved 期末成绩单.xlsx')\n");
fs.writeFileSync(BOOK, "not really a workbook\n");

// 会话文件：pi 的默认布局 `<root>/--<cwd>--/<ts>_<id>.jsonl`；不写 parentId 就是线性历史。
const enc = `--${WORK.replace(/^\/+/, "").replace(/[\\/:]/g, "-")}--`;
const dir = path.join(AGENT, "sessions", enc);
fs.mkdirSync(dir, { recursive: true });
const at = (s) => `2026-11-15T10:00:${String(s).padStart(2, "0")}.000Z`;
const entries = [
  { type: "session", id: SID, cwd: WORK, timestamp: at(0) },
  { type: "message", id: "e1", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "做一个期末成绩单表格" }] } },
  {
    type: "message",
    id: "e2",
    timestamp: at(2),
    message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "write", arguments: { path: "build_xlsx.py" } }] },
  },
  {
    type: "message",
    id: "e3",
    timestamp: at(3),
    message: { role: "assistant", content: [{ type: "toolCall", id: "call_2", name: "open_preview", arguments: { path: "期末成绩单.xlsx" } }] },
  },
  { type: "message", id: "e4", timestamp: at(4), message: { role: "assistant", content: [{ type: "text", text: "已生成并在预览中打开：期末成绩单.xlsx" }] } },
];
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(`${BASE}/#/s/${SID}`, { waitUntil: "networkidle" });

  const btn = page.locator('.topbar [data-act="artifacts"]');
  await btn.waitFor({ timeout: 15000 });
  check("会话在浏览器里打开，产物按钮在", true);
  await btn.click();
  await page.locator(".art-sheet").waitFor({ timeout: 15000 });
  await page.locator(".art-row").first().waitFor({ timeout: 15000 });

  const rows = await page.$$eval(".art-row", (els) =>
    els.map((el) => ({
      name: el.querySelector(".art-name")?.textContent ?? "",
      tools: el.querySelector(".art-tools")?.textContent ?? "",
      badge: el.querySelector(".art-badge")?.textContent ?? "",
      why: el.querySelector(".art-why")?.textContent ?? "",
      hasDiff: Boolean(el.querySelector(".art-go")),
    })),
  );
  const book = rows.find((r) => r.name === "期末成绩单.xlsx");
  const script = rows.find((r) => r.name === "build_xlsx.py");
  check("xlsx（open_preview 交付）出现在产物列表里", Boolean(book), JSON.stringify(rows.map((r) => r.name)));
  check("工具列说它是打开过的（open_preview×1）", book?.tools === "open_preview×1", book?.tools ?? "");
  check("徽章是「未知」（没有写入前原文）", book?.badge === "未知", book?.badge ?? "");
  check("说明是脚本产物那条，不是「桥没在运行」", Boolean(book?.why.includes("脚本") && !book.why.includes("桥没在运行")), book?.why ?? "");
  check("没有可对比的改动 → 不给空的 diff 入口", book?.hasDiff === false);
  check("写入过的 py 仍在列表里（write×1）", script?.tools === "write×1", script?.tools ?? "");
  await page.screenshot({ path: path.join(OUT, "1-artifacts.png"), animations: "disabled" });
  // 窄屏（390px）：弹窗和行都不许撑出视口（settings-console 的列轨 minmax(0,1fr) 防的就是这个）
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  const fit = await page.evaluate(() => {
    const s = document.querySelector(".art-sheet");
    if (!s) return { ok: false };
    const box = s.getBoundingClientRect();
    const rowsIn = [...s.querySelectorAll(".art-row")].every((r) => r.getBoundingClientRect().right <= box.right + 1);
    return { ok: box.right <= window.innerWidth + 1 && rowsIn, width: Math.round(box.width), vw: window.innerWidth };
  });
  check("390px 下弹窗与行都不撑出视口", fit.ok === true, JSON.stringify(fit));
  await page.screenshot({ path: path.join(OUT, "2-artifacts-390.png"), animations: "disabled" });
  // 字号 150%：底栏（st-foot）还得在弹窗里看得见（AGENTS：弹层改完要看一眼底栏）
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "1.5"));
  await sleep(400);
  const foot = await page.evaluate(() => {
    const s = document.querySelector(".art-sheet");
    const f = s?.querySelector(".st-foot");
    if (!s || !f) return { ok: false };
    const sb = s.getBoundingClientRect();
    const fb = f.getBoundingClientRect();
    return { ok: fb.bottom <= sb.bottom + 1 && fb.height > 0 && fb.bottom <= window.innerHeight + 1, footBottom: Math.round(fb.bottom), sheetBottom: Math.round(sb.bottom), vh: window.innerHeight };
  });
  check("字号 150% 下底栏仍在弹窗里", foot.ok === true, JSON.stringify(foot));
  await page.screenshot({ path: path.join(OUT, "3-artifacts-150.png"), animations: "disabled" });
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
console.log(`\nartifacts-delivered: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
