/**
 * #226：网页会话 spawn 时带两段系统提示词 —— 「工作区教训」+「交付礼仪」，开关各自独立。
 *
 * A. 默认：argv 里两个 `--append-system-prompt`，一段是 lessons/ 下的账本文件（本仓库的老毛病），
 *    另一段是交付提示词：声明覆盖全局 AGENTS.md 的「产物交付」、先问卷再 `open_preview`、
 *    不起浏览器窗口、`no-page` / `untrusted-path` 怎么说话、打不开的格式指向「用本机程序打开」。
 * B. `PI_WEB_HINT=0`：只剩教训那一段（提示词关掉不能顺手把教训也顶掉）。
 * C. `PI_WEB_LESSONS=0`：只剩交付提示词（反过来也一样）。
 *
 * 自带丢弃式 bridge + 脚本化 pi（fixture 把 argv 写进 FAKE_PI_LOG），不花模型 turn、
 * 不碰 7864。每个用例按系统分配的空闲端口起桥，三个用例可以连跑、也不会撞上别的探针。
 *
 *   node bridge/tests/hint-spawn.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const ROOT = path.join(REPO, ".scratch", "hint-spawn");
const PASS = "hint-spawn-pass";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 系统分配一个空闲端口：三个用例连跑，固定端口容易撞上别的探针或还没放掉的监听。 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });

/**
 * 工作区 id = 归一化工程根的小写形式（bridge/src/workspaces.ts 的 `normalizePath` + `groupId`）。
 * 这里只对一个刚 `git init` 的目录做一次，与桥的 `keyOf` 走同一条推导，不 import 那份 TS ——
 * 那条 import 会把 statefile.ts 的参数属性带进来，普通 `node` 跑不动。
 */
const groupId = (dir) => dir.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "").toLowerCase();

/** 账本里出现 3 次同类失败 —— `MIN_COUNT` 才够「老毛病」的门槛，教训那段才会生成。走 WS 写，跟页面同一条路。 */
const seedEntries = () =>
  ["2026-11-01T00:00:00Z", "2026-11-03T00:00:00Z", "2026-11-05T00:00:00Z"].map((when) => ({
    key: "bash|path|cd <path>",
    at: when,
    tool: "bash",
    code: "path",
    sig: "cd <path>",
    exit: 1,
    cmd: "cd /nope",
    out: "bash: cd: /nope: No such file or directory",
    why: "目录不存在",
    fix: "",
  }));

/** argv 里所有 `--append-system-prompt` 的值，按出现顺序。 */
const prompts = (argv) => argv.flatMap((a, i) => (a === "--append-system-prompt" ? [argv[i + 1] ?? ""] : []));

async function bootCase(label, extra = {}) {
  const port = await freePort();
  const root = path.join(ROOT, label);
  const state = path.join(root, "state");
  const agent = path.join(root, "agent");
  const cwd = path.join(root, "repo");
  const piLog = path.join(root, "fake-pi.jsonl");
  for (const d of [state, agent, cwd]) fs.mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd }); // 工作区 id = 工程根的小写归一化，测试要自己算

  const env = { ...process.env };
  delete env.PI_WEB_HINT;
  delete env.PI_WEB_LESSONS;
  Object.assign(
    env,
    {
      PI_WEB_PORT: String(port),
      PI_WEB_STATE: state,
      PI_WEB_TUNNEL: "0",
      PI_WEB_HOST: "127.0.0.1",
      PI_WEB_ROOT: path.join(REPO, "web", "dist"),
      PI_AGENT_DIR: agent,
      PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
      FAKE_PI_LOG: piLog,
    },
    extra,
  );

  execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
  const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  let bridgeLog = "";
  bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
  bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) {
        healthy = true;
        break;
      }
    } catch {
      /* wait */
    }
    await sleep(200);
  }
  if (!healthy) {
    try {
      bridge.kill();
    } catch {
      /* already gone */
    }
    throw new Error(`${label}: bridge never came up on ${port}
${bridgeLog.slice(-3000)}`);
  }

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
  const seen = [];
  ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
  ws.on("error", (err) => console.error(`${label}: ws error — ${err.message}
${bridgeLog.slice(-3000)}`));
  await new Promise((r) => ws.on("open", r));

  // 先喂账本，再开会话：教训文件是 spawn 那一刻读的（bridge/src/lessons.ts 的 lessonFile）。
  const wsId = groupId(cwd);
  ws.send(
    JSON.stringify({
      type: "failures.commit",
      ws: wsId,
      sid: `seed-${label}`,
      sname: label,
      at: "2026-11-07T00:00:00Z",
      entries: seedEntries(),
    }),
  );
  for (let i = 0; i < 50 && !seen.some((m) => m.type === "failures.saved"); i++) await sleep(100);

  ws.send(JSON.stringify({ type: "create", cwd, name: label }));
  let sessionId = null;
  for (let i = 0; i < 300 && !sessionId; i++) {
    const hit = seen.find((m) => m.type === "session" && m.state?.id);
    if (hit) sessionId = hit.state.id;
    else await sleep(200);
  }
  if (!sessionId) {
    console.error(`no session for ${label}:`, bridgeLog.slice(-2000));
    try {
      bridge.kill();
    } catch {
      /* already gone */
    }
    throw new Error(`no session: ${label}`);
  }

  // 桥还会用同一个 bin 起一个 `-ne --no-session` 的模型探测子进程，别把它算进来。
  const bootLines = () =>
    fs.existsSync(piLog)
      ? fs
          .readFileSync(piLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((l) => l.t === "argv" && (l.argv ?? []).includes("--session-id"))
      : [];
  for (let i = 0; i < 100 && !bootLines().length; i++) await sleep(100);

  const argv = bootLines()[0]?.argv ?? [];
  const stop = async () => {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    try {
      bridge.kill();
    } catch {
      /* already gone */
    }
    await sleep(700);
  };
  return { argv, stop, log: () => bridgeLog };
}

const HINT_NEEDS = ["覆盖", "要在预览里打开吗", "先不看", "open_preview", "no-page", "untrusted-path", "用本机程序打开"];
const lessonFileOf = (ps) => ps.find((p) => !p.includes("open_preview")) ?? "";
const hintOf = (ps) => ps.find((p) => p.includes("open_preview")) ?? "";

// ---- A. 默认：两段都在 ----
{
  const a = await bootCase("both");
  const ps = prompts(a.argv);
  check("默认：两段 --append-system-prompt", ps.length === 2, JSON.stringify(ps.map((p) => p.slice(0, 40))));
  const lessonPath = lessonFileOf(ps);
  check("其中一段是 lessons/ 下的教训文件", lessonPath.includes("lessons") && fs.existsSync(lessonPath), lessonPath);
  const lessonBody = lessonPath && fs.existsSync(lessonPath) ? fs.readFileSync(lessonPath, "utf8") : "";
  check("教训文件里就是「反复踩的坑」", lessonBody.includes("反复踩的坑"), lessonBody.split("\n")[0] ?? "");
  const hint = hintOf(ps);
  const missing = HINT_NEEDS.filter((w) => !hint.includes(w));
  check("另一段是交付提示词（覆盖关系、问卷、open_preview、失败话术）", Boolean(hint) && !missing.length, missing.join(" / ") || "全部命中");
  check("交付提示词是短文本，不是文件路径", hint.split("\n").length <= 15 && !fs.existsSync(hint), `${hint.split("\n").length} 行`);
  await a.stop();
}

// ---- B. PI_WEB_HINT=0：教训那段必须还在 ----
{
  const b = await bootCase("hint-off", { PI_WEB_HINT: "0" });
  const ps = prompts(b.argv);
  check("PI_WEB_HINT=0：只剩一段 --append-system-prompt", ps.length === 1, JSON.stringify(ps.map((p) => p.slice(0, 40))));
  const lessonPath = ps[0] ?? "";
  check("留下的正是教训文件（没被开关顶掉）", lessonPath.includes("lessons") && fs.existsSync(lessonPath), lessonPath);
  const lessonBody = lessonPath && fs.existsSync(lessonPath) ? fs.readFileSync(lessonPath, "utf8") : "";
  check("教训文件内容照旧", lessonBody.includes("反复踩的坑"));
  check("整条 argv 里没有交付提示词", b.argv.every((a) => !a.includes("open_preview") && !a.includes("用本机程序打开")));
  await b.stop();
}

// ---- C. PI_WEB_LESSONS=0：反过来也不互相顶掉 ----
{
  const c = await bootCase("lessons-off", { PI_WEB_LESSONS: "0" });
  const ps = prompts(c.argv);
  check("PI_WEB_LESSONS=0：只剩一段 --append-system-prompt", ps.length === 1, JSON.stringify(ps.map((p) => p.slice(0, 40))));
  check("留下的是交付提示词", hintOf(ps) !== "" && HINT_NEEDS.every((w) => hintOf(ps).includes(w)));
  check("没有教训文件路径", ps.every((p) => !p.includes("lessons")));
  await c.stop();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} 条失败` : `\n全部通过（${results.length} 项）`);
process.exit(failed ? 1 : 0);
