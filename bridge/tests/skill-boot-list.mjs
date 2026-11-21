/**
 * D357：pi 冷启那几秒里，`commands` / `skills` 也得当场有答案，而且必须是「先给磁盘那份、启动完再补
 * 权威版」，不能只是「等 pi 答得动」。
 *
 * 真 pi 冷启要 5 秒（忙时几十秒）才回 `get_commands`；磁盘扫描只要几十毫秒。用户新开一个会话立刻敲
 * `/skill`，原来会对着「没有匹配的命令」干等这 5 秒。桩 pi 的 `FAKE_PI_STARTUP_MS` 就是演这段启动期：
 * 窗口里一条命令都不答（真 pi 就是这么压着的）。
 *
 * 断言：
 *   1. 启动窗口里的 `commands` 往返 < 1 秒，且给的是磁盘清单（有盘上的技能，没有只有 pi 知道的那个）；
 *   2. 同一时刻的 `skills` 同样秒回，同样只有盘上那份；
 *   3. 启动完成后桥**自己推**一帧 `commands` 与一帧 `skills`，里面补上只有 pi 知道的技能和扩展命令；
 *   4. 窗口里问了两次也只推一次（一排一份，不按请求数翻倍）。
 *
 * Run: npm --prefix bridge run build && node bridge/tests/skill-boot-list.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { freePort } from "../../tools/free-port.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "skill-boot-list");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
/** 桩 pi 的启动期：比桥给启动期的窗口（1000 ms）长得多，任何「等 pi 答」的实现都会明显超时。 */
const STARTUP_MS = 3000;
const WINDOW_MS = 1000;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
// 盘上的那份清单：用户技能目录里放一个，别的什么都不放 —— 「只有 pi 知道」的那个只出现在桩 pi 的回包里。
const SKILL_DIR = path.join(AGENT, "skills", "alpha-skill");
fs.mkdirSync(SKILL_DIR, { recursive: true });
fs.writeFileSync(path.join(SKILL_DIR, "SKILL.md"), "---\nname: alpha-skill\ndescription: 盘上那个技能\n---\n\n正文。\n");

const PI_COMMANDS = [
  { name: "skill:alpha-skill", description: "盘上那个技能", source: "skill" },
  { name: "skill:boot-only", description: "只有 pi 知道（扩展自带的）", source: "skill" },
  { name: "mcp", description: "扩展命令", source: "extension" },
];

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
    FAKE_PI_STARTUP_MS: String(STARTUP_MS),
    FAKE_PI_COMMANDS: JSON.stringify(PI_COMMANDS),
    PI_WEB_BOOT_STATE_MS: String(WINDOW_MS),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

const names = (list) => (list ?? []).map((c) => String(c?.name ?? ""));

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

  /** 每一帧都记下来（type + 到达时刻）；`commands` / `skills` 的应答与推送在同一个流里。 */
  const frames = [];
  const waits = new Set();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    frames.push({ msg, at: Date.now() });
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
    const hit = frames.find((f) => pred(f.msg));
    if (hit) return Promise.resolve(hit.msg);
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

  log(`创建会话（桩 pi 「启动」${STARTUP_MS} ms，桥只等 ${WINDOW_MS} ms）`);
  send({ type: "create", cwd: REPO, name: "启动窗口里的清单" });
  const created = await waitFor((m) => m.type === "session" && m.state?.name === "启动窗口里的清单", 20000, "session 帧");
  const sid = created.sessionId ?? created.state?.id;
  check(Boolean(sid), `会话建好 ${sid}`);
  const starting = frames.find((f) => f.msg.type === "session.state" && f.msg.session?.id === sid);
  check(starting?.msg?.session?.starting === true, "此刻 pi 还在启动（starting = true）");

  // ---- 1. 启动窗口里的 commands：必须秒回，且给的是磁盘那份
  const t1 = Date.now();
  const cmdWait = waitFor((m) => m.type === "commands" && m.sessionId === sid, 20000, "commands 应答");
  send({ type: "commands", sessionId: sid, cwd: REPO });
  const first = await cmdWait;
  const took1 = Date.now() - t1;
  check(took1 < WINDOW_MS, `启动窗口里 commands 秒回（${took1} ms < ${WINDOW_MS} ms）`);
  const firstNames = names(first.commands);
  check(firstNames.includes("skill:alpha-skill"), `先给盘上那份（有 skill:alpha-skill）`);
  check(!firstNames.includes("skill:boot-only"), `不会凭空造出 pi 还没报的东西（没有 skill:boot-only）`);
  check(!firstNames.includes("mcp"), `也没有扩展命令 mcp`);

  // ---- 2. 同步问一次技能面板：同样秒回，同样只有盘上的
  const t2 = Date.now();
  const skillWait = waitFor((m) => m.type === "skills" && m.sessionId === sid, 20000, "skills 应答");
  send({ type: "skills", sessionId: sid });
  const sk = await skillWait;
  const took2 = Date.now() - t2;
  check(took2 < WINDOW_MS, `启动窗口里 skills 秒回（${took2} ms < ${WINDOW_MS} ms）`);
  check(names(sk.commands).includes("alpha-skill"), "技能面板先拿到盘上的 alpha-skill");
  check(!names(sk.commands).includes("boot-only"), "还没有 boot-only（pi 没报过它）");

  // ---- 3. 启动完成后桥自己推一帧：权威清单补上只有 pi 知道的
  const pushed = await waitFor(
    (m) => m.type === "commands" && m.sessionId === sid && names(m.commands).includes("skill:boot-only"),
    20000,
    "启动完成后的 commands 推送",
  );
  const pushNames = names(pushed.commands);
  check(pushNames.includes("skill:boot-only"), "推送里补上了只有 pi 知道的技能");
  check(pushNames.includes("mcp"), "推送里补上了扩展命令 mcp");
  check(pushNames.includes("skill:alpha-skill"), "盘上的那条也还在");
  const pushedSkills = await waitFor(
    (m) => m.type === "skills" && m.sessionId === sid && names(m.commands).includes("boot-only"),
    20000,
    "启动完成后的 skills 推送",
  );
  check(names(pushedSkills.commands).includes("alpha-skill"), "技能推送里两端都齐了");

  // ---- 4. 窗口里问了两次，只推一次
  await sleep(400);
  const pushes = frames.filter((f) => f.msg.type === "commands" && f.msg.sessionId === sid && names(f.msg.commands).includes("skill:boot-only"));
  check(pushes.length === 1, `只推一次（推了 ${pushes.length} 次）`);

  // ---- 5. 之后的普通请求仍是权威清单，且不再推
  const t3 = Date.now();
  const againWait = waitFor((m) => m.type === "commands" && m.sessionId === sid && names(m.commands).length === PI_COMMANDS.length, 10000, "启动后的 commands");
  send({ type: "commands", sessionId: sid, cwd: REPO });
  const again = await againWait;
  check(Date.now() - t3 < WINDOW_MS, `启动后 commands 也很快（${Date.now() - t3} ms）`);
  check(names(again.commands).length === PI_COMMANDS.length, `条目数与 pi 报的一致（${names(again.commands).length}）`);

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
