/**
 * Probe：会话目录不是 git 仓库（多仓工作区的根，比如 `C:\api`）时，点 PR 卡要照样看到 PR 详情。
 *
 * 复现的真实场景：cas3 工作区的会话 cwd 是 `C:\api`（底下才是各个仓库），AI 建完 PR 后对话里出了
 * `dentsusoken/cas3-onecas-api#18131` 的卡；点开面板，头部已经写着 #18131 和仓库名，主体却说
 * 「这个会话的目录没有 GitHub 远端」—— 主体只看会话目录的 origin，不看卡带进来的仓库。
 *
 * 真桥 + 假 gh + 真 Chromium；`/api/github/card` 与 `/api/github/pull` 用 route 顶住（不打 GitHub）。
 * `/api/github/state` 走真桥：会话目录没有 origin，它回来的 repo 就是空的 —— 这正是要验的前提。
 *
 * Run: npm run build && node probes/github-panel-no-origin.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const PORT = Number(process.env.PI_WEB_PORT ?? 7884);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(REPO, ".scratch", "github-panel-no-origin");
const STATE = path.join(ROOT, "state");
const SESSIONS = path.join(ROOT, "sessions");
const WORK = path.join(ROOT, "work");
const SHOTS = path.join(REPO, ".scratch", "shots");
const SID = "zz-no-origin";
const PR = "https://github.com/acme/widgets/pull/18131";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------- fixtures

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK, SHOTS]) fs.mkdirSync(d, { recursive: true });
// WORK 故意不 `git init`：会话目录不是仓库，origin 必然是空的。
// 但它落在本仓库的 .scratch 里，往上找会找到 pi-web-client 自己的 .git —— 用 GIT_CEILING_DIRECTORIES 拦住。

const sessionDir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(sessionDir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "开个 PR" }] } },
  { type: "message", id: "m2", parentId: "m1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: `PR：${PR}` }] } },
  { type: "session_info", id: "n1", parentId: "m2", timestamp: at, name: "no origin probe" },
];
fs.writeFileSync(path.join(sessionDir, `${SID}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

const fakeGh = path.join(REPO, "bridge", "tests", "fixtures", "fake-gh.mjs");

// ---------------------------------------------------------------- 桥

const out = [];
const { PI_HOST_LINK: _hostLink, ...baseEnv } = process.env;
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...baseEnv,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_WEB_WHATS_NEW: "0",
    PI_CODING_AGENT_SESSION_DIR: SESSIONS,
    PI_WEB_GH_JS: fakeGh,
    FAKE_GH_STATE: path.join(ROOT, "gh-state.json"),
    FAKE_GH_ACCOUNTS: JSON.stringify([{ login: "acme", active: true }]),
    GIT_CEILING_DIRECTORIES: ROOT,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", (b) => out.push(String(b)));
bridge.stderr.on("data", (b) => out.push(String(b)));

async function login() {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 25000, "bridge healthz");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

const row = {
  number: 18131,
  title: "期間一括変更時、無効な取引明細の発注を除外",
  draft: false,
  author: "acme",
  head: "feature/x",
  base: "release/4.70.x",
  updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  url: PR,
  additions: 8,
  deletions: 2,
  changedFiles: 1,
};

let browser = null;
try {
  const cookie = await login();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));

  const stateRepos = [];
  page.on("response", async (r) => {
    if (r.url().includes("/api/github/state")) stateRepos.push((await r.json().catch(() => ({})))?.repo ?? null);
  });
  const pullAsks = [];
  await page.route("**/api/github/card*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, pull: row }) }));
  await page.route("**/api/github/pr?*", (route) => {
    pullAsks.push(new URL(route.request().url()).searchParams.get("repo"));
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        pull: row,
        body: "PR 正文：期間一括変更の修正",
        state: "open",
        merged: false,
        mergedAt: null,
        mergeable: true,
        files: [{ path: "VariousWorkPlanningService.java", status: "modified", additions: 8, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b", anchor: "diff-x" }],
        checks: [],
        comments: [],
      }),
    });
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 30000, "session card");
  await page.locator(".session-card").first().click();
  const card = page.locator(".ghlink", { hasText: "#18131" }).first();
  await card.waitFor({ timeout: 20000 });
  await card.click();
  await page.locator(".ghp").waitFor({ timeout: 15000 });
  await until(async () => (await page.locator(".ghp-title").textContent())?.includes("#18131"), 15000, "detail loaded");

  check("前提：会话目录没有 origin（state.repo 是空的）", stateRepos.length > 0 && stateRepos.every((r) => !r), JSON.stringify(stateRepos));
  check("详情按卡上的仓库去取", pullAsks.includes("acme/widgets"), JSON.stringify(pullAsks));
  const bodyText = (await page.locator(".ghp").textContent()) ?? "";
  check("不再说「这个会话的目录没有 GitHub 远端」", !bodyText.includes("没有 GitHub 远端"), "");
  check("PR 详情的内容出来了（正文 / 文件）", bodyText.includes("PR 正文") && bodyText.includes("VariousWorkPlanningService.java"), "");
  await page.screenshot({ path: path.join(SHOTS, "github-panel-no-origin.png") }).catch(() => {});

  // 回到列表：头部仍是卡上的仓库，「在 GitHub 打开」指向它的 PR 列表。
  await page.route("**/api/github/pulls?*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, repo: "acme/widgets", login: "acme", anonymous: false, pulls: [row] }) }),
  );
  await page.locator(".ghp .ghp-back").click();
  await until(async () => (await page.locator(".ghp-title").textContent())?.includes("我的 PR"), 10000, "list view");
  await sleep(300);
  const listText = (await page.locator(".ghp").textContent()) ?? "";
  check("列表页也不说「没有远端」", !listText.includes("没有 GitHub 远端"), "");
  check("列表页有那条 PR", listText.includes("期間一括変更時"), "");
  check("列表页头部有「在 GitHub 打开」", (await page.locator(".ghp .ghp-open").count()) === 1, "");

  await context.close();
} catch (err) {
  failures++;
  console.log(`FAIL 探针中断 — ${err?.message ?? err}`);
  console.log(out.join("").slice(-2500));
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
}

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
