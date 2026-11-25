/**
 * 评审取 PR 提交的那一步，端到端过一次真 git（D402）。
 *
 * 现场是「直连被中间设备重置」：界面只看到 `error: RPC failed; curl 56 Recv failure: Connection
 * was reset`，整次评审死在 fetch。这里把那个现场原样搭出来 ——
 *
 *   坏 origin：info/refs 正常应答（真 `git http-backend`），POST `git-upload-pack` 回 200 后把
 *              TCP 重置 —— 正是截图上那句 stderr 的来源；
 *   好 origin：同一条仓库另一份、全程正常；
 *   本地正向代理：收到绝对 URI 的请求就转给好 origin（测试替身，真实代理按 Host 转发）。
 *
 * 断言两件事：配好 `httpProxy` 时评审自己会绕到代理上取成功；没配时错误里要把**每一条路**
 * 都写出来，而不是只甩一句 Connection was reset。
 *
 *   node --experimental-strip-types bridge/tests/gitpr-fetch-route-e2e.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fetchPullRequestRef } from "../src/gitpr.ts";

const HOST = "127.0.0.2"; // 不在 NO_PROXY 白名单里：127.0.0.1/localhost 会被 curl 跳过代理
const saved = { ...process.env };
const proxyKeys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "BILLION_CONTEXT_PROXY", "NO_PROXY", "no_proxy", "PI_AGENT_DIR"];
for (const key of proxyKeys) delete process.env[key];

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

/** 用真的 `git http-backend` 应答一次 smart HTTP 请求 —— 广告与打包都是 git 自己产出的。 */
function httpBackend(root, { method, pathInfo, query, body, contentType }) {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["http-backend"], {
      windowsHide: true,
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: `/o/r.git${pathInfo}`,
        QUERY_STRING: query ?? "",
        REQUEST_METHOD: method,
        CONTENT_LENGTH: String(body?.length ?? 0),
        CONTENT_TYPE: contentType ?? "",
      },
    });
    const chunks = [];
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.on("error", reject);
    proc.on("close", () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf("\r\n\r\n");
      const head = (split >= 0 ? raw.subarray(0, split) : Buffer.alloc(0)).toString("utf8");
      const payload = split >= 0 ? raw.subarray(split + 4) : raw;
      const headers = {};
      let status = 200;
      for (const line of head.split(/\r?\n/)) {
        const m = /^([^:]+):\s*(.*)$/.exec(line);
        if (!m) continue;
        if (m[1].toLowerCase() === "status") status = Number(m[2].slice(0, 3)) || 200;
        else headers[m[1].toLowerCase()] = m[2];
      }
      resolve({ status, headers, body: payload });
    });
    proc.stdin.end(body ?? Buffer.alloc(0));
  });
}

const listen = (server) => new Promise((r) => server.listen(0, HOST, () => r(server.address().port)));
const close = (server) => new Promise((r) => (server.listening ? server.close(() => r()) : r()));

// ---------------------------------------------------------------- 造仓库
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gitpr-route-"));
const originRoot = path.join(workRoot, "origin");
const bare = path.join(originRoot, "o", "r.git");
const seed = path.join(workRoot, "seed");
execFileSync("git", ["init", "-q", "--bare", bare], { windowsHide: true });
execFileSync("git", ["clone", "-q", bare, seed], { windowsHide: true });
fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
execFileSync("git", ["-C", seed, "add", "-A"], { windowsHide: true });
execFileSync("git", ["-C", seed, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"], { windowsHide: true });
execFileSync("git", ["-C", seed, "push", "-q", bare, "HEAD:refs/pull/636/head", "HEAD:refs/heads/main"], { windowsHide: true });
const headSha = execFileSync("git", ["-C", seed, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();

// ---------------------------------------------------------------- 两个 origin
const stats = { goodPosts: 0, badPosts: 0, proxied: 0 };

const good = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const body = await readBody(req);
  if (req.method === "POST") stats.goodPosts += 1;
  const out = await httpBackend(originRoot, {
    method: req.method,
    pathInfo: url.pathname.replace(/^\/o\/r\.git/, ""),
    query: url.search.slice(1),
    body,
    contentType: req.headers["content-type"],
  });
  res.writeHead(out.status, out.headers);
  res.end(out.body);
});

/**
 * 服务端在传包前会先发进度（sideband band 2）：`remote: Enumerating objects…`。
 * 这里原样发两条，让直连失败时的 stderr **不是**以 `error: RPC failed` 开头。
 */
const sidebandProgress = (text) => {
  const payload = Buffer.concat([Buffer.from([2]), Buffer.from(text)]);
  const len = (payload.length + 4).toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(len), payload]);
};

const bad = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
    const out = await httpBackend(originRoot, {
      method: "GET",
      pathInfo: url.pathname.replace(/^\/o\/r\.git/, ""),
      query: url.search.slice(1),
      body: Buffer.alloc(0),
    });
    res.writeHead(out.status, out.headers);
    res.end(out.body);
    return;
  }
  // 现场：200 已经回了、包刚开始传就被掐断 —— git 报 `RPC failed; curl 56 Recv failure`。
  stats.badPosts += 1;
  res.writeHead(200, { "content-type": "application/x-git-upload-pack-result", "content-length": 10_000_000 });
  res.write(
    Buffer.concat([
      Buffer.from("0008NAK\n"),
      sidebandProgress("Enumerating objects: 5, done.\n"),
      sidebandProgress("Counting objects: 100% (5/5), done.\n"),
    ]),
  );
  setTimeout(() => res.socket?.resetAndDestroy(), 30);
});

// 正向代理：绝对 URI → 忽略 Host，一律转给好 origin（真实代理按 Host 转发）。
const proxy = http.createServer(async (req, res) => {
  if (req.method === "CONNECT") {
    res.writeHead(405);
    res.end();
    return;
  }
  stats.proxied += 1;
  const url = new URL(req.url);
  const headers = { ...req.headers };
  for (const key of ["proxy-connection", "connection", "host"]) delete headers[key];
  const fwd = http.request({ host: HOST, port: goodPort, path: `${url.pathname}${url.search}`, method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  fwd.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(fwd);
});

const goodPort = await listen(good);
const badPort = await listen(bad);
const proxyPort = await listen(proxy);

// ---------------------------------------------------------------- 被测仓库
const repo = path.join(workRoot, "repo");
execFileSync("git", ["init", "-q", repo], { windowsHide: true });
execFileSync("git", ["-C", repo, "remote", "add", "origin", `http://${HOST}:${badPort}/o/r.git`], { windowsHide: true });

const agentDir = (httpProxy) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-"));
  if (httpProxy) fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ httpProxy }));
  return dir;
};

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err?.stack ?? err}`);
  }
};

try {
  await check("配好 httpProxy：直连被重置后自己绕到代理上，把 refs/pull/636/head 取回来", async () => {
    process.env.PI_AGENT_DIR = agentDir(`http://${HOST}:${proxyPort}`);
    const logs = [];
    const ref = await fetchPullRequestRef(repo, 636, (line) => logs.push(line));
    assert.equal(ref, "refs/pi-web/pr-636");
    const got = execFileSync("git", ["-C", repo, "rev-parse", "refs/pi-web/pr-636"], { encoding: "utf8", windowsHide: true }).trim();
    assert.equal(got, headSha, "取回来的必须是被评的那条提交");
    assert.ok(stats.badPosts > 0, "直连那一路确实打到坏 origin 上了");
    assert.ok(stats.proxied > 0, "代理那一路确实被用上了");
    assert.ok(
      logs.some((l) => l.startsWith("直连失败") && l.includes("Connection was reset")),
      `日志里应当留下直连失败的原因：\n${logs.join("\n")}`,
    );
    assert.ok(
      logs.some((l) => l === `代理 http://${HOST}:${proxyPort}（最多 90s）`),
      `日志里应当有走代理那一行：\n${logs.join("\n")}`,
    );
    assert.ok(
      !logs.some((l) => l.startsWith(`代理 http://${HOST}:${proxyPort}失败`)),
      "第一次走代理就成功了，不该再有代理失败行",
    );
  });

  await check("没配代理：失败信息里要写清每一次尝试，而不只是那句 Connection was reset", async () => {
    process.env.PI_AGENT_DIR = agentDir("");
    // 另拿一个干净仓库：上一个仓库已经有过这条提交，git 会拿 adverisement 里的值直接改本地 ref，
    // 压根不发 POST —— 这里要的是「第一次取、必须传包」那个现场。
    const fresh = path.join(workRoot, "repo2");
    execFileSync("git", ["init", "-q", fresh], { windowsHide: true });
    execFileSync("git", ["-C", fresh, "remote", "add", "origin", `http://${HOST}:${badPort}/o/r.git`], { windowsHide: true });
    const before = stats.badPosts;
    await assert.rejects(
      // 候选与现探都钉成空：不然会去探本机系统代理与在听端口，结果就跟着机器跑了。
      () => fetchPullRequestRef(fresh, 636, undefined, { proxies: () => [], discover: async () => [] }),
      (err) => {
        assert.equal(err.code, "pr_fetch_failed");
        assert.match(err.message, /^取不到 PR #636 的提交：/, err.message);
        assert.match(err.message, /直连：.*error: RPC failed; curl 56 Recv failure: Connection was reset/, err.message);
        return true;
      },
    );
    assert.ok(stats.badPosts > before, "失败也要确实尝试过直连");
  });

  await check("谁都没配代理：现探本机在听的端口，认出代理并把提交取回来", async () => {
    process.env.PI_AGENT_DIR = agentDir("");
    const fresh = path.join(workRoot, "repo3");
    execFileSync("git", ["init", "-q", fresh], { windowsHide: true });
    execFileSync("git", ["-C", fresh, "remote", "add", "origin", `http://${HOST}:${badPort}/o/r.git`], { windowsHide: true });
    const logs = [];
    // 现探用真的 netstat + 真的 CONNECT 探测：只把结果限定成这台测试代理
    const ref = await fetchPullRequestRef(fresh, 636, (line) => logs.push(line), {
      proxies: () => [],
      discover: async () => [`http://${HOST}:${proxyPort}`],
    });
    assert.equal(ref, "refs/pi-web/pr-636");
    assert.ok(
      logs.some((l) => l.startsWith("本机探到 1 个代理")) && logs.includes(`代理 http://${HOST}:${proxyPort}（最多 90s）`),
      `日志里应当能看到现探那一步：\n${logs.join("\n")}`,
    );
  });
} finally {
  await close(good);
  await close(bad);
  await close(proxy);
  for (const key of proxyKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(workRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
