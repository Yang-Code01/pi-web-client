/**
 * 没装 gh 时评审还能跑（D428）：`gh pr list` / `gh pr view` 失败成 `gh_missing` 之后，
 * 桥要改走 GitHub REST，而不是把「装 gh」当唯一出路。
 *
 * 这条用例用假 gh（固定退出 127）和一个本地 HTTP 服务模拟 GitHub —— 不碰网络、不碰真账号。
 *
 *   node --experimental-strip-types bridge/tests/gitpr-rest-e2e.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-gitpr-rest-")));
process.env.PI_WEB_STATE = path.join(tmp, "state");
process.env.PI_AGENT_DIR = path.join(tmp, "agent");
fs.mkdirSync(process.env.PI_WEB_STATE, { recursive: true });
fs.mkdirSync(process.env.PI_AGENT_DIR, { recursive: true });
// 这台机器「没装 gh」：评审的 gh 调用全部落到 REST 兜底。
process.env.PI_WEB_GH_JS = path.join(REPO, "bridge", "tests", "fixtures", "gh-missing.mjs");

const work = path.join(tmp, "demo");
fs.mkdirSync(work, { recursive: true });
const git = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@example.com"]);
git(["config", "user.name", "t"]);
git(["remote", "add", "origin", "https://github.com/acme/demo.git"]);

/** 记录 REST 请求：路径 + 带进来的 Authorization。 */
const seen = [];
let notFound = false;
const server = http.createServer((req, res) => {
  seen.push({ path: req.url, auth: req.headers.authorization ?? "" });
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (notFound) return json(404, { message: "Not Found" });
  if (url.pathname === "/repos/acme/demo/pulls") {
    return json(200, [
      { number: 7, title: "Fix the thing", head: { ref: "feat/x" }, base: { ref: "main" }, draft: false, user: { login: "octo" }, updated_at: "2026-01-02T03:04:05Z" },
      { number: 9, title: "Draft work", head: { ref: "wip" }, base: { ref: "main" }, draft: true, user: { login: "octo" }, updated_at: "2026-01-03T00:00:00Z" },
    ]);
  }
  if (url.pathname === "/repos/acme/demo/pulls/7") {
    return json(200, {
      number: 7,
      title: "Fix the thing",
      body: "hello",
      state: "open",
      draft: false,
      html_url: "https://github.com/acme/demo/pull/7",
      user: { login: "octo" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T03:04:05Z",
      additions: 12,
      deletions: 3,
      changed_files: 2,
      head: { ref: "feat/x" },
      base: { ref: "main" },
    });
  }
  if (url.pathname === "/repos/acme/demo/pulls/7/files") {
    return json(200, [
      { filename: "src/a.ts", additions: 10, deletions: 1, status: "modified" },
      { filename: "src/old.ts", additions: 0, deletions: 2, status: "removed" },
    ]);
  }
  if (url.pathname === "/repos/acme/demo/pulls/7/commits") {
    return json(200, [
      { sha: "abc123", commit: { message: "Fix the thing\n\nmore text", author: { date: "2026-01-02T03:04:05Z", name: "Octo Cat" } }, author: { login: "octo" } },
    ]);
  }
  return json(404, { message: "Not Found" });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
// 任何一条先挂都要把这个监听关掉，不然 node --test 会等句柄、整条用例链卡住。
after(() => new Promise((resolve) => server.close(resolve)));
const apiBase = `http://127.0.0.1:${server.address().port}`;

const { listPullRequests, pullRequestInfo, resetPrCache, resetPrInfoCache } = await import("../src/gitpr.ts");
const opts = { fresh: true, login: "octo", token: "tok-123", apiBase };

test("gh 不在 → 列表改走 REST，草稿排后面", async () => {
  resetPrCache();
  const out = await listPullRequests(work, opts);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.via, "rest");
  assert.equal(out.repo, "acme/demo");
  assert.deepEqual(out.prs.map((p) => p.number), [7, 9]);
  assert.equal(out.prs[1].draft, true);
  // 三条请求都要带：只看最后一条的话，以后多打一个请求就会漏判。
  assert.ok(seen.length > 0, "至少打过一次 REST");
  for (const hit of seen) assert.equal(hit.auth, "Bearer tok-123", `REST 要带会话账号的令牌：${hit.path}`);
});

test("gh 不在 → PR 信息也走 REST，files/commits 映射成面板要的形状", async () => {
  resetPrInfoCache();
  const out = await pullRequestInfo(work, 7, opts);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.via, "rest");
  const info = out.info;
  assert.equal(info.title, "Fix the thing");
  assert.equal(info.additions, 12);
  assert.equal(info.changedFiles, 2);
  assert.deepEqual(info.files.map((f) => [f.path, f.changeType]), [
    ["src/a.ts", "modified"],
    ["src/old.ts", "deleted"],
  ]);
  assert.equal(info.filesMore, 0);
  assert.equal(info.commits[0].oid, "abc123");
  assert.equal(info.commits[0].headline, "Fix the thing");
  assert.equal(info.commits[0].author, "octo");
});

test("仓库看不到（404）报 repo_unseen，而不是让人去查代理", async () => {
  resetPrCache();
  notFound = true;
  try {
    const out = await listPullRequests(work, opts);
    assert.equal(out.ok, false);
    assert.equal(out.code, "repo_unseen");
    assert.equal(out.via, "rest");
  } finally {
    notFound = false;
  }
});
