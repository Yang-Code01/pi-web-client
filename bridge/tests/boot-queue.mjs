/**
 * 启动期发出的第一条消息（#197 / D177）：pi 还在加载扩展，桥先收下，气泡立刻出现。
 *
 * 用一个「启动很慢」的桩 pi（FAKE_PI_BOOT_MS）把启动窗口撑开，然后全部从外面看（WS 消息 +
 * 桩 pi 自己的日志，bridge/tests/fixtures/fake-pi.mjs）：
 *   1. `starting` 为真时发 prompt **不报错**：`item.add` 立刻到，item 上带 `pending: "booting"`；
 *   2. 那几秒里桩 pi 一封 prompt 都没收到（消息在桥里排队，没有硬塞给一个还没答话的进程）；
 *   3. 会话名由这条消息决定（左栏不用等 pi 起来就有名字）；
 *   4. `starting` 翻假之后桩 pi 收到这条 prompt（`behavior: null`，第一句不是插话），
 *      同一枚 item 以 `pending: "sent"` 广播一次 `item.replace`；
 *   5. 启动失败（进程在窗口里死了）时气泡留着、标成 `pending: "failed"`，并给一句可读的说明 ——
 *      不能静默消失。完整的重试是 #200。
 *
 * Run: npm --prefix bridge run build && node bridge/tests/boot-queue.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "boot-queue");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const PORT = Number(process.env.PI_WEB_PORT ?? 7877);
const BASE = `http://127.0.0.1:${PORT}`;
/** 启动窗口：够长到「立刻广播」与「就绪后才交给 pi」两件事能分别观察到。 */
const BOOT_MS = 2500;

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
      /* bridge not up yet */
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
    FAKE_PI_LOG: PI_LOG,
    FAKE_PI_BOOT_MS: String(BOOT_MS),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

/** 桩 pi 写下的每一行：argv / prompt / boot-slow / exit —— 都是这次「交没交出去」的证据。 */
const records = () =>
  fs.existsSync(PI_LOG)
    ? fs
        .readFileSync(PI_LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

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
    msg._at = Date.now();
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
  const send = (msg) => ws.send(JSON.stringify(msg));

  // ---------------------------------------------------------------- A. 启动期发第一条
  log(`A. 建会话（桩 pi 要「启动」${BOOT_MS} ms），在窗口里发第一条`);
  // 不给名字：会话名该由启动期发的这条消息决定。
  const mark = seen.length;
  send({ type: "create", cwd: REPO });
  const created = await waitFor((m) => m.type === "session" && m.state?.starting === true && seen.indexOf(m) >= mark, 20000, "session 帧");
  const sid = created.sessionId ?? created.state?.id;
  check(created.state?.starting === true, "刚建好时 starting 为真（这就是启动窗口）");

  const TEXT = "启动期发的第一条";
  const t0 = Date.now();
  send({ type: "prompt", sessionId: sid, text: TEXT, clientId: "local:1" });
  const added = await waitFor(
    (m) => m.type === "item.add" && m.sessionId === sid && m.item?.kind === "user" && m.item?.text === TEXT,
    1500,
    "启动期的 item.add",
  );
  const took = Date.now() - t0;
  check(took < 1000, `气泡在启动窗口里就落地了（${took} ms，pi 还要 ${BOOT_MS} ms 才答话）`);
  check(added.item?.pending === "booting", `item 上带着待发标记（pending=${JSON.stringify(added.item?.pending)}）`);
  check(added.clientId === "local:1", "广播带回了 clientId（那一页据此认领自己的气泡，不重复画）");
  check(!seen.some((m) => m.type === "notice" && m.sessionId === sid && /没|错|失败/.test(String(m.text))), "启动期发消息没有报错");

  const named = await waitFor(
    (m) => m.type === "session.state" && m.session?.id === sid && m.session?.name === TEXT,
    3000,
    "会话名取这条消息",
  );
  check(Boolean(named), `会话名由这条消息决定（左栏不用等 pi 起来就有名字：${named.session?.name}）`);

  check(!records().some((r) => r.t === "prompt"), "窗口里桩 pi 一封 prompt 都没收到（消息在桥里排队）");

  log("等 pi 就绪：第一条要被交出去");
  await waitFor((m) => m.type === "session.state" && m.session?.id === sid && m.session?.starting === false, 20000, "starting=false");
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXT), 10000, "pi 收到这条 prompt");
  const delivered = records().find((r) => r.t === "prompt" && r.text === TEXT);
  check(delivered?.behavior === null, `交出去时是「开一轮」而不是插话（behavior=${JSON.stringify(delivered?.behavior ?? null)}）`);
  const replaced = await waitFor(
    (m) => m.type === "item.replace" && m.sessionId === sid && m.id === added.item.id,
    10000,
    "item.replace sent",
  );
  check(replaced.item?.pending === "sent", `就绪后同一枚气泡改成已交出（pending=${JSON.stringify(replaced.item?.pending)}）`);
  check(!seen.some((m) => m.type === "item.remove" && (m.ids ?? []).includes(added.item.id)), "气泡没有被撤掉");

  // ---------------------------------------------------------------- B. 启动失败：气泡留着、给一句话
  log("B. 建第二个会话，在启动窗口里发消息，然后让 pi 在窗口里死掉");
  const mark2 = seen.length;
  send({ type: "create", cwd: REPO, name: "起不来的那个" });
  const created2 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "起不来的那个" && seen.indexOf(m) >= mark2,
    20000,
    "第二个 session 帧",
  );
  const sid2 = created2.sessionId ?? created2.state?.id;
  check(created2.state?.starting === true, "第二个会话也在启动窗口里");

  const TEXT2 = "这条会赶上启动失败";
  send({ type: "prompt", sessionId: sid2, text: TEXT2, clientId: "local:2" });
  const added2 = await waitFor(
    (m) => m.type === "item.add" && m.sessionId === sid2 && m.item?.text === TEXT2,
    1500,
    "第二个 item.add",
  );
  check(added2.item?.pending === "booting", "第二个气泡同样带着待发标记");

  await until(() => records().some((r) => r.t === "argv" && (r.argv ?? []).includes(sid2)), 10000, "第二个桩 pi 的 argv 行");
  const launch = records().filter((r) => r.t === "argv" && (r.argv ?? []).includes(sid2)).at(-1);
  check(Boolean(launch?.pid), `找到这个会话的桩 pi 进程（pid=${launch?.pid}）`);
  process.kill(launch.pid);

  const failedItem = await waitFor(
    (m) => m.type === "item.replace" && m.sessionId === sid2 && m.id === added2.item.id,
    15000,
    "item.replace failed",
  );
  check(failedItem.item?.pending === "failed", `pi 死在窗口里时气泡标成没发出去（pending=${JSON.stringify(failedItem.item?.pending)}）`);
  check(failedItem.item?.text === TEXT2, "气泡内容还在（没有静默消失）");
  const notice = await waitFor(
    (m) => m.type === "notice" && m.sessionId === sid2 && m.level === "error",
    5000,
    "失败的说明",
  );
  check(/没有发出去/.test(String(notice.text)), `给了一句可读的说明（「${notice.text}」）`);
  check(!seen.some((m) => m.type === "item.remove" && (m.ids ?? []).includes(added2.item.id)), "失败时气泡不被撤掉");

  ws.close();
} catch (err) {
  failed += 1;
  console.error("ERROR", err?.message ?? err);
  console.error(bridgeOut.join("").slice(-1500));
} finally {
  bridge.kill();
}
log(failed ? `FAILED (${failed})` : "PASS");
process.exit(failed ? 1 : 0);
