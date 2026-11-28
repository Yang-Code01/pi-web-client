/**
 * 自动评审的 PR 闸门怎么读一个 PR（`bridge/src/autopr.ts`）。
 *
 * 钉住的是一条真的错（#765）：调用方手上是仓库**目录**（`effectiveReviewDir()` 给的是
 * `gitRoot()`），GitHub REST 要的却是 `owner/name`。两者混成同一个参数时，拼出来的是
 * `/repos//tmp/…/pulls/7`，GitHub 回 404；外面那层 `catch { return null }` 再把它变成一句
 * 「先确认 gh 登录了这个仓库」—— 一次口径错误被翻译成一条误导人的建议，没人能顺着它查下去。
 *
 * 所以这里**不看「有没有抛」**（那正是当初漏掉的原因），只看真的请求了哪个 URL：
 * 每个路径都必须是以 `owner/name` 开头的 `/repos/…`，不带双斜杠，也不带临时目录名。
 *
 *   node --experimental-strip-types bridge/tests/autopr-unit.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const { autoPrFailure, readAutoPr } = await import("../src/autopr.ts");

const HEAD = "5c0543ef00000000000000000000000000000000";

/** 一个带 GitHub 远端的临时仓库：`localRepoName()` 认的就是它的 origin。 */
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-autopr-"));
execFileSync("git", ["-C", repo, "init", "-q"]);
execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/Acme/Widgets.git"]);

/** 假 GitHub：把每个请求的 pathname 记下来，按需回 200 / 404。 */
function fakeGithub() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    hits.push(url.pathname);
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/repos/acme/widgets/pulls/760") {
      return send(200, { number: 760, state: "open", merged: false, mergeable: true, head: { sha: HEAD, ref: "feat/x" } });
    }
    if (url.pathname === `/repos/acme/widgets/commits/${HEAD}/check-runs`) {
      return send(200, { check_runs: [{ name: "unit", status: "completed", conclusion: "success" }] });
    }
    if (url.pathname === `/repos/acme/widgets/commits/${HEAD}/status`) {
      return send(200, { statuses: [] });
    }
    return send(404, { message: "Not Found" });
  });
  return { hits, server };
}

async function listen(server) {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${server.address().port}`;
}

// ------------------------------------------------------------------ 1. 路径口径
{
  const { hits, server } = fakeGithub();
  const apiBase = await listen(server);
  try {
    let view;
    try {
      view = await readAutoPr({ dir: repo, pr: 760, token: "test-token", apiBase });
    } catch (err) {
      // 红的时候必须自己说清楚「请求了哪个路径」——不然这条用例只会变成又一个「读不到 PR」。
      assert.fail(`读不到 PR，实际请求：${JSON.stringify(hits)}（${String(err?.message ?? err)}）`);
    }
    assert.equal(view.headRefName, "feat/x");
    assert.equal(view.state, "open");
    assert.equal(view.mergeable, true);
    assert.deepEqual(view.checks, [{ name: "unit", state: "success" }]);
    assert.equal(view.checksTruncated, false);

    assert.ok(hits.length >= 3, `应该问到 pulls + check-runs + status，实际：${JSON.stringify(hits)}`);
    for (const p of hits) {
      assert.match(p, /^\/repos\/acme\/widgets\//, `请求路径必须带 owner/name：${p}`);
      assert.ok(!p.includes("//"), `请求路径里不该有双斜杠：${p}`);
      assert.ok(!p.includes(path.basename(repo)), `请求路径里不该出现本机目录：${p}`);
    }
    assert.ok(hits.includes("/repos/acme/widgets/pulls/760"), `没问到 PR 本体：${JSON.stringify(hits)}`);
  } finally {
    server.close();
  }
}

// ------------------------------------------------------------------ 2. 目录认不出远端
{
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-autopr-norepo-"));
  execFileSync("git", ["-C", bare, "init", "-q"]);
  await assert.rejects(
    () => readAutoPr({ dir: bare, pr: 760, token: "test-token", apiBase: "http://127.0.0.1:1" }),
    /GitHub/,
    "没有 GitHub 远端时应当直接说清楚，而不是拼一条必然 404 的路径去请求",
  );
}

// ------------------------------------------------------------------ 3. 读不到时说人话
{
  const { server } = fakeGithub();
  const apiBase = await listen(server);
  try {
    const err = await readAutoPr({ dir: repo, pr: 999, token: "test-token", apiBase }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, "404 要抛出来给调用方（以前被 catch 吞成 null，只剩一句「gh 没登录」）");
    const msg = autoPrFailure(err, "acme-bot");
    assert.match(msg, /404/, `404 的说法要提到 404：${msg}`);
    assert.match(msg, /acme-bot/, `要说清是按谁查的：${msg}`);
  } finally {
    server.close();
  }
}

// 401 也一样：令牌的事一眼能认出来，而不是又一句「确认 gh 登录了这个仓库」。
assert.match(autoPrFailure(Object.assign(new Error("Bad credentials"), { code: "unauthorized" }), "acme-bot"), /401.*acme-bot/);

console.log("autopr-unit: ok");
