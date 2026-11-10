import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { piChildEnv } from "./paths.ts";

/** 包内 cli 的相对路径。`node_modules` 那一层单独留着：`npm root -g` 给的**已经**是它，
 *  再拼一次就成了 `node_modules/node_modules/...`（这条曾经让 POSIX 与 Windows 都白跑）。 */
const PKG_IN_NM = path.join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const PKG = path.join("node_modules", PKG_IN_NM);

/** 找 pi 要看的那些「环境」。默认取真进程的；测试传假的，免得真去 fork npm 或真读 bundle。 */
export interface PiProbe {
  platform: NodeJS.Platform;
  execPath: string;
  pathEnv: string;
  env: NodeJS.ProcessEnv;
  /** `npm root -g` 的真实调用；传 null 就不问（测路径拼法的用例走这条）。 */
  npmRoot: (() => string | null) | null;
}

/** 一个「装着若干 node 版本」的目录里有哪些版本，新的排前面。目录不存在（没装 nvm）就是空。 */
function versionsUnder(root: string): string[] {
  try {
    return fs
      .readdirSync(root)
      .filter((d) => /^v\d+\./.test(d))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

/** Windows 上 nvm 把每个版本的全局前缀放在 `%LOCALAPPDATA%\nvm\vX`；POSIX 见 posixCandidates。 */
function nvmCandidates(p: PiProbe): string[] {
  if (p.platform !== "win32") return [];
  const root = p.env.LOCALAPPDATA ? path.join(p.env.LOCALAPPDATA, "nvm") : "";
  if (!root) return [];
  return versionsUnder(root).map((d) => path.join(root, d, PKG));
}

/**
 * POSIX 的全局前缀是 `<node>/../`，包在 `<前缀>/lib/node_modules` 里 —— 不是 `bin/node_modules`。
 * nvm 会把每个版本的前缀放在 `$NVM_DIR/versions/node/vX` 下，所以除了当前 node 自己那一份，
 * 还要看别的版本：跑 bridge 的 node 未必是装 pi 的那个。
 */
function posixCandidates(p: PiProbe): string[] {
  if (p.platform === "win32") return [];
  const inPrefix = (prefix: string) => path.join(prefix, "lib", "node_modules", PKG_IN_NM);
  // execPath = <前缀>/bin/node
  const prefix = path.dirname(path.dirname(p.execPath));
  const out = [inPrefix(prefix)];
  // `NVM_DIR` 是 nvm 的根；没装 nvm 时 versionsUnder 给空数组，当前前缀那条已经够了。
  const nvmRoot = path.join(p.env.NVM_DIR || path.join(p.env.HOME ?? "", ".nvm"), "versions", "node");
  for (const v of versionsUnder(nvmRoot)) out.push(inPrefix(path.join(nvmRoot, v)));
  return out;
}

/**
 * 启动器：Windows 是写死真路径的 `pi.cmd`，POSIX 是指向 cli.js 的 symlink。
 * symlink 直接跟着走 —— 原来按 `statSync` 的大小跳过，可 statSync 会跟 symlink，于是 POSIX 上
 * 这条候选永远被跳过（`bin/pi` 一看就是 40 MB 的 bundle）。
 */
function launcherCandidates(p: PiProbe): string[] {
  const out: string[] = [];
  for (const dir of p.pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of ["pi.cmd", "pi.bat", "pi"]) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      try {
        const st = fs.lstatSync(file);
        if (st.isSymbolicLink()) {
          const real = fs.realpathSync(file);
          if (/cli\.js$/i.test(real) && fs.existsSync(real)) out.push(real);
          continue;
        }
        // 启动器脚本本身只有几行；真是一整块 bundle（> 1 MB）就别去读它。
        if (st.size > 1_000_000) continue;
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

function npmRootBySpawn(p: PiProbe): string | null {
  try {
    // Windows 上 npm 是 `npm.cmd`：Node ≥ 18.20 拒绝不带 shell 去跑 `.cmd`（EINVAL，会被下面的 catch
    // 静默吞掉，这一条候选就永远缺席）。参数是常量，走 shell 没有注入面。
    const win = p.platform === "win32";
    const root = execFileSync(win ? "npm.cmd" : "npm", ["root", "-g"], {
      shell: win,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return root || null;
  } catch {
    return null; /* npm not available */
  }
}

function npmRootCandidates(p: PiProbe): string[] {
  if (!p.npmRoot) return [];
  const root = p.npmRoot();
  return root ? [path.join(root, PKG_IN_NM)] : [];
}

export function piCandidates(over: Partial<PiProbe> = {}): string[] {
  const p: PiProbe = {
    platform: process.platform,
    execPath: process.execPath,
    pathEnv: process.env.PATH ?? "",
    env: process.env,
    npmRoot: () => npmRootBySpawn(p),
    ...over,
  };
  const list: string[] = [];
  if (p.env.PI_BIN) list.push(p.env.PI_BIN);
  list.push(...nvmCandidates(p));
  list.push(...posixCandidates(p));
  list.push(...launcherCandidates(p));
  // Windows 的便携版 node 会把全局包装在 node 自己的目录下（POSIX 上那是 `bin/node_modules`，从来的错位置）。
  if (p.platform === "win32") list.push(path.join(path.dirname(p.execPath), PKG));
  list.push(...npmRootCandidates(p));
  // 老位置留着：Windows 上 npm 的全局前缀就是 `%APPDATA%\npm`，有人直接拿它当 bin 目录。
  list.push(path.join(p.env.APPDATA ?? "", "npm", PKG));
  list.push(path.join(p.env.ProgramData ?? "C:/ProgramData", "npm", PKG));
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
