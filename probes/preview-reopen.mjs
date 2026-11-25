/**
 * Probe: 同一份文件被「打开」两次时只画一次（D388）。
 *
 * 复现的是 2026-11-22 那次：问卷里点「在预览里打开」，预览开了；模型拿到答案后照交付提示词
 * 又调一次 `open_preview`（同路径），面板整个重建 —— 画面闪一下。
 *
 * 现在同路径打开是幂等的：
 *   1. 问卷点开的 html 还在，模型再投一次同路径（内容没变）→ iframe 不重建、不出 loading、body 不清空；
 *   2. 文件真改过之后再投 → 确实重载（新 token，新 src），不拿旧内容糊弄；
 *   3. 重载之后再看同一份 → 又回到不重画；
 *   4. xlsx：第二次投递不销毁 / 不重开表格浮窗（同一个 `section.sd` 节点）。
 *
 * 自带丢弃式 bridge + 脚本化 pi（同 ask-preview.mjs），不花模型 turn、不碰 7864。
 *
 *   npm run build && node probes/preview-reopen.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { WebSocket } from "ws";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";
import { freePort } from "../tools/free-port.mjs";
import { makeFixtures } from "../bridge/tests/fixtures/make-xlsx.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.PREVIEW_REOPEN_PORT ?? (await freePort()));
const ROOT = path.join(REPO, ".scratch", "preview-reopen");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "preview-reopen-pass";
const NAME = "variant.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, WORK]) fs.mkdirSync(d, { recursive: true });
const DOC = path.join(WORK, NAME);
fs.writeFileSync(DOC, `<!doctype html><meta charset=utf-8><title>${NAME}</title><h1>variant</h1>\n`, "utf8");
const SHEET = makeFixtures(WORK).plain;

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  FAKE_PI_LOG: PI_LOG,
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

const piLog = () =>
  fs.existsSync(PI_LOG) ? fs.readFileSync(PI_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const spawnLine = (sid) => piLog().find((l) => l.t === "argv" && (l.argv ?? []).includes(sid) && l.loopback);

let browser = null;
let ws = null;
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

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
  const seen = [];
  ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "create", cwd: WORK, name: "preview-reopen" }));
  let sid = null;
  for (let i = 0; i < 300 && !sid; i++) {
    sid = seen.find((m) => m.type === "session" && m.state?.id)?.state.id ?? null;
    if (!sid) await sleep(100);
  }
  if (!sid) throw new Error(`no session:\n${bridgeOut.join("").slice(-2000)}`);
  for (let i = 0; i < 100 && !spawnLine(sid); i++) await sleep(100);
  const token = spawnLine(sid)?.loopbackToken;
  if (!token) throw new Error("no loopback credential");

  /** 与 open_preview 工具走同一条回环入口：桥 → ws preview.open → 页面 answerPreviewOpen → openPreview。 */
  const openTool = (p) =>
    fetch(`${BASE}/api/preview/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, path: p }),
    }).then((r) => r.json());

  browser = await chromium.launch({ headless: !process.env.PW_HEADFUL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(`${BASE}/#/s/${sid}`, { waitUntil: "networkidle" });
  await page.locator("textarea").first().waitFor({ timeout: 15000 });
  // 首次打开会弹「更新内容」，不关掉会挡住问卷选项的点击。
  if (await page.locator(".whatsnew-back").count()) {
    await page.keyboard.press("Escape");
    await page.locator(".whatsnew-back").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  }

  // ---------------------------------------------------------------- 1. 问卷点开 html
  const asked = fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token,
      tool: "ask_user_question",
      questions: [
        {
          label: "打开",
          prompt: `原型文件 ${DOC.replace(/\\/g, "/")} 已写好，要在预览里打开吗？`,
          options: [{ label: "在预览里打开（推荐）", description: "在右侧预览面板里看它。" }, { label: "先不看", description: "只保留路径。" }],
          allowOther: false,
        },
      ],
    }),
  }).then((r) => r.json());
  asked.catch(() => {});

  const panel = page.locator(".ask-slot").first();
  await panel.waitFor({ timeout: 15000 });
  await panel.locator(".ask-opt", { hasText: "在预览里打开" }).click();
  await page.waitForFunction(() => Boolean(document.querySelector(".viewer iframe.viewer-frame")), null, { timeout: 10000 });
  const firstSrc = await page.evaluate(() => document.querySelector(".viewer iframe.viewer-frame")?.getAttribute("src") ?? "");
  check("第一次打开：iframe 在位", Boolean(firstSrc), firstSrc);
  await sleep(500);

  // 从这里开始记录 DOM 的变化：iframe 被摘 / 出 loading / body 被清空 / 整个 viewer 被摘。
  const armFlash = () =>
    page.evaluate(() => {
      const w = window;
      w.__flash = { iframeRemoved: 0, loading: 0, viewerRemoved: 0, bodyCleared: 0 };
      const isFrame = (n) => n instanceof HTMLElement && n.matches?.("iframe.viewer-frame");
      const isLoad = (n) => n instanceof HTMLElement && [...n.classList ?? []].some((c) => c === "viewer-loading" || c === "viewer-msg");
      if (!w.__mo) {
        w.__mo = new MutationObserver((muts) => {
          for (const m of muts) {
            if ([...m.removedNodes].some(isFrame)) w.__flash.iframeRemoved++;
            if ([...m.addedNodes].some(isLoad)) w.__flash.loading++;
            if (m.removedNodes.length && !m.addedNodes.length) w.__flash.bodyCleared++;
            w.__flash.viewerRemoved += [...m.removedNodes].filter((n) => n instanceof HTMLElement && n.matches?.(".viewer")).length;
          }
        });
        const body = document.querySelector(".viewer-body");
        if (body) w.__mo.observe(body, { childList: true, subtree: true });
      }
      w.__srcBefore = document.querySelector(".viewer iframe.viewer-frame")?.getAttribute("src") ?? "";
    });
  const flash = () => page.evaluate(() => window.__flash);
  const noRepaint = (f) => f.iframeRemoved === 0 && f.loading === 0 && f.bodyCleared === 0 && f.viewerRemoved === 0;

  // ---------------------------------------------------------------- 2. 同路径再投一次（内容没变）
  await armFlash();
  const reopen = await openTool(DOC);
  check("第二次 open_preview：桥的回执 ok", reopen.ok === true, JSON.stringify(reopen));
  await sleep(1500);
  const f2 = await flash();
  console.log("  flash (第 2 次):", JSON.stringify(f2));
  check("第二次打开（内容没变）没有重画：iframe / loading / body / viewer 都没动", noRepaint(f2));

  // ---------------------------------------------------------------- 3. 文件真改过 → 该重载
  await armFlash();
  fs.appendFileSync(DOC, "\n<p>changed</p>\n", "utf8");
  const before = await page.evaluate(() => window.__srcBefore);
  // 并发两趟：第二趟必须并进第一趟（previewOpens），不能各画一遍。
  const [c1, c2] = await Promise.all([openTool(DOC), openTool(DOC)]);
  check("改过之后并发两次投递：两趟都回 ok", c1.ok === true && c2.ok === true, JSON.stringify([c1.ok, c2.ok]));
  const reloaded = await page
    .waitForFunction(
      (src) => {
        const f = document.querySelector(".viewer iframe.viewer-frame");
        return Boolean(f) && f.getAttribute("src") !== src;
      },
      before,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  check("文件真改过之后确实重载（新 token → 新 src）", reloaded);
  const f3 = await flash();
  console.log("  flash (改过之后):", JSON.stringify(f3));
  check("那次重载确实重建了 iframe", f3.iframeRemoved >= 1);
  check("并发两趟只重载一次", f3.iframeRemoved === 1, `iframeRemoved=${f3.iframeRemoved}`);
  await sleep(500);

  // ---------------------------------------------------------------- 4. 重载之后再看同一份 → 又不重画
  await armFlash();
  const reopen3 = await openTool(DOC);
  check("第三次 open_preview 的回执 ok", reopen3.ok === true, JSON.stringify(reopen3));
  await sleep(1200);
  const f4 = await flash();
  console.log("  flash (第 3 次):", JSON.stringify(f4));
  check("重载之后状态已更新：同一份再打开又只抬面板", noRepaint(f4));

  // ---------------------------------------------------------------- 5. xlsx 浮窗
  const openSheet1 = await openTool(SHEET);
  check("xlsx 第一次打开的回执 ok", openSheet1.ok === true, JSON.stringify(openSheet1));
  await page.locator("section.sd").waitFor({ timeout: 20000 });
  await sleep(1000);
  await page.evaluate(() => {
    window.__sd = { removed: 0, added: 0, node: document.querySelector("section.sd") };
    window.__sdmo = new MutationObserver((muts) => {
      for (const m of muts) {
        window.__sd.removed += [...m.removedNodes].filter((n) => n instanceof HTMLElement && n.matches?.("section.sd")).length;
        window.__sd.added += [...m.addedNodes].filter((n) => n instanceof HTMLElement && n.matches?.("section.sd")).length;
      }
    });
    window.__sdmo.observe(document.body, { childList: true, subtree: true });
  });
  const openSheet2 = await openTool(SHEET);
  check("xlsx 第二次打开的回执 ok", openSheet2.ok === true, JSON.stringify(openSheet2));
  await sleep(2000);
  const sd = await page.evaluate(() => {
    const n = document.querySelector("section.sd");
    return { removed: window.__sd.removed, added: window.__sd.added, sameNode: Boolean(n) && n === window.__sd.node, count: document.querySelectorAll("section.sd").length };
  });
  console.log("  sheet:", JSON.stringify(sd));
  check("xlsx 第二次打开没有销毁 / 重开浮窗", sd.removed === 0 && sd.added === 0 && sd.sameNode === true && sd.count === 1);

} catch (err) {
  console.error(bridgeOut.join("").slice(-3000));
  check(`unexpected: ${err?.message ?? String(err)}`, false);
} finally {
  ws?.close();
  await browser?.close();
  bridge.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exitCode = 1;
}
