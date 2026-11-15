/**
 * 热部署只做一件事：把「暂存本地改动 → 拉分支 → 恢复」这段 git 操作单独拎出来，
 * 好让 worker 和临时仓库测试共用同一份实现。这里不碰进程、不写状态。
 */
import { spawnSync } from "node:child_process";

function gitIn(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return {
    ok: r.status === 0,
    status: r.status,
    out: String(r.stdout ?? ""),
    err: String(r.stderr ?? ""),
  };
}

/** `git stash list --format=%gd%x09%H%x09%s`：按唯一 message 找，别盲取 stash@{0}。 */
export function findStash(repo, message) {
  const r = gitIn(repo, ["stash", "list", "--format=%gd%x09%H%x09%s"]);
  if (!r.ok) return null;
  for (const line of r.out.split(/\r?\n/)) {
    const [ref, sha, subject] = line.split("\t");
    // stash 的 commit subject 是「On <branch>: <message>」，message 是我们生成的唯一串。
    if (ref && sha && (subject === message || subject.endsWith(`: ${message}`))) return { ref, sha, subject };
  }
  return null;
}

/** 暂存全部改动（含未跟踪、不含 ignored），成功后必须能在 stash list 里按 message 找到。 */
export function stashPush(repo, message) {
  const r = gitIn(repo, ["stash", "push", "--include-untracked", "-m", message]);
  if (!r.ok) return { ok: false, why: `git stash push 失败：${(r.err || r.out).trim().slice(-800)}` };
  const entry = findStash(repo, message);
  if (!entry) return { ok: false, why: `git stash push 执行了，但 stash list 里找不到 ${message}` };
  return { ok: true, entry };
}

/**
 * 恢复 stash。用 `pop --index` 尽量把暂存区状态也还原；
 * 冲突时 git 会保留 stash 不动，worker 应该中止部署、让旧进程继续跑。
 */
export function stashRestore(repo, message) {
  const entry = findStash(repo, message);
  if (!entry) return { ok: false, why: `找不到 stash「${message}」；可能已被手动 pop/drop` };
  const r = gitIn(repo, ["stash", "pop", "--index", entry.ref]);
  if (!r.ok) return { ok: false, why: `git stash pop ${entry.ref} 失败：${(r.err || r.out).trim().slice(-1000)}` };
  return { ok: true, entry };
}
