/**
 * Probe: `open_preview` 在真 Chromium 里真的把 viewer 拉起来，标题是文件名（#224）。
 *
 * 工具自己跑在 pi 子进程里，浏览器看不到它；这个探针从「桥已经把 `preview.open` 投给页面」
 * 之后接手：一条回环请求 → 网页里的 viewer 弹出、`.viewer-name` 就是文件名。
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
fs.writeFileSync(DOC, "# 笔记\n\nopen_preview 打开的。\n", "utf8");

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
