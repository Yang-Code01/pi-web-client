/**
 * #218 补：历史分页只作用于**隧道连接**。
 *
 * #219–#221 把整段历史按页下发，是为了隧道上切会话不白屏；本机 / 内网连接原来并不慢，
 * 分页在那里只带来一个副作用：切回会话又要一页页点「载入更早」。所以形状跟着**连接**走：
 *
 *   A. 本机 WS（没有 CF 头）订阅一条 220 条的会话 → 整段 220 条、`hasMore: false`；
 *   B. 同一条会话，带 `cf-connecting-ip` 的 WS（= 穿过 cloudflared）→ 末尾一页 60 条、`hasMore: true`；
 *   C. 广播帧同样分形状：改文件换分支后，本机收整段、隧道收一页；
 *   D. 本机在任何一帧上都不会看到 `hasMore: true`（界面因此不会长出「载入更早」）；
 *   E. 隧道的 `history.before` 照旧按游标取上一页。
 *
 * 只用 Node 的 ws 客户端，不起浏览器；端口默认 7891（7888 continue-ui、7889 attach-picker、
 * 7890 history-ui 已占），`PAGING_SCOPE_PORT` 可改，不碰 7864。
 *
 *   node bridge/tests/paging-scope.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.PAGING_SCOPE_PORT ?? 7891);
const ROOT = path.join(REPO, ".scratch", "paging-scope");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE_SIZE = 60;
const SID = "0190cccc-0000-7000-8000-0000000000c3";
const ROUNDS = 110; // 220 条
const TOTAL = ROUNDS * 2;

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

/** 每条用户消息后跟一条回复；`prefix` 让「另一条分支」的 id 与原文完全不同（非前缀）。 */
function transcript(prefix, rounds) {
  const rows = [];
  let parent = null;
  for (let i = 0; i < rounds; i++) {
    const u = `${prefix}u${i}`;
    const a = `${prefix}a${i}`;
    rows.push(userRow(u, parent, `${prefix} question ${i}——这一句要够长，整段帧才明显比一页大`, rows.length + 1));
    rows.push(asstRow(a, u, `${prefix} answer ${i}`, rows.length + 1));
    parent = a;
  }
  return rows;
}

const file = path.join(DIR, `2026-01-01T00-00-00-000Z_${SID}.jsonl`);
function writeSession(rows, touchedAt) {
  const header = { type: "session", version: 3, id: SID, timestamp: t(0), cwd: WORK };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, [header, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.renameSync(tmp, file);
  fs.utimesSync(file, touchedAt, touchedAt);
}
writeSession(transcript("a", ROUNDS), new Date(Date.now() - 3600_000));

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

/** 一条 WS：`headers` 里带 `cf-connecting-ip` 就等价于从 tunnel 进来（见 auth.isTunnelRequest）。 */
function connect(headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}`, ...headers } });
  const got = [];
  ws.on("message", (b) => got.push(JSON.parse(b.toString())));
  const open = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  return { ws, got, open };
}

/** 等到一条满足 `pred` 的帧。`list` 必须是那条连接的**活数组** —— 传 `slice()` 会把快照冻住，之后的帧永远等不到。 */
const waitFor = async (list, pred, ms = 20000, from = 0) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = list.slice(from).reverse().find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
};
const isFrame = (type, sessionId) => (m) => m.type === type && m.sessionId === sessionId && m.history;
const bytes = (m) => Buffer.byteLength(JSON.stringify(m));

const local = connect();
const tunnel = connect({ "cf-connecting-ip": "203.0.113.7" });

try {
  await Promise.all([local.open, tunnel.open]);
  const helloLocal = await waitFor(local.got, (m) => m.type === "hello");
  const helloTunnel = await waitFor(tunnel.got, (m) => m.type === "hello");
  check("hello：本机连接 public=false", helloLocal?.public === false, String(helloLocal?.public));
  check("hello：隧道连接 public=true", helloTunnel?.public === true, String(helloTunnel?.public));

  // -- A. 本机订阅：整段 --------------------------------------------------
  local.ws.send(JSON.stringify({ type: "subscribe", sessionId: SID }));
  const localSession = await waitFor(local.got, isFrame("session", SID));
  check("本机：帧里是整段", localSession?.items?.length === TOTAL, `items ${localSession?.items?.length} / ${TOTAL}`);
  check("本机：history.hasMore = false", localSession?.history?.hasMore === false, JSON.stringify(localSession?.history));
  check("本机：history.total 仍是整段条数", localSession?.history?.total === TOTAL, String(localSession?.history?.total));

  // -- B. 隧道订阅：末尾一页 ----------------------------------------------
  tunnel.ws.send(JSON.stringify({ type: "subscribe", sessionId: SID }));
  const tunnelSession = await waitFor(tunnel.got, isFrame("session", SID));
  check("隧道：只给末尾一页", tunnelSession?.items?.length === PAGE_SIZE, `items ${tunnelSession?.items?.length} / ${PAGE_SIZE}`);
  check("隧道：history.hasMore = true", tunnelSession?.history?.hasMore === true, JSON.stringify(tunnelSession?.history));
  check("隧道：history.total 知道整段", tunnelSession?.history?.total === TOTAL, String(tunnelSession?.history?.total));
  check(
    "隧道：这一帧比本机整段帧小得多",
    tunnelSession && localSession && bytes(tunnelSession) * 2 < bytes(localSession),
    `${bytes(tunnelSession)} B vs ${bytes(localSession)} B`,
  );

  // -- C. 广播帧同样分形状：改文件换分支 ----------------------------------
  const localMark = local.got.length;
  const tunnelMark = tunnel.got.length;
  writeSession(transcript("c", 90), new Date()); // 180 条，与 a* 完全不同 → 非前缀（分支切换）
  const localItems = await waitFor(local.got, isFrame("items", SID), 20000, localMark);
  const tunnelItems = await waitFor(tunnel.got, isFrame("items", SID), 20000, tunnelMark);
  const seen = (sock, mark) =>
    sock.got
      .slice(mark)
      .map((m) => `${m.type}/${String(m.sessionId).slice(-6)}/items:${Array.isArray(m.items) ? m.items.length : typeof m.items}/hist:${m.history ? m.history.hasMore : "none"}`)
      .join(" | ") || "无";
  check(
    "分支切换·本机：整段",
    localItems?.items?.length === 180 && localItems.history?.hasMore === false,
    `items ${localItems?.items?.length}, hasMore ${localItems?.history?.hasMore}；收到的帧：${seen(local, localMark)}`,
  );
  check(
    "分支切换·隧道：一页",
    tunnelItems?.items?.length === PAGE_SIZE && tunnelItems.history?.hasMore === true && tunnelItems.history?.total === 180,
    `items ${tunnelItems?.items?.length}, ${JSON.stringify(tunnelItems?.history)}`,
  );

  // -- D. 本机从头到尾不该看到「还有更早的」 ------------------------------
  const localPaged = local.got.filter((m) => (m.type === "session" || m.type === "items") && m.sessionId === SID && m.history?.hasMore === true);
  check("本机：没有任何一帧说「还有更早」", localPaged.length === 0, `${localPaged.length} 帧`);

  // -- E. 隧道的 history.before 照旧能往前取 -----------------------------
  const before = tunnelItems.items[0].id;
  tunnel.ws.send(JSON.stringify({ type: "history.before", sessionId: SID, before }));
  const older = await waitFor(tunnel.got, (m) => m.type === "history" && m.sessionId === SID && m.before === before);
  check("隧道：history.before 取回上一页", older?.items?.length === PAGE_SIZE, `items ${older?.items?.length}`);
  check("隧道：上一页说还有更早的", older?.hasMore === true, String(older?.hasMore));
} catch (err) {
  check(`用例中断：${err?.message ?? err}`, false);
  console.error(bridgeLog.slice(-2000));
} finally {
  local.ws.close();
  tunnel.ws.close();
  bridge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\npaging-scope: ${results.length - failed.length}/${results.length} ok`);
if (failed.length) {
  console.error(failed.map((f) => ` - ${f.name}`).join("\n"));
  process.exit(1);
}
