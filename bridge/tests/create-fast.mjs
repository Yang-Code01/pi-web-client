/**
 * 「新建会话」不许等 pi 启动（D122）。
 *
 * 实测：带着一整套扩展把 pi 冷启起来要 8 秒（本机 12 个 npm 扩展 + 5 个本地扩展；机器忙时 15 秒），
 * 而桥原来在 `create` 里 `await get_state`，于是那 8 秒全部变成对话框上的「启动中…」。
 *
 * 这份测试用一个「启动很慢」的桩 pi（FAKE_PI_BOOT_MS）钉住三件事：
 *   1. `create` 的应答（带 sessionId 的 session 帧）在 **1.5 秒内**到达，不跟着 pi 的启动走；
 *   2. 刚创建时 `state.starting === true`（页面据此禁用输入框、显示「pi 正在启动…」）；
 *   3. pi 真的答完之后 `starting` 翻成 false —— 不然页面会永远停在「启动中」。
 *
 * 全部从外面观察：WS 消息 + 桩 pi 自己的日志，不看桥的内部字段。
 *
 * Run: npm --prefix bridge run build && node bridge/tests/create-fast.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "create-fast");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const PORT = 7905;
const BASE = `http://127.0.0.1:${PORT}`;
/** 桩 pi 的「启动」时长：够长到任何「等它」的实现都会明显超时。 */
const BOOT_MS = 4000;
/** create 的应答必须比它快得多。 */
const BUDGET_MS = 1500;

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
    FAKE_PI_LOG: PI_LOG,
    FAKE_PI_BOOT_MS: String(BOOT_MS),
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

  log(`创建会话（桩 pi 会「启动」${BOOT_MS} ms）`);
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: "create", cwd: REPO, name: "启动慢的会话" }));
  const created = await waitFor((m) => m.type === "session" && m.state?.name === "启动慢的会话", 20000, "session 帧");
  const took = Date.now() - t0;
  const sid = created.sessionId ?? created.state?.id;
  log(`  应答用了 ${took} ms（预算 ${BUDGET_MS} ms），会话 ${sid}`);

  check(took < BUDGET_MS, `create 没有等 pi 启动（${took} ms < ${BUDGET_MS} ms；桩 pi 要 ${BOOT_MS} ms 才答话）`);
  check(created.state?.starting === true, `刚创建时会话标着 starting（拿到 ${JSON.stringify(created.state?.starting)}）`);
  check(!bridgeOut.join("").includes("get_state"), "创建路径没有阻塞等待 get_state（日志里没有它的超时痕迹）");

  log("等桩 pi 答完 get_state，starting 要自己翻下去");
  const settled = await waitFor((m) => m.type === "session.state" && m.session?.id === sid && m.session?.starting === false, 20000, "starting=false");
  const flipAt = settled._at - t0;
  check(Boolean(settled), "starting 翻成 false 了（页面不会永远停在「启动中」）");
  check(flipAt >= BOOT_MS - 150, `翻转发生在 pi 真正就绪之后（${flipAt} ms ≥ ${BOOT_MS} ms）`);

  // 桩 pi 自己的记录：它确实被「慢启动」过，而且 get_state 是启动完成后才被答的。
  const records = fs
    .readFileSync(PI_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  check(records.some((r) => r.t === "boot-slow"), "桩 pi 记录了这次「慢启动」");
  check(records.some((r) => r.t === "argv"), "桩 pi 真的被拉起来了");

  // 桥日志里那行「启动完成 X ms」是这次新加的诊断出口。
  // stdout 的读取与 WS 消息是两条通道：桥写完这行日志可能比 session.state 晚到几十毫秒，等一会儿再判。
  let bootLine;
  for (let i = 0; i < 50 && !bootLine; i += 1) {
    bootLine = bridgeOut.join("").split("\n").find((l) => l.includes("[boot]") && l.includes(sid));
    if (!bootLine) await sleep(100);
  }
  check(Boolean(bootLine), `桥日志里有启动耗时（${bootLine?.trim() ?? "没有找到"}）`);
  if (bootLine) {
    const ms = Number(/(\d+)\s*ms/.exec(bootLine)?.[1] ?? 0);
    check(ms >= BOOT_MS - 150, `日志里的耗时是真实值（${ms} ms ≥ ${BOOT_MS} ms）`);
  }

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
