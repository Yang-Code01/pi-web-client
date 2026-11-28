/**
 * 自动评审的限时授权（D462 第 5 条）：哪些命令能被放过、哪些必须照旧弹审批卡。
 *
 * 这里的每个「不许」都是一条安全边界：推送写进了别条分支、强推、一次推全部、
 * 别的 PR 号、同名的别的仓库、`&&` 接在后面的一切 —— 放过一个就等于给闸门开后门。
 *
 *   node --experimental-strip-types bridge/tests/reviewgrant-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PI_WEB_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-grant-"));

const { grantAllows, currentBranch, GRANT_TTL_MS } = await import("../ext/grant-match.ts");
const { GRANT_TTL_MS: SRC_TTL_MS, readGrant, writeGrant } = await import("../src/reviewgrant.ts");

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

const NOW = 1_700_000_000_000;
const REPO = "/Users/x/pi-web-client";
const SLUG = "o/pi-web-client";
const grant = (over = {}) => ({ branch: "feat/review-auto", pr: 747, repo: REPO, slug: SLUG, expiresAt: NOW + 60_000, ...over });
const allows = (cmd, head = "feat/review-auto", g = grant(), cwd = REPO) => grantAllows(g, cmd, { head, cwd }, NOW);

// ---------------------------------------------------------------- 推送

check("推授权的那条分支：放过", () => {
  assert.equal(allows("git push origin feat/review-auto"), true);
  assert.equal(allows("git push -u origin feat/review-auto"), true);
  assert.equal(allows("git push origin HEAD:feat/review-auto"), true);
  assert.equal(allows("git push origin HEAD:refs/heads/feat/review-auto"), true);
});

check("refspec 的目标写成 HEAD：不认（说不清远端会更新成哪条分支）", () => {
  assert.equal(allows("git push origin main:HEAD"), false);
  assert.equal(allows("git push origin feat/review-auto:HEAD"), false);
  assert.equal(allows("git push origin HEAD"), true, "没有 refspec 的 HEAD = 推当前分支，交给 head 去对");
});

check("裸 push：当前分支就是授权那条才放过", () => {
  assert.equal(allows("git push"), true);
  assert.equal(allows("git push origin"), true);
  assert.equal(allows("git push", "feat/other"), false);
});

check("推别的分支：不放过", () => {
  assert.equal(allows("git push origin feat/other"), false);
  assert.equal(allows("git push origin main"), false);
  assert.equal(allows("git push origin feat/review-auto feat/other"), false);
});

check("强推 / 一次推全部 / 删远端分支：都不放过", () => {
  for (const cmd of [
    "git push --force origin feat/review-auto",
    "git push -f origin feat/review-auto",
    "git push --force-with-lease origin feat/review-auto",
    "git push --all origin",
    "git push --mirror origin",
    "git push --tags origin",
    "git push --delete origin feat/review-auto",
    "git push -d origin feat/review-auto",
    "git push origin +feat/review-auto",
  ]) {
    assert.equal(allows(cmd), false, cmd);
  }
});

check("复合命令：前面那条被授权也不放过（后面那截没人看过）", () => {
  assert.equal(allows("git push origin feat/review-auto && rm -rf ~"), false);
  assert.equal(allows("git push origin feat/review-auto; rm -rf ~"), false);
  assert.equal(allows("git push origin feat/review-auto | sh"), false);
  assert.equal(allows("cd /tmp && git push origin feat/review-auto"), false);
});

check("删远端分支的两种写法都挡：`:branch` 与 `--prune`", () => {
  assert.equal(allows("git push origin :feat/review-auto"), false, "空源 refspec 是删远端分支");
  assert.equal(allows("git push origin feat/review-auto:"), false, "空目标名同样不认");
  assert.equal(allows("git push --prune origin"), false);
});

check("cwd 不在授权仓库里（别的检出）：不放过", () => {
  assert.equal(allows("git push origin feat/review-auto", "feat/review-auto", grant(), "/Users/x/other"), false);
  assert.equal(allows("git push origin feat/review-auto", "feat/review-auto", grant(), `${REPO}/web/src`), true, "子目录算同一个仓库");
});

check("`2>&1` / `2>/dev/null` 不挡（不启动第二条命令），管道照旧挡", () => {
  assert.equal(allows("git push origin feat/review-auto 2>&1"), true);
  assert.equal(allows("git push origin feat/review-auto 2>/dev/null"), true);
  assert.equal(allows("git push origin feat/review-auto | tee push.log"), false);
});

check("反斜杠续行接回去再判（不是绕过）", () => {
  assert.equal(allows("git push origin \\\n  feat/other"), false);
  assert.equal(allows("git push origin \\\n  feat/review-auto"), true);
  // 选项后面就断行的合法写法：`^` 锚定的正则要能从接回去的那一行上认出来
  assert.equal(allows("gh -R o/pi-web-client \\\n  pr merge 747"), true);
});

// ---------------------------------------------------------------- 合并

check("合授权的那个 PR：放过（两种写法）", () => {
  assert.equal(allows("gh pr merge 747"), true);
  assert.equal(allows("gh pr merge 747 --merge"), true);
  assert.equal(allows("gh pr merge 747 --squash --delete-branch"), true, "合并方式的选项不影响「是不是这个号」");
  assert.equal(allows("gh api -X PUT repos/o/pi-web-client/pulls/747/merge -f merge_method=merge"), true);
});

check("合别的号 / 别的仓库：不放过", () => {
  assert.equal(allows("gh pr merge 748"), false);
  assert.equal(allows("gh api -X PUT repos/o/pi-web-client/pulls/748/merge"), false);
  assert.equal(allows("gh -R other/repo pr merge 747"), false);
  assert.equal(allows("gh -R o/pi-web-client pr merge 747"), true, "认出来的就是它");
  // 评审 #6：**同名的别的仓库**也是别的仓库（同号 PR 合进去就是合错东西）
  assert.equal(allows("gh -R other/pi-web-client pr merge 747"), false);
  assert.equal(allows("gh api -X PUT repos/other/pi-web-client/pulls/747/merge"), false);
  assert.equal(allows("gh api -X PUT repos/o/pi-web-client/pulls/747/merge -f merge_method=merge"), true);
});

check("长选项 `--repo` 也算「显式点名」（只能点名自己的仓库）", () => {
  // 以前只认 `-R`：`--repo other/x` 被读成空仓库 → 退回「按 cwd 算」→ 借这张授权合别人的同号 PR。
  assert.equal(allows("gh pr merge 747 --repo other/x"), false);
  assert.equal(allows("gh pr merge 747 --repo=other/x"), false);
  assert.equal(allows("gh pr merge 747 --repo other/pi-web-client"), false, "同名的别的仓库也是别的仓库");
  assert.equal(allows("gh pr merge 747 --repo o/pi-web-client"), true);
  assert.equal(allows("gh pr merge 747 --repo=o/pi-web-client"), true);
  assert.equal(allows("gh pr merge 747 -Ro/pi-web-client"), true);
  // 写了选项却没给值：认不出仓库，一律拒（别退回 cwd）
  assert.equal(allows("gh pr merge 747 --repo"), false);
});

check("PR 号只认位置上的那个，不把选项的值当号", () => {
  assert.equal(allows("gh pr merge --match-head-commit 34 747"), true, "34 是选项的值，不是 PR 号");
  assert.equal(allows("gh pr merge 747 --match-head-commit 34"), true);
  assert.equal(allows("gh pr merge --match-head-commit 34 748"), false);
});

check("绕过闸门的选项：`--admin`（跳过分支保护）/ `--auto`（交给 GitHub 自动合）不放过", () => {
  assert.equal(allows("gh pr merge 747 --admin"), false);
  assert.equal(allows("gh pr merge 747 --auto"), false);
  assert.equal(allows("gh pr merge 747 --auto --merge"), false);
  assert.equal(allows("gh pr merge 747 --merge"), true);
});

check("`-R` 的仓库写法：URL / `.git` 后缀也算「显式点名」，归一后再比", () => {
  assert.equal(allows("gh -R https://github.com/o/pi-web-client pr merge 747"), true, "写的就是自己的仓库");
  assert.equal(allows("gh -R o/pi-web-client.git pr merge 747"), true);
  assert.equal(allows("gh -R https://github.com/other/x pr merge 747"), false);
  // `--repo` 是前缀、不是它本身：以前 `--repofeature x` 会把 `feature` 当成仓库去比
  // （比不上 → 拒，方向安全）；现在不把它当仓库，命令按「没点名仓库」走 cwd 那一路。
  assert.equal(allows("gh pr merge 747 --repofeature x"), true);
});

check("把命令推到远端执行的推送选项：不放过", () => {
  assert.equal(allows("git push --receive-pack=sh origin feat/review-auto"), false);
  assert.equal(allows("git push --exec=sh origin feat/review-auto"), false);
  assert.equal(allows("git push --upload-pack=/tmp/x origin feat/review-auto"), false);
  assert.equal(allows("git push origin feat/review-auto"), true);
});

check("没说号码的合并（`gh pr merge` 认当前分支）：不放过", () => {
  assert.equal(allows("gh pr merge --merge"), false);
});

check("认不出自己是谁（slug 空）时，显式点名别的仓库一律拒", () => {
  assert.equal(allows("gh -R o/pi-web-client pr merge 747", "feat/review-auto", grant({ slug: "" })), false);
});

check("没授权合并不等于授权推送，反之亦然", () => {
  assert.equal(allows("gh pr merge 747", "feat/review-auto", grant({ pr: 0 })), false);
  assert.equal(allows("git push origin feat/review-auto", "feat/review-auto", grant({ branch: "" })), false);
});

// ---------------------------------------------------------------- 授权本身的时效

check("过期 / 没有授权：一律不放过", () => {
  // 第三格是 `{ head, cwd }`：光传分支名（`head` 实际是 undefined）会让「过期 + 分支匹配」
  // 这条路径没被真的走到 —— 用例照样绿，但覆盖的是别的东西。
  const ctx = { head: "feat/review-auto", cwd: REPO };
  assert.equal(grantAllows(null, "git push origin feat/review-auto", ctx, NOW), false);
  assert.equal(grantAllows(grant({ expiresAt: NOW - 1 }), "git push origin feat/review-auto", ctx, NOW), false);
  assert.equal(grantAllows(grant({ expiresAt: 0 }), "gh pr merge 747", ctx, NOW), false);
  // 同一条命令、同一份 ctx，只有「没过期」这一处不同：过期就是那道闸。
  assert.equal(grantAllows(grant(), "git push origin feat/review-auto", ctx, NOW), true);
});

check("两边各定义的 GRANT_TTL_MS 必须一致（闸门在子进程里加载的是 ext 那份）", () => {
  // 直接 import 两份常量来比：以前靠一条正则从源码文本里「算」出值，谁把常量改写成
  // `(60 * 1000)` 或 `60_000` 就会算出 NaN，报错只说「漂了」，排查方向被带偏。
  assert.equal(SRC_TTL_MS, GRANT_TTL_MS, "src 与 ext 的 GRANT_TTL_MS 漂了：改一处必须改两处");
  assert.ok(Number.isFinite(SRC_TTL_MS) && SRC_TTL_MS > 0, "两边都得是正数");
});

check("无关命令：不归这份授权管（照样走原来的判定）", () => {
  for (const cmd of ["rm -rf dist", "npm i left-pad", "git reset --hard", "gh pr create", "ls -la"]) {
    assert.equal(allows(cmd), false, cmd);
  }
});

// ---------------------------------------------------------------- 读 HEAD

check("currentBranch：读 .git/HEAD", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-head-"));
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feat/thing\n");
  assert.equal(currentBranch(repo), "feat/thing");
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "9f2c1a9d\n");
  assert.equal(currentBranch(repo), "", "detached HEAD 没有「这条分支」");
  assert.equal(currentBranch(path.join(repo, "nope")), "");
});

check("currentBranch：worktree 的 .git 是文件", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-wt-"));
  const real = path.join(base, ".git", "worktrees", "feat");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "HEAD"), "ref: refs/heads/feat/wt\n");
  const wt = path.join(base, "wt");
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${real}\n`);
  assert.equal(currentBranch(wt), "feat/wt");
});

// ---------------------------------------------------------------- 落盘（脑侧）

check("写进去、读回来；收掉就没了", () => {
  const session = "sess-grant-1";
  writeGrant(session, { branch: "feat/x", pr: 12, repo: "/repo", slug: "o/r" }, NOW);
  const back = readGrant(session, NOW);
  assert.equal(back?.branch, "feat/x");
  assert.equal(back?.pr, 12);
  assert.equal(back?.slug, "o/r");
  assert.equal(back?.expiresAt, NOW + GRANT_TTL_MS);
  writeGrant(session, null, NOW);
  assert.equal(readGrant(session, NOW), null);
});

check("过期读不出来", () => {
  const session = "sess-grant-2";
  writeGrant(session, { branch: "feat/x", pr: 0, repo: "/repo", slug: "o/r" }, NOW);
  assert.equal(readGrant(session, NOW + GRANT_TTL_MS + 1), null);
});

check("收授权不动同一份文件里的 patterns / mode", () => {
  const session = "sess-grant-3";
  const file = path.join(process.env.PI_WEB_STATE, "allow", `${session}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ patterns: ["tool:read"], mode: "strict" }));
  writeGrant(session, { branch: "feat/x", pr: 3, repo: "/repo", slug: "o/r" }, NOW);
  writeGrant(session, null, NOW);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(data.patterns, ["tool:read"]);
  assert.equal(data.mode, "strict");
  assert.equal(data.auto, undefined);
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
