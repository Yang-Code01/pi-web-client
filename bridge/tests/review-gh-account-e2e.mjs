/**
 * 代码评审的 `gh` / `git` 必须按**会话选的账号**跑（#17545）。
 *
 * 现场：面板里这个会话选的是 `xyang-qingmin`（能看到 `ISID/cas3-onecas-api`），
 * 但评审由桥自己 spawn `gh`，拿的是机器 active 的 `Yang-Code01`，于是
 * `GraphQL: Could not resolve to a Repository with the name …`，而提示还指向代理。
 *
 * 这个用例盯三件事：
 *   1. `sessionGhAccount()` 认得出会话账号，并给出它的令牌；
 *   2. `resolvePullRequest()` 把令牌带进 `gh pr view`（假 gh 记下 `GH_TOKEN`）**与两处 `git fetch`**
 *      （远端用 `ext::` 转给一个 node 小脚本，它把 git 子进程看到的 `GH_TOKEN` 写下来）；
 *   3. 仓库看不到这种「对端已经回答」的失败不再换代理重试，并且报 `repo_unseen`。
 *
 *   node --experimental-strip-types bridge/tests/review-gh-account-e2e.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-gh-")));
// 状态目录必须是这条用例自己的：写进真桥的状态目录会改掉本机的账号偏好。
process.env.PI_WEB_STATE = path.join(tmp, "state");
process.env.PI_AGENT_DIR = path.join(tmp, "agent");
fs.mkdirSync(path.join(process.env.PI_WEB_STATE, "github"), { recursive: true });
fs.mkdirSync(process.env.PI_AGENT_DIR, { recursive: true });

process.env.PI_WEB_GH_JS = path.join(REPO, "bridge", "tests", "fixtures", "fake-gh.mjs");
// 机器 active 是 Yang-Code01 —— 正是出问题的那台机器的形状。
process.env.FAKE_GH_ACCOUNTS = JSON.stringify([
  { login: "Yang-Code01", active: true },
  { login: "xyang-qingmin", active: false },
]);
/** 假 gh 每被调用一次就往这里记一行（参数 + `GH_TOKEN`）。 */
const LOG = path.join(tmp, "gh-log.jsonl");
process.env.FAKE_GH_LOG = LOG;

// 这个会话选了 xyang-qingmin（面板里点过；桥把它存在 accounts.json 的 session 映射里）。
fs.writeFileSync(
  path.join(process.env.PI_WEB_STATE, "github", "accounts.json"),
  JSON.stringify({ pats: {}, session: { "sess-cas": "xyang-qingmin" } }),
);

const { sessionGhAccount } = await import("../src/github.ts");
const { resolvePullRequest, resetPrCache } = await import("../src/gitpr.ts");

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

/**
 * 一个真 git 仓库 + 真远端（本地 bare 仓），有 `main` 与 `refs/pull/17545/head`。
 * 不用网络：出问题的是「按谁出网」，不是「怎么出网」。
 */
const origin = path.join(tmp, "origin.git");
git(["init", "-q", "--bare", origin], tmp);
const work = path.join(tmp, "work", "cas3-onecas-api");
fs.mkdirSync(work, { recursive: true });
git(["init", "-q", "-b", "main"], work);
git(["config", "user.email", "t@example.com"], work);
git(["config", "user.name", "t"], work);
fs.writeFileSync(path.join(work, "README.md"), "base\n");
git(["add", "."], work);
git(["commit", "-q", "-m", "base"], work);
git(["remote", "add", "origin", origin], work);
git(["push", "-q", "origin", "main"], work);
// PR 的 head 提交挂到 refs/pull/17545/head 上（GitHub 上对所有 PR 都存在这个 ref）。
fs.writeFileSync(path.join(work, "pr.txt"), "pr\n");
git(["add", "."], work);
git(["commit", "-q", "-m", "pr head"], work);
git(["push", "-q", "origin", "HEAD:refs/pull/17545/head"], work);
git(["reset", "-q", "--hard", "HEAD~1"], work);

/**
 * git 那侧的令牌怎么验：让 `origin` 走 `ext::`，命令是一个 node 脚本 —— 它把看到的 `GH_TOKEN`
 * 追加到 `GIT_LOG`，再把请求转给真的 `git upload-pack`。
 *
 * 为什么不用「PATH 里放一个假 git」：`gitpr.ts` 的 `run()` 是 `execFile`、不带 shell，Windows 上
 * libuv 只认 `.exe` / `.com`，`.cmd` 根本起不来，那种写法在 CI 里永远是绿的假断言。
 * `ext::` 的命令行**不做引号解析**（Windows 上会把 `"路径"` 整段当参数交给 node），
 * 所以路径按 work 目录给相对值、用正斜杠。
 */
const GIT_LOG = path.join(tmp, "git-token.txt");
process.env.SPY_OUT = GIT_LOG;
fs.writeFileSync(
  path.join(work, "upload-spy.mjs"),
  [
    'import { spawnSync } from "node:child_process";',
    'import fs from "node:fs";',
    "fs.appendFileSync(process.env.SPY_OUT, String(process.env.GH_TOKEN ?? \"\") + \"\\n\");",
    'const r = spawnSync("git", ["upload-pack", process.argv[2] || "."], { stdio: "inherit" });',
    "process.exit(r.status ?? 1);",
  ].join("\n"),
);
git(["config", "protocol.ext.allow", "always"], work);
const originUrl = `ext::node upload-spy.mjs ${path.relative(work, origin).split(path.sep).join("/")}`;
git(["remote", "set-url", "origin", originUrl], work);
const gitTokens = () =>
  fs.existsSync(GIT_LOG) ? fs.readFileSync(GIT_LOG, "utf8").split("\n").filter(Boolean) : [];

/** 假 gh 记下来的调用。 */
const ghCalls = () =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const clearLog = () => fs.rmSync(LOG, { force: true });

test("sessionGhAccount：按会话选的账号取令牌，而不是机器 active 那个", async () => {
  const gh = await sessionGhAccount(work, "sess-cas");
  assert.equal(gh.login, "xyang-qingmin");
  assert.equal(gh.env?.GH_TOKEN, "gho_fake_xyang-qingmin");
});

test("resolvePullRequest：gh 与 git 都带上会话账号的 GH_TOKEN", async () => {
  clearLog();
  fs.rmSync(GIT_LOG, { force: true });
  resetPrCache();
  const gh = await sessionGhAccount(work, "sess-cas");
  const lines = [];
  const pr = await resolvePullRequest(work, 17545, (line) => lines.push(line), { env: gh.env });
  assert.equal(pr.pr, 17545);
  assert.equal(pr.baseRefName, "main");
  // 取到的是远端那个 PR head 的提交（本地 HEAD 还停在 base 上）：说明 fetch 真跑通了。
  const head = git(["rev-parse", "refs/pi-web/pr-17545"], work).trim();
  assert.notEqual(head, git(["rev-parse", "HEAD"], work).trim());
  assert.equal(head, git(["rev-parse", "refs/pull/17545/head"], origin).trim());

  const views = ghCalls().filter((c) => c.args[0] === "pr" && c.args[1] === "view");
  assert.equal(views.length, 1, "gh pr view 应该只跑一次（直连成功）");
  assert.equal(views[0].token, "gho_fake_xyang-qingmin", "评审的 gh 必须用会话账号的令牌");
  // git fetch 也走同一个令牌：`gh auth git-credential` 读的就是 GH_TOKEN。
  assert.ok(lines.some((l) => l.includes("refs/pull/17545/head")), "该真的去 fetch 了 PR ref");
  // 两处 fetch（PR ref + base）都经过 `ext::` 那个转发脚本：它记下的就是 git 子进程拿到的环境。
  // 只断言「fetch 跑过」的话，git 那侧以后丢了 env 这个用例也发现不了（PR #700 的评审意见）。
  assert.deepEqual(gitTokens(), ["gho_fake_xyang-qingmin", "gho_fake_xyang-qingmin"], "两处 git fetch 都要带上会话账号的令牌");
});

test("仓库看不到：报 repo_unseen，且不再绕代理重试一遍", async () => {
  clearLog();
  resetPrCache();
  process.env.FAKE_GH_PR_ERROR = "GraphQL: Could not resolve to a Repository with the name 'ISID/cas3-onecas-api'. (repository)";
  try {
    const gh = await sessionGhAccount(work, "sess-cas");
    const lines = [];
    // 一条真能试的代理候选：换成代理就会再 spawn 一次 gh —— 断言「只问一次」才咬得住。
    const opts = { env: gh.env, proxies: () => ["http://127.0.0.1:9"], discover: async () => [] };
    await assert.rejects(
      () => resolvePullRequest(work, 17545, (line) => lines.push(line), opts),
      (err) => {
        assert.equal(err.code, "repo_unseen");
        assert.match(err.message, /Could not resolve to a Repository/);
        return true;
      },
    );
    const views = ghCalls().filter((c) => c.args[0] === "pr" && c.args[1] === "view");
    // 直连一次就够：换代理再问一遍拿到的还是同一句 GraphQL，只是把 7 秒拖得更长。
    assert.equal(views.length, 1, "对端已经答了的失败不该换代理重试");
  } finally {
    delete process.env.FAKE_GH_PR_ERROR;
  }
});
