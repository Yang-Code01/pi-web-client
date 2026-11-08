/**
 * Probe: `open_preview` 的桥端闭环（#224）—— 扩展打的那条本机回环路由。
 *
 * Covers: 有页面在看本会话 → `{ok:true}` 且**那条**连接收到 `{type:"preview.open", path}`；
 * 没有页面在看 → `{ok:false, reason:"no-page"}`（不静默当成功）；页面看的是别的会话 →
 * 同样 no-page 且那条连接什么都收不到；token 不对 → 403。
 *
 * #225 加的那组：两个标签页都在看本会话 → 两条都收到；会话目录之外、transcript 没提过 →
 * `untrusted-path` 且不投递；目录外但 transcript 提过 → 允许；只扫 transcript 尾部（超窗口的
 * 提及不算）。
 *
 * 自带丢弃式 bridge + 脚本化 pi（fixture 会把回环 origin 与 token 写进 FAKE_PI_LOG），
 * 不花模型 turn、不碰 7864。端口默认 7892，可用 PREVIEW_PORT 改。
 *
 *   node bridge/tests/preview-tool.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.PREVIEW_PORT ?? 7892);
const ROOT = path.join(REPO, ".scratch", "preview-tool");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "preview-tool-pass";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, WORK]) fs.mkdirSync(d, { recursive: true });
const DOC = path.join(WORK, "笔记.md");
fs.writeFileSync(DOC, "# 笔记\n\n给 open_preview 看的。\n", "utf8");
// #225: 会话目录之外的两份 —— 一份 transcript 提过，一份从没提过。
const OUTSIDE = path.join(ROOT, "outside");
fs.mkdirSync(OUTSIDE, { recursive: true });
const SECRET = path.join(OUTSIDE, "没提过.md");
const MENTIONED = path.join(OUTSIDE, "提过.md");
for (const f of [SECRET, MENTIONED]) fs.writeFileSync(f, "# 目录外\n\n不该随手能开。\n", "utf8");

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
  // #225: 让桩 pi 报一个会话文件，测试才能往 transcript 里写「提到过」的那一行。
  FAKE_PI_SESSION: "1",
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

const piLog = () =>
  fs.existsSync(PI_LOG) ? fs.readFileSync(PI_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
/** spawn 那一笔里有会话 id + 回环凭据；模型探测子进程（`-ne --no-session`）没有 --session-id。 */
const spawnLine = (sid) => piLog().find((l) => l.t === "argv" && (l.argv ?? []).includes(sid) && l.loopback);

const post = async (url, body, headers = {}) => {
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
};

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
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  /** A page connection: opens with the cookie, then subscribes to one session (= `watching`). */
  async function page(sid) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
    const seen = [];
    ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
    for (let i = 0; i < 100 && !seen.some((m) => m.type === "session" && m.state?.id === sid); i++) await sleep(100);
    return { ws, seen };
  }

  const creator = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const created = [];
  creator.on("message", (b) => created.push(JSON.parse(b.toString())));
  await new Promise((r) => creator.on("open", r));

  async function makeSession(name) {
    const before = created.filter((m) => m.type === "session" && m.state?.id).length;
    creator.send(JSON.stringify({ type: "create", cwd: WORK, name }));
    for (let i = 0; i < 300; i++) {
      const list = created.filter((m) => m.type === "session" && m.state?.id);
      if (list.length > before) return list.at(-1).state.id;
      await sleep(100);
    }
    throw new Error(`no session ${name}:\n${bridgeLog.slice(-1500)}`);
  }
  const A = await makeSession("preview-a");
  const B = await makeSession("preview-b");
  for (let i = 0; i < 100 && !(spawnLine(A) && spawnLine(B)); i++) await sleep(100);
  const aLine = spawnLine(A);
  check("pi 子进程拿到了回环凭据（PI_WEB_LOOPBACK + TOKEN）", Boolean(aLine?.loopback && aLine?.loopbackToken), JSON.stringify({ loopback: aLine?.loopback, hasToken: Boolean(aLine?.loopbackToken) }));
  if (!aLine?.loopback || !aLine?.loopbackToken) throw new Error("no loopback credential");
  check("凭据名已经改成中性名字", (aLine.piWeb ?? []).includes("PI_WEB_LOOPBACK") && (aLine.piWeb ?? []).includes("PI_WEB_LOOPBACK_TOKEN") && !(aLine.piWeb ?? []).includes("PI_WEB_ASK"), (aLine.piWeb ?? []).join(","));
  const loaded = (aLine.argv ?? []).filter((arg, i, all) => all[i - 1] === "-e");
  check("网页会话的 pi 挂上了 open_preview 扩展", loaded.some((p) => /open-preview\.ts$/.test(p)), loaded.join(","));
  const token = aLine.loopbackToken;
  const open = (p, tok = token) => post("/api/preview/open", { token: tok, path: p });
  /** 这条连接有没有收到针对这个路径的投递（等一会儿，别和 WS 抢时序）。 */
  const deliveredTo = async (conn, target) => {
    for (let i = 0; i < 40; i++) {
      const hit = conn.seen.find((m) => m.type === "preview.open" && m.path === target);
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };

  // ---- 1. 没有页面在看这个会话 → 明确失败，不当成功
  const none = await open(DOC);
  check("没有页面在看 → ok:false / reason:no-page", none.data?.ok === false && none.data?.reason === "no-page", `${none.status} ${JSON.stringify(none.data)}`);

  // ---- 2. 页面在看的是别的会话 → 同样失败，而且那条连接收不到东西
  const other = await page(B);
  const wrong = await open(DOC);
  await sleep(400);
  check("页面看的是别的会话 → ok:false / reason:no-page", wrong.data?.ok === false && wrong.data?.reason === "no-page", JSON.stringify(wrong.data));
  check("别的会话的页面收不到 preview.open", !other.seen.some((m) => m.type === "preview.open"), JSON.stringify(other.seen.filter((m) => m.type === "preview.open")));

  // ---- 3. 有页面在看本会话 → 成功，且那条连接收到路径
  const mine = await page(A);
  const hit = await open(DOC);
  check("有页面在看 → ok:true", hit.status === 200 && hit.data?.ok === true, `${hit.status} ${JSON.stringify(hit.data)}`);
  check("回执里是解析后的绝对路径", hit.data?.path === DOC, String(hit.data?.path));
  let delivered = null;
  for (let i = 0; i < 40 && !delivered; i++) {
    delivered = mine.seen.find((m) => m.type === "preview.open" && m.sessionId === A) ?? null;
    if (!delivered) await sleep(100);
  }
  check("看本会话的页面收到 preview.open，带这条路径", delivered?.path === DOC, JSON.stringify(delivered));
  check("别的会话的页面仍然收不到", !other.seen.some((m) => m.type === "preview.open"));

  // ---- 4. 凭据不对 → 403
  const bad = await open(DOC, "not-a-real-token");
  check("token 不对 → 403", bad.status === 403, `${bad.status} ${JSON.stringify(bad.data)}`);

  // ---- 5. 隧道过来的请求进不来（和 /api/ask 同一道闸）
  const tunnel = await post("/api/preview/open", { token, path: DOC }, { "cf-connecting-ip": "203.0.113.9" });
  check("公网隧道 → 403", tunnel.status === 403, `${tunnel.status} ${JSON.stringify(tunnel.data)}`);

  // ---- 6. 两个标签页都在看本会话 → 两条都收到（两边都是「正在看」）
  const second = await page(A);
  const DOC2 = path.join(WORK, "两份.md");
  fs.writeFileSync(DOC2, "# 两份\n\n两个标签页都该看见。\n", "utf8");
  const both = await open(DOC2);
  check("两个标签页都在看 → ok:true", both.data?.ok === true, JSON.stringify(both.data));
  const got1 = await deliveredTo(mine, DOC2);
  const got2 = await deliveredTo(second, DOC2);
  check("第一张标签页收到", got1?.path === DOC2, JSON.stringify(got1));
  check("第二张标签页也收到", got2?.path === DOC2, JSON.stringify(got2));

  // ---- 7. 会话目录之外、transcript 没提过 → 拒绝，且不投递、不签发
  const leaked = await open(SECRET);
  check(
    "cwd 外且 transcript 没提过 → ok:false / reason:untrusted-path",
    leaked.status === 200 && leaked.data?.ok === false && leaked.data?.reason === "untrusted-path",
    `${leaked.status} ${JSON.stringify(leaked.data)}`,
  );
  check("拒绝时不回路径 / 凭据", leaked.data?.path === undefined && leaked.data?.token === undefined, JSON.stringify(leaked.data));
  await sleep(300);
  check("拒绝的那条没有投给任何页面", ![...mine.seen, ...second.seen].some((m) => m.type === "preview.open" && m.path === SECRET));

  // ---- 8. 会话目录之外，但 transcript 里提过 → 允许（历史里出现过的文件本来就能手点开）
  const transcript = path.join(AGENT, "sessions", `${A}.jsonl`);
  check("桩 pi 报了会话文件（transcript 存在）", fs.existsSync(transcript), transcript);
  const mention = `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `那份放到了 ${MENTIONED} 里` }] } })}\n`;
  fs.appendFileSync(transcript, mention, "utf8");
  const mentioned = await open(MENTIONED);
  check("cwd 外但 transcript 提过 → ok:true", mentioned.data?.ok === true, `${mentioned.status} ${JSON.stringify(mentioned.data)}`);
  const got3 = await deliveredTo(mine, MENTIONED);
  check("提过的那条投给了页面", got3?.path === MENTIONED, JSON.stringify(got3));

  // ---- 9. 只扫 transcript 尾部：提及被挤出尾部窗口之后就不再算数（上限写在 preview.ts）
  const filler = `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "x".repeat(4096) }] } })}\n`;
  fs.appendFileSync(transcript, filler.repeat(Math.ceil((600 * 1024) / filler.length)), "utf8");
  const aged = await open(MENTIONED);
  check(
    "提及已滑出尾部窗口 → 重新拒绝",
    aged.data?.ok === false && aged.data?.reason === "untrusted-path",
    `${aged.status} ${JSON.stringify(aged.data)}`,
  );

  mine.ws.close();
  second.ws.close();
  other.ws.close();
  creator.close();
} catch (err) {
  console.error(bridgeLog.slice(-3000));
  check(`unexpected: ${err?.message ?? String(err)}`, false);
} finally {
  bridge.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exitCode = 1;
}
