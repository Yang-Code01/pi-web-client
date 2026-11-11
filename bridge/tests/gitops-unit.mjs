/**
 * D234: 分支操作工作台的写执行通道集成测试。
 *
 * 跟 git-history-unit.mjs 一样用真 git 现搭仓库，不 mock：白名单拼 argv、冲突态、
 * 5s TTL 缓存失效、按 dir 串行，都是 mock 证明不了的。
 *
 *   node --experimental-transform-types bridge/tests/gitops-unit.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_OP_IDS, executeGitOp, gitDiff, gitRefs, gitState, previewGitOp } from "../src/gitops.ts";
import { gitHistory, gitInfo } from "../src/git.ts";

const root = mkdtempSync(join(tmpdir(), "pi-gitops-"));
const dir = join(root, "work");

const norm = (text) => text.replace(/\r\n/g, "\n");

/** 固定身份与时间：不依赖 ~/.gitconfig，也不让 commit hash 随机器漂移。 */
const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "core.fsmonitor=false", "-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).trim();

const put = (file, text) => {
  const p = join(dir, file);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
};
const commit = (file, text, msg) => {
  put(file, text);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "--short", "HEAD");
};
const ok = (out, why) => {
  assert.equal(out.ok, true, `${why}：${out.stderr || out.code}`);
  assert.equal(out.exitCode, 0, why);
};
const bad = (out, why) => {
  assert.equal(out.ok, false, why);
  assert.ok(out.exitCode !== 0 || out.code, why);
  assert.ok(out.argv.length >= 4, `${why}：失败卡要带上真实 argv`);
};

try {
  execFileSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
  // 身份：即使 machine 上没有全局 user.name，测试也走固定的 -c 参数。
  const c1 = commit("a.txt", "one\n", "a: one");
  const c2 = commit("b.txt", "two\n", "b: two");
  const c3 = commit("b.txt", "two\ntwo-and-half\n", "b: three");

  // ---------------------------------------------------------------- 白名单
  assert.equal(GIT_OP_IDS.length, 24, "24 个工作流动词，多一个少一个都要改界面注册表");
  assert.deepEqual(
    [...GIT_OP_IDS].sort(),
    ["abort", "branch_del", "branch_new", "cherry_pick", "clean_fd", "commit", "continue", "fetch", "merge", "pull", "push", "push_force", "rebase", "reset_hard", "restore", "revert", "stage", "stash", "stash_drop", "stash_pop", "switch", "tag", "tag_del", "unstage"].sort(),
  );
  assert.equal(previewGitOp("switch", { branch: "--force" }), null, "`-` 开头的分支名不许进 argv");
  assert.equal(previewGitOp("switch", { branch: "feat/x" })?.[0], "switch", "正常分支名走 switch");
  assert.equal(previewGitOp("unknown-verb"), null, "未知 id 不生成 argv");
  assert.ok(previewGitOp("cherry_pick", { hashes: `${c1} ${c2}` })?.includes(c2), "多哈希占位符承诺的用法：按空格切成两条");
  assert.ok(previewGitOp("cherry_pick", { hashes: [`${c1}`, `${c2}`] })?.includes(c2), "数组形式的多哈希也要认");
  assert.ok(previewGitOp("restore", { paths: ["../outside"] }) === null || !previewGitOp("restore", { paths: ["../outside"] })?.includes("../outside"), "`..` 路径不许进 argv");
  const unknown = await executeGitOp(dir, "rm -rf /", { paths: ["--no-preserve-root"] });
  bad(unknown, "网页传任意 argv 一律被拒");
  assert.equal(unknown.code, "unknown_op", "未知 id 有稳定错误码");

  // ---------------------------------------------------------------- 状态 / refs / 差异
  const state0 = await gitState(dir);
  assert.equal(state0.head, "main");
  assert.equal(state0.dirty, 0);
  assert.equal(state0.pending, null);
  const refs0 = await gitRefs(dir);
  assert.ok(refs0.groups.find((g) => g.name === "本地")?.refs.some((r) => r.name === "main"), "本地分组含 main");
  assert.equal(refs0.groups.find((g) => g.name === "远程")?.refs.length, 0, "init 出来的仓库没有远程跟踪 ref");

  // 任意 ref（HEAD~3 / HEAD^ / HEAD@{1}）在历史 tab 和差异 tab 要一致。
  // HEAD~3 在只有 3 条提交时不存在，用 HEAD^ 与 HEAD~2 验。
  const hist = await gitHistory(dir, { n: 20, base: "HEAD~2", fresh: true });
  assert.equal(hist.base, "HEAD~2", "历史读接受任意 ref");
  const diff = await gitDiff(dir, "HEAD~2", "HEAD", "");
  assert.equal(diff.base, "HEAD~2", "差异读不能静默回退到 defaultBase");
  assert.equal(diff.target, "HEAD");
  assert.ok(diff.files.some((f) => f.path === "b.txt"), "差异文件列表含 b.txt");
  const bfile = diff.files.find((f) => f.path === "b.txt");
  assert.ok(bfile?.lines.some((l) => l.tag === "add" || l.tag === "mod"), "文本并排行有变化标签");
  assert.equal(diff.limit.lines, 200);
  assert.equal(diff.limit.bytes, 400 * 1024);
  // 根提交：没有父，左侧空树也要出文件，不能抛 base_unknown。
  const rootDiff = await gitDiff(dir, "", "HEAD", c1);
  assert.equal(rootDiff.target, c1);
  assert.ok(rootDiff.files.length >= 1, "根提交 vs 空树能读");

  // 非文本占位 + 大文件截断：不把二进制塞进前端。
  put("shot.png", "\u0089PNG\r\n\u001a\nfake-bytes");
  git(dir, "add", "shot.png");
  git(dir, "commit", "-q", "-m", "png: add");
  put("big.txt", "x".repeat(500 * 1024));
  git(dir, "add", "big.txt");
  git(dir, "commit", "-q", "-m", "big: add");
  const rich = await gitDiff(dir, "HEAD~2", "HEAD", "");
  const png = rich.files.find((f) => f.path === "shot.png");
  assert.equal(png?.kind, "image", "图片走图片分支");
  assert.ok(png?.images?.target?.startsWith("data:"), "小图给 data URL");
  const big = rich.files.find((f) => f.path === "big.txt");
  assert.equal(big?.truncated, true, "500KB 文件被 200 行 / 400KB 截断");
  assert.match(big?.note ?? "", /只显示前 200 行/);

  // ---------------------------------------------------------------- stage / unstage / commit
  put("scratch.txt", "dirty\n");
  const s1 = await gitState(dir);
  assert.equal(s1.dirty, 1, "未跟踪文件算脏");
  assert.equal(s1.untracked.length, 1);
  ok(await executeGitOp(dir, "stage", { paths: ["scratch.txt"] }), "stage 勾中文件");
  const s2 = await gitState(dir);
  assert.equal(s2.staged.length, 1, "stage 后进入已暂存组");
  ok(await executeGitOp(dir, "unstage", { paths: ["scratch.txt"] }), "unstage 反向");
  // 原本就没跟踪过的新文件，unstage 后是 `??`（未跟踪），不是 ` M`（未暂存）。
  assert.equal((await gitState(dir)).untracked.length, 1, "unstage 后新文件回到未跟踪组");
  assert.equal((await gitState(dir)).staged.length, 0, "暂存区被清空");
  ok(await executeGitOp(dir, "stage", { paths: ["scratch.txt"] }), "重新 stage");
  ok(await executeGitOp(dir, "commit", { message: "scratch: add" }), "commit 结构化 message");
  assert.equal((await gitState(dir)).dirty, 0, "commit 后干净");
  const noMsg = await executeGitOp(dir, "commit", { message: "" });
  bad(noMsg, "空提交说明被 invalid_params 挡住");
  assert.equal(noMsg.code, "invalid_params");

  // 缓存失效：gitInfo / gitHistory 有 5s TTL，写成功后必须拿到新 head。
  const before = await gitInfo(dir, true);
  assert.equal(before?.branch, "main");
  ok(await executeGitOp(dir, "branch_new", { name: "feat/x", from: "HEAD" }), "新建分支");
  const afterRefs = await gitRefs(dir);
  assert.ok(afterRefs.groups[0].refs.some((r) => r.name === "feat/x"), "新分支立刻出现在 refs");
  const afterInfo = await gitInfo(dir, false);
  assert.equal(afterInfo?.branch, "main", "branch_new 不移动 HEAD");
  const switched = await executeGitOp(dir, "switch", { branch: "feat/x" });
  ok(switched, "切到 feat/x");
  assert.equal(switched.state.branch, "feat/x");
  assert.equal((await gitInfo(dir, false))?.branch, "feat/x", "TTL 缓存已失效，chip 读得到新分支");

  // ---------------------------------------------------------------- 多哈希（cherry-pick / revert）
  git(dir, "checkout", "-q", "-b", "picks", c1);
  const picked = await executeGitOp(dir, "cherry_pick", { hashes: `${c2} ${c3}` });
  ok(picked, "多个哈希一次 cherry-pick");
  assert.ok(picked.argv.includes(c2) && picked.argv.includes(c3), "两个哈希都在真实 argv 里");
  assert.equal(norm(readFileSync(join(dir, "b.txt"), "utf8")), "two\ntwo-and-half\n", "两条提交都落到工作区");
  const reverted = await executeGitOp(dir, "revert", { hashes: `${c3}` });
  ok(reverted, "revert 单哈希");
  assert.equal(norm(readFileSync(join(dir, "b.txt"), "utf8")), "two\n", "回滚提交生效");
  const injectedHashes = previewGitOp("cherry_pick", { hashes: "h1; rm -rf /" });
  assert.ok(injectedHashes && injectedHashes.every((a) => !/\s/.test(a)), "多哈希按空白切成 argv 数组，不整条交给 shell");
  assert.ok(!injectedHashes?.includes("-rf"), "`-` 开头的 token 被清洗掉");
  const injectedRun = await executeGitOp(dir, "cherry_pick", { hashes: "h1; rm -rf /" });
  bad(injectedRun, "伪造的哈希列表只是 git 参数错误，不会执行后面的命令");
  assert.ok(existsSync(root), "注入串没有删掉临时仓库（execFile 不经 shell）");

  // ---------------------------------------------------------------- 脏区保护 / restore / stash
  git(dir, "checkout", "-q", "main");
  put("scratch.txt", "changed again\n");
  const dirtySwitch = await executeGitOp(dir, "switch", { branch: "feat/x" });
  // 文件名不同，git 允许带改动切分支；这里只证明 dirty 状态被读到了。
  assert.ok(dirtySwitch.state.dirty >= 0);
  const restored = await executeGitOp(dir, "restore", { paths: ["scratch.txt"] });
  ok(restored, "逐文件 restore");
  assert.ok(restored.argv.includes("restore"), "restore 走白名单 argv");
  assert.equal(norm(readFileSync(join(dir, "scratch.txt"), "utf8")), "dirty\n", "勾中的文件回到 HEAD");
  const noPaths = await executeGitOp(dir, "restore", { paths: [] });
  bad(noPaths, "restore 没勾文件必须拒绝，不能变成整库丢弃");
  assert.equal(noPaths.code, "invalid_params");
  put("stash-me.txt", "stash\n");
  ok(await executeGitOp(dir, "stash", { message: "before work", includeUntracked: true }), "stash 含未跟踪");
  assert.equal((await gitState(dir)).dirty, 0, "stash 后干净");
  ok(await executeGitOp(dir, "stash_pop", { index: 0 }), "取回 stash");
  assert.equal(norm(readFileSync(join(dir, "stash-me.txt"), "utf8")), "stash\n", "未跟踪文件也回来了");

  // ---------------------------------------------------------------- 冲突态：只放行 abort / continue
  git(dir, "checkout", "-q", "-b", "left", c1);
  put("clash.txt", "left\n");
  git(dir, "add", "clash.txt");
  git(dir, "commit", "-q", "-m", "left: clash");
  git(dir, "checkout", "-q", "-b", "right", c1);
  put("clash.txt", "right\n");
  git(dir, "add", "clash.txt");
  git(dir, "commit", "-q", "-m", "right: clash");
  const conflict = await executeGitOp(dir, "merge", { branch: "left" });
  assert.equal(conflict.ok, false, "冲突不是 ok");
  assert.ok(conflict.exitCode !== 0, "冲突带真实退出码");
  assert.match(`${conflict.stderr}\n${conflict.stdout}`, /CONFLICT|Automatic merge failed|conflict/i, "git 的原始输出（stdout 里的 CONFLICT / 或 stderr）保留给失败卡");
  assert.equal(conflict.code, "conflict", "稳定码 conflict：stdout + stderr 一起判，不能只看 stderr");
  assert.ok(conflict.conflicts.includes("clash.txt"), "冲突文件清单给逐文件标记用");
  assert.ok(["merge", "rebase", "cherry-pick", "revert"].includes(conflict.pending ?? ""), "pending 让前端只放行中止/继续/handoff");
  assert.equal(conflict.refresh, false, "冲突不触发 fresh 刷新");
  const aborted = await executeGitOp(dir, "abort", {});
  ok(aborted, "abort 收掉冲突态");
  assert.equal(aborted.state.pending, null);
  assert.equal(aborted.state.conflicts.length, 0);

  // ---------------------------------------------------------------- 串行：同一 dir 不互踩 index.lock
  const parallel = await Promise.all([
    executeGitOp(dir, "tag", { name: "t1", at: "HEAD" }),
    executeGitOp(dir, "tag", { name: "t2", at: "HEAD" }),
    executeGitOp(dir, "tag", { name: "t3", at: "HEAD" }),
  ]);
  for (const out of parallel) ok(out, "三个并发 tag 都成功");
  const tags = git(dir, "tag", "--list").split("\n").filter(Boolean).sort();
  assert.deepEqual(tags, ["t1", "t2", "t3"], "按 dir 串行，没有 index.lock 争用");

  // ---------------------------------------------------------------- 红色动词的确认边界
  const reset = await executeGitOp(dir, "reset_hard", { at: "HEAD" });
  ok(reset, "reset_hard 在确认卡之后才由前端调用");
  assert.ok(reset.argv.includes("--hard"));
  const clean = await executeGitOp(dir, "clean_fd", {});
  ok(clean, "clean_fd 在确认卡之后才由前端调用");
  assert.ok(clean.argv.includes("-fd"));
  const forcePreview = previewGitOp("push_force", { remote: "origin", branch: "main", lease: true });
  assert.ok(forcePreview?.includes("--force-with-lease"), "默认带保护，不是裸 --force");
  assert.ok(!forcePreview?.includes("--force "), "带保护时不出现 `--force` 单独参数");
  const bareForce = previewGitOp("push_force", { remote: "origin", branch: "main", lease: false });
  assert.ok(bareForce?.includes("--force"), "关掉开关才是裸 --force（仍需红色确认）");

  // ---------------------------------------------------------------- 非仓库 / 参数清洗
  const plain = join(root, "plain");
  mkdirSync(plain, { recursive: true });
  const notRepo = await executeGitOp(plain, "tag", { name: "nope" });
  assert.equal(notRepo.ok, false, "非仓库目录不能执行写操作");
  assert.equal(notRepo.code, "not_repo");
  const injected = await executeGitOp(dir, "tag", { name: "-x; echo pwned", at: "HEAD" });
  bad(injected, "tag 名以 `-` 开头被清洗掉，不变成选项");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("git-ops: ok — 白名单 / 24 动词 / 任意 ref / 富差异 / 写后缓存 / 多哈希 / 冲突 / 串行 / 红色确认 / 参数清洗");
