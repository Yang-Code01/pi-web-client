/**
 * Probe: `open_preview` 在真 Chromium 里真的把 viewer 拉起来，标题是文件名（#224）；
 * 并且（#225）投递范围的收紧在页面上看得见：指错会话的请求不让页面变一丁点（正文、滚动位置都不动），
 * 两个标签页都在看同一个会话时两边都弹。
 *
 * 工具自己跑在 pi 子进程里，浏览器看不到它；这个探针从「桥已经把 `preview.open` 投给页面」
 * 之后接手：一条回环请求 → 网页里的 viewer 弹出、`.viewer-name` 就是文件名（md / html / 代码
 * 三种文件各一条，都落在预览态）。
 * 前端还有一道「sessionId 不对就丢掉」的双保险，桥不可能自己发错，所以用
 * `routeWebSocket` 抢过页面的 socket、伪造一条错会话的 `preview.open` 来测它。
 *
 * 自带丢弃式 bridge + 脚本化 pi（fixture 会把回环 origin 与 token 写进 FAKE_PI_LOG），
 * 不花模型 turn、不碰 7864。端口默认 7893，可用 PREVIEW_UI_PORT 改。
 *
 *   node probes/preview-open.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync, spawn } from "node:child_process";
import { WebSocket } from "ws";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.PREVIEW_UI_PORT ?? 7893);
const ROOT = path.join(REPO, ".scratch", "preview-open");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "preview-open-pass";
const NAME = "笔记.md";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, WORK, OUT]) fs.mkdirSync(d, { recursive: true });
const DOC = path.join(WORK, NAME);
// 长文：正文必须能滚，"滚动位置没变" 才是一条有内容的断言。
fs.writeFileSync(
  DOC,
  `# 笔记\n\nopen_preview 打开的。\n\n${Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段：${"长文用来把 viewer 撑到能滚动。".repeat(4)}`).join("\n\n")}\n`,
  "utf8",
);

/** 上次崩掉留下的 bridge 会占着端口，探针就会悄悄跑在旧的 dist 上。 */
function killPort(port) {
  try {
    const pids = new Set();
    const out = execSync("netstat -ano", { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+(\S+)\s+\S+\s+(\d+)$/);
      if (m && Number(m[1]) === port && /:0$/.test(m[2])) pids.add(Number(m[3]));
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
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

const post = async (url, body) => {
  const res = await fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

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

  // 一个网页会话（脚本化 pi，不花模型 turn）：工具将来就是在这个会话里被调用的。
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
  const seen = [];
  ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "create", cwd: WORK, name: "preview-open" }));
  let sid = null;
  for (let i = 0; i < 300 && !sid; i++) {
    sid = seen.find((m) => m.type === "session" && m.state?.id)?.state.id ?? null;
    if (!sid) await sleep(100);
  }
  if (!sid) throw new Error(`no session:\n${bridgeOut.join("").slice(-2000)}`);
  for (let i = 0; i < 100 && !spawnLine(sid); i++) await sleep(100);
  const token = spawnLine(sid)?.loopbackToken;
  if (!token) throw new Error("no loopback credential");
  console.log("session", sid);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
  // #225: 桥不会给错的会话投递，所以前端那道双保险只能伪造一条来测。拦下页面的 socket 并
  // `connectToServer()`（双向转发照旧），之后就能以服务端的口吻往页面里塞 `preview.open`。
  let pageWs = null;
  await context.routeWebSocket("**/ws", (wsRoute) => {
    pageWs = wsRoute;
    wsRoute.connectToServer();
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(`${BASE}/#/s/${sid}`, { waitUntil: "networkidle" });
  await page.locator(".topbar .icon-btn", { hasText: "文件" }).waitFor({ timeout: 15000 });
  check("会话在浏览器里打开了", true);

  // 页面订阅（watching）和这条请求是两条线：页面还没到就再敲一次，最多 15 秒。
  let reply = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    reply = await post("/api/preview/open", { token, path: DOC });
    if (reply.data?.ok) break;
    await sleep(300);
  }
  check("桥说打开了（ok:true）", reply?.data?.ok === true, JSON.stringify(reply?.data));

  let title = "";
  const titled = await page
    .waitForFunction((name) => document.querySelector(".viewer-name")?.textContent === name, NAME, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  title = (await page.locator(".viewer-name").textContent({ timeout: 1000 }).catch(() => "")) ?? "";
  check("viewer 弹出来了", (await page.locator(".viewer").count()) === 1);
  check(`标题是文件名（${NAME}）`, titled && title === NAME, JSON.stringify(title));
  check("正文渲染成 markdown 预览", (await page.locator(".viewer-body .md-doc").count()) === 1);
  await page.screenshot({ path: path.join(OUT, "1-opened.png"), animations: "disabled" });

  // ---- #225: 页面此刻长什么样，用于「什么都没变」的断言（正文、滚动位置、viewer 个数）
  const snapshot = (p) =>
    p.evaluate(() => {
      const body = document.querySelector(".viewer-body");
      return {
        name: document.querySelector(".viewer-name")?.textContent ?? "",
        html: body?.innerHTML ?? "",
        scrollTop: body?.scrollTop ?? -1,
        viewers: document.querySelectorAll(".viewer").length,
      };
    });
  const unchanged = (a, b) => a.name === b.name && a.html === b.html && a.viewers === b.viewers && a.scrollTop === b.scrollTop;

  await page.locator(".viewer-body").evaluate((el) => (el.scrollTop = 400));
  await sleep(400);
  const before = await snapshot(page);
  check("正文能滚（「滚动位置没变」才有意义）", before.scrollTop > 0, String(before.scrollTop));

  // 另一个会话：只为拿一个「别人的」回环凭据
  ws.send(JSON.stringify({ type: "create", cwd: WORK, name: "preview-other" }));
  let sidB = null;
  for (let i = 0; i < 300 && !sidB; i++) {
    sidB = seen.find((m) => m.type === "session" && m.state?.id && m.state.id !== sid)?.state.id ?? null;
    if (!sidB) await sleep(100);
  }
  if (!sidB) throw new Error("no second session");
  for (let i = 0; i < 100 && !spawnLine(sidB)?.loopbackToken; i++) await sleep(100);
  const tokenB = spawnLine(sidB)?.loopbackToken;
  if (!tokenB) throw new Error("no loopback credential for the other session");
  // 创建会话的那条连接自己会「在看」新建的会话（桥的 create 顺手订阅了它）。它不是页面，
  // 留着的话请求 B 就会投给它，"没人看 B" 这个前提就假了 —— 先关掉。
  ws.close();
  await sleep(300);

  const DOC2 = path.join(WORK, "两份.md");
  fs.writeFileSync(DOC2, "# 两份\n\n给前端双保险用的。\n", "utf8");

  // ---- 7. 请求指向别的会话 → no-page，而且当前页面一点没动（不能只断言「没弹 viewer」）
  const wrong = await post("/api/preview/open", { token: tokenB, path: DOC2 });
  check("请求指向别的会话 → no-page", wrong.data?.ok === false && wrong.data?.reason === "no-page", JSON.stringify(wrong.data));
  await sleep(600);
  const afterWrong = await snapshot(page);
  check(
    "wrong-session 之后页面内容没变（标题 / 正文 / viewer 个数）",
    afterWrong.name === before.name && afterWrong.html === before.html && afterWrong.viewers === before.viewers,
    `${JSON.stringify(afterWrong.name)} viewers=${afterWrong.viewers}`,
  );
  check("wrong-session 之后滚动位置没变", afterWrong.scrollTop === before.scrollTop, `${before.scrollTop} → ${afterWrong.scrollTop}`);
  await page.screenshot({ path: path.join(OUT, "2-wrong-session.png"), animations: "disabled" });

  // ---- 8. 前端双保险：sessionId 不是当前会话的 preview.open 直接丢掉
  if (!pageWs) throw new Error("没截到页面的 WebSocket");
  pageWs.send(JSON.stringify({ type: "preview.open", sessionId: sidB, path: DOC2 }));
  await sleep(800);
  const afterForged = await snapshot(page);
  check("伪造的错会话投递被前端丢掉（内容）", unchanged(before, afterForged), JSON.stringify({ name: afterForged.name, viewers: afterForged.viewers }));
  check("伪造的错会话投递被前端丢掉（滚动位置）", afterForged.scrollTop === before.scrollTop, `${before.scrollTop} → ${afterForged.scrollTop}`);

  // 正对照：同一条伪造消息，sessionId 对了就会被打开 —— 否则上一条断言是空的。
  pageWs.send(JSON.stringify({ type: "preview.open", sessionId: sid, path: DOC2 }));
  const switched = await page
    .waitForFunction(() => document.querySelector(".viewer-name")?.textContent === "两份.md", null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("同一条伪造消息、会话对了就打开（上面那条不是空断言）", switched);
  check("页面还在原会话（工具只开预览，不切会话）", page.url().endsWith(`#/s/${sid}`), page.url());

  // ---- 9. 两个标签页都在看同一个会话 → 两边都弹
  const page2 = await context.newPage();
  page2.on("pageerror", (e) => console.log("page error:", e.message));
  await page2.goto(`${BASE}/#/s/${sid}`, { waitUntil: "networkidle" });
  await page2.locator(".topbar .icon-btn", { hasText: "文件" }).waitFor({ timeout: 15000 });
  const DOC3 = path.join(WORK, "三份.md");
  fs.writeFileSync(DOC3, "# 三份\n\n两个标签页都该弹。\n", "utf8");
  let both = null;
  const t2 = Date.now();
  while (Date.now() - t2 < 15000) {
    both = await post("/api/preview/open", { token, path: DOC3 });
    const n1 = await page.locator(".viewer-name").textContent({ timeout: 500 }).catch(() => "");
    const n2 = await page2.locator(".viewer-name").textContent({ timeout: 500 }).catch(() => "");
    if (both.data?.ok && n1 === "三份.md" && n2 === "三份.md") break;
    await sleep(300);
  }
  check("桥说打开了（两个标签页）", both?.data?.ok === true, JSON.stringify(both?.data));
  check("第一张标签页弹到三份.md", (await page.locator(".viewer-name").textContent()) === "三份.md");
  check("第二张标签页也弹到三份.md", (await page2.locator(".viewer-name").textContent()) === "三份.md");
  await page2.screenshot({ path: path.join(OUT, "3-second-tab.png"), animations: "disabled" });

  // ---- 10/11. html 与代码文件：也是落在预览态（`pane === "preview"`），标题是文件名。
  // 两种文件在页面上长得完全不一样（html 在沙箱 iframe 里渲染，代码是带行号的 `<pre>`），
  // 只测 md 会漏掉「打开是打开了，但落到编辑/浏览态上」这种回归。
  const paneName = async (p) => (await p.locator(".viewer-head .pane-seg button.on").textContent({ timeout: 1000 }).catch(() => "")) ?? "";

  const HTML_DOC = path.join(WORK, "演示.html");
  fs.writeFileSync(HTML_DOC, "<!doctype html><meta charset=\"utf-8\"><h1>演示页</h1>\n", "utf8");
  const htmlReply = await post("/api/preview/open", { token, path: HTML_DOC });
  check("html: 桥说打开了", htmlReply.data?.ok === true, JSON.stringify(htmlReply.data));
  const htmlTitled = await page
    .waitForFunction(() => document.querySelector(".viewer-name")?.textContent === "演示.html", null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("html: 标题是文件名（演示.html）", htmlTitled);
  check("html: 落在预览态", (await paneName(page)) === "预览", await paneName(page));
  check("html: 正文是沙箱 iframe", (await page.locator(".viewer-body iframe.viewer-frame").count()) === 1);
  await page.screenshot({ path: path.join(OUT, "4-html.png"), animations: "disabled" });

  const CODE_DOC = path.join(WORK, "示例.py");
  fs.writeFileSync(CODE_DOC, "# 代码文件也该进预览\nprint('open_preview code marker')\n", "utf8");
  const codeReply = await post("/api/preview/open", { token, path: CODE_DOC });
  check("代码: 桥说打开了", codeReply.data?.ok === true, JSON.stringify(codeReply.data));
  const codeTitled = await page
    .waitForFunction(() => document.querySelector(".viewer-name")?.textContent === "示例.py", null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("代码: 标题是文件名（示例.py）", codeTitled);
  check("代码: 落在预览态", (await paneName(page)) === "预览", await paneName(page));
  const codeText = (await page.locator(".viewer-body pre.viewer-src").textContent({ timeout: 2000 }).catch(() => "")) ?? "";
  check("代码: 正文是带行号的源码", codeText.includes("open_preview code marker"), codeText.slice(0, 80));
  await page.screenshot({ path: path.join(OUT, "5-code.png"), animations: "disabled" });

  ws.close();
} catch (err) {
  console.error(bridgeOut.join("").slice(-3000));
  check(`unexpected: ${err?.message ?? String(err)}`, false);
} finally {
  await browser?.close();
  bridge.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed · shots in ${OUT}`);
  if (failed) process.exitCode = 1;
}
