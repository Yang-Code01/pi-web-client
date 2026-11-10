import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { piChildEnv } from "./paths.ts";

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
        // POSIX 上 npm 把 pi 做成指向 cli.js 的 symlink，读进来就是 40 MB 的 bundle；
        // 启动器脚本本身只有几行，超过 1 MB 就直接跳过。
        if (fs.statSync(file).size > 1_000_000) continue;
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
    // Windows 上 npm 是 `npm.cmd`：Node ≥ 18.20 拒绝不带 shell 去跑 `.cmd`（EINVAL，会被下面的 catch
    // 静默吞掉，这一条候选就永远缺席）。参数是常量，走 shell 没有注入面。
    const win = process.platform === "win32";
    const root = execFileSync(win ? "npm.cmd" : "npm", ["root", "-g"], {
      shell: win,
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

/** Version of the pi package sitting next to the bundle; re-read after `pi update` replaces it (#49). */
export function readVersion(cli: string): string {
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
 *
 * `fast` skips extension discovery (`-ne --no-session`): 1–2 s instead of the 12–15 s a full boot
 * costs with a real extension set (D150). The price is the models an extension registers
 * (`qwen-pool/…`), so the fast pass is only ever the first of two (see `pushCatalog` in index.ts).
 */
export async function fetchModels(cli: string, opts: { fast?: boolean; timeoutMs?: number } = {}): Promise<ModelInfo[]> {
  const args = opts.fast ? [cli, "--mode", "rpc", "-ne", "--no-session"] : [cli, "--mode", "rpc"];
  // 完整那趟要跑用户装的全部扩展，25 s 在这台机器上已经不够用了；快的那趟没有扩展可等。
  const timeoutMs = opts.timeoutMs ?? (opts.fast ? 15000 : 45000);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: piChildEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buf = "";
    let stderr = "";
    let settled = false;
    const done = (err: Error | null, list?: ModelInfo[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 500);
      err ? reject(err) : resolve(list ?? []);
    };
    const why = () => (stderr.trim() ? `：${stderr.trim().split(/\r?\n/).slice(-3).join(" ")}` : "");
    const timer = setTimeout(() => done(new Error(`get_available_models 超时（${Math.round(timeoutMs / 1000)}s）${why()}`)), timeoutMs);
    // stderr 只留尾巴：pi 崩掉时真正的原因通常在最后几行，把它带进报错比干等 45 s 有用。
    child.stderr.on("data", (d) => { stderr = (stderr + d.toString("utf8")).slice(-2000); });
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      for (let at = buf.indexOf("\n"); at >= 0; at = buf.indexOf("\n")) {
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
    // pi 在回答之前就退出（扩展崩溃、`pi update` 正换文件）：以前这里没人接，界面就白等满超时。
    child.on("exit", (code, signal) => done(new Error(`pi 还没回模型列表就退出了（code ${code ?? "-"}${signal ? ` / ${signal}` : ""}）${why()}`)));
    // Same race as RpcChild: the child can be gone before this write lands.
    child.stdin.on("error", (err: Error) => done(err));
    try {
      child.stdin.write(`${JSON.stringify({ id: "models-1", type: "get_available_models" })}\n`);
    } catch (err) {
      done(err as Error);
    }
  });
}
