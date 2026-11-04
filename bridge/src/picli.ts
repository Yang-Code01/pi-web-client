/**
 * pi's own maintenance subcommands, run for the page (#33): packages (`pi list / install / remove /
 * update`) and MCP servers (`pi mcp list / add / remove / login / logout`).
 *
 * Only a fixed set of operations exists here, each turned into an argv with checked values; the
 * page never sends a command line. Output streams back as it comes (installs take a while), and the
 * two listings are parsed so the page can show rows instead of text.
 */
import { spawn } from "node:child_process";
import { piChildEnv } from "./paths.ts";

export type PiCliOp =
  | { op: "pkg.list"; cwd?: string }
  | { op: "pkg.install"; source: string; local?: boolean; cwd?: string }
  | { op: "pkg.remove"; source: string; local?: boolean; cwd?: string }
  | { op: "pkg.update"; target: "self" | "extensions" | "models" | "all" | string; force?: boolean; cwd?: string }
  | { op: "mcp.list"; cwd?: string }
  | { op: "mcp.add"; name: string; command?: string; args?: string[]; url?: string; env?: string[]; local?: boolean; cwd?: string; description?: string }
  | { op: "mcp.remove"; name: string; local?: boolean; cwd?: string }
  | { op: "mcp.login"; name: string; cwd?: string }
  | { op: "mcp.logout"; name: string; cwd?: string };

const WRITES = new Set(["pkg.install", "pkg.remove", "pkg.update", "mcp.add", "mcp.remove", "mcp.login", "mcp.logout"]);
export const isWriteOp = (op: string) => WRITES.has(op);

function text(v: unknown, what: string, max = 500): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > max || /[\0\r\n]/.test(s)) throw new Error(`${what}不合法`);
  return s;
}

function serverName(v: unknown): string {
  const s = text(v, "MCP 服务名", 100);
  if (!/^[\w.-]+$/.test(s)) throw new Error("MCP 服务名只能用字母、数字、. _ -");
  return s;
}

/** Page request → argv after `cli`, timeout, and whether the output is JSON / the package list. */
export function buildArgs(req: Record<string, unknown>): { args: string[]; timeoutMs: number; parse: "packages" | "mcp" | null } {
  const local = req.local === true ? ["--local"] : [];
  switch (req.op) {
    case "pkg.list":
      return { args: ["list"], timeoutMs: 60_000, parse: "packages" };
    case "pkg.install":
      return { args: ["install", text(req.source, "包来源"), ...local], timeoutMs: 15 * 60_000, parse: null };
    case "pkg.remove":
      return { args: ["remove", text(req.source, "包来源"), ...local], timeoutMs: 5 * 60_000, parse: null };
    case "pkg.update": {
      const t = String(req.target ?? "self");
      const args = t === "self" ? ["update"] : t === "extensions" ? ["update", "--extensions"] : t === "models" ? ["update", "--models"] : t === "all" ? ["update", "--all"] : ["update", text(t, "包来源")];
      // #49: `--force` reinstalls pi even when it is already the latest (the failure-recovery path).
      if (req.force === true) args.push("--force");
      return { args, timeoutMs: 15 * 60_000, parse: null };
    }
    case "mcp.list":
      return { args: ["mcp", "list", "--json"], timeoutMs: 3 * 60_000, parse: "mcp" };
    case "mcp.add": {
      const name = serverName(req.name);
      const extra: string[] = [];
      for (const e of Array.isArray(req.env) ? req.env : []) {
        const kv = text(e, "环境变量", 2000);
        if (!/^[A-Za-z_][\w]*=/.test(kv)) throw new Error(`环境变量要写成 KEY=VALUE：${kv.slice(0, 40)}`);
        extra.push("--env", kv);
      }
      if (typeof req.description === "string" && req.description.trim()) extra.push("--description", text(req.description, "描述", 1000));
      for (const h of Array.isArray(req.headers) ? req.headers : []) {
        const kv = text(h, "header", 4000);
        if (!/^[A-Za-z0-9-]+=/.test(kv)) throw new Error(`header 要写成 Name=Value：${kv.slice(0, 40)}`);
        extra.push("--header", kv);
      }
      if (typeof req.exposure === "string" && req.exposure) {
        if (!["codemode", "deferred", "direct", "hidden"].includes(req.exposure)) throw new Error("exposure 只能是 codemode / deferred / direct / hidden");
        extra.push("--exposure", req.exposure);
      }
      if (typeof req.url === "string" && req.url.trim()) {
        const url = text(req.url, "URL", 2000);
        if (!/^https?:\/\//i.test(url)) throw new Error("URL 要以 http:// 或 https:// 开头");
        return { args: ["mcp", "add", name, ...local, ...extra, "--url", url], timeoutMs: 60_000, parse: null };
      }
      const command = text(req.command, "启动命令", 1000);
      const args = (Array.isArray(req.args) ? req.args : []).map((a) => {
        const s = String(a);
        if (s.length > 2000 || /[\0\r\n]/.test(s)) throw new Error("参数不合法");
        return s;
      });
      return { args: ["mcp", "add", name, ...local, ...extra, "--", command, ...args], timeoutMs: 60_000, parse: null };
    }
    case "mcp.remove":
      return { args: ["mcp", "remove", serverName(req.name), ...local], timeoutMs: 60_000, parse: null };
    case "mcp.login":
      return { args: ["mcp", "login", serverName(req.name)], timeoutMs: 6 * 60_000, parse: null };
    case "mcp.logout":
      return { args: ["mcp", "logout", serverName(req.name)], timeoutMs: 60_000, parse: null };
    default:
      throw new Error(`没有这个操作：${String(req.op)}`);
  }
}

export interface PackageRow {
  scope: "user" | "project";
  source: string;
  path: string | null;
}

/** `pi list` text → rows ("User packages:" / "Project packages:", two-space source, four-space path). */
export function parsePackages(out: string): PackageRow[] {
  const rows: PackageRow[] = [];
  let scope: PackageRow["scope"] | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (/^\S.*packages:\s*$/i.test(line)) {
      scope = /^project/i.test(line) ? "project" : "user";
      continue;
    }
    if (!scope) continue;
    const src = /^ {2}(\S.*)$/.exec(line);
    const loc = /^ {4}(\S.*)$/.exec(line);
    if (loc && rows.length && rows[rows.length - 1].path === null) rows[rows.length - 1].path = loc[1].trim();
    else if (src && !line.startsWith("    ")) rows.push({ scope, source: src[1].trim(), path: null });
  }
  return rows;
}

/** Run one op. `onOutput` gets stdout+stderr as it arrives; resolves with the exit code and parsed data. */
export function runPiCli(
  cli: string,
  req: Record<string, unknown>,
  onOutput: (chunk: string) => void,
): { done: Promise<{ code: number | null; data: unknown; output: string }>; kill: () => void } {
  const { args, timeoutMs, parse } = buildArgs(req);
  const cwd = typeof req.cwd === "string" && req.cwd ? req.cwd : process.cwd();
  const env = piChildEnv();
  const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let all = "";
  const take = (b: Buffer, isOut: boolean) => {
    const s = b.toString("utf8");
    if (isOut) stdout += s;
    all = (all + s).slice(-200_000);
    // The JSON listing is data, not something to show line by line.
    if (parse !== "mcp" || !isOut) onOutput(s);
  };
  child.stdout.on("data", (b) => take(b, true));
  child.stderr.on("data", (b) => take(b, false));
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const done = new Promise<{ code: number | null; data: unknown; output: string }>((resolve) => {
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, data: null, output: `${all}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let data: unknown = null;
      if (parse === "packages") data = parsePackages(stdout);
      if (parse === "mcp") {
        try {
          data = JSON.parse(stdout);
        } catch {
          data = null;
          onOutput(stdout);
        }
      }
      resolve({ code, data, output: all });
    });
  });
  return { done, kill: () => child.kill() };
}
