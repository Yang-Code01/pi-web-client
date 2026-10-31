import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Q-021: the branch name under the composer. The page cannot start a process, so the only place
 * that can answer "which branch is this" is the bridge. Everything here is read-only: `rev-parse`
 * and `status --porcelain` never write, and `core.fsmonitor=false` keeps a repo's configured
 * fsmonitor hook from being executed on our behalf.
 */

export interface GitInfo {
  /** Repository root as git reports it (`--show-toplevel`, already forward-slashed on Windows). */
  repo: string;
  /** Branch name, or the short SHA when HEAD is detached. Empty only for an unborn HEAD. */
  branch: string;
  /** HEAD is detached: `branch` is a short SHA, not a ref. */
  detached: boolean;
  /** `git init` ran but nothing was committed — there is no HEAD to name yet. */
  empty: boolean;
  /** Lines from `status --porcelain=v1 -uno`: tracked changes + staged; 0 = clean. */
  dirty: number;
}

const run = promisify(execFile);

/** git is slow enough on Windows (30-80ms per call) that a 1s poll cannot just re-run it. */
const TTL_MS = 5000;
const cache = new Map<string, { at: number; info: GitInfo | null }>();

/** One `git` invocation. `null` on any failure — including git not being installed at all. */
async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", dir, "-c", "core.fsmonitor=false", ...args], {
      timeout: 4000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return String(stdout).trim();
  } catch {
    return null;
  }
}

async function probe(dir: string): Promise<GitInfo | null> {
  // Doubles as the "is this a repository" test: outside a work tree this fails with exit 128.
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;

  const abbrev = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let branch = abbrev ?? "";
  let detached = false;
  let empty = false;
  if (abbrev === null) {
    // `git init` with no commit: rev-parse HEAD is ambiguous, the repo still exists.
    empty = true;
  } else if (branch === "HEAD") {
    const short = await git(dir, ["rev-parse", "--short", "HEAD"]);
    if (short) {
      branch = short;
      detached = true;
    } else {
      branch = "";
      empty = true;
    }
  }

  // -uno skips untracked scanning (an order of magnitude on big repos); --no-optional-locks keeps
  // us from taking index.lock while the user's own git is running in a terminal.
  const porcelain = await git(dir, ["--no-optional-locks", "status", "--porcelain=v1", "-uno"]);
  const dirty = porcelain ? porcelain.split("\n").filter((line) => line.trim() !== "").length : 0;

  return { repo: top.replace(/\\/g, "/"), branch, detached, empty, dirty };
}

/**
 * Branch (or detached SHA) of the repository containing `dir`, or `null` when it is not in one.
 * Cached for TTL_MS per absolute path; `fresh` bypasses the cache (window focus, 一轮结束).
 */
export async function gitInfo(dir: string, fresh = false): Promise<GitInfo | null> {
  if (!dir) return null;
  const key = path.resolve(dir);
  const hit = cache.get(key);
  const now = Date.now();
  if (!fresh && hit && now - hit.at < TTL_MS) return hit.info;
  let info: GitInfo | null = null;
  try {
    info = await probe(key);
  } catch {
    info = null;
  }
  cache.set(key, { at: now, info });
  if (cache.size > 200) {
    // Bound the map: only the last few directories matter, and this runs on every 切会话.
    for (const [k, v] of cache) if (now - v.at > TTL_MS * 12) cache.delete(k);
  }
  return info;
}
