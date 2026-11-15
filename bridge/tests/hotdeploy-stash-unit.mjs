/**
 * 热部署 stash 流程：在临时 git 仓库里跑真的 stash/pop，不碰本仓库。
 *
 *   node bridge/tests/hotdeploy-stash-unit.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findStash, stashPush, stashRestore } from "../../scripts/hotdeploy-git.mjs";

function git(repo, ...args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} 失败：${r.stderr || r.stdout}`);
  return String(r.stdout ?? "").trim();
}

function write(repo, name, text) {
  fs.writeFileSync(path.join(repo, name), text);
}

function read(repo, name) {
  return fs.readFileSync(path.join(repo, name), "utf8");
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hotdeploy-stash-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "hotdeploy@example.test");
  git(repo, "config", "user.name", "hotdeploy test");
  git(repo, "config", "core.autocrlf", "false");
  write(repo, "a.txt", "base\n");
  write(repo, "b.txt", "base b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

// ------------------------------------------------- ① 暂存后工作区干净，恢复后内容和未跟踪文件都回来
{
  const repo = makeRepo();
  // 先放一个旧 stash，确认按 message 找，不会误取 stash@{0}。
  write(repo, "b.txt", "old stash\n");
  const old = stashPush(repo, "old-stash");
  assert.equal(old.ok, true);

  write(repo, "a.txt", "local change\n");
  write(repo, "new.txt", "untracked\n");
  const msg = "hotdeploy-test-1";
  const pushed = stashPush(repo, msg);
  assert.equal(pushed.ok, true, "stash push 成功");
  assert.equal(git(repo, "status", "--porcelain"), "", "暂存后工作区应该干净");
  assert.equal(read(repo, "a.txt"), "base\n");
  assert.equal(fs.existsSync(path.join(repo, "new.txt")), false);
  assert.ok(findStash(repo, msg), "按 message 能找到新 stash");
  assert.ok(findStash(repo, "old-stash"), "旧 stash 还在");

  const restored = stashRestore(repo, msg);
  assert.equal(restored.ok, true, "stash pop 成功");
  assert.equal(read(repo, "a.txt"), "local change\n");
  assert.equal(read(repo, "new.txt"), "untracked\n", "未跟踪文件也要恢复");
  assert.equal(findStash(repo, msg), null, "pop 后新 stash 应该消失");
  assert.ok(findStash(repo, "old-stash"), "旧 stash 不能被动到");

  fs.rmSync(repo, { recursive: true, force: true });
}

// ------------------------------------------------- ② pop 冲突：失败但 stash 不能丢
{
  const repo = makeRepo();
  write(repo, "a.txt", "local change\n");
  const msg = "hotdeploy-test-conflict";
  assert.equal(stashPush(repo, msg).ok, true);

  // 模拟 pull 后上游改了同一个文件，pop 必然冲突。
  write(repo, "a.txt", "remote change\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "remote changed a.txt");

  const restored = stashRestore(repo, msg);
  assert.equal(restored.ok, false, "冲突时 pop 必须报失败");
  assert.ok(findStash(repo, msg), "冲突后 stash 必须保留");

  // 清掉冲突现场，避免临时目录删不掉。
  git(repo, "reset", "--hard", "HEAD");
  fs.rmSync(repo, { recursive: true, force: true });
}

// ------------------------------------------------- ③ worker 端到端：build 失败时也要恢复 stash
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hotdeploy-worker-"));
  const remote = `${repo}-remote.git`;
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "hotdeploy@example.test");
  git(repo, "config", "user.name", "hotdeploy test");
  git(repo, "config", "core.autocrlf", "false");
  fs.mkdirSync(path.join(repo, "bridge"));
  write(repo, "bridge/package.json", JSON.stringify({ name: "fake-bridge", private: true }));
  write(repo, "build.mjs", "process.exit(1);\n");
  write(repo, "package.json", JSON.stringify({ name: "fake", private: true, scripts: { build: "node build.mjs" } }));
  write(repo, ".gitignore", ".scratch/\n");
  write(repo, "tracked.txt", "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  fs.mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");

  write(repo, "tracked.txt", "base\nlocal\n");
  write(repo, "new.txt", "untracked\n");
  const worker = fileURLToPath(new URL("../../scripts/hotdeploy.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [worker, "--dir", repo, "--branch", "main", "--port", "65534", "--stash"], {
    cwd: path.resolve(path.dirname(worker), ".."),
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0, "build 失败时 worker 必须报错");
  assert.equal(read(repo, "tracked.txt"), "base\nlocal\n", "失败后 tracked 改动要恢复");
  assert.equal(read(repo, "new.txt"), "untracked\n", "失败后未跟踪文件要恢复");
  assert.equal(git(repo, "stash", "list"), "", "失败恢复后不应留下本轮 stash");

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
}

// ------------------------------------------------- ④ worker pop 冲突：停在恢复步骤，不进入换进程
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hotdeploy-worker-conflict-"));
  const remote = `${repo}-remote.git`;
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "hotdeploy@example.test");
  git(repo, "config", "user.name", "hotdeploy test");
  git(repo, "config", "core.autocrlf", "false");
  fs.mkdirSync(path.join(repo, "bridge"));
  write(repo, "bridge/package.json", JSON.stringify({ name: "fake-bridge", private: true }));
  write(repo, "build.mjs", [
    'import fs from "node:fs";',
    'fs.mkdirSync("bridge/dist", { recursive: true });',
    'fs.writeFileSync("bridge/dist/build-id.json", JSON.stringify({ id: "fake-build" }));',
    "",
  ].join("\n"));
  write(repo, "package.json", JSON.stringify({ name: "fake", private: true, scripts: { build: "node build.mjs" } }));
  write(repo, ".gitignore", ".scratch/\nbridge/dist/\n");
  write(repo, "tracked.txt", "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  fs.mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");

  // 远端把 tracked.txt 改掉；本地回到 base 后再改同一个文件，pop 必冲突。
  write(repo, "tracked.txt", "remote\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-q", "-m", "remote changed tracked.txt");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "reset", "--hard", "HEAD~1");
  write(repo, "tracked.txt", "local\n");

  const worker = fileURLToPath(new URL("../../scripts/hotdeploy.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [worker, "--dir", repo, "--branch", "main", "--port", "65533", "--stash"], {
    cwd: path.resolve(path.dirname(worker), ".."),
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0, "pop 冲突时 worker 必须报错");
  const state = JSON.parse(read(repo, ".scratch/hot-deploy/state.json"));
  assert.equal(state.step, 3, "必须停在恢复本地改动这一步");
  assert.match(state.error, /本地改动恢复失败/, "错误里要说明恢复失败");
  assert.ok(state.stash, "错误里要留下 stash message");
  assert.ok(git(repo, "stash", "list").includes(state.stash), "冲突后 stash 必须保留");
  assert.ok(!read(repo, ".scratch/hot-deploy/worker.log").includes("杀掉旧 bridge"), "不能进入换进程");

  git(repo, "reset", "--hard", "HEAD");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
}

console.log("hotdeploy-stash-unit: ok");
