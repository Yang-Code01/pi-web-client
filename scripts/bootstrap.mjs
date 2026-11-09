#!/usr/bin/env node
/**
 * 一条命令备齐这个项目要的东西（#D-待定）：pi 本体 → 三个 pi 扩展 → bridge / peer / web 的依赖。
 *
 * 为什么不是桥启动时自己装：装东西要写用户的全局目录（`~/.pi/agent`），那是用户的地盘，桥每天
 * 开开关关不该在后台偷偷改它；`npm install` 是用户自己按下的一次性动作，放在这里最诚实。
 *
 * 三件事按顺序做，每件都先查再动：
 *   1. pi 本体：找不到、或低于清单里的最低版本，才 `npm i -g @earendil-works/pi-coding-agent@latest`。
 *      机器上已经有更新的版本就一动不动 —— 不降级、不替用户决定。
 *   2. 三个扩展：只看 pi 的 settings 里有没有这个包（有就不动，哪怕版本旧），缺的才 `pi install`。
 *   3. 子包依赖：bridge / peer / web 各跑一次 `npm --prefix … install`（node_modules 已在时也跑，
 *      它自己会判断要不要动）。
 *
 * 失败不炸掉 `npm install`：写一份状态到 `<状态目录>/bootstrap.json`，桥在页面上把它说出来
 * （`/api/deps`）。真正缺了 pi 的话 `npm start` 会自己报错，比这里卡住更有用。
 *
 * 用法：
 *   node scripts/bootstrap.mjs            装
 *   node scripts/bootstrap.mjs --check    只报告（不装任何东西），不齐时退出码 1
 *   node scripts/bootstrap.mjs --deps-only  只装子包依赖（CI 用：不碰全局 pi 目录）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FLAG = "--experimental-transform-types";

// 这个脚本要用 bridge/src 里的清单和 pi 定位逻辑（TS）。Node ≥ 22.18 默认就能直接 import .ts；
// 老一点的运行时（或文件里出现需要转换的语法时）退回到 `--experimental-transform-types` 再跑一遍。
// 不是故意耍花招：`node scripts/bootstrap.mjs` 得能在没编译过的仓库里直接用。
async function loadModules() {
  try {
    return {
      ...(await import("../bridge/src/deps.ts")),
      ...(await import("../bridge/src/paths.ts")),
      ...(await import("../bridge/src/pi.ts")),
    };
  } catch (err) {
    if (!process.allowedNodeEnvironmentFlags.has(FLAG)) throw err;
    const r = spawnSync(process.execPath, [FLAG, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
}

const { MIN_PI_VERSION, REQUIRED_PACKAGES, bareSource, installSource, piTooOld, agentDir, piCandidates } = await loadModules();

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
// CI 里只装子包依赖：往构建机的全局目录里写 pi 与扩展，既没意义又会互相踩。
const CI = !!process.env.CI && !args.has("--force");
const NO_AUTO = !!process.env.PI_WEB_NO_AUTOINSTALL && !args.has("--force");
const DEPS_ONLY = args.has("--deps-only") || CI || NO_AUTO;
const QUIET = args.has("--quiet");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

const out = (line = "") => console.log(line);
const step = (line) => {
  if (!QUIET) out(line);
};

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", timeout: opts.timeout ?? 15 * 60_000, windowsHide: true, ...opts });
  return { code: r.status ?? (r.error ? -1 : 0), stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.message ?? null };
}

// ---------------------------------------------------------------- 1. pi 本体

function readVersionAt(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function findPi() {
  // bridge/src/pi.ts 的候选表就是唯一真相：nvm、PATH 上的启动器、npm root -g、APPDATA。
  for (const cli of piCandidates()) {
    if (!fs.existsSync(cli)) continue;
    const version = readVersionAt(path.resolve(path.dirname(cli), "..", ".."));
    return { cli, version };
  }
  return null;
}

function installPi() {
  step(`  pi 不在或低于 ${MIN_PI_VERSION}，装最新版…`);
  const r = run(NPM, ["install", "-g", "@earendil-works/pi-coding-agent@latest"], { timeout: 30 * 60_000 });
  if (r.code === 0) return null;
  const why = (r.stderr || r.stdout || r.error || "").trim().split(/\r?\n/).slice(-4).join("\n");
  if (process.platform === "win32") {
    // 没有 npm 的时候还有一条路：winget 装个 Node，再走一遍。装完的 Node 要重新开外壳才进 PATH，
    // 所以我们只把命令打出来 —— 在这个进程里换 PATH 是哄自己。
    const has = run("where", ["npm.cmd"]).code === 0;
    if (!has) {
      step("  没有 npm。可以先跑： winget install OpenJS.NodeJS.LTS  然后重开一个终端，再跑 npm install");
      return "没有 npm（winget 装了 Node 之后要重开终端）";
    }
  }
  return `pi 装不上：${why}`;
}

// ---------------------------------------------------------------- 2. 三个扩展

function installedSources() {
  const file = path.join(agentDir(), "settings.json");
  let json = {};
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* 没有 settings.json：等于什么都没装 */
  }
  const rows = Array.isArray(json.packages) ? json.packages : [];
  return rows
    .map((row) => (typeof row === "string" ? row : typeof row?.source === "string" ? row.source : ""))
    .filter(Boolean)
    .map((source) => ({ source: bareSource(source), full: source, name: bareSource(source).replace(/^npm:/, "") }));
}

function packageVersion(name) {
  // npm 装的包落在 <agentDir>/npm/node_modules；git / 本地来源读不到就算 null（只用于显示）。
  return readVersionAt(path.join(agentDir(), "npm", "node_modules", ...name.split("/")));
}

function installPackages(pi, record) {
  const have = installedSources();
  for (const pkg of REQUIRED_PACKAGES) {
    const hit = have.find((h) => h.name.toLowerCase() === pkg.name.toLowerCase());
    if (hit) {
      record.skipped.push(`${pkg.source}${pkg.version ? `（要 ${pkg.version}）` : ""} 已装${packageVersion(pkg.name) ? ` ${packageVersion(pkg.name)}` : ""}，不动`);
      step(`  ✓ ${pkg.source} 已装，跳过（${pkg.feature}）`);
      continue;
    }
    const want = installSource(pkg);
    step(`  → 装 ${want} …`);
    if (CHECK) {
      // --check 不装东西，但缺了要说清楚：退出码靠它。
      record.installed.push(`${want}（缺）`);
      record.ok = false;
      record.error ??= `缺 ${want}`;
      step(`  ✗ 缺 ${want}（${pkg.feature}）`);
      continue;
    }
    const r = run(process.execPath, [pi.cli, "install", want], { timeout: 20 * 60_000 });
    if (r.code === 0) {
      record.installed.push(want);
      step(`  ✓ ${want}`);
    } else {
      const why = (r.stderr || r.stdout || r.error || "").trim().split(/\r?\n/).slice(-3).join(" / ");
      record.error ??= `${want} 装不上：${why}`;
      step(`  ✗ ${want}：${why}`);
    }
  }
}

// ---------------------------------------------------------------- 3. 子包依赖

function installProjectDeps(record) {
  for (const name of ["bridge", "peer", "web"]) {
    const dir = path.join(ROOT, name);
    if (!fs.existsSync(path.join(dir, "package.json"))) continue;
    if (CHECK) continue;
    step(`  → ${name} 的依赖…`);
    const r = run(NPM, ["install", "--prefix", dir, "--no-audit", "--no-fund"], { timeout: 30 * 60_000 });
    if (r.code !== 0) {
      const why = (r.stderr || r.stdout || r.error || "").trim().split(/\r?\n/).slice(-3).join(" / ");
      record.error ??= `${name} 的依赖装不上：${why}`;
      step(`  ✗ ${name}：${why}`);
    }
  }
}

// ---------------------------------------------------------------- 主流程

const record = { at: Date.now(), ok: true, error: null, installed: [], skipped: [], pi: null };
const started = Date.now();
step(`pi-web-client 依赖整备${CHECK ? "（--check：只看不动）" : ""}`);
if (CI || NO_AUTO) step(CI ? "  （CI：只装子包依赖，不碰全局 pi 目录）" : "  （PI_WEB_NO_AUTOINSTALL=1：不碰全局 pi 目录，要装就 unset 后重跑）");

let pi = findPi();
record.pi = pi?.version ?? null;
if (!pi || piTooOld(pi.version)) {
  if (CHECK) {
    record.ok = false;
    record.error ??= pi ? `pi ${pi.version} 低于 ${MIN_PI_VERSION}` : "找不到 pi";
    step(`  ✗ ${record.error}`);
  } else {
    const err = installPi();
    if (err) {
      record.ok = false;
      record.error = err;
    }
    pi = findPi();
    record.pi = pi?.version ?? null;
  }
} else {
  step(`  ✓ pi ${pi.version}（≥ ${MIN_PI_VERSION}）`);
}

if (!DEPS_ONLY) {
  if (pi) installPackages(pi, record);
  else if (!record.error) {
    record.ok = false;
    record.error = "找不到 pi，扩展一个都没装";
  }
}
installProjectDeps(record);
record.ok = record.ok && !record.error;

// 状态文件给桥读（`/api/deps` 的 bootstrap 字段）：页面据此说“上次 npm install 没成功”。
try {
  const stateDir = process.env.PI_WEB_STATE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "pi-web-client");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "bootstrap.json"), `${JSON.stringify(record, null, 2)}\n`);
} catch (err) {
  step(`  （状态没写下来：${err?.message ?? err}）`);
}

const took = ((Date.now() - started) / 1000).toFixed(1);
if (record.ok) {
  const did = record.installed.length ? `新装 ${record.installed.length} 项` : "没有要装的";
  step(`完成（${did}，${took}s）`);
} else {
  out("");
  out("⚠ 依赖没整备齐：" + record.error);
  out("  可以再跑一次： " + "node scripts/bootstrap.mjs");
  out("  或者手动装：");
  for (const pkg of REQUIRED_PACKAGES) out(`    pi install ${installSource(pkg)}`);
}
if (CHECK) process.exit(record.ok ? 0 : 1);
