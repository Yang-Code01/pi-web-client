/**
 * 设置 → 子代理：把磁盘上的 agent 定义扫成一张只读事实表（#212）。
 *
 * 不 import pi-subagents 包本身 —— 只认目录，所以包没装、目录不在、settings.json 坏掉都能给出
 * 可解释的空结果，而不是把设置面板带崩。扫描顺序 包内 → 用户 → 项目 → agentScanDirs，同名后者
 * 覆盖前者（和 pi-subagents 自己的优先级一致）。排除目录先统一算好（agentExcludeDirs 与
 * agentScanDirs 里 `!` 开头的条目），整个子树不扫。
 *
 * frontmatter 只解析文件开头一段 `---` 之间的行级 `key: value`，不做完整 YAML：agent 文件里
 * 有缩进的多行字段（tools 列表之类）时，那些行直接跳过。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentDir as defaultAgentDir } from "./paths.ts";

/** `package` 包内、`user` 用户级、`project` 项目级、`scan` 是 settings 的 agentScanDirs 追加的目录。 */
export type AgentSource = "package" | "user" | "project" | "scan";

export interface SubagentFrontmatter {
  name: string | null;
  description: string | null;
  model: string | null;
  thinking: string | null;
}

export interface SubagentFact extends SubagentFrontmatter {
  name: string;
  source: AgentSource;
  path: string;
}

export interface ScannedAgentDir {
  path: string;
  source: AgentSource;
  exists: boolean;
  /** 这个目录里读到的 agent 定义数（被同名覆盖的也算）。 */
  count: number;
}

export interface SubagentScan {
  cwd: string | null;
  /** 包根存不存在；false 时前端说明「没装 pi-subagents」，而不是「没有 agent」。 */
  installed: boolean;
  /** 同名覆盖之后剩下的 agent，按扫描顺序。 */
  agents: SubagentFact[];
  /** 每个被扫的目录（含不存在的），按扫描顺序。 */
  directories: ScannedAgentDir[];
  errors: string[];
}

export interface ScanSubagentsOptions {
  cwd?: string | null;
  /** 全局 pi agent 目录；默认 paths.agentDir()。 */
  agentDir?: string;
  /** 用户主目录（`~` 展开用）；默认 os.homedir()。 */
  homeDir?: string;
  /** pi-subagents 包根候选；默认从 agentDir 与 cwd 的 node_modules 里找。 */
  packageRoots?: string[];
}

const FIELDS = ["name", "description", "model", "thinking"] as const;

/** 目录递归深度：agent 一般放一层子目录，再深就是仓库/依赖了。 */
const MAX_DEPTH = 2;

/** 解析 agent 文件开头那段 frontmatter；没有 `---` 或没有值就是 null。 */
export function parseFrontmatter(text: string): SubagentFrontmatter {
  const out: SubagentFrontmatter = { name: null, description: null, model: null, thinking: null };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  if (lines[i]?.trim() !== "---") return out;
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (!(FIELDS as readonly string[]).includes(key)) continue;
    out[key as keyof SubagentFrontmatter] = unquote(match[2]);
  }
  return out;
}

function unquote(raw: string): string | null {
  let value = raw.trim();
  const quote = value[0];
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1).trim();
  return value ? value : null;
}

export function scanSubagents(options: ScanSubagentsOptions = {}): SubagentScan {
  const cwd = options.cwd ? path.resolve(options.cwd) : null;
  const agent = path.resolve(options.agentDir ?? defaultAgentDir());
  const home = path.resolve(options.homeDir ?? os.homedir());
  const errors: string[] = [];

  const userSettings = readSettingsJson(path.join(agent, "settings.json"), errors);
  const projectSettings = cwd ? readSettingsJson(path.join(cwd, ".pi", "settings.json"), errors) : null;

  // 排除目录与追加目录都必须先全部算完，否则先扫的目录会被后读到的 `!` 条目漏掉。
  const excludes: string[] = [];
  const extraDirs: DirPlan[] = [];
  collectSettings(userSettings, agent, home, excludes, extraDirs);
  collectSettings(projectSettings, cwd ? path.join(cwd, ".pi") : agent, home, excludes, extraDirs);

  const packageRoots = options.packageRoots ?? defaultPackageRoots(agent, cwd);
  const plans: DirPlan[] = packageRoots.map((dir) => ({ dir: path.join(dir, "agents"), source: "package" as AgentSource }));
  plans.push({ dir: path.join(agent, "agents"), source: "user" });
  if (cwd) {
    // 文档里的旧项目路径 `.agents/**/*.md` 排在 `.pi/agents` **前面**：同名时项目配置目录赢（agents.md 的
    // Discovery notes）。`~/.agents` 不是 agent 目录 —— 那是 skills 的根，扫它会拿一堆 SKILL.md 当 agent。
    plans.push({ dir: path.join(cwd, ".agents"), source: "project" });
    plans.push({ dir: path.join(cwd, ".pi", "agents"), source: "project" });
  }
  plans.push(...extraDirs);

  const seen = new Set<string>();
  const directories: ScannedAgentDir[] = [];
  const agents = new Map<string, SubagentFact>();
  for (const plan of plans) {
    const key = dirKey(plan.dir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (excludes.some((excluded) => isWithin(excluded, plan.dir))) continue;
    directories.push(scanDir(plan, agents, errors, excludes));
  }

  return {
    cwd,
    installed: packageRoots.some((dir) => isDir(dir)),
    agents: [...agents.values()],
    directories,
    errors,
  };
}

interface DirPlan {
  dir: string;
  source: AgentSource;
}

function collectSettings(
  settings: Record<string, unknown> | null,
  base: string,
  home: string,
  excludes: string[],
  extraDirs: DirPlan[],
): void {
  const subagents = asRecord(settings?.subagents) ?? {};
  for (const raw of asStrings(subagents.agentExcludeDirs)) excludes.push(resolvePath(raw, base, home));
  for (const raw of asStrings(subagents.agentScanDirs)) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith("!")) {
      excludes.push(resolvePath(entry.slice(1), base, home));
      continue;
    }
    for (const dir of expandScanPattern(entry, base, home)) extraDirs.push({ dir, source: "scan" });
  }
}

function scanDir(plan: DirPlan, agents: Map<string, SubagentFact>, errors: string[], excludes: string[]): ScannedAgentDir {
  const exists = isDir(plan.dir);
  if (!exists) return { path: plan.dir, source: plan.source, exists: false, count: 0 };

  const files: string[] = [];
  walk(plan.dir, 0, files, errors, excludes);
  files.sort();
  let count = 0;
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      errors.push(`${file}：${message(err)}`);
      continue;
    }
    const frontmatter = parseFrontmatter(text);
    const name = frontmatter.name ?? path.basename(file, ".md");
    agents.set(name, { ...frontmatter, name, source: plan.source, path: file });
    count += 1;
  }
  return { path: plan.dir, source: plan.source, exists: true, count };
}

function walk(dir: string, depth: number, out: string[], errors: string[], excludes: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    errors.push(`${dir}：${message(err)}`);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludes.some((excluded) => isWithin(excluded, full))) continue;
      if (depth < MAX_DEPTH) walk(full, depth + 1, out, errors, excludes);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md") || entry.name.endsWith(".chain.md")) continue;
    out.push(full);
  }
}

/** 默认包根：全局 npm 目录 + 项目自己的 node_modules / .pi/npm。 */
function defaultPackageRoots(agent: string, cwd: string | null): string[] {
  const roots = [path.join(agent, "npm", "node_modules", "pi-subagents")];
  if (cwd) roots.push(path.join(cwd, "node_modules", "pi-subagents"), path.join(cwd, ".pi", "npm", "node_modules", "pi-subagents"));
  return roots;
}

/** `~` 展开与相对路径解析；相对路径按 settings 文件所在目录算（用户级 = agentDir，项目级 = <cwd>/.pi）。 */
function resolvePath(raw: string, base: string, home: string): string {
  const value = expandHome(raw.trim(), home);
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
}

/** agentScanDirs 支持 `~` 与单段 `*`（形如 `~/.pi/flows/<一段>/agents`）；展不开就返回空。 */
function expandScanPattern(raw: string, base: string, home: string): string[] {
  const full = resolvePath(raw, base, home);
  const parts = full.split(path.sep);
  const star = parts.indexOf("*");
  if (star < 0) return [full];
  if (parts.some((part, index) => index !== star && part.includes("*"))) return [];
  const head = parts.slice(0, star).join(path.sep) || path.sep;
  const tail = parts.slice(star + 1);
  let names: string[];
  try {
    names = fs
      .readdirSync(head, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => path.join(head, name, ...tail));
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) return path.join(home, value.slice(2));
  return value;
}

function readSettingsJson(file: string, errors: string[]): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  try {
    return asRecord(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    errors.push(`${file}：${message(err)}`);
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Windows 下同一个目录有两种大小写，比较/去重前统一。 */
function dirKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** `candidate` 在 `root` 之内（含 root 自己）。 */
function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(dirKey(root), dirKey(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
