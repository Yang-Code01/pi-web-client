/**
 * Probe：#666 —— 链接卡右缘那颗「代码评审」，以及「建完 PR 默认不再自动开面板」。
 *
 * 真桥 + 假 gh（桥里已有的 `PI_WEB_GH_JS` 缝）+ 真 Chromium。验的全是外部行为：
 *   1. 默认值：设置 → 对话 里「建完 PR 自动打开面板」是**关**的，主开关是开的；手动打开后刷新还在。
 *   2. 判据未到（`/api/github/state` 被挂住）：同仓 / 跨仓两张卡上的钮都是**亮的**（不是一屏灰）。
 *   3. 判据到了：同仓卡的钮可点；跨仓卡灰掉、title 写明两个仓库；issue 卡根本没有这颗钮。
 *   4. 点同仓卡的钮：右栏切到「代码评审」、号填好、**没开跑**、GitHub 面板关掉、右栏从折叠变展开。
 *   5. 点跨仓卡的灰钮：什么都不发生。
 *
 * 为什么不驱动 `github.pr` 那一帧：「建完 PR 自动开面板」是壳看见子进程跑 `gh pr create` 之后发的帧，
 * 假 gh 顶不出真实会话里的那一轮（要真模型）。那一条的判断逻辑只有 `githubFeature()` 一处，
 * 由 `web/tests/github-unit.mjs` 盯着；这里盯「开关的默认值与持久化」这半截，两边加起来是完整的。
 *
 * Run: npm run build && node probes/github-card-review.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const PORT = Number(process.env.PI_WEB_PORT ?? 7883);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(REPO, ".scratch", "github-card-probe");
const STATE = path.join(ROOT, "state");
const SESSIONS = path.join(ROOT, "sessions");
const WORK = path.join(ROOT, "work");
const SHOTS = path.join(REPO, ".scratch", "shots");
const SID = "zz-card-review";
/** 会话仓库是 acme/widgets；会话里出现的三种卡：同仓 PR / 跨仓 PR / 同仓 issue。 */
const SAME = "https://github.com/acme/widgets/pull/661";
const FOREIGN = "https://github.com/acme/other/pull/12";
const ISSUE = "https://github.com/acme/widgets/issues/7";

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
// 远端地址决定「本会话仓库」：桥按 origin 认（与评审面板的 PR 列表同一个口径）。
git("remote", "add", "origin", "git@github.com:acme/widgets.git");
fs.writeFileSync(path.join(WORK, "a.txt"), "hello\n");
git("add", "-A");
git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init");

const sessionDir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(sessionDir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: `看看这个 ${SAME}` }] } },
  {
    type: "message",
    id: "m2",
    parentId: "m1",
    timestamp: at,
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `顺手提一下别仓的那个 ${FOREIGN}，还有一个老 issue ${ISSUE}。`,
        },
      ],
    },
  },
  {
    type: "message",
    id: "m3",
    parentId: "m2",
    timestamp: at,
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          // 真实会话里的写法：全角冒号 + 加粗的号，**没有链接**（热部署那次就是这种）。
          text: "4 条都核实成立，已修完并开了 PR：**#669**（`fix/review-followup` → `main`）。",
        },
      ],
    },
  },
  {
    type: "message",
    id: "m4",
    parentId: "m3",
    timestamp: at,
    message: {
      role: "assistant",
      // 号写了但根本不是 PR：猜出来的那张卡必须自己撤掉（留着等于把 issue 报成 PR）。
      content: [{ type: "text", text: "早先还提过 PR：#424242，后来关了。" }],
    },
  },
  { type: "session_info", id: "n1", parentId: "m4", timestamp: at, name: "card review probe" },
];
fs.writeFileSync(path.join(sessionDir, `${SID}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

const fakeGh = path.join(REPO, "bridge", "tests", "fixtures", "fake-gh.mjs");
const GH_STATE = path.join(ROOT, "gh-state.json");

// ---------------------------------------------------------------- 桥

const out = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    // 刚起的实例会弹「更新日志」，它会盖住页面、把点击吃掉（探针里没有真人去关它）。
    PI_WEB_WHATS_NEW: "0",
    // 只从 fixture 目录列会话；不碰用户真的会话目录。
    PI_CODING_AGENT_SESSION_DIR: SESSIONS,
    // 假 gh：这一条不发网络请求，也不会去动本机真的登录态。
    PI_WEB_GH_JS: fakeGh,
    FAKE_GH_STATE: GH_STATE,
    FAKE_GH_ACCOUNTS: JSON.stringify([{ login: "acme", active: true }]),
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

let browser = null;

/** 卡片上的号在 `.ghlink-num` 里，文字搜索按它走（标题是异步填的，不能当锚点）。 */
const cardWith = (page, num) => page.locator(".ghcard", { hasText: num });
const anyCard = (page, num) => page.locator(".ghlink", { hasText: num });

/** 两个仓库名都写进 title 才说明「为什么灰」对人有意义。 */
const reviewTitleOk = (title) => title.includes("acme/other") && title.includes("acme/widgets");

try {
  const cookie = await login();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));

  // 标题那一行由 `/api/github/card` 填。真打 GitHub 会让这条探针依赖网络与一个不存在的仓库，
  // 所以直接给一行固定的：这层不在本探针要验的行为里。
  await page.route("**/api/github/card*", (route) => {
    const url = new URL(route.request().url());
    const number = Number(url.searchParams.get("number")) || 0;
    route.fulfill({
      contentType: "application/json",
      // 桥对「这个号不是 PR」的回答就是 pull: null（不是 404），正文里猜出来的卡按它撤。
      body: JSON.stringify({
        ok: true,
        pull:
          number === 424242
            ? null
            : {
                number,
                title: number === 661 ? "链接卡上加一颗「代码评审」" : number === 669 ? "只写号的转述也要出卡" : "别仓的一个 PR",
                draft: false,
                author: "acme",
                head: "feat/x",
                base: "main",
                updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
                url: "",
                additions: 105,
                deletions: 21,
                changedFiles: 5,
              },
      }),
    });
  });

  // ------------------------------------------------ 1) 判据未到：钮是亮的
  await page.route("**/api/github/state*", () => {
    /* 永远不回：模拟「会话仓库还没问回来」 */
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 30000, "session card");
  await page.locator(".session-card").first().click();
  await cardWith(page, "#661").waitFor({ timeout: 20000 });
  const sameUnknown = cardWith(page, "#661").locator(".ghlink-review");
  const foreignUnknown = cardWith(page, "#12").locator(".ghlink-review");
  check("判据未到时同仓卡的钮是亮的", !(await sameUnknown.isDisabled()), "");
  check("判据未到时跨仓卡的钮也是亮的（不是一屏灰）", !(await foreignUnknown.isDisabled()), "");

  // ------------------------------------------------ 2) 判据到了：跨仓灰、issue 没钮
  await page.unroute("**/api/github/state*");
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 30000, "session card (reload)");
  await page.locator(".session-card").first().click();
  await cardWith(page, "#661").waitFor({ timeout: 20000 });
  const sameBtn = cardWith(page, "#661").locator(".ghlink-review");
  const foreignBtn = cardWith(page, "#12").locator(".ghlink-review");
  await until(async () => (await foreignBtn.isDisabled()) === true, 15000, "cross-repo button greyed");
  check("同仓卡的钮可点", !(await sameBtn.isDisabled()), "");
  check("跨仓卡的钮灰掉", await foreignBtn.isDisabled(), "");
  const foreignTitle = await foreignBtn.getAttribute("title");
  check("灰掉时写明为什么（两个仓库都在 title 里）", reviewTitleOk(foreignTitle ?? ""), foreignTitle ?? "");
  const issueCard = anyCard(page, "#7");
  check("issue 卡不画这颗钮", (await issueCard.locator(".ghlink-review").count()) === 0, "");
  check("issue 卡也不是 .ghcard（没有被拆成两块）", (await issueCard.evaluate((el) => el.closest(".ghcard") === null)) === true, "");

  // ------------------------------------------------ 2b) 正文里只写号的 PR 也出卡
  const guessCard = page.locator(".ghlink", { hasText: "#669" }).first();
  await guessCard.waitFor({ timeout: 20000 });
  check("正文里只写了「PR：**#669**」也出卡", (await page.locator(".ghlink", { hasText: "#669" }).count()) === 1, "");
  // 仓库与标题都是判据 / 桥的答复回来之后才补的，得等它们落地再断言（取到标题会把仓库名换掉）。
  await until(
    async () => ((await guessCard.locator(".ghlink-title").textContent()) ?? "").includes("只写号"),
    15000,
    "guess card title",
  ).catch(() => {});
  const guessTitle = (await guessCard.locator(".ghlink-title").textContent()) ?? "";
  check("猜出来的卡补上了本会话仓库、真取到了标题", guessTitle.includes("只写号"), guessTitle);
  check("猜出来的卡也是同仓，评审钮可点", (await page.locator(".ghcard", { hasText: "#669" }).locator(".ghlink-review").isDisabled()) === false, "");
  await sleep(800);
  check("号对不上真 PR 的那张自己撤掉了（不留「取不到标题」的破卡）", (await page.locator(".ghlink", { hasText: "#424242" }).count()) === 0, "");

  // ------------------------------------------------ 3) 主区照旧开 GitHub 面板
  await page.locator(".ghp").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  check("点之前 GitHub 面板没开着", (await page.locator(".ghp").count()) === 0, "");
  await cardWith(page, "#661").locator(".ghlink").click();
  await page.locator(".ghp").waitFor({ timeout: 15000 });
  check("点卡片主区仍然开 GitHub 面板", (await page.locator(".ghp").count()) === 1, "");
  // 面板是贴在视口右缘的 dock，开着的时候正好盖住卡片右缘那颗钮（真人点不到）。
  // 所以这里用面板自己的 ✕ 关，而不是靠点那颗钮 —— 「点钮顺手关面板」那行是防御性的，这段验不到。
  await page.locator(".ghp .ghp-close").click();
  await page.locator(".ghp").waitFor({ state: "detached", timeout: 8000 });
  check("面板自己的 ✕ 能关（为了继续验下一件事）", (await page.locator(".ghp").count()) === 0, "");

  // ------------------------------------------------ 4) 折叠右栏，再点「代码评审」
  await page.locator('.topbar [data-act="queue"]').click();
  await until(async () => (await page.locator(".main.no-right").count()) === 1, 8000, "right pane collapsed");
  check("右栏可以折叠（为了验下一件事）", true, "");

  await sameBtn.click();
  check("点「代码评审」时没有东西挡着（GitHub 面板是关的）", (await page.locator(".ghp").count()) === 0, "");
  await until(async () => (await page.locator(".main.no-right").count()) === 0, 8000, "right pane expanded");
  check("右栏从折叠变展开", (await page.locator(".main.no-right").count()) === 0, "");
  const tab = page.locator('.exec-tabs button[data-exec-tab="review"]');
  await tab.waitFor({ timeout: 8000 });
  check("右栏切到「代码评审」页签", (await tab.getAttribute("aria-selected")) === "true", "");
  const prInput = page.locator(".rv-prq").first();
  await prInput.waitFor({ timeout: 8000 });
  check("PR 号已经填好", (await prInput.inputValue()) === "#661", await prInput.inputValue());
  check("没有自动开跑（面板上没有「中断评审」）", (await page.locator(".rv-stop").count()) === 0, "");
  // 界面上「没开跑」还要有磁盘上的证据：真的开跑会先落一份 running 状态。
  const reviewDir = path.join(STATE, "review");
  const runs = fs.existsSync(reviewDir) ? fs.readdirSync(reviewDir) : [];
  check("桥上没收到 review.run（状态目录里没有评审记录）", runs.length === 0, runs.join(","));
  await page.screenshot({ path: path.join(SHOTS, "github-card-review.png") }).catch(() => {});

  // ------------------------------------------------ 5) 灰钮点不动
  const before = await tab.getAttribute("aria-selected");
  await foreignBtn.evaluate((el) => el.click());
  await sleep(300);
  check("点灰钮什么都不发生", (await tab.getAttribute("aria-selected")) === before && (await page.locator(".ghp").count()) === 0, "");

  // ------------------------------------------------ 6) 设置里的默认值与持久化
  const openSettings = async () => {
    await page.locator(".set-btn").click();
    const nav = page.locator('.st-nav__item[data-sec="chat"]');
    await nav.waitFor({ timeout: 10000 });
    await nav.click();
  };
  const autoRow = () => page.locator(".settings-row", { hasText: "建完 PR 自动打开面板" }).locator("input[type=checkbox]");
  const cardsRow = () => page.locator(".settings-row", { hasText: "GitHub 链接变卡片" }).locator("input[type=checkbox]");

  await openSettings();
  await autoRow().waitFor({ timeout: 8000 });
  check("默认：主开关（链接变卡片）是开的", await cardsRow().isChecked(), "");
  check("默认：建完 PR 自动打开面板是关的", (await autoRow().isChecked()) === false, "");
  await autoRow().click();
  check("点一下就开（开关不是摆设）", await autoRow().isChecked(), "");
  await page.locator('.st-head__actions button:has-text("关闭")').click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 30000, "session card (after reload)");
  await page.locator(".session-card").first().click();
  await openSettings();
  await autoRow().waitFor({ timeout: 8000 });
  check("打开之后刷新还在（存进了 pi.prefs）", await autoRow().isChecked(), "");

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
