/**
 * Probe：PR 详情面板的「文档式」版面（D 见 docs/DECISIONS.md）。
 *
 * 验的是用户在 #640 截图里指出的几个毛病有没有真的消失，全是外部行为：
 *   1. 描述全文一屏摊开，**没有**内层滚动框（scrollHeight ≈ clientHeight）。
 *   2. 四格数字与 hero 卡不再存在；「示例数据」整块只出现一次。
 *   3. 文件清单 8 个文件全在，560px 两列、420px 一列（@container 按面板自己宽度切）。
 *   4. 评论不再只露最后一条 + 死的「还有 1 条」：两条都在，`.ghp-post` 各一条。
 *   5. 描述走 renderMarkdown：h2 与行内 code 都成了真元素。
 *
 * Run: npm run build && node probes/pr-detail-layout.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const PORT = Number(process.env.PI_WEB_PORT ?? 7884);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(REPO, ".scratch", "pr-detail-probe");
const STATE = path.join(ROOT, "state");
const SESSIONS = path.join(ROOT, "sessions");
const WORK = path.join(ROOT, "work");
const SHOTS = path.join(REPO, ".scratch", "shots");
const SID = "zz-pr-detail";
const LINK = "https://github.com/acme/widgets/pull/640";
const NUM = 640;

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

const git = (...args) => execFileSync("git", ["-C", WORK, ...args], { encoding: "utf8", windowsHide: true });
git("init", "-q");
git("remote", "add", "origin", "git@github.com:acme/widgets.git");
fs.writeFileSync(path.join(WORK, "a.txt"), "hello\n");
git("add", "-A");
git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init");

const sessionDir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(sessionDir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: `看这个 ${LINK}` }] } },
  { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name: "pr detail layout probe" },
];
fs.writeFileSync(path.join(sessionDir, `${SID}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

const FILES = [
  ["CHANGELOG.md", "modified", 1, 0],
  ["docs/DECISIONS.md", "modified", 21, 0],
  ["package.json", "modified", 1, 0],
  ["web/package.json", "modified", 1, 1],
  ["web/src/app.ts", "modified", 35, 8],
  ["web/src/ask-text.ts", "added", 70, 0],
  ["web/src/styles.css", "modified", 9, 2],
  ["web/tests/ask-text-unit.mjs", "added", 88, 0],
];

const BODY = [
  "## 用户能看到的",
  "",
  "提问卡片不再把模型给的痕迹原样摊开：",
  "",
  "- 题干里的字面 `\\n\\n`（模型把换行二次转义了）折成真换行；",
  "- `` `bridge/src/rpc.ts` `` 这类反引号片段渲染成 `行内代码`，反引号本身不再露出来；",
  "- 选项说明补上换行与「任意处断行」，长路径不再把卡片顶宽；",
  "- 合并正式用它之前跟「兼容回放」：把最近一个批次的历史提问卡重新用新管线渲染，任何一张宽窄变化就红。",
  "",
  "## 为什么要动",
  "",
  "以前的代码把 `\\n` 当普通字符，于是整段题干挤成一行。",
].join("\n");

const DETAIL = {
  ok: true,
  pull: {
    number: NUM,
    title: "fix(web): 提问卡片把字面 \\n 折行、反引号片段渲染成行内代码",
    draft: false,
    author: "Yang-Code01",
    head: "fix/ask-card-text",
    base: "main",
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    url: LINK,
    additions: 226,
    deletions: 11,
    changedFiles: 8,
  },
  body: BODY,
  state: "open",
  mergeable: true,
  files: FILES.map(([p, status, additions, deletions]) => ({
    path: p,
    status,
    additions,
    deletions,
    patch: "",
    anchor: `diff-${p.length}${p.charCodeAt(0)}`,
  })),
  sample: {
    checks: [
      { name: "typecheck", state: "success" },
      { name: "unit", state: "success" },
      { name: "ui", state: "failure" },
      { name: "e2e", state: "pending" },
    ],
    comments: [
      { author: "octocat", body: "这类改动值得先写一条 unit。", at: new Date(Date.now() - 86400000).toISOString() },
      { author: "hubot", body: "补了：第 10 段逐帧采样，任何一帧 opacity < 0.99 就红。", at: new Date(Date.now() - 3600000).toISOString() },
    ],
  },
};

// ---------------------------------------------------------------- 桥

// 我这个进程可能是由 7864 那份壳起的会话（继承了 PI_HOST_LINK）。带着它起探针，子桥会去连
// 壳的命名管道、而不是自己开 7884，于是「等 healthz」永远超时。
const env = {
  ...process.env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_WEB_WHATS_NEW: "0",
    PI_CODING_AGENT_SESSION_DIR: SESSIONS,
    PI_WEB_GH_JS: path.join(REPO, "bridge", "tests", "fixtures", "fake-gh.mjs"),
    FAKE_GH_STATE: path.join(ROOT, "gh-state.json"),
  FAKE_GH_ACCOUNTS: JSON.stringify([{ login: "acme", active: true }]),
};
// 会话是 7864 那份壳起的：带着 PI_HOST_LINK 起探针，子桥会去连壳的命名管道、不去开 7884。
delete env.PI_HOST_LINK;

const out = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
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

let browser = null;

/** 列数：0px 0px 这种字符串按空白切开数。 */
const cols = (page) =>
  page.locator(".ghp-filegrid").evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(" ").length);

try {
  const cookie = await login();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));

  const json = (body) => ({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/github/card*", (route) => route.fulfill(json({ ok: true, pull: DETAIL.pull })));
  await page.route("**/api/github/pr*", (route) => route.fulfill(json(DETAIL)));
  await page.route("**/api/github/pulls*", (route) => route.fulfill(json({ ok: true, repo: "acme/widgets", pulls: [DETAIL.pull] })));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 30000, "session card");
  await page.locator(".session-card").first().click();
  const card = page.locator(".ghcard", { hasText: `#${NUM}` });
  await card.waitFor({ timeout: 20000 });
  await card.locator(".ghlink").click();

  await page.locator(".ghp .ghp-doc").waitFor({ timeout: 20000 });
  await sleep(400);

  // ------------------------------------------------ 1) 版面骨架
  check("hero 卡没了", (await page.locator(".ghp-hero").count()) === 0);
  check("四格数字没了", (await page.locator(".ghp-stats").count()) === 0);
  check("「示例数据」整块只出现一次", (await page.locator(".ghp .ghp-sample").count()) === 1);

  const kicker = (await page.locator(".ghp-kicker").innerText()).replace(/\s+/g, " ");
  check("kicker 带号与 checks", kicker.includes(`#${NUM}`) && kicker.includes("2/4"), kicker);
  const warnClass = await page.locator(".ghp-kicker-checks").getAttribute("class");
  check("有失败时 checks 不是绿的（warn 色）", (warnClass ?? "").includes("ghp-kicker-checks") && !(warnClass ?? "").includes("ok"), warnClass ?? "");

  const by = (await page.locator(".ghp-doc-by").innerText()).replace(/\s+/g, " ");
  check("署名行带作者、分支、改动量", by.includes("Yang-Code01") && by.includes("fix/ask-card-text") && by.includes("+226"), by);

  // ------------------------------------------------ 2) 描述全文，没有内层滚动
  const scroll = await page.locator(".ghp-doc").evaluate((n) => ({
    sh: n.scrollHeight,
    ch: n.clientHeight,
    ov: getComputedStyle(n).overflowY,
  }));
  check("描述不设内层滚动框", scroll.ov === "visible", scroll.ov);
  check("描述全文一屏摊开（没有截断）", scroll.sh <= scroll.ch + 2, `${scroll.sh}/${scroll.ch}`);
  check("描述走 markdown：h2 成了真元素", (await page.locator(".ghp-doc h2").count()) >= 2);
  check("描述走 markdown：行内 code 成了真元素", (await page.locator(".ghp-doc code").count()) >= 2);
  check("描述里的列表渲染成了真 li（不是一整块纯文本）", (await page.locator(".ghp-doc li").count()) >= 4);

  // ------------------------------------------------ 3) 文件清单
  check("8 个文件全在", (await page.locator(".ghp-frow").count()) === 8);
  check("560px 时文件清单两列", (await cols(page)) === 2, String(await cols(page)));
  await page.locator(".ghp").evaluate((n) => n.style.setProperty("--ghp-w", "420px"));
  await sleep(250);
  check("面板收到 420px 时降到一列", (await cols(page)) === 1, String(await cols(page)));
  await page.locator(".ghp").evaluate((n) => n.style.setProperty("--ghp-w", "560px"));
  await sleep(250);

  // ------------------------------------------------ 4) 讨论
  check("两条评论都列出来了（不是只露最后一条）", (await page.locator(".ghp-post").count()) === 2);
  check("「还有 N 条」那颗死链接没了", (await page.locator(".ghp .ghp-more").count()) === 0);
  const thread = await page.locator(".ghp-thread").innerText();
  check("两条评论的正文都在", thread.includes("先写一条 unit") && thread.includes("逐帧采样"), "");

  // ------------------------------------------------ 5) 底栏照旧
  check("合并按钮还在", (await page.locator(".ghp-merge").count()) === 1);
  check("「在 GitHub 看差异」还在", (await page.locator(".ghp .ghp-btn", { hasText: "差异" }).count()) >= 1);

  await page.locator(".ghp").screenshot({ path: path.join(SHOTS, "pr-detail-560.png") });
  await page.locator(".ghp").evaluate((n) => n.style.setProperty("--ghp-w", "400px"));
  await sleep(250);
  await page.locator(".ghp").screenshot({ path: path.join(SHOTS, "pr-detail-400.png") });
  console.log("shots:", path.join(SHOTS, "pr-detail-560.png"), path.join(SHOTS, "pr-detail-400.png"));
} catch (e) {
  failures++;
  console.log("FAIL probe threw —", String(e?.message ?? e));
  console.log(out.join("").slice(-3000));
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
}

console.log(failures ? `\n${failures} 处不成立` : "\n全部成立");
process.exit(failures ? 1 : 0);
