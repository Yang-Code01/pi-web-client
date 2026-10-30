import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PKG = path.join(
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);

function nvmCandidates(): string[] {
  const root = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "nvm") : "";
  if (!root) return [];
  try {
    return fs
      .readdirSync(root)
      .filter((d) => /^v\d+\./.test(d))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((d) => path.join(root, d, PKG));
  } catch {
    return [];
  }
}

/** Launchers like C:\Users\me\bin\pi.cmd hardcode the real cli.js; read it back out. */
function launcherCandidates(): string[] {
  const out: string[] = [];
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of ["pi.cmd", "pi.bat", "pi"]) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      try {
        const text = fs.readFileSync(file, "utf8");
        for (const m of text.matchAll(/"([^"]*pi-coding-agent[^"]*cli\.js)"/g)) out.push(m[1]);
        for (const m of text.matchAll(/([A-Za-z]:\\[^\s"]*pi-coding-agent[^\s"]*cli\.js)/g)) out.push(m[1]);
      } catch {
        /* ignore unreadable launcher */
      }
    }
  }
  return out;
}

function npmRootCandidates(): string[] {
  const out: string[] = [];
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const root = execFileSync(npm, ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (root) out.push(path.join(root, PKG));
  } catch {
    /* npm not available */
  }
  return out;
}

export function piCandidates(): string[] {
  const list: string[] = [];
  if (process.env.PI_BIN) list.push(process.env.PI_BIN);
  list.push(...nvmCandidates());
  list.push(...launcherCandidates());
  list.push(path.join(path.dirname(process.execPath), PKG));
  list.push(...npmRootCandidates());
  list.push(path.join(process.env.APPDATA ?? "", "npm", PKG));
  list.push(path.join(process.env.ProgramData ?? "C:/ProgramData", "npm", PKG));
  return Array.from(new Set(list.filter(Boolean)));
}

export function resolvePi(): { cli: string; version: string } {
  for (const cli of piCandidates()) {
    if (!fs.existsSync(cli)) continue;
    return { cli, version: readVersion(cli) };
  }
  throw new Error(
    [
      "找不到 pi 的 CLI。试过这些路径：",
      ...piCandidates().map((c) => `  - ${c}`),
      "可以设置环境变量 PI_BIN 指向 .../pi-coding-agent/dist/bundle/cli.js",
    ].join("\n"),
  );
}

function readVersion(cli: string): string {
  const pkg = path.join(path.dirname(path.dirname(path.dirname(cli))), "package.json");
  try {
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Levels pi knows about, in the order a UI should show them. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  levels: string[];
  contextWindow?: number;
  supportsImages?: boolean;
}

function levelsOf(model: any): string[] {
  const map = model?.thinkingLevelMap;
  if (!model?.reasoning) return ["off"];
  if (!map || typeof map !== "object") return ["off", "low", "medium", "high"];
  const supported = THINKING_LEVELS.filter((lv) => map[lv] != null);
  return supported.length ? supported : ["off"];
}

/**
 * One throwaway `--mode rpc` child just to read the model catalog: the list belongs to the
 * pi install, not to a session, so it must be available before any session is opened.
 */
export async function fetchModels(cli: string): Promise<ModelInfo[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--mode", "rpc"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buf = "";
    const done = (err: Error | null, list?: ModelInfo[]) => {
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 500);
      err ? reject(err) : resolve(list ?? []);
    };
    const timer = setTimeout(() => done(new Error("get_available_models 超时")), 25000);
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let at: number;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at).replace(/\r$/, "");
        buf = buf.slice(at + 1);
        if (!line.trim()) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "response" && msg.command === "get_available_models") {
          const models = (msg.data?.models ?? []).map((m: any) => ({
            id: String(m.id),
            name: String(m.name ?? m.id),
            provider: String(m.provider ?? ""),
            levels: levelsOf(m),
            contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
            supportsImages: Array.isArray(m.input) ? m.input.includes("image") : undefined,
          }));
          done(null, models);
          return;
        }
      }
    });
    child.on("error", (err) => done(err));
    // Same race as RpcChild: the child can be gone before this write lands.
    child.stdin.on("error", (err: Error) => done(err));
    try {
      child.stdin.write(JSON.stringify({ id: "models-1", type: "get_available_models" }) + "\n");
    } catch (err) {
      done(err as Error);
    }
  });
}
