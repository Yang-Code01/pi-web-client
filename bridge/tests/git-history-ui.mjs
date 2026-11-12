/**
 * D235: 分支 chip 已经从「只读历史」升级成「分支操作工作台」。
 *
 * 这个测试自己起一份 bridge（临时口令 / 临时 state / fake pi），再在临时 git 仓库里开一个会话，
 * 用真实浏览器点一遍：三 tab、全部动词、cherry-pick 常驻、交给 AI 两出口、对照分支输入检索、
 * 居中操作卡、红色确认、真实写操作后 chip 刷新、结构化失败卡、冲突态只放行中止 / 继续、
 * 隧道 403、窄屏单列。
 *
 * 先 `npm run build`（bridge/dist + web/dist 都是这里的输入），再：
 *   npm run test:githist:ui
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-gitops-ui-"));
const STATE = path.join(ROOT, "state");
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const PORT = Number(process.env.GITOPS_UI_PORT ?? 7927);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "gitops-ui-pass";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok   " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`gitops-ui failed: ${name}${detail ? ` — ${detail}` : ""}`);
};
/**
 * 图解帧必须真的按 SVG 画出来。`opFrames()` 返回的字符串由 `branchsheet.ts` 里 `svgNode()`
 * 用 DOMParser 以 `image/svg+xml` 解析：`<svg>` 少了 `xmlns` 就落进**无命名空间**，于是
 * `<style>` 的文字被当正文画进卡片（满屏 `.n{fill:var(--accent)}`）、圆和线也不渲染。
 * 一把量一簇帧：命名空间、CSS 文本有没有漏成可见文字、形状有没有真占面积。
 */
const framesState = (page, sel, boxSel) =>
  page.evaluate(([s, b]) => {
    const svgs = [...document.querySelectorAll(s)];
    return {
      total: svgs.length,
      badNs: svgs.filter((svg) => svg.namespaceURI !== "http://www.w3.org/2000/svg").length,
      leaked: /fill:var\(/.test(document.querySelector(b)?.innerText ?? ""),
      tiny: svgs.filter((svg) => {
        const shape = svg.querySelector("rect, circle");
        return !shape || Math.round(shape.getBoundingClientRect().width) <= 1;
      }).length,
    };
  }, [sel, boxSel]);

/** 所有 git 调用固定身份与时间，免得依赖跑这台机器的 ~/.gitconfig。 */
const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "core.fsmonitor=false", "-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8" },
  ).trim();

const put = (cwd, file, text) => {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `ui: ${file}`);
};

// 会话的 cwd 必须是真仓库：有 origin/main、两条以上提交、且 main 与 feat/x 改了同一个文件（后面造冲突）。
const bare = path.join(ROOT, "origin.git");
const dir = path.join(ROOT, "work");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { encoding: "utf8" });
execFileSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
git(dir, "remote", "add", "origin", bare);
put(dir, "a.txt", "one");
put(dir, "b.txt", "two");
git(dir, "push", "-q", "-u", "origin", "main");
git(dir, "remote", "set-head", "origin", "-a");
git(dir, "checkout", "-q", "-b", "feat/x");
put(dir, "a.txt", "from-feat");
git(dir, "checkout", "-q", "main");
put(dir, "a.txt", "from-main");
git(dir, "checkout", "-q", "feat/x");
check("测试仓库干净且有远程对照", git(dir, "status", "--porcelain") === "" && Boolean(git(dir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main")));
// 分支多的时候右栏要能滚动，不能被 flex 压扁（实测 122 个分支时行高从 24px 掉到 10px，文字只剩中间一条）。
for (let i = 0; i < 40; i += 1) git(dir, "branch", `bulk/${i}`);

fs.mkdirSync(STATE, { recursive: true });
const env = {
  ...process.env,
  PI_WEB_STATE: STATE,
  PI_AGENT_DIR: path.join(ROOT, "agent"),
  PI_WEB_PORT: String(PORT),
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_TUNNEL: "0",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_BIN: FAKE_PI,
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (chunk) => (bridgeLog += chunk.toString()));
bridge.stderr.on("data", (chunk) => (bridgeLog += chunk.toString()));
let browser;
let socket;

try {
  let healthy = false;
  for (let i = 0; i < 100; i += 1) {
    try { healthy = (await fetch(`${BASE}/healthz`)).ok; if (healthy) break; } catch { /* starting */ }
    await sleep(200);
  }
  check("自建 bridge 起来了", healthy);

  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  check("登录成功", login.ok, `HTTP ${login.status}`);
  const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");
  const cookie = `${cookieName}=${cookieValue}`;

  socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const frames = [];
  socket.on("message", (chunk) => frames.push(JSON.parse(chunk.toString())));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "create", cwd: dir, name: "gitops-ui" }));
  let sessionId = null;
  for (let i = 0; i < 100 && !sessionId; i += 1) {
    sessionId = frames.find((f) => f.type === "session" && f.state?.id)?.state.id ?? null;
    if (!sessionId) await sleep(100);
  }
  check("临时仓库上的会话建好了", Boolean(sessionId));

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/#/s/${sessionId}`);
  await page.waitForSelector(".app", { timeout: 20000 });
  await page.waitForSelector(".git-chip", { timeout: 20000 });
  check("状态行显示分支 chip", (await page.textContent(".git-chip .git-branch"))?.includes("feat/x") === true);

  await page.click(".git-chip");
  await page.waitForSelector(".branch-sheet.go-sheet", { timeout: 20000 });
  await page.waitForSelector(".go-tabs [data-tab]", { timeout: 20000 });
  await page.waitForSelector(".bc-row", { timeout: 20000 });
  check("弹窗标题是操作工作台", (await page.textContent(".branch-title"))?.includes("分支操作工作台") === true);
  check("三 tab", await page.locator(".go-tabs [data-tab]").count() === 3);
  for (const id of ["history", "diff", "manual"]) {
    check(`tab ${id} 存在`, await page.locator(`.go-tabs [data-tab="${id}"]`).count() === 1);
  }
  await page.waitForSelector(".go-branch-side [data-group]", { timeout: 20000 });
  const groups = await page.evaluate(() => {
    const heads = [...document.querySelectorAll(".go-branch-side [data-group]")];
    return {
      names: heads.map((n) => n.dataset.group),
      expanded: heads.map((n) => n.getAttribute("aria-expanded")),
      rows: document.querySelectorAll(".go-branch-side .go-branch-row").length,
    };
  });
  check("右栏两组都在（本地 + 远程）", groups.names.join() === "本地,远程");
  check("右栏两组首次全部折叠", groups.rows === 0 && groups.expanded.every((v) => v === "false"));
  await page.click('.go-branch-side [data-group="本地"]');
  await page.waitForSelector(".go-branch-side .go-branch-row", { timeout: 20000 });
  const rowBox = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".go-branch-side .go-branch-row")];
    const heights = rows.map((n) => Math.round(n.getBoundingClientRect().height));
    return { count: heights.length, min: Math.min(...heights), names: rows.slice(0, 4).map((n) => n.textContent) };
  });
  // 行里有 overflow:hidden，flex 的自动最小尺寸是 0；子项不认 flex:none 时会一起压成几像素，文字只剩中间一条。
  check(`右栏 ${rowBox.count} 个分支行没被 flex 压扁`, rowBox.count > 30 && rowBox.min >= 18);
  check("右栏分支行文字完整", rowBox.names.every((t) => /^●? ?[\w./-]+$/.test(t)));
  check("展开只影响本地组", (await page.locator('.go-branch-side [data-group="远程"]').getAttribute("aria-expanded")) === "false");
  check("折叠状态记进 localStorage", /"本地":false/.test((await page.evaluate(() => localStorage.getItem("pi.goGroupsFolded"))) ?? ""));
  await page.click('.go-branch-side [data-group="本地"]');
  await page.waitForSelector(".go-branch-side .go-branch-row", { state: "detached", timeout: 20000 });
  check("再点一次收起", await page.locator(".go-branch-side .go-branch-row").count() === 0);
  await page.click('.go-branch-side [data-group="本地"]');
  await page.waitForSelector(".go-branch-side .go-branch-row", { timeout: 20000 });
  check("stamp 不再谎称只读", /操作后会刷新/.test(await page.textContent(".branch-stamp") ?? ""));
  check("↑↓ 计数还在", await page.locator(".bc-pill").count() === 2);
  check("cherry-pick 常驻标题栏（m00401 反馈 1）", await page.locator('.go-tool-row [data-op="cherry_pick"]').count() === 1);
  for (const id of ["revert", "tag", "switch", "merge"]) {
    check(`快捷入口 ${id}`, await page.locator(`.go-tool-row [data-op="${id}"]`).count() === 1);
  }

  // 全部动词：24 个一个不少，红色组也列得出来。
  await page.click(".go-tool-row [data-verbs='1']");
  await page.waitForSelector(".go-verbs-grid [data-op]");
  check("全部动词 · 24", await page.locator(".go-verbs-grid [data-op]").count() === 24);
  for (const id of ["cherry_pick", "revert", "tag", "stash", "rebase", "reset_hard", "restore", "abort", "continue"]) {
    check(`动词表里有 ${id}`, await page.locator(`.go-verbs-grid [data-op="${id}"]`).count() === 1);
  }
  check("红色动词分组可见", await page.locator(".go-verbs-grid .go-verb.red").count() === 8);
  await page.click(".go-verbs [data-cancel='1']");

  // 交给 AI：选分支 + 写要求 → 实时预览 → 只预填到当前会话，不自动发送。
  await page.click(".go-tool-row [data-ai='1']");
  await page.waitForSelector(".go-ai-card .go-textarea");
  check("AI 入口有分支下拉", await page.locator(".go-ai-card select.go-select").count() === 1);
  check("AI 入口有两个出口", await page.locator(".go-ai-card [data-ai-go]").count() === 2);
  await page.fill(".go-ai-card .go-textarea", "先别动 git，告诉我该不该合并 main");
  const preview = await page.textContent(".go-ai-card pre");
  check("提示词含用户要求", preview?.includes("先别动 git，告诉我该不该合并 main") === true);
  check("提示词打包了仓库与分支", preview?.includes("仓库：") === true && preview?.includes("选中的分支：") === true);
  await page.click(".go-ai-card [data-ai-go='current']");
  await page.waitForSelector(".composer-input textarea");
  const filled = await page.inputValue(".composer-input textarea");
  check("提示词预填进输入框", filled.includes("先别动 git，告诉我该不该合并 main"));
  check("没有自动发送（提示词还在输入框里）", filled.length > 40);
  check("给了「已放进输入框」回执", /已放进输入框/.test(await page.textContent(".branch-hint") ?? ""));

  // 对照分支：关键词检索 + 直接输入任意 ref（HEAD~1）+ 回车生效。
  await page.fill(".go-cmp-input", "main");
  await page.waitForSelector(".go-cmp-menu:not([hidden]) [data-cmp-pick]");
  check("检索出 origin/main", await page.locator('.go-cmp-menu [data-cmp-pick="origin/main"]').count() === 1);
  check("检索有「用输入的 ref 对照」", await page.locator(".go-cmp-menu [data-cmp-use='1']").count() === 1);
  await page.fill(".go-cmp-input", "HEAD~1");
  await page.press(".go-cmp-input", "Enter");
  await page.waitForFunction(() => {
    const el = document.querySelector(".go-cmp-input");
    return el instanceof HTMLInputElement && el.value === "HEAD~1";
  }, null, { timeout: 20000 });
  await page.waitForSelector(".bc-row", { timeout: 20000 });
  check("任意 ref 对照没被吞掉", await page.inputValue(".go-cmp-input") === "HEAD~1");
  check("任意 ref 对照没进错误态", !/读取失败/.test(await page.textContent(".branch-stamp") ?? ""));
  await page.fill(".go-cmp-input", "origin/main");
  await page.press(".go-cmp-input", "Enter");
  await page.waitForFunction(() => {
    const el = document.querySelector(".go-cmp-input");
    return el instanceof HTMLInputElement && el.value === "origin/main";
  }, null, { timeout: 20000 });

  // 差异 tab：文件列表 + 并排文本行。
  await page.click('.go-tabs [data-tab="diff"]');
  await page.waitForSelector(".go-diff-files [data-file]", { timeout: 20000 });
  check("差异列出变更文件", await page.locator(".go-diff-files [data-file]").count() >= 1);
  await page.click('.go-diff-files [data-file="0"]');
  await page.waitForSelector(".go-codegrid .go-code", { timeout: 20000 });
  check("并排 diff 有行", await page.locator(".go-codegrid .go-code").count() >= 2);
  check("差异文件栏标注当前对照", /origin\/main/.test(await page.textContent(".go-diff-files") ?? ""));

  // 图解手册：24 张卡、红色筛选 8 张、每卡有前后两帧 SVG。
  await page.click('.go-tabs [data-tab="manual"]');
  await page.waitForSelector(".go-manual-grid .go-mcard", { timeout: 20000 });
  check("手册列全 24 个动词", await page.locator(".go-manual-grid .go-mcard").count() === 24);
  check("每张卡有两帧图解", await page.locator(".go-manual-grid .go-mcard").first().locator(".go-ill-cell svg").count() === 2);
  const ill = await framesState(page, ".go-manual-grid .go-mcard .go-ill-cell svg", ".go-manual-grid");
  // 24 张卡 × 2 帧；三种图形（文件/丢弃/分支）都要走到，所以整簇量一遍，不只量第一张。
  check("手册 24 张卡共 48 帧", ill.total === 48, `total=${ill.total}`);
  check("图解帧都在 SVG 命名空间里", ill.badNs === 0, JSON.stringify(ill));
  check("图解帧没把 CSS 文本画成字", ill.leaked === false);
  check("图解帧的图形真有尺寸", ill.tiny === 0, `tiny=${ill.tiny}`);
  await page.locator(".go-filters button").nth(1).click();
  check("只看红色筛出 8 个", await page.locator(".go-manual-grid .go-mcard.red").count() === 8);
  await page.locator(".go-filters button").first().click();
  await page.waitForSelector('.go-manual-grid [data-op="cherry_pick"]', { timeout: 20000 });

  // 普通操作卡：cherry-pick 有字段、命令预览、两帧图解。
  await page.click('.go-manual-grid [data-op="cherry_pick"]');
  await page.waitForSelector('[data-op-card="cherry_pick"]');
  check("cherry-pick 卡居中打开", await page.locator('.go-op-layer:not([hidden]) [data-op-card="cherry_pick"]').count() === 1);
  check("cherry-pick 卡有哈希字段", await page.locator('[data-op-card="cherry_pick"] [data-field="hashes"]').count() === 1);
  check("cherry-pick 卡有命令预览", /cherry-pick/.test(await page.textContent('[data-op-card="cherry_pick"] pre') ?? ""));
  check("操作卡有两帧图解", await page.locator('[data-op-card="cherry_pick"] .go-frame svg').count() === 2);
  const cardFrame = await framesState(page, '[data-op-card="cherry_pick"] .go-frame svg', '[data-op-card="cherry_pick"] .go-frame');
  check("操作卡图解也按 SVG 渲染", cardFrame.total === 2 && cardFrame.badNs === 0 && !cardFrame.leaked && cardFrame.tiny === 0, JSON.stringify(cardFrame));
  await page.click('[data-op-card="cherry_pick"] [data-cancel="1"]');

  // 红色动作：先出确认卡（丢失清单 + 回退命令），不点执行。
  await page.click('.go-manual-grid [data-op="reset_hard"]');
  await page.waitForSelector('[data-op-card="reset_hard"]');
  check("红色按钮写「查看确认卡」", (await page.textContent('[data-op-card="reset_hard"] [data-run="1"]'))?.includes("查看确认卡") === true);
  await page.click('[data-op-card="reset_hard"] [data-run="1"]');
  await page.waitForSelector('[data-confirm="reset_hard"]');
  check("红色确认卡列出会丢什么", await page.locator('[data-confirm="reset_hard"] .go-lose li').count() >= 1);
  check("红色确认卡给可复制回退命令", /git reset --hard ORIG_HEAD/.test(await page.textContent('[data-confirm="reset_hard"] pre') ?? ""));
  check("真执行按钮是 data-force", await page.locator('[data-confirm="reset_hard"] [data-force="1"]').count() === 1);
  await page.click('[data-confirm="reset_hard"] [data-cancel="1"]');

  // 真实写操作：新建并切到 feat/ui-test，成功后状态行 chip 跟着刷新。
  await page.click('.go-tool-row [data-op="switch"]');
  await page.waitForSelector('[data-op-card="switch"]');
  await page.fill('[data-op-card="switch"] [data-field="branch"]', "feat/ui-test");
  await page.check('[data-op-card="switch"] [data-switch="create"]');
  await page.click('[data-op-card="switch"] [data-run="1"]');
  await page.waitForSelector(".go-result-card.ok", { timeout: 20000 });
  check("写操作给成功卡", /执行成功/.test(await page.textContent(".go-result-card.ok") ?? ""));
  await page.waitForFunction(() => {
    const el = document.querySelector(".git-chip .git-branch");
    return el?.textContent?.includes("feat/ui-test") === true;
  }, null, { timeout: 20000 });
  check("chip 刷新到新分支", (await page.textContent(".git-chip .git-branch"))?.includes("feat/ui-test") === true);
  await page.keyboard.press("Escape"); // 收起结果卡

  // 结构化失败卡：干净仓库上 commit 必然失败，卡里要有 exit / argv / handoff。
  await page.click('.go-tool-row [data-op="commit"]');
  await page.waitForSelector('[data-op-card="commit"]');
  await page.fill('[data-op-card="commit"] [data-field="message"]', "nothing staged");
  await page.click('[data-op-card="commit"] [data-run="1"]');
  await page.waitForSelector(".go-result-card.bad", { timeout: 20000 });
  check("失败卡写 exit 码", /执行失败 · exit/.test(await page.textContent(".go-result-card.bad") ?? ""));
  check("失败卡列出已执行命令", /\$ git .*/.test(await page.textContent(".go-result-card.bad") ?? ""));
  check("失败卡有交给 agent", await page.locator('.go-result-card.bad [data-agent="result"]').count() === 1);
  await page.keyboard.press("Escape");

  // 冲突态：merge main 撞 a.txt → 只放行中止 / 继续、逐文件勾完才让继续。
  await page.click('.go-tool-row [data-op="merge"]');
  await page.waitForSelector('[data-op-card="merge"]');
  await page.fill('[data-op-card="merge"] [data-field="branch"]', "main");
  await page.click('[data-op-card="merge"] [data-run="1"]');
  await page.waitForSelector(".go-result-card.warn", { timeout: 20000 });
  check("冲突结果卡", /仓库停在冲突状态/.test(await page.textContent(".go-result-card.warn") ?? ""));
  check("冲突卡列冲突文件", await page.locator(".go-conflict-row").count() >= 1);
  check("冲突卡的中止按钮", await page.locator('.go-result-card.warn [data-op="abort"]').count() === 1);
  check("冲突卡的继续按钮", await page.locator('.go-result-card.warn [data-op="continue"]').count() === 1);
  // 继续按钮直接打开逐文件标记卡，别先按 Esc（那会把结果卡连同状态一起收掉）。
  await page.click('.go-result-card.warn [data-op="continue"]');
  await page.waitForSelector(".go-conflict [data-continue='1']", { timeout: 20000 });
  check("逐文件勾完才能继续", await page.locator('.go-conflict [data-continue="1"]').isDisabled());
  await page.check('.go-conflict [data-conflict="a.txt"]');
  check("勾完一个冲突文件后放行", !(await page.locator('.go-conflict [data-continue="1"]').isDisabled()));
  await page.click('.go-conflict [data-cancel="1"]');
  await page.click('.go-tool-row [data-op="commit"]');
  check("冲突态拒绝普通动词", /仓库停在冲突状态/.test(await page.textContent(".branch-hint") ?? ""));
  // 用 HTTP 收口冲突，避免把测试仓库留在 merge 态。
  const abort = await fetch(`${BASE}/api/git/op`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ dir, id: "abort", params: {} }),
  });
  check("冲突已收口", (await abort.json()).ok === true);
  // 关掉并重新打开弹窗，让 UI 重新读到「没有 pending」的状态。
  await page.keyboard.press("Escape");
  await page.waitForSelector(".branch-sheet.go-sheet", { state: "detached", timeout: 20000 });
  await page.click(".git-chip");
  await page.waitForSelector(".bc-row", { timeout: 20000 });

  // 双闸：隧道头即使来自回环，写操作也必须 403。
  const tunnel = await fetch(`${BASE}/api/git/op`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-forwarded-proto": "https" },
    body: JSON.stringify({ dir, id: "tag", params: { name: "should-not-exist" } }),
  });
  const tunnelBody = await tunnel.json();
  check("隧道写操作 403", tunnel.status === 403, `HTTP ${tunnel.status}`);
  check("隧道写操作码 op_public", tunnelBody.code === "op_public", JSON.stringify(tunnelBody));
  const local = await fetch(`${BASE}/api/git/state`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ dir }),
  });
  check("本机回环读仓库状态 200", local.ok && (await local.json()).repo !== undefined);

  // Esc 逐层收起：先操作卡，再整个弹窗。
  await page.click('.go-tool-row [data-op="fetch"]');
  await page.waitForSelector('[data-op-card="fetch"]');
  await page.keyboard.press("Escape");
  check("Esc 先收起操作卡", await page.locator(".go-op-layer:not([hidden])").count() === 0);
  await page.keyboard.press("Escape");
  check("再按 Esc 关掉弹窗", await page.locator(".branch-sheet.go-sheet").count() === 0);

  // 窄屏：历史两列退化成单列 tab。
  const narrow = await browser.newContext({ viewport: { width: 430, height: 860 }, locale: "zh-CN" });
  await narrow.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const small = await narrow.newPage();
  await small.goto(`${BASE}/#/s/${sessionId}`);
  await small.waitForSelector(".git-chip", { timeout: 20000 });
  await small.click(".git-chip");
  await small.waitForSelector(".bc-row", { timeout: 20000 });
  check("窄屏出现两列切换 tab", await small.locator(".go-side-tabs button").count() === 2);
  check("窄屏只显示一列", await small.locator(".bc-col:visible").count() === 1);
  await narrow.close();

  console.log("gitops-ui: ok — 三 tab / 24 动词 / AI 两出口 / 对照检索 / 操作卡 / 红色确认 / chip 刷新 / 失败卡 / 冲突态 / 隧道 403 / 窄屏");
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { if (socket?.readyState === WebSocket.OPEN) socket.close(); } catch { /* ignore */ }
  bridge.kill();
  await sleep(150);
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (bridgeLog.includes("Error:")) console.error(bridgeLog.slice(-3000));
}
