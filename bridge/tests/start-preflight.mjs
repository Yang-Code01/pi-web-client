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
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort } from "../../tools/free-port.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PREFLIGHT = path.join(ROOT, "scripts", "preflight.mjs");
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
const info = {
  ok: true,
  version: "0.0.0-stub",
  buildId: "stub",
  pid: process.pid,
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

const children = [];

async function startStub(kind, port) {
  const entry = kind === "foreign" ? FOREIGN : STUB;
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      STUB_PORT: String(port),
      STUB_STOP: path.join(TMP, `stop-${port}.txt`),
      STUB_LEGACY: kind === "legacy" ? "1" : "0",
      STUB_GARBLED: kind === "garbled" ? "1" : "0",
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

/** 起一次 preflight。stdin 给 `ignore`：这就是 CI / `| tee` 那类非交互场景。 */
function runPreflight(port, args = []) {
  // 卡住（powershell 挂起、readline 等输入）时不能把整轮测试拖成永不结束的进程。
  const LIMIT_MS = 60_000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PREFLIGHT, ...args], {
      env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_STATE: STATE, PI_START_FORCE: "" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (out += String(c)));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经没了 */
      }
      resolve({ code: null, out: `${out}\n[preflight 跑了 ${LIMIT_MS / 1000}s 还没退，已经收掉]` });
    }, LIMIT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
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

  console.log("start-preflight: ok");
} catch (err) {
  console.error(String(err?.stack ?? err));
  process.exitCode = 1;
} finally {
  for (const child of children) {
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
