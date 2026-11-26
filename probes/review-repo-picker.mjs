/**
 * Probe：「评审仓库」选择器（D415）。
 *
 * 场景就是用户提的那一个：会话目录是一个**大文件夹**（本身不是 git 仓库），里面躺着两个子仓库。
 *   开评审页签 → 不是仓库那一屏 + 「选一个仓库」→ 弹层列出子目录（仓库带分支/改动徽标，普通目录写「不是仓库」）
 *   → 点 alpha → 抬头出现 `评审仓库：alpha`、not-git 那一屏消失 → 钉子在桥上落盘
 *   → `×` 回会话目录 → 钉子被删
 *   → 再开一次，直接把 `beta/src` 敲进搜索框回车 → 抬头是 `beta`（桥用 gitRoot 归一成仓库根）
 *   → 刷新页面，钉子还在 → 弹层里面包屑上走一层回到大文件夹。
 *
 * 不需要 `ocr`、不跑真评审：只验「评哪个目录」这条链，所以比 code-review.mjs 快得多。
 *
 * Run: npm run build && node probes/review-repo-picker.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const PORT = Number(process.env.PI_WEB_PORT ?? 7883);
const BASE = `http://127.0.0.1:${PORT}`;
// 必须落在仓库外面：`<repo>/.scratch/...` 本身就在一个 git 仓库里，`gitRoot()` 会指到仓库根，
// 「大文件夹不是仓库」这个前提根本不成立（踩过一次：面板照样是正常的评审屏）。
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-picker-"));
const STATE = path.join(ROOT, "state");
const SESSIONS = path.join(ROOT, "sessions");
/** 大文件夹：本身不是仓库，`alpha` / `beta` 是，`docs` 不是。 */
const WORK = path.join(ROOT, "work");
const SID = "zz-review-repo-picker";

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

for (const d of [STATE, SESSIONS, WORK]) fs.mkdirSync(d, { recursive: true });
const gitIn = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true });
const mkRepo = (name) => {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "index.ts"), `export const name = "${name}";\n`);
  gitIn(dir, "add", "-A");
  gitIn(dir, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init");
  return dir;
};
mkRepo("alpha");
const beta = mkRepo("beta");
fs.mkdirSync(path.join(WORK, "docs"), { recursive: true });
fs.mkdirSync(path.join(beta, "src"), { recursive: true });
fs.writeFileSync(path.join(beta, "index.ts"), 'export const name = "beta changed";\n');

const sessionDir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(sessionDir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "repo picker probe" }] } },
  { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name: "repo picker probe" },
];
fs.writeFileSync(path.join(sessionDir, `${SID}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

// ---------------------------------------------------------------- 桥

// 从 pi 里跑探针时父进程的「我在某个会话里」标记会漏给桥（见 probes/code-review.mjs 的注释）。
const cleanEnv = () => {
  const env = { ...process.env };
  delete env.PI_HOST_LINK;
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_WEB_")) delete env[key];
    else if (key.startsWith("PI_SDK_")) delete env[key];
    else if (["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL"].includes(key)) delete env[key];
  }
  return env;
};
const proc = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...cleanEnv(),
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_WEB_WHATS_NEW: "0",
    PI_CODING_AGENT_SESSION_DIR: SESSIONS,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const out = [];
proc.stdout.on("data", (b) => out.push(String(b)));
proc.stderr.on("data", (b) => out.push(String(b)));

const pinDir = path.join(STATE, "review", "pins");
const pinFiles = () => (fs.existsSync(pinDir) ? fs.readdirSync(pinDir).filter((f) => f.endsWith(".json")) : []);
const pinTarget = () => {
  const files = pinFiles();
  if (!files.length) return "";
  try {
    return String(JSON.parse(fs.readFileSync(path.join(pinDir, files[0]), "utf8")).dir ?? "");
  } catch {
    return "";
  }
};

let browser = null;
try {
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 30000, "bridge healthz");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  /** 页面上没有「当前会话」时先点开列表里那一条（探针只造了一个）。 */
  const openSession = async () => {
    if (await page.locator(".session-card").count()) return;
    await until(async () => (await page.locator(".session-card").count()) >= 1, 30000, "session card");
    await page.locator(".session-card").first().click();
  };
  const openReviewTab = async () => {
    const tab = page.locator('.exec-tabs button[data-exec-tab="review"]');
    await tab.waitFor({ timeout: 20000 });
    await tab.click();
    await page.locator(".review").waitFor({ timeout: 10000 });
  };
  const chipText = async () => ((await page.locator(".rv-repo-chip").count()) ? (await page.locator(".rv-repo-chip").first().innerText()).trim() : "");
  const openPicker = async () => {
    const btn = page.locator(".rv-pickrepo:visible, .rv-repo-chip:visible").first();
    await btn.waitFor({ timeout: 10000 });
    await btn.click();
    await page.locator(".repopick").waitFor({ timeout: 10000 });
  };

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await openSession();
  await openReviewTab();

  // 1) 大文件夹不是仓库：说明 + 入口，没有抬头 chip
  await page.locator(".rv-notgit, .rv-repo-chip, .review .empty").first().waitFor({ timeout: 25000 });
  if ((await page.locator(".rv-notgit").count()) !== 1) {
    console.log("面板上是：", (await page.locator(".review").innerText()).slice(0, 400));
  }
  check("不是仓库那一屏带「选一个仓库」", (await page.locator(".rv-pickrepo").count()) === 1);
  check("这时没有抬头 chip", (await page.locator(".rv-repo-chip").count()) === 0);

  // 2) 弹层：子目录列出来，仓库带徽标，普通目录写「不是仓库」
  await openPicker();
  await page.locator(".repopick-row", { hasText: "alpha" }).first().waitFor({ timeout: 15000 });
  const alphaRow = page.locator(".repopick-row", { hasText: "alpha" }).first();
  const betaRow = page.locator(".repopick-row", { hasText: "beta" }).first();
  const docsRow = page.locator(".repopick-row", { hasText: "docs" }).first();
  await until(async () => (await alphaRow.locator(".repopick-badge").count()) > 0, 20000, "alpha badge");
  check("alpha 有分支徽标", /\S/.test((await alphaRow.locator(".repopick-badge").innerText()).trim()));
  check("beta 有分支徽标", (await betaRow.locator(".repopick-badge").count()) > 0);
  check("docs 标成「不是仓库」", (await docsRow.locator(".repopick-faint").count()) === 1);
  check("面包屑能上走（有 >1 节）", (await page.locator(".repopick-crumb").count()) > 1);

  // 3) 点 alpha 选中 → 底栏「使用 alpha」→ 弹层关、抬头 chip、not-git 屏消失、桥落盘
  await alphaRow.locator(".repopick-name").click();
  await until(async () => (await page.locator(".repopick-use").innerText()).includes("alpha"), 10000, "use button names alpha");
  await page.locator(".repopick-use").click();
  await until(async () => (await page.locator(".repopick").count()) === 0, 15000, "picker closed");
  await until(async () => (await chipText()) === "alpha", 15000, "chip = alpha");
  check("抬头 chip 是 alpha", (await chipText()) === "alpha");
  check("not-git 那一屏没了", (await page.locator(".rv-notgit").count()) === 0);
  await until(() => pinTarget() !== "", 10000, "pin file");
  check("钉子在桥上落盘", pinTarget().replace(/[\\/]+$/, "").toLowerCase().endsWith(`${path.sep}alpha`.toLowerCase()), pinTarget());
  check("钉住后有 × 清钉钮", (await page.locator(".rv-repo-x").count()) === 1);

  // 4) × → 回会话目录，钉子被删
  await page.locator(".rv-repo-x").click();
  await page.locator(".rv-notgit").waitFor({ timeout: 15000 });
  await until(() => pinFiles().length === 0, 10000, "pin removed");
  check("× 之后回到 not-git", (await page.locator(".rv-notgit").count()) === 1);
  check("× 之后钉子在桥上被删", pinFiles().length === 0);

  // 5) 敲路径：`beta/src` 由桥的 gitRoot 归一成 `beta`
  await openPicker();
  await page.locator(".repopick-q").fill(path.join(WORK, "beta", "src"));
  await page.locator(".repopick-q").press("Enter");
  await until(async () => (await chipText()) === "beta", 15000, "chip = beta");
  check("敲 beta/src 落成 beta", (await chipText()) === "beta");

  // 6) 刷新页面：钉子还在（存在桥端，不在页面内存里）
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await openSession();
  await openReviewTab();
  await until(async () => (await chipText()) === "beta", 20000, "chip survives reload");
  check("刷新后 chip 仍是 beta", (await chipText()) === "beta");

  // 7) 弹层从当前位置往上走一层：回到大文件夹，能再看见 alpha
  await openPicker();
  await page.locator(".repopick-up").first().waitFor({ timeout: 10000 });
  await page.locator(".repopick-up").first().click();
  await page.locator(".repopick-row", { hasText: "alpha" }).first().waitFor({ timeout: 15000 });
  check("上走一层看见大文件夹里的 alpha", (await page.locator(".repopick-row", { hasText: "alpha" }).count()) === 1);
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".repopick").count()) === 0, 10000, "picker closed by esc");

  check("页面没有 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));
} finally {
  if (browser) await browser.close().catch(() => {});
  proc.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (failures) console.log(`\n--- bridge 日志尾部 ---\n${out.join("").slice(-2000)}`);
}

console.log(failures ? `\nFAIL ${failures} 项` : "\nreview-repo-picker: 全部通过");
process.exit(failures ? 1 : 0);
