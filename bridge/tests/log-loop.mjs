/**
 * D358：桥的 stdout 断了（父进程先死掉 / 管道被关）时，`log()` 不许把自己递归成死循环。
 *
 * 现场：测试跑完把桥留了下来，它的 stdout 管道早断了。`console.log` 抛 EPIPE →
 * `survive`（uncaughtException 处理器）又调 `log()` 记这条错误 → 再抛 EPIPE …… 同一条错误无限
 * 递归。一台机器上残留 18 个这样的桥，每个每秒写 200–500KB，日志涨到 3.5GB，load average 130，
 * 整机（包括正在用的那个桥）都卡到几秒一帧。
 *
 * 这里的做法就是把那条管道剪掉再让它写日志，看三件事：
 *   1. 日志文件不再疯长（修复前这里 1.5 秒能写几 MB 到几百 MB）；
 *   2. 那条日志**照样进得了文件**（只是控制台不再写）；
 *   3. 桥还活着，/healthz 照常应答。
 *
 * Run: npm run build:bridge && node bridge/tests/log-loop.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort } from "../../tools/free-port.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = await freePort();
const ROOT = path.join(REPO, ".scratch", "log-loop");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const BASE = `http://127.0.0.1:${PORT}`;
const LOGFILE = path.join(STATE, "logs", "bridge.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

delete process.env.PI_BIN;
const { resolvePi } = await import("../dist/pi.js");
const realPkg = path.dirname(path.dirname(path.dirname(resolvePi().cli)));

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });

let failed = false;
const check = (cond, msg) => {
  if (cond) console.log("  ok  ", msg);
  else {
    failed = true;
    console.error("  FAIL", msg);
  }
};
const env = { ...process.env };
for (const k of Object.keys(env)) if (/_API_KEY$|_TOKEN$/.test(k)) delete env[k];

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_PEER: "0",
    PI_AGENT_DIR: AGENT,
    PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
    PI_WEB_PI_PKG: realPkg,
    PI_OFFLINE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", () => {});
bridge.stderr.on("data", () => {});

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
}

const sizeOf = () => (fs.existsSync(LOGFILE) ? fs.statSync(LOGFILE).size : 0);
const healthz = async () => {
  const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(5000) });
  return res.ok;
};

try {
  await until(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok, 30000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  check(sizeOf() > 0, `桥起来了，日志已有内容（${sizeOf()} 字节）`);

  // 剪断它的 stdout / stderr：之后任何一次 console.log 都会得到 EPIPE，正是现场那个形状。
  bridge.stdout.destroy();
  bridge.stderr.destroy();
  await sleep(200);

  // 触发一次日志：口令不对 → `log("login failed from …")`。
  const before = sizeOf();
  const bad = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "definitely-not-it" }),
  });
  check(bad.status === 401, `错口令照旧回 401（拿到 ${bad.status}）`);

  await sleep(1500);
  const grown = sizeOf() - before;
  const text = fs.readFileSync(LOGFILE, "utf8");
  const hits = text.split("\n").filter((l) => l.includes("login failed")).length;

  check(hits >= 1, `那条日志还是进了文件（login failed 出现 ${hits} 次）`);
  check(grown < 200 * 1024, `1.5 秒内日志只涨了 ${grown} 字节（修复前是每秒几十万字节的死循环）`);
  check(await healthz(), "剪断 stdout 之后桥仍然应答 /healthz");
  check(bridge.exitCode === null, "桥没有退出");

  // 断言形状：不该出现「uncaughtException: …EPIPE」刷屏的痕迹。
  const epipe = text.split("\n").filter((l) => l.includes("EPIPE")).length;
  check(epipe < 10, `日志里没有 EPIPE 刷屏（${epipe} 行）`);
} catch (err) {
  failed = true;
  console.error("  FAIL", (err && err.message) || err);
} finally {
  bridge.kill("SIGKILL");
  await sleep(200);
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(failed ? "\nlog-loop: FAILED" : "\nlog-loop: ok");
  process.exit(failed ? 1 : 0);
}
