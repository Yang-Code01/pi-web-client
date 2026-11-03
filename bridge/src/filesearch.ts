/**
 * `@` file search for the composer (#25): what the terminal's `@` autocomplete does — fuzzy-find a
 * path under the session's cwd and insert it.
 *
 * The candidate list comes from `git ls-files` (tracked + untracked, minus ignored) when the cwd is
 * in a repo, else from a bounded walk that skips the usual heavy folders. It is cached per cwd for
 * a few seconds: every keystroke asks again.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_FILES = 20_000;
const CACHE_MS = 10_000;
const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "venv", "__pycache__", "target", ".cache", ".scratch"]);

const cache = new Map<string, { at: number; files: Promise<string[]> }>();

function gitFiles(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout).split("\0").filter(Boolean).slice(0, MAX_FILES));
      },
    );
  });
}

function walk(cwd: string): string[] {
  const out: string[] = [];
  const stack = [""];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) stack.push(child);
      } else if (e.isFile()) out.push(child);
      if (out.length >= MAX_FILES) break;
    }
  }
  return out;
}

export function listFiles(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
  const files = gitFiles(cwd).then((list) => list ?? walk(cwd));
  cache.set(cwd, { at: Date.now(), files });
  return files;
}

/**
 * Rank like an editor's quick-open: the query's characters must appear in order; a hit in the file
 * name beats one spread over the path, consecutive runs and word starts score extra, shorter wins.
 */
export function rankFiles(files: string[], query: string, limit = 30): string[] {
  const q = query.toLowerCase().replace(/\\/g, "/");
  if (!q) return files.slice().sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length).slice(0, limit);
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    const f = file.toLowerCase();
    const base = f.slice(f.lastIndexOf("/") + 1);
    let score = 0;
    if (base === q) score += 1000;
    else if (base.startsWith(q)) score += 600;
    else if (base.includes(q)) score += 400;
    else if (f.includes(q)) score += 200;
    else {
      // subsequence over the whole path
      let i = 0;
      let run = 0;
      let bonus = 0;
      for (let j = 0; j < f.length && i < q.length; j++) {
        if (f[j] === q[i]) {
          i++;
          run++;
          bonus += run + (j === 0 || "/._-".includes(f[j - 1]) ? 3 : 0);
        } else run = 0;
      }
      if (i < q.length) continue;
      score += bonus;
    }
    scored.push({ file, score: score - file.length * 0.1 });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.file);
}
