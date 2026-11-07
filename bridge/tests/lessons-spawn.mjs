/**
 * 老毛病回流的两块，在真进程里走一遍（D164 延伸）：
 *
 *   A. 账本里有反复出现的类 → 下次 spawn 的 argv 里多一个 `--append-system-prompt <文件>`，
 *      文件内容就是「这个工作区过去反复踩的坑」（不是替用户顶掉他手填的那段）；
 *   B. 会话跑着的时候发 `failures.remind` → 桥往会话里补一条「[自动提醒 · 老毛病重犯]」，
 *      同一类第二次不再重复（节流在桥里，不靠前端自觉）。
 *
 * 自带丢弃式 bridge + 脚本化 pi（fixture 启动时会把 argv 写进 FAKE_PI_LOG），不花模型 turn、
 * 不碰 7864。端口默认 7896，可用 LESSONS_PORT 改。
 *
 *   node bridge/tests/lessons-spawn.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { groupId, normalizePath } from "../src/workspaces.ts";

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.LESSONS_PORT ?? 7896);
const ROOT = path.join(REPO, ".scratch", "lessons-spawn");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const REPO_DIR = path.join(ROOT, "repo");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "lessons-spawn-pass";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(AGENT, { recursive: true });
fs.mkdirSync(REPO_DIR, { recursive: true });
// 一个真 git 根：工作区 id 是「工程根的小写归一化」，测试要能自己算出同一个字符串。
execFileSync("git", ["init", "-q"], { cwd: REPO_DIR });
const WS_ID = groupId(normalizePath(REPO_DIR));

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
};
// 测试进程自己也要用同一个 state 目录读写账本。
process.env.PI_WEB_STATE = STATE;
const { mergeFailures } = await import("../src/failures.ts");

execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));
const done = (code) => {
  try {
    bridge.kill();
  } catch {
    /* already gone */
  }
  process.exit(code);
};

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
const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
const seen = [];
ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
await new Promise((r) => ws.on("open", r));

const piLog = () =>
  fs.existsSync(PI_LOG) ? fs.readFileSync(PI_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
/** 会话自己那次 spawn —— 桥还会用同一个 bin 起一个 `-ne --no-session` 的模型探测子进程，别把它算进来。 */
const bootLines = () => piLog().filter((l) => l.t === "argv" && (l.argv ?? []).includes("--session-id"));

ws.send(JSON.stringify({ type: "create", cwd: REPO_DIR, name: "lessons-spawn" }));
let sessionId = null;
for (let i = 0; i < 300 && !sessionId; i++) {
  const hit = seen.find((m) => m.type === "session" && m.state?.id);
  if (hit) sessionId = hit.state.id;
  else await sleep(200);
}
if (!sessionId) {
  console.error("no session:", bridgeLog.slice(-2000));
  done(1);
}
console.log("session", sessionId, "ws", WS_ID);

for (let i = 0; i < 100 && !bootLines().length; i++) await sleep(100);
check("第一次 spawn：账本还空，不追加系统提示词", bootLines().length >= 1 && !bootLines()[0].argv.includes("--append-system-prompt"), JSON.stringify(bootLines()[0]?.argv ?? []));

const item = (at) => ({
  key: "bash|path|cd <path>",
  at,
  tool: "bash",
  code: "path",
  sig: "cd <path>",
  exit: 1,
  cmd: "cd /nope",
  out: "bash: cd: /nope: No such file or directory",
  why: "目录不存在",
  fix: "",
});
mergeFailures({
  ws: WS_ID,
  sid: sessionId,
  sname: "lessons-spawn",
  at: "2026-11-07T00:00:00Z",
  items: [item("2026-11-01T00:00:00Z"), item("2026-11-03T00:00:00Z"), item("2026-11-05T00:00:00Z")],
});

// 关掉再发一条消息：openLive 会重新 spawn，第二次的 argv 才是要验的那次。
ws.send(JSON.stringify({ type: "close", sessionId }));
await sleep(800);
ws.send(JSON.stringify({ type: "prompt", sessionId, text: "reopen" }));
for (let i = 0; i < 200 && bootLines().length < 2; i++) await sleep(100);
const second = bootLines()[1];
check("第二次 spawn：带上 --append-system-prompt", Boolean(second?.argv.includes("--append-system-prompt")));
const lessonPath = second ? second.argv[second.argv.indexOf("--append-system-prompt") + 1] ?? "" : "";
check("提示词文件落在 state 的 lessons/ 下", lessonPath.includes("lessons") && fs.existsSync(lessonPath), lessonPath);
const lessonBody = lessonPath && fs.existsSync(lessonPath) ? fs.readFileSync(lessonPath, "utf8") : "";
check("文件里就是「反复踩的坑」那一段", lessonBody.includes("反复踩的坑") && lessonBody.includes("3 次 · bash · cd <path>"));

// 当场叫住：会话正跑着（刚发过 prompt），桥应当把它当 followUp 补进 pi 的输入。
const turns = () => piLog().filter((l) => l.t === "turn");
const before = turns().length;
const remind = (key) => ({ type: "failures.remind", ws: WS_ID, sid: sessionId, key, tool: "bash", sig: "cd <path>", why: "目录不存在", n: 9 });
ws.send(JSON.stringify(remind("bash|path|cd <path>")));
for (let i = 0; i < 50 && turns().length === before; i++) await sleep(100);
check("同一类再犯：桥补一条自动提醒", turns().slice(before).some((t) => String(t.text).includes("[自动提醒 · 老毛病重犯]")));
const acks = () => seen.filter((m) => m.type === "failures.reminded");
check("桥回执说投递成功（ok:true）", acks().some((m) => m.ok === true && m.key === "bash|path|cd <path>"));

const after = turns().length;
ws.send(JSON.stringify(remind("bash|path|cd <path>")));
await sleep(1200);
check("同一类只提醒一次（桥里节流，不靠前端）", turns().length === after);
check("第二发不被当成新提醒：回执 ok:false", acks().some((m) => m.ok === false));

const failed = results.filter((r) => !r.ok).length;
if (failed) console.error(`\n--- bridge log ---\n${bridgeLog.slice(-2500)}`);
console.log(failed ? `\n${failed} 条失败` : "\n全部通过");
done(failed ? 1 : 0);
