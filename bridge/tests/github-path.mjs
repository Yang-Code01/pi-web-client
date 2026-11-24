/**
 * GitHub 通道：**壳真的挂在了 pi 子进程的 PATH 上**。
 *
 * 这一条是整套设计的最后一厘米 —— 逻辑全对、PATH 没插进去，AI 敲的 `gh` 还是机器上那个，
 * 会话账号等于没做。所以这里不看桥的内部字段，只看桩 pi 自己报上来的两份环境
 * （`bridge/tests/fixtures/fake-pi.mjs` 的 `pathHead` / `githubShim`）。
 *
 *   npm --prefix bridge run build && node bridge/tests/github-path.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { freePort } from "../../tools/free-port.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "github-path");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });
fs.writeFileSync(PI_LOG, "");

let failed = 0;
let n = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "  ok" : "  FAIL"} ${++n}  ${label}${extra ? `  (${extra})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* not yet */
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const notes = () => {
  if (!fs.existsSync(PI_LOG)) return [];
  return fs
    .readFileSync(PI_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};
/** 只认真正的会话进程：桥自己还会 spawn 一个 `pi --version` 探针。 */
const sessionNotes = () => notes().filter((x) => x.t === "argv" && (x.argv ?? []).includes("-e"));

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_BIN: FAKE_PI,
    FAKE_PI_LOG: PI_LOG,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
bridge.stdout.on("data", (b) => (out += b.toString()));
bridge.stderr.on("data", (b) => (out += b.toString()));

let ws = null;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20_000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20_000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", (e) => j(new Error(`ws: ${e.message}`)));
  });
  ws.send(JSON.stringify({ type: "create", cwd: REPO, name: "gh 路径" }));

  await until(() => sessionNotes().some((x) => x.pathHead), 30_000, "会话启动");
  const boot = sessionNotes().find((x) => x.pathHead);
  const binDir = path.join(STATE, "github", "bin");
  check(boot.githubShim === "1", "子进程认得自己在壳底下（PI_WEB_GITHUB_SHIM=1）", String(boot.githubShim));
  check(boot.pathHead === binDir, "PATH 最前面就是壳目录", boot.pathHead);
  check(fs.existsSync(path.join(binDir, "gh")), "壳文件真的落盘了", binDir);
  const shim = fs.readFileSync(path.join(binDir, "gh"), "utf8");
  check(/github-shim\.(js|ts)/.test(shim), "壳指向这个构建里的 github-shim", (shim.match(/github-shim\.\w+/) ?? [""])[0]);
  // 用户的登录 shell 不该被动过：壳目录只在桥起的子进程里。
  check(!(process.env.PATH ?? "").split(path.delimiter).includes(binDir), "壳目录没有写进本机 PATH");
} catch (err) {
  failed += 1;
  console.log(`  FAIL ${err.message}`);
  console.log(out.split("\n").slice(-12).join("\n"));
} finally {
  try {
    ws?.close();
  } catch {
    /* already gone */
  }
  const dead = new Promise((r) => bridge.once("exit", r));
  bridge.kill();
  await Promise.race([dead, sleep(8000)]);
}

console.log(failed ? "\n有断言没过" : `\n全部通过（${n} 条）`);
process.exit(failed ? 1 : 0);
