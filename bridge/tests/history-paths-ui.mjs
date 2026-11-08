/**
 * #221：分支切换、唤醒续接、断线重连也走一页。
 *
 * 三条路径原先都是整段广播 `items`，这里用一条 UI 用例打真 bridge，逐条钉住：
 *   A. 切到别的会话再切回来 —— 每次都是末尾一页，带 `history: { hasMore, total }`；
 *   B. 断线重连、自动重新订阅 —— 仍是一页，DOM 里的条目没有翻倍；
 *   C. 会话文件被改到另一条分支（终端里 /tree）—— 桥只推一页，不是整段；
 *   D. 休眠会话被唤醒续接（发一句话）—— 同样只推一页；
 *   E. 新建会话 —— `history` 是 `{ hasMore: false, total: 0 }`，页面没有「载入更早」。
 *
 * 会话文件是手写的（200+ 条），不花模型 turn：pi 用 `fixtures/fake-pi.mjs`，只负责让桥把
 * 休眠会话重新拉起来。端口默认 7887，`HISTORY_UI_PORT` 可改；不碰 7864 上的实例。
 *
 *   node bridge/tests/history-paths-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.HISTORY_UI_PORT ?? 7887);
const ROOT = path.join(REPO, ".scratch", "history-paths-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const OUT = path.join(REPO, ".scratch", "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE_SIZE = 60;

const SID_A = "0190cccc-0000-7000-8000-0000000000a1";
const SID_B = "0190cccc-0000-7000-8000-0000000000b2";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

const encode = (cwd) => `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const DIR = path.join(AGENT, "sessions", encode(WORK));
fs.mkdirSync(DIR, { recursive: true });

const t = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const userRow = (id, parentId, text, n) => ({
  type: "message",
  id,
  parentId,
  timestamp: t(n),
  message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(t(n)) },
});
const asstRow = (id, parentId, text, n) => ({
  type: "message",
  id,
  parentId,
  timestamp: t(n),
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "x",
    provider: "x",
    model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.parse(t(n)),
  },
});

/** 每条用户消息后跟一条回复；`prefix` 让「另一条分支」的 id 与原文完全不同（非前缀）。 */
function transcript(prefix, rounds) {
  const rows = [];
  let parent = null;
  for (let i = 0; i < rounds; i++) {
    const u = `${prefix}u${i}`;
    const a = `${prefix}a${i}`;
    rows.push(userRow(u, parent, `${prefix} question ${i}`, rows.length + 1));
    rows.push(asstRow(a, u, `${prefix} answer ${i}`, rows.length + 1));
    parent = a;
  }
  return rows;
}

function writeSession(sid, rows, touchedAt) {
  const file = path.join(DIR, `2026-01-01T00-00-00-000Z_${sid}.jsonl`);
  const header = { type: "session", version: 3, id: sid, timestamp: t(0), cwd: WORK };
  // 先写临时文件再改名：桥每 400ms 读一次盘，直接覆写会让它读到半截 JSONL。
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, [header, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.renameSync(tmp, file);
  fs.utimesSync(file, touchedAt, touchedAt);
  return file;
}

writeSession(SID_A, transcript("a", 110), new Date(Date.now() - 3600_000)); // 220 条
writeSession(SID_B, transcript("b", 75), new Date(Date.now() - 3600_000)); // 150 条
const totalA = 220;
const totalB = 150;

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  FAKE_PI_LOG: path.join(ROOT, "fake-pi.jsonl"),
};
const bridge = spawn(process.execPath, [DIST], {
  cwd: REPO,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

for (let i = 0; i < 150; i++) {
  try {
    if (fs.existsSync(path.join(STATE, "passphrase.txt")) && (await fetch(`${BASE}/healthz`)).ok) break;
  } catch {
    /* wait */
  }
  await sleep(200);
}
const PASS = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: PASS }),
});
const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");

// A second WS does the things the page cannot (create a session, wake a sleeping one).
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
const seen = [];
ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
await new Promise((r) => ws.on("open", r));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
// Record what the page's own socket receives, before the app opens it.
await ctx.addInitScript(() => {
  const Native = window.WebSocket;
  const frames = (window.__historyFrames = []);
  const sockets = (window.__sockets = []);
  const get = (msg) => (msg && typeof msg === "object" ? msg : null);
  const Patched = function (...args) {
    const sock = new Native(...args);
    sockets.push(sock);
    sock.addEventListener("message", (ev) => {
      try {
        const m = get(JSON.parse(ev.data));
        if (!m || (m.type !== "session" && m.type !== "items")) return;
        frames.push({
          type: m.type,
          sessionId: m.sessionId ?? m.state?.id ?? null,
          items: Array.isArray(m.items) ? m.items.length : null,
          history: m.history ?? null,
          bytes: typeof ev.data === "string" ? ev.data.length : 0,
          at: Date.now(),
        });
      } catch {
        /* not a bridge frame */
      }
    });
    return sock;
  };
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Patched[k] = Native[k];
  Patched.prototype = Native.prototype;
  window.WebSocket = Patched;
});
const page = await ctx.newPage();
page.on("pageerror", (e) => log("pageerror:", e.message));

const frames = () => page.evaluate(() => window.__historyFrames);
const lastFrame = async (type, sessionId) => {
  const all = await frames();
  return [...all].reverse().find((f) => f.type === type && f.sessionId === sessionId) ?? null;
};
const waitFrame = (type, sessionId, from = 0, timeout = 20000) =>
  page.waitForFunction(
    ({ type, sessionId, from }) => window.__historyFrames.slice(from).some((f) => f.type === type && f.sessionId === sessionId),
    { type, sessionId, from },
    { timeout },
  );
const userBubbles = () => page.locator(".msg.user").count();

const pageAssertions = async (label, sid, expectedTotal, expectedHasMore) => {
  const f = await lastFrame("session", sid);
  check(`${label}：是末尾一页`, f?.items != null && f.items <= PAGE_SIZE, `items ${f?.items} ≤ ${PAGE_SIZE}`);
  check(`${label}：帧带 history`, f?.history?.hasMore === expectedHasMore && f.history?.total === expectedTotal, JSON.stringify(f?.history));
  check(`${label}：帧远小于整段`, f?.bytes > 0 && f.bytes < 100_000, `${f?.bytes} bytes`);
  check(`${label}：DOM 没画整段`, (await userBubbles()) <= PAGE_SIZE / 2 + 2, `${await userBubbles()} 条用户气泡`);
};

try {
  // -- A. 切会话，再切回来 -------------------------------------------------
  await page.goto(`${BASE}/#/s/${SID_A}`);
  await waitFrame("session", SID_A, 0, 25000);
  await page.waitForSelector(".composer .perm-btn", { timeout: 20000 });
  await pageAssertions("打开 A", SID_A, totalA, true);
  const usersA = await userBubbles();
  check("A 的第一页确实有内容可看", usersA > 0, `${usersA} 条用户气泡`);

  const markSwitch = (await frames()).length;
  await page.evaluate((sid) => (location.hash = `#/s/${sid}`), SID_B);
  await waitFrame("session", SID_B, markSwitch, 25000);
  await pageAssertions("切到 B", SID_B, totalB, true);

  const markBack = (await frames()).length;
  await page.evaluate((sid) => (location.hash = `#/s/${sid}`), SID_A);
  await waitFrame("session", SID_A, markBack, 25000);
  await pageAssertions("切回 A", SID_A, totalA, true);
  check("切回来仍是第一页，没有把 B 的旧页串进来", (await userBubbles()) === usersA, `${await userBubbles()} vs ${usersA}`);

  // -- B. 断线重连：自动重新订阅后仍是一页，DOM 不翻倍 ---------------------
  const markDrop = (await frames()).length;
  // 拔线：关掉页面自己那条 socket，Socket.onclose 会照常退避重连、hello 里重新 subscribe。
  await page.evaluate(() => window.__sockets.at(-1).close());
  await sleep(500);
  await waitFrame("session", SID_A, markDrop, 30000);
  await pageAssertions("重连后", SID_A, totalA, true);
  check("重连后没有把同一页画两遍", (await userBubbles()) === usersA, `${await userBubbles()} vs ${usersA}`);

  // -- C. 分支切换：文件被改到另一条分支，桥只推一页 -----------------------
  const markBranch = (await frames()).length;
  const branchRows = transcript("c", 90); // 180 条，与原来的 a* 完全不同 → 非前缀
  writeSession(SID_A, branchRows, new Date());
  await waitFrame("items", SID_A, markBranch, 15000);
  const branchFrame = (await frames()).slice(markBranch).find((f) => f.type === "items" && f.sessionId === SID_A);
  check("分支切换：items 帧是一页", branchFrame?.items != null && branchFrame.items <= PAGE_SIZE, `items ${branchFrame?.items} ≤ ${PAGE_SIZE}`);
  check("分支切换：items 帧带 history", branchFrame?.history?.hasMore === true && branchFrame.history?.total === 180, JSON.stringify(branchFrame?.history));
  check("分支切换：帧远小于整段", branchFrame?.bytes > 0 && branchFrame.bytes < 100_000, `${branchFrame?.bytes} bytes`);
  await sleep(300);
  const branchUsers = await userBubbles();
  check("分支切换：整页替换，没有叠加旧内容", branchUsers <= PAGE_SIZE / 2 + 2, `${branchUsers} 条用户气泡`);

  // -- D. 唤醒续接：休眠会话被一句话拉起，同样只推一页 ---------------------
  const markWake = (await frames()).length;
  ws.send(JSON.stringify({ type: "prompt", sessionId: SID_B, text: "wake up" }));
  await waitFrame("items", SID_B, markWake, 30000);
  const wakeFrame = (await frames()).slice(markWake).find((f) => f.type === "items" && f.sessionId === SID_B);
  check("唤醒续接：items 帧是一页", wakeFrame?.items != null && wakeFrame.items <= PAGE_SIZE, `items ${wakeFrame?.items} ≤ ${PAGE_SIZE}`);
  check("唤醒续接：items 帧带 history", wakeFrame?.history?.hasMore === true && wakeFrame.history?.total === totalB + 1, JSON.stringify(wakeFrame?.history));

  // -- E. 新建会话：空历史，没有「载入更早」 ------------------------------
  const markCreate = seen.length;
  ws.send(JSON.stringify({ type: "create", cwd: WORK, name: "fresh" }));
  let fresh = null;
  for (let i = 0; i < 200 && !fresh; i++) {
    fresh = seen.slice(markCreate).find((m) => m.type === "session" && m.state?.id && m.history);
    if (!fresh) await sleep(100);
  }
  check("新建会话：history = { hasMore: false, total: 0 }", fresh?.history?.hasMore === false && fresh?.history?.total === 0, JSON.stringify(fresh?.history));
  check("新建会话：items 是空的", Array.isArray(fresh?.items) && fresh.items.length === 0, `${fresh?.items?.length}`);
  check("新建会话：页面上没有「载入更早」", (await page.locator(".load-earlier, .history-more").count()) === 0);
} catch (err) {
  check(`用例中断：${err?.message ?? err}`, false);
  console.error(bridgeLog.slice(-2000));
} finally {
  await browser.close();
  ws.close();
  bridge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nhistory-paths-ui: ${results.length - failed.length}/${results.length} ok`);
if (failed.length) {
  console.error(failed.map((f) => ` - ${f.name}`).join("\n"));
  process.exit(1);
}
