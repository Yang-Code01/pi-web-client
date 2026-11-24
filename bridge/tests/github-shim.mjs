/**
 * GitHub 通道的壳（#661）：`gh` 真的落到本会话账号上，而且 PATH 真的被改了 —— 这两条都要能看见。
 *
 * 两块：
 *  A. **注入**：起一份真桥 + 桩 pi，读桩 pi 自己记下的启动环境（PATH 头、`PI_WEB_GITHUB_SHIM`），
 *     再断言壳目录里有 `gh` / `gh.cmd`，而且**本机 PATH 没被动过**。
 *  B. **壳自己的行为**：一个只实现两条 shim 路由的假桥 + 一个假的「真 gh」，验
 *     ①令牌交过去 ②回报给桥 ③没装 gh 时内置实现能建 PR ④没实现的子命令明确失败 ⑤桥不在时说人话。
 *
 *   npm run build:bridge && node bridge/tests/github-shim.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { freePort } from "../../tools/free-port.mjs";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const SHIM = path.join(REPO, "bridge", "dist", "github-shim.js");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-github-shim-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假的「真 gh」：把收到的 argv 与 `GH_TOKEN` 原样打出来，让用例断言壳把令牌交了过去。 */
const FAKE_REAL_GH = path.join(tmp, "fake-real-gh.mjs");
fs.writeFileSync(
  FAKE_REAL_GH,
  [
    "// 顶替真 gh：只回显壳给了什么。",
    "const argv = process.argv.slice(2);",
    'process.stdout.write(JSON.stringify({ ghToken: process.env.GH_TOKEN ?? null, argv }) + "\\n");',
    "if (argv[0] === \"pr\" && argv[1] === \"create\") {",
    '  process.stdout.write("https://github.com/acme/widgets/pull/42\\n");',
    "}",
    "process.exit(Number(process.env.FAKE_REAL_GH_EXIT ?? 0));",
    "",
  ].join("\n"),
);

/** 内置实现要在一个真 git 目录里跑：壳用 `identity.cwd` 的 `origin` 认仓库。 */
const work = path.join(tmp, "work", "widgets");
fs.mkdirSync(work, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: work });
execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: work });
fs.writeFileSync(path.join(work, "README.md"), "widgets\n");
execFileSync("git", ["add", "."], { cwd: work });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "修掉残影"], { cwd: work });

// ---------------------------------------------------------------- 假桥（两条 shim 路由）

/** 假桥收到的回报（壳每次收尾都会 POST 一条）。 */
const reports = [];
/** identity 的档位：`ok` / `no-gh`（没真 gh，有令牌）/ `nil`（令牌为空）/ `bare`（两者都没有）。 */
let identityMode = "ok";
/** 内置实现要打的上游（假 GitHub）。 */
const upstreamCalls = [];

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://gh.test");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    upstreamCalls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization ?? null, body });
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/repos/acme/widgets") {
      res.end(JSON.stringify({ default_branch: "main" }));
      return;
    }
    if (url.pathname === "/repos/acme/widgets/pulls" && req.method === "POST") {
      res.end(JSON.stringify({ number: 43, html_url: "https://github.com/acme/widgets/pull/43" }));
      return;
    }
    res.end(JSON.stringify({}));
  });
});
const upstreamBase = await new Promise((r) => upstream.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${upstream.address().port}`)));

const shimBridge = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (req.url === "/api/github/shim/identity" && req.headers["x-pi-loopback"] !== "tok-shim") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/github/shim/identity") {
      res.end(
        JSON.stringify({
          ok: true,
          login: identityMode === "nil" ? null : "qingmin-new",
          source: "session",
          token: identityMode === "nil" || identityMode === "bare" ? null : "gho_fake_qingmin-new",
          realGh: identityMode === "no-gh" || identityMode === "bare" ? null : FAKE_REAL_GH,
          sessionId: "s1",
          cwd: work,
          api: upstreamBase,
        }),
      );
      return;
    }
    if (req.url === "/api/github/shim/report") {
      reports.push(body);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.end("{}");
  });
});
const shimBase = await new Promise((r) => shimBridge.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${shimBridge.address().port}`)));

/** 跑一次壳，返回 stdout / stderr / 退出码。 */
function runShim(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIM, ...args], {
      env: { ...process.env, PI_WEB_LOOPBACK: shimBase, PI_WEB_LOOPBACK_TOKEN: "tok-shim", PI_WEB_GITHUB_REAL_GH_JS: FAKE_REAL_GH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------- B. 壳

test("壳：把本会话的令牌交给真 gh（透传），并把这次调用回报给桥", async () => {
  reports.length = 0;
  const r = await runShim(["api", "user", "--jq", ".login"]);
  assert.equal(r.code, 0);
  const got = JSON.parse(r.stdout.trim().split("\n")[0]);
  assert.equal(got.ghToken, "gho_fake_qingmin-new", "GH_TOKEN 就是本会话账号的令牌");
  assert.deepEqual(got.argv, ["api", "user", "--jq", ".login"]);
  await sleep(150);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].argv, ["api", "user", "--jq", ".login"]);
  assert.equal(reports[0].exit, 0);
  assert.equal(reports[0].login, "qingmin-new");
});

test("壳：`pr create` 成功时输出里有 PR 链接（桥据此推帧）", async () => {
  reports.length = 0;
  const r = await runShim(["pr", "create", "--fill"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /github\.com\/acme\/widgets\/pull\/42/);
  await sleep(150);
  assert.equal(reports[0].exit, 0);
  assert.match(reports[0].stdout, /pull\/42/);
});

test("壳：真 gh 非零退出时退出码原样带出来", async () => {
  const r = await runShim(["pr", "list"], { FAKE_REAL_GH_EXIT: "3" });
  assert.equal(r.code, 3);
});

test("壳：没装 gh 时内置实现能建 PR（PR 核心），走 REST 并打出链接", async () => {
  identityMode = "no-gh";
  upstreamCalls.length = 0;
  const r = await runShim(["pr", "create", "--fill", "--title", "修掉残影", "--base", "main"]);
  identityMode = "ok";
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /https:\/\/github\.com\/acme\/widgets\/pull\/43/);
  const post = upstreamCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/widgets/pulls");
  assert.ok(post, "确实 POST 了 /pulls");
  assert.equal(post.auth, "Bearer gho_fake_qingmin-new", "内置实现也带着本会话的令牌");
  assert.match(post.body, /"title":"修掉残影"/);
});

test("壳：没装 gh 时对没实现的子命令明确失败，不假装成功", async () => {
  identityMode = "no-gh";
  const r = await runShim(["issue", "list"]);
  identityMode = "ok";
  assert.equal(r.code, 1);
  assert.match(r.stderr, /内置实现只覆盖 PR 核心/);
});

test("壳：没装 gh 也没有令牌时，`auth status` 仍然说得出在用谁", async () => {
  identityMode = "no-gh";
  const r = await runShim(["auth", "status"]);
  identityMode = "ok";
  assert.equal(r.code, 0);
  assert.match(r.stdout, /qingmin-new/);
});

test("壳：没有令牌时也能读公开仓库，只有写才拦（US17）", async () => {
  identityMode = "bare"; // 没装 gh，也没有令牌
  const read = await runShim(["pr", "list"]);
  assert.equal(read.code, 0, read.stderr);
  const write = await runShim(["pr", "create", "--fill", "--title", "x"]);
  identityMode = "ok";
  assert.equal(write.code, 1);
  assert.match(write.stderr, /只能读公开仓库/);
});

test("壳：桥不认识这个会话时大声失败", async () => {
  const r = await runShim(["pr", "list"], { PI_WEB_LOOPBACK_TOKEN: "wrong" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /桥没认出这个会话|unauthorized/);
});

test("壳：桥根本连不上时说人话", async () => {
  const r = await runShim(["pr", "list"], { PI_WEB_LOOPBACK: "http://127.0.0.1:1" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /连不上桥/);
});

// ---------------------------------------------------------------- A. 注入

test("注入：pi 子进程的 PATH 最前面就是壳目录，本机 PATH 没被动过", async () => {
  const state = path.join(tmp, "inject-state");
  const agent = path.join(tmp, "inject-agent");
  const log = path.join(tmp, "fake-pi.jsonl");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });
  fs.writeFileSync(log, "");
  const port = await freePort();
  const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: REPO,
    env: { ...process.env, PI_WEB_PORT: String(port), PI_WEB_STATE: state, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: agent, PI_BIN: FAKE_PI, FAKE_PI_LOG: log },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  bridge.stdout.on("data", (b) => (out += b));
  bridge.stderr.on("data", (b) => (out += b));
  let ws = null;
  try {
    for (let i = 0; i < 400; i++) {
      if (fs.existsSync(path.join(state, "passphrase.txt"))) break;
      await sleep(50);
    }
    for (let i = 0; i < 400; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
      } catch {
        /* 还没起 */
      }
      await sleep(50);
    }
    const pass = fs.readFileSync(path.join(state, "passphrase.txt"), "utf8").trim();
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: pass }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
    await new Promise((r, j) => {
      ws.once("open", r);
      ws.once("error", (e) => j(new Error(String(e.message))));
    });
    ws.send(JSON.stringify({ type: "create", cwd: REPO, name: "壳注入" }));

    let note = null;
    for (let i = 0; i < 600; i++) {
      const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
      note = lines.map((l) => JSON.parse(l)).find((n) => n.t === "argv" && (n.argv ?? []).includes("-e"));
      if (note) break;
      await sleep(50);
    }
    assert.ok(note, `桩 pi 没拿到会话进程的环境\n${out.split("\n").slice(-8).join("\n")}`);
    const binDir = path.join(state, "github", "bin");
    assert.equal(note.githubShim, "1", "PI_WEB_GITHUB_SHIM 到了子进程");
    assert.equal(note.pathHead, binDir, "PATH 最前面就是壳目录");
    assert.ok(fs.existsSync(path.join(binDir, "gh")), "POSIX 的壳落盘了");
    assert.ok(fs.existsSync(path.join(binDir, "gh.cmd")), "Windows 的壳也落盘了");
    assert.match(fs.readFileSync(path.join(binDir, "gh"), "utf8"), /github-shim\.js/);
    assert.ok(!(process.env.PATH ?? "").split(path.delimiter).includes(binDir), "本机 PATH 没被动过");
  } finally {
    try {
      ws?.close();
    } catch {
      /* 已经关了 */
    }
    const dead = new Promise((r) => bridge.once("exit", r));
    bridge.kill();
    await Promise.race([dead, sleep(8000)]);
  }
});

test.after(() => {
  shimBridge.close();
  upstream.close();
});
