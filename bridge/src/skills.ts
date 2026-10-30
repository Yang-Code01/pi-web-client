import fs from "node:fs";
import path from "node:path";
import { agentDir, readJson, statePath, writeJson } from "./paths.ts";

export interface SkillInfo {
  /** Skill name as pi knows it; the prompt command is `/skill:<name>`. */
  name: string;
  description: string;
  source: "user" | "project" | "other";
  /** How often this skill was picked from the web palette (drives the "common" list). */
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

/** Minimal frontmatter reader: only `name` and `description` matter here. */
function frontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const out: { name?: string; description?: string } = {};
  for (const raw of text.slice(3, end).split(/\r?\n/)) {
    const m = /^(name|description):\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (value) out[m[1] as "name" | "description"] = value;
  }
  return out;
}

function scanDir(dir: string, source: SkillInfo["source"], out: Map<string, SkillInfo>): void {
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
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, entry.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const fm = frontmatter(text);
    const name = fm.name || entry.name;
    if (out.has(name)) continue;
    out.set(name, { name, description: fm.description ?? "", source, uses: 0, lastUsed: 0 });
  }
}

/**
 * Disk fallback for sessions without a live rpc child (pi itself is the
 * authoritative source: `get_commands` reports what the resource loader found).
 */
export function scanSkills(cwd: string): SkillInfo[] {
  const found = new Map<string, SkillInfo>();
  scanDir(path.join(agentDir(), "skills"), "user", found);
  scanDir(path.join(cwd, ".pi", "skills"), "project", found);
  return [...found.values()];
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
