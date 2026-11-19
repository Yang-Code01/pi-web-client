/**
 * 热部署只做一件事：把「暂存本地改动 → 拉分支 → 恢复」这段 git 操作单独拎出来，
 * 好让 worker 和临时仓库测试共用同一份实现。这里不碰进程、不写状态。
 */
import { spawnSync } from "node:child_process";

function gitIn(repo, args) {
  // windowsHide：热部署 worker 无控制台，不带就每个 git 弹一扇窗。
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  return {
    ok: r.status === 0,
    status: r.status,
    out: String(r.stdout ?? ""),
    err: String(r.stderr ?? ""),
  };
}

const DEFAULT_HOTDEPLOY_PROXY = "http://127.0.0.1:18791";
export { DEFAULT_HOTDEPLOY_PROXY };

/** 统一代理 URL：补 http://、压小写、去末尾斜杠，避免同一代理因写法不同重复尝试。 */
function normalizeProxy(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(withScheme).href.replace(/\/+$/, "");
  } catch {
    return withScheme.replace(/\/+$/, "");
  }
}

/**
 * 热部署 fetch 的代理候选：先让用户显式指定，再跟随当前环境，最后才用历史默认端口。
 * 同一代理只保留一次。
 */
export function proxyCandidates(env = process.env) {
  const out = [];
  for (const key of ["BILLION_CONTEXT_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    const value = normalizeProxy(env[key]);
    if (value && !out.includes(value)) out.push(value);
  }
  const fallback = normalizeProxy(DEFAULT_HOTDEPLOY_PROXY);
  if (!out.includes(fallback)) out.push(fallback);
  return out;
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
  if (!r.ok) return { ok: false, created: false, why: `git stash push 失败：${(r.err || r.out).trim().slice(-800)}` };
  const entry = findStash(repo, message);
  // push 已经成功、只是 find 不到：create 标记让 worker 把 message 写进状态，至少用户知道去哪找。
  if (!entry) return { ok: false, created: true, why: `git stash push 执行了，但 stash list 里找不到 ${message}` };
  return { ok: true, entry };
}

/**
 * 恢复 stash。只恢复工作区，不还原暂存区：`pop --index` 在 index 冲突时可能已经落地
 * 文件却返回非零，worker 会误判成没恢复。热部署只承诺工作区内容回来，index 状态不是契约。
 * 冲突时 git 会保留 stash 不动，worker 应该中止部署、让旧进程继续跑。
 */
export function stashRestore(repo, message) {
  const entry = findStash(repo, message);
  if (!entry) return { ok: false, why: `找不到 stash「${message}」；可能已被手动 pop/drop` };
  const r = gitIn(repo, ["stash", "pop", entry.ref]);
  if (!r.ok) return { ok: false, why: `git stash pop ${entry.ref} 失败：${(r.err || r.out).trim().slice(-1000)}` };
  return { ok: true, entry };
}
