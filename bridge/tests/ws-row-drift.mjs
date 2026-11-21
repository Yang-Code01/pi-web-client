/**
 * 置顶横排（行 2）漂成空的根因回归：**新建会话的 `session.state` 帧里没有 `ws`**。
 *
 * 现场（window_dev，2026-11-21）：页面先开着 → 在新目录里开新会话 → 第二排只剩「＋」，
 * 顶栏那颗胶囊还丢了工作区色点。原因是 `wsOf()`（web/src/nowchip.ts）反查本区只有三条
 * 来源：override / `sessions.list` 条目的 `ws` / 会话快照的 `ws`，最后才是 `keys[cwd]`。
 * 新会话在页面里是**由 `session.state` 广播**建出来的（新建、跑起来、改状态都走它），
 * 而这条帧原来不带 `ws`；`keys[cwd]` 又要等 `resolve()` 补缓存，而那只在客户端连上时跑
 * —— 于是三条来源全空，`starredRow()` 按 D210 回空。
 *
 * 钉住三件事（都是桥对外的行为，不看内部字段）：
 *   1. `session.state` 帧带着这个会话的工作区（`session.ws` = 组 id）；
 *   2. `create` 之后桥自己补一次工作区缓存，并广播 `sessions.list` + `workspaces`，
 *      那份快照里 `keys[cwd]` 已经有了 —— 页面即使错过了 `ws` 也能按 cwd 反查到本区；
 *   3. 把收到的帧按顺序**增量重放**一遍（`wsOf()` 的镜像），从页面知道这个会话的那一帧起，
 *      每帧之后反查本区都不能是 null —— 顺序错了（`session.state` 早于含新组的快照）也红。
 *
 * Run: npm run test:ws-row
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { freePort } from "../../tools/free-port.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "ws-row-drift");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
/**
 * 全新目录：桥的工作区缓存（`keys`）里绝不会有它 —— 就是 window_dev 当时的位置。
 * 必须落在**任何 git 仓之外**（`os.tmpdir()` 下临时建），否则 `resolve()` 会把它并进所属仓的组。
 */
const FRESH = fs.mkdtempSync(path.join(os.tmpdir(), "pwc-ws-row-"));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const GROUP = FRESH.replace(/\\/g, "/").toLowerCase();
const CWD_KEY = GROUP;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });


const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed += 1;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* the bridge is not up yet: fetch throws rather than returning false */
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
    FAKE_PI_LOG: path.join(ROOT, "fake-pi.jsonl"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const seen = [];
  const waits = new Set();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    seen.push(msg);
    for (const w of [...waits]) {
      if (w.pred(msg)) {
        waits.delete(w);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", (e) => j(new Error(`ws: ${e.message}`)));
  });
  const waitFor = (pred, ms, label) => {
    const hit = seen.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const entry = { pred, resolve };
      entry.timer = setTimeout(() => {
        waits.delete(entry);
        reject(new Error(`timeout: ${label}`));
      }, ms);
      waits.add(entry);
    });
  };

  log(`在工作区缓存里从没出现过的目录里建会话：${FRESH}`);
  ws.send(JSON.stringify({ type: "create", cwd: FRESH, name: "行2漂移" }));
  const created = await waitFor(
    (m) => (m.type === "session" || m.type === "session.state") && (m.state ?? m.session)?.cwd === FRESH,
    30000,
    "create 的会话帧",
  );
  const sid = created.sessionId ?? created.state?.id ?? created.session?.id;
  log(`  会话 ${sid}`);

  // ---- 1. session.state 帧必须自带工作区 ----
  const st = await waitFor(
    (m) => m.type === "session.state" && m.session?.id === sid && m.session?.ws,
    15000,
    "带 ws 的 session.state",
  ).catch(() => null);
  const anyState = seen.find((m) => m.type === "session.state" && m.session?.id === sid);
  check(
    Boolean(st),
    `session.state 帧带着工作区（拿到 ${JSON.stringify(anyState?.session?.ws)}；应为 ${GROUP}）`,
  );
  check(
    !anyState || anyState.session.ws === GROUP,
    `ws 是这个 cwd 的组 id（拿到 ${JSON.stringify(anyState?.session?.ws)}）`,
  );

  // ---- 2. create 之后桥自己补缓存并广播：快照里的 keys 已经有这个 cwd ----
  const list = await waitFor(
    (m) => m.type === "sessions.list" && m.workspace?.keys?.[CWD_KEY],
    20000,
    "create 后带 keys 的 sessions.list",
  ).catch(() => null);
  const lastList = [...seen].reverse().find((m) => m.type === "sessions.list" && m.sessions?.some((s) => s.id === sid));
  check(Boolean(list), `create 之后桥补上了工作区缓存并广播（keys[${CWD_KEY}] = ${JSON.stringify(list?.workspace?.keys?.[CWD_KEY])}）`);
  check(
    Boolean(list?.workspace?.groups?.some((g) => g.id === GROUP)),
    "那份快照的 groups 里有这个目录的组",
  );
  check(
    lastList?.sessions?.find((s) => s.id === sid)?.ws === GROUP,
    `列表条目的 ws 也是它（拿到 ${JSON.stringify(lastList?.sessions?.find((s) => s.id === sid)?.ws)}）`,
  );

  // ---- 3. 页面侧：按帧顺序增量重放，从「页面知道这个会话」起，每帧之后反查本区都不许是 null ----
  // 镜像 web/src/nowchip.ts:67-86 `wsOf()`（override → 列表条目 ws → 会话快照 ws → keys[cwd]），
  // 以及 `starredRow()` 按 D210 的回空规则（解析不到本区 → 第二排整条空）。
  const wsOf = (session, workspace, listedWs) => {
    const groups = workspace?.groups ?? [];
    const wanted = [workspace?.overrides?.[session.id], listedWs, session.ws].find((v) => Boolean(v));
    if (wanted) {
      const hit = groups.find((g) => g.id === wanted);
      if (hit) return hit.id;
    }
    const cwd = String(session.cwd ?? "").replace(/\\/g, "/");
    if (!cwd) return null;
    const root = workspace?.keys?.[cwd.toLowerCase()];
    if (!root) return null;
    const id = String(root).replace(/\\/g, "/").toLowerCase();
    return groups.some((g) => g.id === id) ? id : null;
  };

  const page = { workspace: null, sessions: [], known: false };
  const drifted = [];
  for (const m of seen) {
    // 页面每收到一帧就更新手里的快照（app.ts 的 manage / workspaces / sessions.list / session.state 分支）
    if (m.workspace) page.workspace = m.workspace;
    if (m.type === "sessions.list" && Array.isArray(m.sessions)) page.sessions = m.sessions;
    if (m.type === "session.state" && m.session?.id === sid) {
      // app.ts:3133 mergeSession：有就展开合并，没有就插到最前面
      const i = page.sessions.findIndex((x) => x.id === sid);
      if (i >= 0) page.sessions[i] = { ...page.sessions[i], ...m.session };
      else page.sessions = [{ ...m.session }, ...page.sessions];
      page.known = true;
    }
    const answer = m.state ?? m.session;
    if (answer?.id === sid || (m.type === "sessions.list" && page.sessions.some((x) => x.id === sid)))
      page.known = true;
    if (!page.known) continue;
    const self = page.sessions.find((x) => x.id === sid) ?? answer;
    const listed = page.sessions.find((x) => x.id === sid);
    const group = wsOf(self, page.workspace, listed?.ws);
    if (group !== GROUP) drifted.push({ type: m.type, got: group });
  }
  check(page.known, "重放里确实遇到了「页面知道这个会话」的那一刻");
  check(
    drifted.length === 0,
    `从知道这个会话起，反查本区始终命中（漂掉 ${drifted.length} 帧：${JSON.stringify(drifted.slice(0, 3))}）`,
  );

  ws.close();
} catch (err) {
  failed += 1;
  console.error("ERROR", err?.message ?? err);
  console.error(bridgeOut.join("").slice(-1500));
} finally {
  bridge.kill();
  await sleep(200);
  // 桩 pi 可能还攥着这个 cwd（Windows 上删不掉），临时目录留给系统清理。
  try {
    fs.rmSync(FRESH, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
log(failed ? `FAILED (${failed})` : "PASS");
await sleep(300);
process.exit(failed ? 1 : 0);
