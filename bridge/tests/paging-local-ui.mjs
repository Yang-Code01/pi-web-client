/**
 * #295：本机 / 内网连接整段下发历史 —— 切回去立刻是完整历史，不再退回第一页。
 *
 * 这套用例走用户看到的那一层（真 bridge + 真页面），钉住四件事：
 *   A. 打开一条 220 条的会话：`session` 帧就是 220 条、`hasMore: false`，页面一次画完 110 轮；
 *   B. 切到别的会话再切回来：仍是整段、仍是 110 轮，底部不会长出「载入更早」（这就是报的现象）；
 *   C. 断线重连（页面自己那条 socket 被拔掉）：重新订阅后还是整段，DOM 不翻倍、也不退回一页；
 *   D. 全程没有任何一帧说「还有更早的」—— 界面因此没有任何入口去点。
 *
 * 会话文件是手写的（220 条），不花模型 turn；pi 用 `fixtures/fake-pi.mjs`，本用例不需要拉起它。
 * 端口默认 7892（7887 history-paths、7888 continue、7889 attach、7890 history、7891 paging-scope
 * 已占），`PAGING_LOCAL_UI_PORT` 可改；不碰 7864 上的实例。
 *
 *   node bridge/tests/paging-local-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.PAGING_LOCAL_UI_PORT ?? 7892);
const ROOT = path.join(REPO, ".scratch", "paging-local-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const BASE = `http://127.0.0.1:${PORT}`;

const SID_A = "0190cccc-0000-7000-8000-0000000000d1";
const SID_B = "0190cccc-0000-7000-8000-0000000000d2";
const ROUNDS_A = 110; // 220 条
const ROUNDS_B = 20; // 40 条
const TOTAL_A = ROUNDS_A * 2;
const TOTAL_B = ROUNDS_B * 2;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

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

/** 每条用户消息后跟一条回复；`prefix` 让两条会话的 id 完全不同（非前缀）。 */
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
}

writeSession(SID_A, transcript("a", ROUNDS_A), new Date(Date.now() - 3600_000));
writeSession(SID_B, transcript("b", ROUNDS_B), new Date(Date.now() - 3600_000));

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  // 故意不设 PI_WEB_PAGE_ALL：这套用例验的就是「本机不分页」（D215）。
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  FAKE_PI_LOG: path.join(ROOT, "fake-pi.jsonl"),
};
delete env.PI_WEB_PAGE_ALL;
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
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

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
// 页面自己的 socket 收到什么，都在 `window.__frames` 里留一份形状摘要。
await ctx.addInitScript(() => {
  const Native = window.WebSocket;
  const frames = (window.__frames = []);
  const sockets = (window.__sockets = []);
  const Patched = function (...args) {
    const sock = new Native(...args);
    sockets.push(sock);
    sock.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (!m || (m.type !== "session" && m.type !== "items")) return;
        frames.push({
          type: m.type,
          sessionId: m.sessionId ?? m.state?.id ?? null,
          items: Array.isArray(m.items) ? m.items.length : null,
          history: m.history ?? null,
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

const frames = () => page.evaluate(() => window.__frames);
const lastFrame = async (type, sessionId) => {
  const all = await frames();
  return [...all].reverse().find((f) => f.type === type && f.sessionId === sessionId) ?? null;
};
const waitFrame = (type, sessionId, from = 0, timeout = 20000) =>
  page.waitForFunction(
    ({ type, sessionId, from }) => window.__frames.slice(from).some((f) => f.type === type && f.sessionId === sessionId),
    { type, sessionId, from },
    { timeout },
  );
const userBubbles = () => page.locator(".msg.user").count();
/** 「载入更早」那一行：`.chat-more`，没有更早的时候 `hidden`。 */
const moreRowShown = async () => (await page.locator(".chat-more").count()) > 0 && (await page.locator(".chat-more").first().isVisible());
/** 等页面把这一页画完（气泡数稳定在期望值），而不是靠固定 sleep 赌。 */
const waitBubbles = (n, timeout = 20000) =>
  page.waitForFunction((n) => document.querySelectorAll(".msg.user").length === n, n, { timeout });

try {
  // -- A. 本机打开一条 220 条的会话：整段，一次画完 ------------------------
  await page.goto(`${BASE}/#/s/${SID_A}`);
  await waitFrame("session", SID_A, 0, 25000);
  await page.waitForSelector(".composer .perm-btn", { timeout: 20000 });
  const openA = await lastFrame("session", SID_A);
  check("打开 A：帧里就是整段", openA?.items === TOTAL_A, `items ${openA?.items} / ${TOTAL_A}`);
  check("打开 A：history 说没有更早的", openA?.history?.hasMore === false && openA.history?.total === TOTAL_A, JSON.stringify({ hasMore: openA?.history?.hasMore, total: openA?.history?.total }));
  check("打开 A：轮次索引是整段", openA?.history?.turns?.length === ROUNDS_A, `${openA?.history?.turns?.length} 轮`);
  await waitBubbles(ROUNDS_A);
  check("打开 A：页面画完了 110 轮", (await userBubbles()) === ROUNDS_A, `${await userBubbles()} 条用户气泡`);
  check("打开 A：没有「载入更早」", !(await moreRowShown()));

  // -- B. 切走再切回来：仍是整段（这就是 #295 报的现象） ------------------
  const markSwitch = (await frames()).length;
  await page.evaluate((sid) => (location.hash = `#/s/${sid}`), SID_B);
  await waitFrame("session", SID_B, markSwitch, 25000);
  await waitBubbles(ROUNDS_B);
  const openB = await lastFrame("session", SID_B);
  check("切到 B：整段", openB?.items === TOTAL_B && openB.history?.hasMore === false, `${openB?.items} / ${ROUNDS_B} 轮`);
  check("切到 B：没有「载入更早」", !(await moreRowShown()));

  const markBack = (await frames()).length;
  await page.evaluate((sid) => (location.hash = `#/s/${sid}`), SID_A);
  await waitFrame("session", SID_A, markBack, 25000);
  await waitBubbles(ROUNDS_A);
  const backA = await lastFrame("session", SID_A);
  check("切回 A：仍拿到整段", backA?.items === TOTAL_A, `items ${backA?.items} / ${TOTAL_A}`);
  check("切回 A：history 仍说没有更早的", backA?.history?.hasMore === false, JSON.stringify({ hasMore: backA?.history?.hasMore, total: backA?.history?.total }));
  check("切回 A：110 轮全在，没有退回一页", (await userBubbles()) === ROUNDS_A, `${await userBubbles()} 条用户气泡`);
  check("切回 A：没有「载入更早」", !(await moreRowShown()));

  // -- C. 断线重连：重新订阅后还是整段，DOM 不翻倍 ------------------------
  const markDrop = (await frames()).length;
  await page.evaluate(() => window.__sockets.at(-1).close());
  await sleep(500);
  await waitFrame("session", SID_A, markDrop, 30000);
  await waitBubbles(ROUNDS_A);
  const again = await lastFrame("session", SID_A);
  check("重连后：仍是整段", again?.items === TOTAL_A && again.history?.hasMore === false, `items ${again?.items} / ${TOTAL_A}`);
  check("重连后：没有把同一页画两遍", (await userBubbles()) === ROUNDS_A, `${await userBubbles()} 条用户气泡`);

  // -- D. 全程没有任何一帧说「还有更早的」 --------------------------------
  const paged = (await frames()).filter((f) => f.history?.hasMore === true);
  check("本机：没有任何一帧说「还有更早」", paged.length === 0, `${paged.length} 帧`);
  const short = (await frames()).filter((f) => f.type === "session" && f.items !== null && f.items < TOTAL_A && f.sessionId === SID_A);
  check("本机：A 的 session 帧从没被切成小页", short.length === 0, `${short.length} 帧`);
} catch (err) {
  check(`用例中断：${err?.message ?? err}`, false);
  console.error(bridgeLog.slice(-2000));
} finally {
  await browser.close();
  bridge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\npaging-local-ui: ${results.length - failed.length}/${results.length} ok`);
if (failed.length) {
  console.error(failed.map((f) => ` - ${f.name}`).join("\n"));
  process.exit(1);
}
