#!/usr/bin/env node
/**
 * 启动前的端口检查（`scripts/preflight.mjs`）的进程边界测试（D441）。
 *
 * 为什么要在进程边界上考：这个脚本干的活是「看别的进程的命令行、请它自己收工、必要时硬杀」，
 * 把这几件事换成桩就什么都没验到。所以桩占用者是**真的**一个进程，而且落在
 * `<tmp>/bridge/dist/host.js` 上 —— 路径里带着桥的入口名，「命令行里是桥入口」那条校验
 * 才会自然通过，测到的才是 preflight 自己的认人逻辑，而不是它被喂了什么。
 *
 * 每个用例都用免费的临时端口；**绝不在 7864 上跑**（那是正在服务本机的那一份）。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { freePort } from "../../tools/free-port.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PREFLIGHT = path.join(ROOT, "scripts", "preflight.mjs");
const START = path.join(ROOT, "scripts", "start.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-"));
const STATE = path.join(TMP, "state");
/** 本项目的桥：路径里有 `bridge/dist/host.js`，认人那一步才会认成「自己人」。 */
const STUB = path.join(TMP, "fake", "bridge", "dist", "host.js");
/** 别人的服务：只是个会答 /healthz 的服务器，命令行跟桥无关。 */
const FOREIGN = path.join(TMP, "other", "server.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
    await sleep(80);
  }
}

async function healthz(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) });
    return res.ok ? await res.json().catch(() => ({})) : null;
  } catch {
    return null;
  }
}

/**
 * 桩：答 /healthz（带上自己的 pid）、可选地答 /api/host/stop。
 * `legacy=1` 模拟 `PI_HOST_DISABLE=1` 起的旧桥：/healthz 里没有 `brain` 键，也没有停机接口。
 */
const STUB_SRC = `
import fs from "node:fs";
import http from "node:http";
const port = Number(process.env.STUB_PORT);
const legacy = process.env.STUB_LEGACY === "1";
// /healthz 回一句不是 JSON 的东西：模拟回包被截断。
const garbled = process.env.STUB_GARBLED === "1";
const mark = process.env.STUB_STOP;
// /healthz 报的 pid 可以被 STUB_SAY_PID 改掉：模拟「回包里的 pid 是别人」（被反代答了）。
const sayPid = Number(process.env.STUB_SAY_PID || 0);
const info = {
  ok: true,
  version: "0.0.0-stub",
  buildId: "stub",
  pid: sayPid > 0 ? sayPid : process.pid,
  uptime: 5,
  sessions: [{ id: "s1", pid: process.pid, turnActive: true }],
};
if (!legacy) info.brain = { pid: process.pid, ready: true };
const srv = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(garbled ? '{"ok":tru' : JSON.stringify(info));
    return;
  }
  if (req.url === "/api/host/stop" && !legacy) {
    fs.writeFileSync(mark, "stopped");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => process.exit(0), 30);
    return;
  }
  res.writeHead(404);
  res.end();
});
srv.listen(port, "127.0.0.1");
`;

fs.mkdirSync(path.dirname(STUB), { recursive: true });
fs.mkdirSync(path.dirname(FOREIGN), { recursive: true });
fs.writeFileSync(STUB, STUB_SRC);
fs.writeFileSync(FOREIGN, STUB_SRC);

/** 按树收掉（Windows 上 `taskkill /T`；这里只用于测试自己的子进程，它们的树里没有别人的会话）。 */
function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已经没了 */
  }
}

const children = [];
/** 第 8 例手工写下的 pid 文件，收尾时要拆（真桥会自己删，桩不会）。 */
let plantedPidFile = null;

async function startStub(kind, port, extra = {}) {
  const entry = kind === "foreign" ? FOREIGN : STUB;
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      STUB_PORT: String(port),
      STUB_STOP: path.join(TMP, `stop-${port}.txt`),
      STUB_LEGACY: kind === "legacy" ? "1" : "0",
      STUB_GARBLED: kind === "garbled" ? "1" : "0",
      ...extra,
    },
    // 桩自己崩了（端口被抢、`STUB_PORT` 非法）也要把它最后那句话带出来：
    // 否则现场只剩一句「超时：桩在 :N 上起来」，没法排查。
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  child.log = "";
  child.stdout.on("data", (c) => (child.log += String(c)));
  child.stderr.on("data", (c) => (child.log += String(c)));
  try {
    await until(async () => (await healthz(port)) !== null, `桩（${kind}）在 :${port} 上起来`);
  } catch (err) {
    throw new Error(`${err.message}\n--- 桩（${kind}）的输出 ---\n${child.log || "（一句都没说）"}`);
  }
  return child;
}

/** 起一次 preflight。stdin 给 `ignore`：这就是 CI / `| tee` 那类非交互场景。
 * `entry` 换成 `start.mjs` 就能考它那条路（它内部那次检查传 `ask: false`）。 */
function runPreflight(port, args = [], entry = PREFLIGHT, { fakeTty = false, limitMs = 60_000 } = {}) {
  // 卡住（powershell 挂起、readline 等输入）时不能把整轮测试拖成永不结束的进程。
  const LIMIT_MS = limitMs;
  return new Promise((resolve) => {
    // 假 TTY：把 `process.stdin` 换成一个 `isTTY = true` 的空流。readline 会在它上面等输入、
    // 永远等不到（没有底层句柄），这正是我们要的：被测的那条路要是问了，就卡到超时那一档。
    const prelude = fakeTty
      ? `import { PassThrough } from "node:stream"; const s = new PassThrough(); s.isTTY = true; Object.defineProperty(process, "stdin", { value: s, configurable: true }); await import(${JSON.stringify(pathToFileURL(entry).href)});`
      : null;
    // `--` 之后的才进 `process.argv`：不加的话 `--force` 会被 node 当成自己的选项。
    // `-e` 模式下 node 吃掉 `argv[1]`，所以先塞一个占位的脚本名，`process.argv.slice(2)` 才与直跑一致。
    const argv = prelude ? ["--input-type=module", "-e", prelude, "--", "start.mjs", ...args] : [entry, ...args];
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_STATE: STATE, PI_START_FORCE: "" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // 也交给 finally 统一收：前面的断言炸掉时，这一份不该留到整轮测试结束。
    children.push(child);
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (out += String(c)));
    const note = () => `${out}\n[preflight 跑了 ${LIMIT_MS / 1000}s 还没退，已经收掉]`;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已经没了 */
      }
      // kill 只是发信号：它若连 SIGTERM 都不理，5 秒后强行落地，别让 Promise 永远悬着。
      // 但这一例算失败（`code: null`），后面那些「端口空了」的断言会当场红 —— 真发生了就该红，
      // 而不是让下一例去撞一个还活着的旧进程。
      setTimeout(() => {
        try {
          killTree(child.pid);
        } catch {
          /* 已经没了 */
        }
        resolve({ code: null, out: note() });
      }, 5000).unref();
    }, LIMIT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      // 超时那条路也要等 exit 再返回：立刻 resolve 的话，它可能还在跑、下一例撞上同一个端口。
      resolve({ code: timedOut ? null : code, out: timedOut ? note() : out });
    });
  });
}

try {
  // 1. 端口空着：一声不响地放行（常见路径，别在每次 npm start 里刷屏）。
  {
    const port = await freePort();
    const r = await runPreflight(port);
    assert.equal(r.code, 0, `端口空着应当放行：${r.out}`);
    assert.equal(r.out.trim(), "", "空闲路径不该有任何输出");
  }

  // 2. 端口上是自己那份 + --force：走优雅停机（POST /api/host/stop），不硬杀。
  {
    const port = await freePort();
    const stub = await startStub("ours", port);
    const mark = path.join(TMP, `stop-${port}.txt`);
    const r = await runPreflight(port, ["--force"]);
    assert.equal(r.code, 0, `停掉之后应当放行：${r.out}`);
    assert.ok(fs.existsSync(mark), "应当先请它自己收工（/api/host/stop），而不是直接硬杀");
    await until(async () => stub.exitCode !== null, "壳自己退掉");
    await until(async () => (await healthz(port)) === null, "桩退出、端口空出来");
    assert.equal(stub.exitCode, 0, "优雅停机应当让壳自己以 0 退出");
  }

  // 3. 认出来了，但没交互终端又没 --force：只看不动，退出 2，并告诉用户怎么授权。
  {
    const port = await freePort();
    const stub = await startStub("ours", port);
    const r = await runPreflight(port);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /已经有一份 pi-web-client 在跑/, "要认出是自己那份");
    assert.match(r.out, new RegExp(`pid ${stub.pid}`), "要把 pid 指出来");
    assert.match(r.out, /不是交互终端/, "要说清为什么不问");
    assert.match(r.out, /--force/, "要给出授权的办法");
    assert.ok(await healthz(port), "没被授权时绝不许动它");
  }

  // 4. 别人的服务：连 --force 也不许动，只把证据印出来、让用户自己处理。
  {
    const port = await freePort();
    const stub = await startStub("foreign", port);
    const r = await runPreflight(port, ["--force"]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /被别的程序占着/, "不是自己人就别冒充");
    assert.match(r.out, /PI_WEB_PORT/, "要给换端口的出口");
    assert.ok(await healthz(port), "别人的服务绝不能被停掉");
    assert.equal(stub.exitCode, null, "桩必须还活着");
  }

  // 5. 认出来是自己那份，但 /healthz 回包读不懂（被截断）：不敢断它有没有壳，就别硬杀，
  //    只试一次优雅停机；它自己退了才算成功。
  {
    const port = await freePort();
    const stub = await startStub("garbled", port);
    const mark = path.join(TMP, `stop-${port}.txt`);
    const r = await runPreflight(port, ["--force"]);
    assert.equal(r.code, 0, `优雅停成功就该放行：${r.out}`);
    assert.match(r.out, /healthz 没读懂/, "要说清为什么不敢硬杀");
    assert.ok(fs.existsSync(mark), "应当先请它自己收工");
    await until(() => stub.exitCode !== null || stub.signalCode !== null, "桩自己退掉", 5000);
    assert.equal(stub.exitCode, 0, "走的是优雅停机，不是被硬杀");
  }

  // 6. 没有壳的旧桥（PI_HOST_DISABLE=1）：没有停机接口，只能硬杀；硬杀完端口要真空出来。
  {
    const port = await freePort();
    const stub = await startStub("legacy", port);
    const r = await runPreflight(port, ["--force"]);
    assert.equal(r.code, 0, `硬杀之后应当放行：${r.out}`);
    assert.match(r.out, /只能硬杀/, "要预先说明它会硬杀（可能留孤儿 pi）");
    await until(async () => (await healthz(port)) === null, "旧桥被硬杀、端口空出来");
    // 端口空出来不等于进程真没了（它可能自己关了监听但还在跑）：硬杀要看到进程退。
    await until(() => stub.exitCode !== null || stub.signalCode !== null, "旧桥进程被停掉", 5000);
  }

  // 7. `scripts/start.mjs` 那条路（`start:nobuild` / 直跑）：它内部那次检查**不提问**——链首已经问过
  //    用户了。没授权时只看不动、退出 2，并说清「这一次不再问第二遍」；有 `--force` 才动手。
  //    stdin 给一个假 TTY（它会读 isTTY）：要是它还问，就会卡在读输入上，直到 60s 超时那一档。
  {
    const port = await freePort();
    const stub = await startStub("ours", port);
    // start.mjs 先看 bridge/dist 里有没有入口；这个 worktree 里构建过才有。
    assert.ok(fs.existsSync(path.join(ROOT, "bridge", "dist", "host.js")), "先 npm run build:bridge");
    const r = await runPreflight(port, [], START, { fakeTty: true });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /不再问第二遍/, "要说清这一次为什么不问");
    assert.match(r.out, /--force/, "要给出授权的办法");
    assert.ok(await healthz(port), "没被授权时绝不许动它");
    assert.equal(stub.exitCode, null, "桩必须还活着");
    // 有授权就在第二次也动手：这是「检查完到 listen 之间又被抢」那条路的出口。
    const mark = path.join(TMP, `stop-${port}.txt`);
    // 有授权就在第二次也动手。start.mjs 动完手会接着 spawn 真的壳，这里只要看它没被退出 2 拦住、
    // 也没在提问上卡住：拿到口令那一行就算过去了。
    const r2 = await runPreflight(port, ["--force"], START, { fakeTty: true, limitMs: 25_000 });
    assert.notEqual(r2.code, 2, `带 --force 不该被端口检查拦住：${r2.out}`);
    assert.match(r2.out, /已启动/, `第二次检查之后要接着起壳：${r2.out}`);
    assert.ok(fs.existsSync(mark), "带 --force 时第二次也走优雅停机");
    await until(() => stub.exitCode !== null || stub.signalCode !== null, "壳自己退掉", 5000);
  }

  // 8. `/healthz` 报的不是这份桥的 pid（被反代答了、或者回包里是别人的号），pid 文件里才是它：
  //    `/healthz` 这条线索认出来的是外人，不能就此收手 —— 要接着看 pid 文件与 listen 枚举，
  //    否则端口上自己那份会被误判成外人，连 `--force` 都不肯动。
  {
    const port = await freePort();
    const otherPort = await freePort();
    const foreign = await startStub("foreign", otherPort);
    const stub = await startStub("ours", port, { STUB_SAY_PID: String(foreign.pid) });
    // 与真桥一致：pid 文件里记的是自己。
    plantedPidFile = path.join(os.tmpdir(), `pi-web-bridge-${port}.pid`);
    fs.writeFileSync(plantedPidFile, `${stub.pid}\n`);
    const r = await runPreflight(port, ["--force"]);
    assert.equal(r.code, 0, `listen 上的自己人也要认出来：${r.out}`);
    await until(async () => (await healthz(port)) === null, "停掉之后端口空出来");
    assert.equal(foreign.exitCode, null, "被 /healthz 指错的那个外人绝不能被碰");
  }

  console.log("start-preflight: ok");
} catch (err) {
  console.error(String(err?.stack ?? err));
  process.exitCode = 1;
} finally {
  if (plantedPidFile) fs.rmSync(plantedPidFile, { force: true });
  for (const child of children) {
    // 已经退了的 pid 不能碰：那个号可能已经被系统发给了别人（`ChildProcess.kill()` 自己也会拦，
    // 这里写明是为了读代码的人不用去查它拦不拦）。
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill();
    } catch {
      /* 已经没了 */
    }
  }
  await sleep(300);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔还攥着文件，留给临时目录自己清 */
  }
}
