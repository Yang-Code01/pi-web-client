/**
 * GitHub 通道的桥端（#661）：假 gh + 假 GitHub + 临时状态目录，真跑 HTTP，不碰网络也不碰真令牌。
 *
 * 测的是**外部行为**：这个会话该用哪个账号、认不认得出仓库、隧道访客能干什么、上游 401 怎么映射。
 * 假 gh 沿用桥里已有的 `PI_WEB_GH_JS` 测试缝（`bridge/tests/fixtures/fake-gh.mjs`），
 * 假 GitHub 顶替 `https://api.github.com`（`ctx.upstreamApi`，生产不传）。
 *
 *   node --experimental-strip-types bridge/tests/github-e2e.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-github-e2e-")));
// 状态目录必须是这条用例自己的：写到真桥的状态目录里会污染本机的账号偏好与 PAT。
process.env.PI_WEB_STATE = path.join(tmp, "state");
process.env.PI_AGENT_DIR = path.join(tmp, "agent");
fs.mkdirSync(process.env.PI_WEB_STATE, { recursive: true });
fs.mkdirSync(process.env.PI_AGENT_DIR, { recursive: true });

const GH_STATE = path.join(tmp, "gh-state.json");
process.env.PI_WEB_GH_JS = path.join(REPO, "bridge", "tests", "fixtures", "fake-gh.mjs");
process.env.FAKE_GH_STATE = GH_STATE;
process.env.FAKE_GH_ACCOUNTS = JSON.stringify([
  { login: "Yang-Code01", active: true },
  { login: "qingmin-new", active: false },
]);

const { handleGithub, resetGithubCaches, seenLinks } = await import("../src/github.ts");
const { ghLinksIn } = await import("../../web/src/github-shared.ts");

/** 一个带 GitHub 远端的工作目录（真 `git remote get-url`，不联网）。 */
const work = path.join(tmp, "work", "widgets");
fs.mkdirSync(work, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: work });
execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: work });

const emptyDir = path.join(tmp, "work", "plain");
fs.mkdirSync(emptyDir, { recursive: true });

// ---------------------------------------------------------------- 假 GitHub（上游）

const up = { hits: { pulls: 0, pull: 0, files: 0, user: 0 }, mode: "ok", lastPullPath: "" };
const PULLS = [
  {
    number: 12,
    title: "fix(ask): 问卷残影跟着会话走",
    draft: false,
    user: { login: "acme-bot" },
    head: { ref: "fix/ask" },
    base: { ref: "main" },
    updated_at: "2026-11-24T03:00:00Z",
    html_url: "https://github.com/acme/widgets/pull/12",
    additions: 105,
    deletions: 21,
    changed_files: 5,
  },
];

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://gh.test");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (up.mode === "401") return send(401, { message: "Bad credentials" });
  if (url.pathname === "/user") {
    up.hits.user += 1;
    return send(200, { login: "pat-user" });
  }
  if (url.pathname === "/repos/acme/widgets/pulls") {
    up.hits.pulls += 1;
    return send(200, PULLS);
  }
  up.lastPullPath = url.pathname;
  const pull = /^\/repos\/[\w.-]+\/[\w.-]+\/pulls\/(\d+)$/.exec(url.pathname);
  if (pull && url.pathname.startsWith("/repos/acme/widgets/")) {
    up.hits.pull += 1;
    return send(200, PULLS[0]);
  }
  const files = /^\/repos\/acme\/widgets\/pulls\/(\d+)\/files$/.exec(url.pathname);
  if (files) {
    up.hits.files += 1;
    return send(200, [{ filename: "bridge/src/sessions.ts", status: "modified", additions: 18, deletions: 3, patch: "@@ -1,2 +1,3 @@\n-old\n+new" }]);
  }
  send(404, { message: "Not Found" });
});
const upBase = await new Promise((r) => upstream.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${upstream.address().port}`)));

// ---------------------------------------------------------------- 被测的桥

/** 页面推帧的落点（`ctx.send`）。 */
const frames = [];
/** 会话级 loopback 令牌 → 会话。真桥由 `SessionsManager.byLoopbackToken` 提供，这里是一张表。 */
const sessions = { "tok-s1": { id: "s1", cwd: work }, "tok-s2": { id: "s2", cwd: work }, "tok-s3": { id: "s3", cwd: emptyDir } };

const bridge = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://bridge.test");
  const ctx = {
    publicReq: req.headers["x-test-tunnel"] === "1",
    send: (frame) => frames.push(frame),
    byLoopbackToken: (token) => sessions[token] ?? null,
    // 真桥里是 `SessionsManager.get(id).state.cwd`：会话在的时候，URL 里的 `cwd` 不作数。
    sessionCwd: (id) => ({ s1: work, s2: work, s3: emptyDir })[id] ?? null,
    upstreamApi: upBase,
    // 只给这条用例：假装这台机器没装 gh。
    ghPath: req.headers["x-test-no-gh"] === "1" ? null : undefined,
  };
  if (await handleGithub(req, res, url, ctx)) return;
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "no such route" }));
});
const base = await new Promise((r) => bridge.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${bridge.address().port}`)));

async function call(method, route, body, headers = {}) {
  const res = await fetch(base + route, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 也照原样带回去，断言更好写 */
  }
  return { status: res.status, json, text };
}

const state = (sessionId, headers = {}) => call("GET", `/api/github/state?sessionId=${sessionId}&cwd=${encodeURIComponent(work)}`, null, headers);

/** 回到「什么都没设过」：清掉会话选择、工作区偏好、全局偏好，再清缓存。 */
function freshPrefs() {
  fs.rmSync(path.join(process.env.PI_WEB_STATE, "github", "accounts.json"), { force: true });
  fs.rmSync(path.join(work, ".pi", "settings.json"), { force: true });
  fs.rmSync(path.join(process.env.PI_AGENT_DIR, "settings.json"), { force: true });
  resetGithubCaches();
}

test("state：默认用 gh 的 active 账号，并从 git 远端认出仓库", async () => {
  freshPrefs();
  const r = await state("s1");
  assert.equal(r.status, 200);
  assert.equal(r.json.gh, true);
  assert.equal(r.json.ghState, "ok");
  assert.deepEqual(r.json.accounts, [
    { login: "Yang-Code01", kind: "gh", active: true },
    { login: "qingmin-new", kind: "gh", active: false },
  ]);
  assert.deepEqual(r.json.session, { login: "Yang-Code01", kind: "gh", source: "active" });
  assert.equal(r.json.repo, "acme/widgets");
  assert.equal(r.json.readonly, false);
});

test("state：这个会话临时选的账号压过工作区与 active", async () => {
  resetGithubCaches();
  const set = await call("POST", "/api/github/account", { sessionId: "s1", login: "qingmin-new" });
  assert.equal(set.status, 200);
  const r = await state("s1");
  assert.deepEqual(r.json.session, { login: "qingmin-new", kind: "gh", source: "session" });
});

test("state：工作区设置压过全局设置，全局压过 active", async () => {
  resetGithubCaches();
  // 工作区：这个目录的 .pi/settings.json
  fs.mkdirSync(path.join(work, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(work, ".pi", "settings.json"), JSON.stringify({ githubAccount: "qingmin-new" }));
  fs.writeFileSync(path.join(process.env.PI_AGENT_DIR, "settings.json"), JSON.stringify({ githubAccount: "Yang-Code01" }));
  const project = await state("s2");
  assert.deepEqual(project.json.session, { login: "qingmin-new", kind: "gh", source: "project" }, "工作区设置压过全局");

  // 换一个没有工作区设置的目录：全局那条生效
  const global = await call("GET", `/api/github/state?sessionId=s3&cwd=${encodeURIComponent(emptyDir)}`);
  assert.deepEqual(global.json.session, { login: "Yang-Code01", kind: "gh", source: "global" });
});

test("state：没装 gh 时说得出是哪一档，不编造账号", async () => {
  resetGithubCaches();
  const r = await state("s1", { "x-test-no-gh": "1" });
  assert.equal(r.json.gh, false);
  assert.equal(r.json.ghState, "no-gh");
  assert.deepEqual(r.json.accounts, []);
  assert.equal(r.json.session, null);
});

test("state：gh 没登录时是「登录态读不到」，不是「没装」", async () => {
  resetGithubCaches();
  fs.writeFileSync(GH_STATE, "logged-out");
  const r = await state("s1");
  assert.equal(r.json.gh, true);
  assert.equal(r.json.ghState, "logged-out");
  assert.deepEqual(r.json.accounts, []);
  fs.rmSync(GH_STATE, { force: true });
  resetGithubCaches();
});

test("隧道访客：读照常并标 readonly，写一律 403", async () => {
  const read = await state("s1", { "x-test-tunnel": "1" });
  assert.equal(read.status, 200);
  assert.equal(read.json.readonly, true);
  const write = await call("POST", "/api/github/account", { sessionId: "s1", login: "qingmin-new" }, { "x-test-tunnel": "1" });
  assert.equal(write.status, 403);
  assert.equal(write.json.code, "tunnel_readonly");
});

test("pulls：一行一个归一化的 PR，带上仓库与匿名标记", async () => {
  freshPrefs();
  const r = await call("GET", `/api/github/pulls?sessionId=s1&cwd=${encodeURIComponent(work)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.repo, "acme/widgets");
  assert.equal(r.json.login, "Yang-Code01");
  assert.equal(r.json.anonymous, false);
  assert.deepEqual(r.json.pulls, [
    {
      number: 12,
      title: "fix(ask): 问卷残影跟着会话走",
      draft: false,
      author: "acme-bot",
      head: "fix/ask",
      base: "main",
      updatedAt: "2026-11-24T03:00:00Z",
      url: "https://github.com/acme/widgets/pull/12",
      additions: 105,
      deletions: 21,
      changedFiles: 5,
    },
  ]);
});

test("pulls：没有令牌时标成匿名（照样能读公开仓库）", async () => {
  resetGithubCaches();
  const r = await call("GET", `/api/github/pulls?sessionId=s1&cwd=${encodeURIComponent(work)}`, null, { "x-test-no-gh": "1" });
  assert.equal(r.status, 200);
  assert.equal(r.json.anonymous, true);
  assert.equal(r.json.login, null);
  assert.equal(r.json.pulls.length, 1);
});

test("pulls：目录没有 GitHub 远端时说清楚，不瞎猜", async () => {
  resetGithubCaches();
  const r = await call("GET", `/api/github/pulls?sessionId=s3&cwd=${encodeURIComponent(emptyDir)}`);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "no-repo");
});

test("cwd：会话存在时以会话自己的目录为准（URL 里那个不算）", async () => {
  resetGithubCaches();
  const r = await call("GET", `/api/github/state?sessionId=s1&cwd=${encodeURIComponent(emptyDir)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.repo, "acme/widgets", "emptyDir 没有远端，但 s1 的目录是 work");
});

test("读接口：repo / cwd 先校验再拼进上游（隧道访客也能打这两条）", async () => {
  resetGithubCaches();
  up.hits.pulls = 0;
  // 用桥不认识的 sessionId：已知会话的 cwd 以会话为准（上一条），这里验的是 URL 参数本身。
  // `..` 与 `?` 都能改写 `/repos/<repo>/…` 那段：要么拿到任意端点，要么往上游注入查询参数。
  for (const repo of ["../../user", "acme/widgets?state=all", "acme", "acme/widgets/../.."]) {
    const r = await call("GET", `/api/github/pulls?sessionId=s9&cwd=${encodeURIComponent(work)}&repo=${encodeURIComponent(repo)}`);
    assert.equal(r.status, 400, `repo=${repo} 要拒`);
    assert.equal(r.json.code, "bad_args");
  }
  // cwd 会被原样交给 `git -C` 与工作区设置：相对路径、带 `..`、不存在的目录都不收。
  for (const cwd of ["..", "./x", `${work}/..`, path.join(tmp, "nope")]) {
    const r = await call("GET", `/api/github/pulls?sessionId=s9&cwd=${encodeURIComponent(cwd)}`);
    assert.equal(r.status, 400, `cwd=${cwd} 要拒`);
    assert.equal(r.json.code, "bad_args");
  }
  assert.equal(up.hits.pulls ?? 0, 0, "被拒的请求一条也不许打到上游");
});

test("pr：正文 + 文件差异 + checks/评论是示例样本", async () => {
  resetGithubCaches();
  const r = await call("GET", `/api/github/pr?sessionId=s1&cwd=${encodeURIComponent(work)}&number=12`);
  assert.equal(r.status, 200);
  assert.equal(r.json.pull.number, 12);
  assert.equal(r.json.files.length, 1);
  assert.equal(r.json.files[0].path, "bridge/src/sessions.ts");
  assert.match(r.json.files[0].patch, /^-old$/m);
  assert.ok(Array.isArray(r.json.sample.checks) && r.json.sample.checks.length > 0, "checks 是示例样本");
  assert.ok(
    r.json.sample.checks.some((c) => c.state !== "success"),
    "样例不能全绿：一片绿太像真的 CI，而这是编的",
  );
  assert.ok(Array.isArray(r.json.sample.comments), "comments 是示例样本");
});

test("card：只回一行，并且 60 秒内不重复问上游", async () => {
  resetGithubCaches();
  up.hits.pull = 0;
  const first = await call("GET", "/api/github/card?repo=acme/widgets&number=12");
  assert.equal(first.status, 200);
  assert.equal(first.json.pull.number, 12);
  assert.equal(up.hits.pull, 1);
  const second = await call("GET", "/api/github/card?repo=acme/widgets&number=12");
  assert.equal(second.json.pull.number, 12);
  assert.equal(up.hits.pull, 1, "第二次走缓存，不再打上游");
});

test("上游不认令牌时映射成 401，不是 500", async () => {
  resetGithubCaches();
  up.mode = "401";
  const r = await call("GET", `/api/github/pr?sessionId=s1&cwd=${encodeURIComponent(work)}&number=12`);
  assert.equal(r.status, 401);
  assert.equal(r.json.code, "unauthorized");
  up.mode = "ok";
});

test("PAT：存之前先问一次 GitHub 这枚令牌是谁的，页面只见登录名", async () => {
  freshPrefs();
  const r = await call("PUT", "/api/github/pat", { token: "ghp_sentinel_token" });
  assert.equal(r.status, 200);
  assert.equal(r.json.login, "pat-user", "登录名来自上游 /user，不是页面自己说的");
  assert.equal(r.json.encrypted, process.platform === "win32", "非 Windows 明文 + 0600，Windows 走 DPAPI");
  assert.equal(up.hits.user, 1);

  const st = await state("s1");
  assert.ok(st.json.accounts.some((a) => a.login === "pat-user" && a.kind === "pat"), "PAT 账号出现在账号表里");
  assert.deepEqual(st.json.pats, ["pat-user"], "另外单独给一份「谁存了 PAT」，界面用来打标");

  // 页面拿不到令牌本体，磁盘上也不许出现在 accounts.json 里
  const raw = fs.readFileSync(path.join(process.env.PI_WEB_STATE, "github", "accounts.json"), "utf8");
  assert.ok(!raw.includes("ghp_sentinel_token"), "accounts.json 里不该有令牌");
});

test("PAT：没装 gh 时它就是写操作的唯一靠山（账号来源标 pat-only）", async () => {
  resetGithubCaches();
  const st = await call("GET", `/api/github/state?sessionId=s1&cwd=${encodeURIComponent(emptyDir)}`, null, { "x-test-no-gh": "1" });
  assert.equal(st.json.gh, false);
  assert.deepEqual(st.json.session, { login: "pat-user", kind: "pat", source: "pat-only" });
  const pulls = await call("GET", `/api/github/pulls?sessionId=s1&cwd=${encodeURIComponent(work)}`, null, { "x-test-no-gh": "1" });
  assert.equal(pulls.json.anonymous, false, "有 PAT 就不是匿名");
});

test("PAT：隧道访客存不了、删不了", async () => {
  const put = await call("PUT", "/api/github/pat", { token: "x" }, { "x-test-tunnel": "1" });
  assert.equal(put.status, 403);
  const del = await call("DELETE", "/api/github/pat?login=pat-user", null, { "x-test-tunnel": "1" });
  assert.equal(del.status, 403);
});

test("PAT：删掉之后账号表与磁盘都不留", async () => {
  const del = await call("DELETE", "/api/github/pat?login=pat-user");
  assert.equal(del.status, 200);
  const st = await state("s1");
  assert.ok(!st.json.accounts.some((a) => a.login === "pat-user"));
  assert.deepEqual(st.json.pats, []);
  const dir = path.join(process.env.PI_WEB_STATE, "github", "pat");
  const left = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepEqual(left, [], "令牌文件也删掉了");
});

test("shim identity：只认会话级 loopback 令牌", async () => {
  resetGithubCaches();
  const none = await call("POST", "/api/github/shim/identity", {});
  assert.equal(none.status, 401);
  const bad = await call("POST", "/api/github/shim/identity", {}, { "x-pi-loopback": "nope" });
  assert.equal(bad.status, 401);
  const ok = await call("POST", "/api/github/shim/identity", {}, { "x-pi-loopback": "tok-s1" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.sessionId, "s1");
  assert.equal(ok.json.login, "Yang-Code01");
  assert.equal(ok.json.token, "gho_fake_Yang-Code01");
  assert.ok(ok.json.realGh, "有真 gh 时把它的路径也给壳");
  assert.equal(ok.json.api, upBase, "壳的 REST 兜底也知道打哪个上游");
});

test("shim report：`pr create` 成功 → 桥推出 github.pr 帧", async () => {
  frames.length = 0;
  const r = await call(
    "POST",
    "/api/github/shim/report",
    { argv: ["pr", "create", "--fill"], exit: 0, stdout: "https://github.com/acme/widgets/pull/42\n", stderr: "", login: "Yang-Code01" },
    { "x-pi-loopback": "tok-s1" },
  );
  assert.equal(r.status, 200);
  assert.deepEqual(frames, [
    {
      type: "github.pr",
      sessionId: "s1",
      repo: "acme/widgets",
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      login: "Yang-Code01",
    },
  ]);
});

test("shim report：认出链接但不是新建 → 只发 github.seen", async () => {
  frames.length = 0;
  await call(
    "POST",
    "/api/github/shim/report",
    { argv: ["pr", "view", "12"], exit: 0, stdout: "state:\tOPEN\nhttps://github.com/acme/widgets/pull/12\n", stderr: "" },
    { "x-pi-loopback": "tok-s1" },
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "github.seen");
  assert.equal(frames[0].links[0].kind, "pull");
  assert.equal(frames[0].links[0].id, "12");
});

test("shim report：命令失败时不发帧，也不编造链接", async () => {
  frames.length = 0;
  const r = await call(
    "POST",
    "/api/github/shim/report",
    { argv: ["pr", "create"], exit: 1, stdout: "", stderr: "https://github.com/acme/widgets/pull/99\nboom" },
    { "x-pi-loopback": "tok-s1" },
  );
  assert.equal(r.status, 200);
  assert.equal(r.json.opened, false);
  assert.deepEqual(frames, []);
});

test("shim report：没有 loopback 令牌就拒绝", async () => {
  const r = await call("POST", "/api/github/shim/report", { argv: ["pr", "list"] });
  assert.equal(r.status, 401);
});

test("桥与页面认链接的口径一致（同一批样本必须得出一样的 kind / repo / id）", () => {
  // US38：解析器有两份（跨包难共享），但口径不能分叉 —— 改动一处忘了另一处，这条会红。
  const samples = [
    "https://github.com/acme/widgets/pull/12",
    "看这个 https://github.com/acme/widgets/pull/12。另外 https://gitlab.com/a/b/pull/3",
    "https://github.com/a/b/issues/7\nhttps://github.com/a/b/commit/deadbeef",
    "https://github.com/my-org.name/repo_1.x/pull/99",
    "https://github.com/a/b/pull/1 https://github.com/a/b/pull/1",
    "没有链接",
  ];
  for (const text of samples) {
    const bridge = seenLinks(text).map((l) => `${l.kind}|${l.repo}|${l.id}`);
    const page = ghLinksIn(text).map((l) => `${l.kind}|${l.repo}|${l.id}`);
    assert.deepEqual(page, bridge, `口径分叉：${text}`);
  }
});

test("工作区默认账号：能写进 .pi/settings.json，并且下一个会话就读到了（US15）", async () => {
  freshPrefs();
  const w = await call("POST", "/api/github/project-account", { cwd: work, login: "qingmin-new" });
  assert.equal(w.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(path.join(work, ".pi", "settings.json"), "utf8"));
  assert.equal(onDisk.githubAccount, "qingmin-new", "写的是项目文件，跟着仓库走");
  resetGithubCaches();
  const st = await call("GET", `/api/github/state?sessionId=s-new&cwd=${encodeURIComponent(work)}`);
  assert.deepEqual(st.json.session, { login: "qingmin-new", kind: "gh", source: "project" }, "新会话读到了它");
  // 清空同一入口也能做
  await call("POST", "/api/github/project-account", { cwd: work, login: "" });
  const cleared = JSON.parse(fs.readFileSync(path.join(work, ".pi", "settings.json"), "utf8"));
  assert.equal(cleared.githubAccount, undefined);
  freshPrefs();
});

test("隧道访客：改工作区设置也 403", async () => {
  const r = await call("POST", "/api/github/project-account", { cwd: work, login: "x" }, { "x-test-tunnel": "1" });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "tunnel_readonly");
});

test("pr：每个文件带 GitHub 的 diff 锚点（点一行就落到那个文件）", async () => {
  resetGithubCaches();
  const r = await call("GET", `/api/github/pr?sessionId=s1&cwd=${encodeURIComponent(work)}&number=12`);
  const file = r.json.files[0];
  assert.match(file.anchor, /^diff-[0-9a-f]{64}$/, "锚点是 diff-<sha256(路径)>");
  // 口径：同一路径必须是同一个锚点（前端拼 #anchor 用的就是它）
  const again = await call("GET", `/api/github/pr?sessionId=s1&cwd=${encodeURIComponent(work)}&number=12`);
  assert.equal(again.json.files[0].anchor, file.anchor);
});

test("pr：显式给 repo 时不按会话 cwd 算（跨仓链接卡不会显示本仓同号 PR）", async () => {
  resetGithubCaches();
  up.lastPullPath = "";
  // 会话 cwd 是 acme/widgets，但卡片来自另一个仓库：路由必须照 repo 打过去。
  await call("GET", `/api/github/pr?sessionId=s1&cwd=${encodeURIComponent(work)}&number=12&repo=Yang-Code01/pi-web-client`);
  assert.match(up.lastPullPath, /^\/repos\/Yang-Code01\/pi-web-client\/pulls\//, `按卡片里的仓库打了：${up.lastPullPath}`);
});

test.after(() => {
  bridge.close();
  upstream.close();
});
