/**
 * 冷启超过 get_state 等待窗口时，会话也必须拿到模型（输入框下的模型 chip 不能停在「模型 / –」）。
 *
 * 实测：机器忙时 pi 带着整套扩展冷启要 137 秒，远超桥给启动期 get_state 的 30 秒窗口；
 * 原来超时就算了，state.model / modelName / thinkingLevel 永远是空的。
 *
 * 桩 pi 慢启动 BOOT_MS，桥的启动窗口用 PI_WEB_BOOT_STATE_MS 压到 BOOT_MS 以下，断言：
 *   1. 窗口一过 starting 照旧翻 false（启动期排队的消息不被这次修复拖住）；
 *   2. 之后 session.state 里终究出现 model = fake-model、modelName = Fake Model。
 *
 * Run: npm --prefix bridge run build && node bridge/tests/boot-slow-state.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { freePort } from "../../tools/free-port.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "boot-slow-state");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
/** 桩 pi 的「启动」时长：够长到任何「等它」的实现都会明显超时。 */
const BOOT_MS = 3000;
const WINDOW_MS = 1000;

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
    PI_WEB_BOOT_STATE_MS: String(WINDOW_MS),
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

  log(`创建会话（桩 pi 「启动」${BOOT_MS} ms，桥只等 ${WINDOW_MS} ms）`);
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: "create", cwd: REPO, name: "启动超慢的会话" }));
  const created = await waitFor((m) => m.type === "session" && m.state?.name === "启动超慢的会话", 20000, "session 帧");
  const sid = created.sessionId ?? created.state?.id;
  const settled = await waitFor((m) => m.type === "session.state" && m.session?.id === sid && m.session?.starting === false, 20000, "starting=false");
  check(settled._at - t0 < BOOT_MS, `启动窗口一过 starting 就翻 false（${settled._at - t0} ms < ${BOOT_MS} ms）`);
  const st = await waitFor((m) => m.type === "session.state" && m.session?.id === sid && m.session?.model, 15000, "model 到达").catch(() => null);
  check(st?.session?.model === "fake-model", `超时之后仍拿到模型 id（${JSON.stringify(st?.session?.model)}）`);
  check(st?.session?.modelName === "Fake Model", `以及模型名（${JSON.stringify(st?.session?.modelName)}）`);

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
