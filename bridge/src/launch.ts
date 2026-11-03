/**
 * Launch options for a web session (#28): the CLI flags a terminal user would add to `pi`, kept per
 * session so that a stopped session that is taken over again starts with the same ones.
 *
 * Everything coming from the page is validated here; what reaches the argv is a closed set of flags
 * with checked values (spawn gets an argv, never a shell line, so quoting is not an issue — values
 * are still checked so a typo fails here, readably, instead of as a pi startup error).
 */
import fs from "node:fs";
import { statePath, readJson, writeJson } from "./paths.ts";

export interface LaunchOptions {
  /** `--model`: `provider/id` or a pattern pi accepts. */
  model?: string;
  /** `--thinking`. */
  thinking?: string;
  /** `--tools`: comma list, plain names replace the defaults, `+x` / `-x` adjust them. */
  tools?: string;
  /** `--no-builtin-tools`. */
  noBuiltinTools?: boolean;
  /** `-e <path>` (repeatable). The approval gate is always loaded on top. */
  extensions?: string[];
  /** `--skill <path>` (repeatable). */
  skills?: string[];
  /** `--append-system-prompt <text|path>`. */
  appendSystemPrompt?: string;
  /** `-ne`: no discovered / configured / built-in extensions (explicit -e still load). */
  noExtensions?: boolean;
  /** `-nc`: no AGENTS.md / CLAUDE.md. */
  noContextFiles?: boolean;
  /** `--no-mcp`. */
  noMcp?: boolean;
  /** `--offline`. */
  offline?: boolean;
}

const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function pathList(value: unknown, what: string): string[] | undefined {
  if (value == null || value === "") return undefined;
  const list = (Array.isArray(value) ? value : String(value).split(/\r?\n/)).map((v) => String(v).trim()).filter(Boolean);
  if (list.length > 10) throw new Error(`${what}最多 10 个`);
  for (const p of list) if (p.length > 1000 || /[\0\r\n]/.test(p)) throw new Error(`${what}路径不合法：${p.slice(0, 80)}`);
  return list.length ? list : undefined;
}

/** Page input → options, or a readable error. Unknown keys are dropped. */
export function cleanLaunch(raw: unknown): LaunchOptions {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: LaunchOptions = {};
  const model = typeof r.model === "string" ? r.model.trim() : "";
  if (model) {
    if (!/^[\w.:/@*+-]{1,200}$/.test(model)) throw new Error(`模型写法不对：${model}`);
    out.model = model;
  }
  const thinking = typeof r.thinking === "string" ? r.thinking.trim() : "";
  if (thinking) {
    if (!LEVELS.has(thinking)) throw new Error(`思考档位只能是 ${[...LEVELS].join(" / ")}`);
    out.thinking = thinking;
  }
  const tools = typeof r.tools === "string" ? r.tools.replace(/\s+/g, "") : "";
  if (tools) {
    if (!/^[\w*+\-.:,]{1,500}$/.test(tools)) throw new Error(`工具列表写法不对：${tools}`);
    const parts = tools.split(",").filter(Boolean);
    const adjust = parts.filter((p) => p.startsWith("+") || p.startsWith("-"));
    // pi refuses a list mixing plain names with +x / -x (docs/cli.md Tools).
    if (adjust.length && adjust.length !== parts.length) throw new Error("工具列表里不能把普通名字和 +x / -x 混用");
    out.tools = parts.join(",");
  }
  const extensions = pathList(r.extensions, "扩展");
  if (extensions) out.extensions = extensions;
  const skills = pathList(r.skills, "技能");
  if (skills) out.skills = skills;
  const prompt = typeof r.appendSystemPrompt === "string" ? r.appendSystemPrompt.trim() : "";
  if (prompt) {
    if (prompt.length > 20_000) throw new Error("追加的系统提示词太长（最多 2 万字）");
    out.appendSystemPrompt = prompt;
  }
  for (const key of ["noBuiltinTools", "noExtensions", "noContextFiles", "noMcp", "offline"] as const) {
    if (r[key] === true) out[key] = true;
  }
  return out;
}

export function launchArgs(o: LaunchOptions): string[] {
  const args: string[] = [];
  if (o.model) args.push("--model", o.model);
  if (o.thinking) args.push("--thinking", o.thinking);
  if (o.tools) args.push("--tools", o.tools);
  if (o.noBuiltinTools) args.push("--no-builtin-tools");
  if (o.noExtensions) args.push("--no-extensions");
  for (const e of o.extensions ?? []) args.push("--extension", e);
  for (const s of o.skills ?? []) args.push("--skill", s);
  if (o.appendSystemPrompt) args.push("--append-system-prompt", o.appendSystemPrompt);
  if (o.noContextFiles) args.push("--no-context-files");
  if (o.noMcp) args.push("--no-mcp");
  if (o.offline) args.push("--offline");
  return args;
}

/** One-line summary for the session card / 会话 section. */
export function describeLaunch(o: LaunchOptions): string {
  const bits: string[] = [];
  if (o.model) bits.push(`模型 ${o.model}`);
  if (o.thinking) bits.push(`思考 ${o.thinking}`);
  if (o.tools) bits.push(`工具 ${o.tools}`);
  if (o.noBuiltinTools) bits.push("无内置工具");
  if (o.noExtensions) bits.push("不加载扩展");
  if (o.extensions?.length) bits.push(`+${o.extensions.length} 个扩展`);
  if (o.skills?.length) bits.push(`+${o.skills.length} 个技能`);
  if (o.appendSystemPrompt) bits.push("追加系统提示词");
  if (o.noContextFiles) bits.push("不读 AGENTS.md");
  if (o.noMcp) bits.push("无 MCP");
  if (o.offline) bits.push("离线");
  return bits.join(" · ");
}

const launchFile = (id: string) => statePath("launch", `${id.replace(/[^\w.-]/g, "")}.json`);

export function readLaunch(id: string): LaunchOptions {
  if (!id) return {};
  try {
    return cleanLaunch(readJson<unknown>(launchFile(id), {}));
  } catch {
    return {};
  }
}

export function writeLaunch(id: string, o: LaunchOptions): void {
  if (!id) return;
  if (!Object.keys(o).length) {
    fs.rmSync(launchFile(id), { force: true });
    return;
  }
  writeJson(launchFile(id), o);
}
