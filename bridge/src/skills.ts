import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentDir, readJson, statePath, writeJson } from "./paths.ts";

export interface SkillInfo {
  /** Skill name as pi knows it; the prompt command is `/skill:<name>`. */
  name: string;
  description: string;
  source: "user" | "project" | "other";
  /** How often `/skill:<name>` was actually sent from the web client (drives the "common" list). */
  uses: number;
  lastUsed: number;
}

type UsageMap = Record<string, { count?: number; last?: number }>;

function usagePath(): string {
  return statePath("skill-usage.json");
}

function readUsage(): UsageMap {
  return readJson<UsageMap>(usagePath(), {});
}

/**
 * Minimal frontmatter reader: only `name` and `description` matter here. It follows YAML for the
 * shapes skills actually use: a plain one-liner, a quoted string, and a block scalar (`>` folds to
 * spaces, `|` keeps the line breaks) — long descriptions are routinely written as `description: >`.
 */
export function frontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const lines = text.slice(3, end).split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    // Top-level keys only: a nested `name:` inside `metadata:` is not this skill's name.
    const m = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1] as "name" | "description";
    const inline = m[2].trim();
    if (/^[>|][+-]?$/.test(inline)) {
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() && !/^\s/.test(line)) break; // dedent ends the block
        block.push(line.trim());
      }
      while (block.length && !block[block.length - 1]) block.pop();
      const value = inline.startsWith(">") ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
      if (value) out[key] = value;
      continue;
    }
    const value = inline.replace(/^["']|[\"']$/g, "");
    if (value) out[key] = value;
  }
  return out;
}

/** One directory pi reads skills from, and the scope it belongs to. */
export interface SkillRoot {
  scope: "user" | "project";
  dir: string;
}

/**
 * Every root pi discovers skills from, in pi's own order: project `.pi/skills`, project
 * `.agents/skills` from cwd up to the repository root, then the user's `<agentDir>/skills` and
 * `~/.agents/skills`. A name collision keeps the first one found (pi's behaviour), so project
 * skills shadow user skills.
 */
export function skillRoots(cwd: string | null): SkillRoot[] {
  const roots: SkillRoot[] = [];
  if (cwd) {
    roots.push({ scope: "project", dir: path.join(cwd, ".pi", "skills") });
    let dir = path.resolve(cwd);
    for (;;) {
      roots.push({ scope: "project", dir: path.join(dir, ".agents", "skills") });
      if (fs.existsSync(path.join(dir, ".git"))) break;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  roots.push({ scope: "user", dir: path.join(agentDir(), "skills") });
  roots.push({ scope: "user", dir: path.join(os.homedir(), ".agents", "skills") });
  return roots;
}

/** A skill pi would load, plus where it lives — what the 商店 needs to delete one again (D126). */
export interface SkillEntry extends SkillInfo {
  /** Absolute path of the directory holding SKILL.md. */
  path: string;
  /** The root it was discovered in (`skillRoots()`). */
  root: string;
  /** A junction / symlink: removing it unlinks the link and never the target. */
  link: boolean;
  /** The page may delete it: it came from a user root (project skills belong to the repo). */
  removable: boolean;
}

function scanDir(dir: string, scope: SkillRoot["scope"], out: Map<string, SkillEntry>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Junctions/symlinks (Windows skill installs are often junctions) are neither
    // isDirectory() nor isFile(); only regular files are skipped.
    if (entry.isFile()) continue;
    const abs = path.join(dir, entry.name);
    let text: string;
    try {
      text = fs.readFileSync(path.join(abs, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const fm = frontmatter(text);
    const name = fm.name || entry.name;
    if (out.has(name)) continue;
    let link = false;
    try {
      link = fs.lstatSync(abs).isSymbolicLink();
    } catch {
      /* vanished between readdir and lstat: treat as a plain directory */
    }
    out.set(name, { name, description: fm.description ?? "", source: scope === "user" ? "user" : "project", uses: 0, lastUsed: 0, path: abs, root: dir, link, removable: scope === "user" });
  }
}

/**
 * Disk fallback for sessions without a live rpc child (pi itself is the
 * authoritative source: `get_commands` reports what the resource loader found).
 */
export function scanSkills(cwd: string | null): SkillInfo[] {
  return scanSkillEntries(cwd).map(({ path: _p, root: _r, link: _l, removable: _d, ...info }) => info);
}

/** The same scan, keeping each skill's directory (installed list + uninstall guard). */
export function scanSkillEntries(cwd: string | null): SkillEntry[] {
  const found = new Map<string, SkillEntry>();
  for (const root of skillRoots(cwd)) scanDir(root.dir, root.scope, found);
  return [...found.values()];
}

/**
 * Which user root holds `target`, if the page is allowed to delete it. The roots themselves and
 * anything under a project root are refused; the caller still has to check SKILL.md / symlinks.
 */
export function userSkillRootOf(target: string): string | null {
  const abs = path.resolve(target);
  for (const root of skillRoots(null)) {
    if (root.scope !== "user") continue;
    const rel = path.relative(path.resolve(root.dir), abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    return root.dir;
  }
  return null;
}

/** Attach usage counters and order: most used first, then most recent, then name. */
export function rankSkills(list: SkillInfo[]): SkillInfo[] {
  const usage = readUsage();
  return list
    .map((s) => ({
      ...s,
      uses: Number(usage[s.name]?.count) || 0,
      lastUsed: Number(usage[s.name]?.last) || 0,
    }))
    .sort((a, b) => b.uses - a.uses || b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
}

export function bumpSkillUsage(name: string): void {
  if (!name) return;
  const usage = readUsage();
  const prev = usage[name] ?? { count: 0, last: 0 };
  usage[name] = { count: (Number(prev.count) || 0) + 1, last: Date.now() };
  try {
    writeJson(usagePath(), usage);
  } catch {
    /* a read-only state dir only costs the "common" ordering */
  }
}
