#!/usr/bin/env node
/**
 * 一条命令备齐这个项目要的东西（D220）：pi 本体 → 四个 pi 扩展 → bridge / peer / web 的依赖。
 *
 * 为什么不是桥启动时自己装：装东西要写用户的全局目录（`~/.pi/agent`），那是用户的地盘，桥每天
 * 开开关关不该在后台偷偷改它；`npm install` 是用户自己按下的一次性动作，放在这里最诚实。
 *
 * 三件事按顺序做，每件都先查再动：
 *   1. pi 本体：找不到、或低于清单里的最低版本，才 `npm i -g @earendil-works/pi-coding-agent@latest`。
 *      机器上已经有更新的版本就一动不动 —— 不降级、不替用户决定。
 *   2. 四个扩展：问 `pi list` 用户级装了哪些包，按包名对（npm / git / 本地路径装的都算），
 *      有就不动（哪怕版本旧），缺的才 `pi install`。和页面上「本项目需要」用的是同一个判据。
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
 *   node scripts/bootstrap.mjs --start    `npm start` 前的关卡（D224）：pi 与扩展齐了才放行，缺了就说
 *                                          缺哪个、先跑 npm install；什么都不装
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
      ...(await import("../bridge/src/picli.ts")),
      ...(await import("../bridge/src/depsstatus.ts")),
    };
  } catch (err) {
    if (!process.allowedNodeEnvironmentFlags.has(FLAG)) throw err;
    const r = spawnSync(process.execPath, [FLAG, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
}

const { MIN_PI_VERSION, REQUIRED_PACKAGES, agentDir, bootstrapCommand, foundPackages, installSource, parsePackages, piTooOld, piCandidates, readPackageJson, statePath } =
  await loadModules();

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
// CI 里只装子包依赖：往构建机的全局目录里写 pi 与扩展，既没意义又会互相踩。
const CI = !!process.env.CI && !args.has("--force");
const NO_AUTO = !!process.env.PI_WEB_NO_AUTOINSTALL && !args.has("--force");
const DEPS_ONLY = args.has("--deps-only") || CI || NO_AUTO;
const QUIET = args.has("--quiet");
const START = args.has("--start");
// npm 在 Windows 上是 `npm.cmd`。Node 从 18.20 起拒绝 spawn 一个不带 shell 的 `.cmd`（EINVAL），
// 所以这里不叫 npm 这个名字：让 node 直接跑 `npm-cli.js`。postinstall 里有 npm_execpath，
// 手动 `node scripts/bootstrap.mjs` 时按 node 自己的安装位置猜一次。
const NPM_CLI = (() => {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && /npm-cli\.js$/i.test(fromEnv) && fs.existsSync(fromEnv)) return fromEnv;
  const guess = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return fs.existsSync(guess) ? guess : null;
})();

/** 命令行里说「缺了少哪块」的口径。界面上另有一套（web/src/app.ts 的 depsFeature），
 *  两边都按 id 取，不共用中文 —— 一个给终端，一个给 tr()。 */
const FEATURE = {
  subagents: "设置→子代理、后台卡、subagent 工具",
  todo: "执行面板计划区（@juicesharp/rpiv-todo）",
  questionnaire: "网页问卷（ask_user_question）",
  "web-access": "web_search / fetch_content / source_check 等联网工具",
};

const out = (line = "") => console.log(line);
const step = (line) => {
  if (!QUIET) out(line);
};

function runNpm(npmArgs, opts = {}) {
  if (NPM_CLI) return run(process.execPath, [NPM_CLI, ...npmArgs], opts);
  // 非 Windows 上 npm 是普通的 node 脚本，能直接 spawn；Windows 退到 shell（参数都是常量）。
  return run("npm", npmArgs, { ...opts, shell: process.platform === "win32" });
}

/** 失败时给人看的那几行：stderr 优先，取最后 n 行。 */
function tail(r, n, sep = " / ") {
  return (r.stderr || r.stdout || r.error || "").trim().split(/\r?\n/).slice(-n).join(sep);
}

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
  const npmArgs = ["install", "-g", "@earendil-works/pi-coding-agent@latest"];
  let r = runNpm(npmArgs, { timeout: 30 * 60_000 });
  if (r.code !== 0 && /EALLOWREMOTE/.test(`${r.stderr}${r.stdout}`)) {
    // npm ≥ 12 默认 allow-remote=none：registry 与 tarball 不同源（典型是 registry 被指到
    // `http://` 镜像，包地址却是 `https://`）时，npm 把包当成「remote」拒掉。
    // 只放行这一次调用，不去改用户的 npmrc。
    step("  npm 拒了 remote 取包（npm ≥ 12 的 allow-remote=none），加 --allow-remote=all 再试一次…");
    r = runNpm([...npmArgs, "--allow-remote=all"], { timeout: 30 * 60_000 });
  }
  if (r.code === 0) return null;
  let why = tail(r, 4, "\n");
  if (/EALLOWREMOTE/.test(why)) {
    why +=
      "\n（npm ≥ 12 的 allow-remote=none 挡住了 tarball 下载：把 registry 换成同名 https 地址，" +
      "例如 `npm config set registry https://registry.npmmirror.com/`）";
  }
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

// ---------------------------------------------------------------- 2. 四个扩展

/**
 * 用户级已装的包。和页面同一个判据（`foundPackages`，D220）：问 `pi list`，包名读各包自己的
 * package.json，读不到才按来源猜 —— 所以 git / 本地路径装的同名包也认得出来，不会再装一份。
 * `pi list` 跑不起来就不装任何扩展：宁可少装，也不装出两份同名扩展。
 */
function installedPackages(pi) {
  const r = run(process.execPath, [pi.cli, "list"], { timeout: 60_000 });
  if (r.code !== 0) return { error: `pi list 跑不起来：${tail(r, 3)}`, found: [] };
  return { error: null, found: foundPackages(parsePackages(r.stdout), readPackageJson) };
}

function installPackages(pi, record) {
  const listed = installedPackages(pi);
  if (listed.error) {
    record.ok = false;
    record.error ??= listed.error;
    step(`  ✗ ${listed.error}（扩展这一轮不装，免得装出重复的）`);
    return;
  }
  for (const pkg of REQUIRED_PACKAGES) {
    const hit = findInstalled(listed.found, pkg);
    if (hit) {
      record.skipped.push(`${pkg.source}${pkg.version ? `（要 ${pkg.version}）` : ""} 已装${hit.version ? ` ${hit.version}` : ""}（${hit.source}），不动`);
      step(`  ✓ ${pkg.source} 已装，跳过（${FEATURE[pkg.id] ?? pkg.id}）`);
      continue;
    }
    const want = installSource(pkg);
    step(`  → 装 ${want} …`);
    if (CHECK) {
      // --check 不装东西，但缺了要说清楚：退出码靠它。
      record.installed.push(`${want}（缺）`);
      record.ok = false;
      record.error ??= `缺 ${want}`;
      step(`  ✗ 缺 ${want}（${FEATURE[pkg.id] ?? pkg.id}）`);
      continue;
    }
    const r = run(process.execPath, [pi.cli, "install", want], { timeout: 20 * 60_000 });
    if (r.code === 0) {
      record.installed.push(want);
      step(`  ✓ ${want}`);
    } else {
      const why = tail(r, 3);
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
    const r = runNpm(["install", "--prefix", dir, "--no-audit", "--no-fund"], { timeout: 30 * 60_000 });
    if (r.code !== 0) {
      const why = tail(r, 3);
      record.error ??= `${name} 的依赖装不上：${why}`;
      step(`  ✗ ${name}：${why}`);
    }
  }
}

// ---------------------------------------------------------------- npm start 前的关卡（D224）

/** 按包名对（npm 包名不分大小写）；装和查共用这一个判据。 */
function findInstalled(found, pkg) {
  return found.find((h) => h.name.toLowerCase() === pkg.name.toLowerCase());
}

/**
 * 「齐了」的结论记在状态目录里，键是 pi 的位置与版本、清单、pi 的 settings.json（装 / 卸扩展都会
 * 改它）。键不变就不再问 `pi list` —— 它要把 pi 整个加载一遍，一次十几秒，每次 npm start 都跑
 * 太贵。只记「齐了」：缺东西时每次都重新问，补上就放行。
 */
function startKey(pi) {
  const dir = path.resolve(agentDir());
  let settings = "none";
  try {
    const st = fs.statSync(path.join(dir, "settings.json"));
    settings = `${st.size}:${st.mtimeMs}`;
  } catch {
    // 没有 settings.json：pi 还没装过任何包。
  }
  return JSON.stringify({ pi: pi.cli, version: pi.version, need: REQUIRED_PACKAGES.map(installSource), agent: dir, settings });
}

function startCheck() {
  if (CI) return 0;
  const pi = findPi();
  // lines 说缺什么；manual 是关了自动安装时要人手动跑的命令（只列缺的）。
  const blocked = (lines, manual) => {
    out("✗ pi 的依赖没备齐，这次不启动：");
    for (const line of lines) out(`  - ${line}`);
    if (NO_AUTO) {
      out("PI_WEB_NO_AUTOINSTALL 开着，npm install 不会替你装；手动装：");
      for (const cmd of manual) out(`  ${cmd}`);
    } else {
      out("先在仓库根目录跑一次 npm install（会自动装上），再 npm start。");
    }
    return 1;
  };
  const piInstall = ["npm install -g @earendil-works/pi-coding-agent@latest"];
  if (!pi) return blocked(["找不到 pi"], piInstall);
  if (piTooOld(pi.version)) return blocked([`pi ${pi.version} 低于 ${MIN_PI_VERSION}`], piInstall);

  const cache = statePath("start-check.json");
  const key = startKey(pi);
  try {
    if (JSON.parse(fs.readFileSync(cache, "utf8")).key === key) return 0;
  } catch {
    // 没记过或坏了：重新问。
  }
  const listed = installedPackages(pi);
  if (listed.error) {
    out(`⚠ 没法确认 pi 扩展齐不齐（${listed.error}），照常启动。`);
    return 0;
  }
  const missing = REQUIRED_PACKAGES.filter((pkg) => !findInstalled(listed.found, pkg));
  if (missing.length)
    return blocked(
      missing.map((pkg) => `缺 ${installSource(pkg)}（${FEATURE[pkg.id] ?? pkg.id}）`),
      missing.map((pkg) => `pi install ${installSource(pkg)}`),
    );
  try {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, `${JSON.stringify({ key, at: Date.now() })}\n`);
  } catch {
    // 记不下来只是下次再问一遍。
  }
  out(`✓ pi 扩展齐了（${REQUIRED_PACKAGES.length} 个）`);
  return 0;
}

if (START) process.exit(startCheck());

// ---------------------------------------------------------------- 主流程

const record = { at: Date.now(), ok: true, error: null, installed: [], skipped: [], pi: null };
const started = Date.now();
step(`pi-web-client 依赖整备${CHECK ? "（--check：只看不动）" : ""}`);
if (CI || NO_AUTO) step(CI ? "  （CI：只装子包依赖，不碰全局 pi 目录）" : "  （PI_WEB_NO_AUTOINSTALL=1：不碰全局 pi 目录，要装就 unset 后重跑）");

let pi = findPi();
record.pi = pi?.version ?? null;
if (DEPS_ONLY && !CHECK) {
  // --deps-only / CI / PI_WEB_NO_AUTOINSTALL：一行都不往用户全局目录写。
  step(`  - pi ${pi?.version ?? "（没找到）"}（这一轮不碰全局 pi 目录）`);
} else if (!pi || piTooOld(pi.version)) {
  if (CHECK) {
    record.ok = false;
    record.error ??= pi ? `pi ${pi.version} 低于 ${MIN_PI_VERSION}` : "找不到 pi";
    step(`  ✗ ${record.error}`);
  } else {
    const was = pi?.cli ?? null;
    const err = installPi();
    if (err) {
      record.ok = false;
      record.error = err;
    }
    pi = findPi();
    record.pi = pi?.version ?? null;
    // 装完还旧 = 装到了别的前缀，而候选表前面还有一个旧的。桥也按同一张表找，所以照实说。
    if (pi && piTooOld(pi.version)) {
      record.ok = false;
      record.error ??= `装完还是 ${pi.version}（${pi.cli}）${was && was !== pi.cli ? `，原来那个在 ${was}` : ""}：先处理更前面那个 pi，或把 PATH 指到新装的那份`;
      step(`  ✗ ${record.error}`);
    }
  }
} else {
  step(`  ✓ pi ${pi.version}（≥ ${MIN_PI_VERSION}）`);
}

// --check 装不了东西，所以 DEPS_ONLY 也照查（不然「三个包全缺」会报 0）。
if (!DEPS_ONLY || CHECK) {
  if (pi) installPackages(pi, record);
  else if (!record.error) {
    record.ok = false;
    record.error = "找不到 pi，扩展一个都没装";
  }
}
installProjectDeps(record);
record.ok = record.ok && !record.error;

// 状态文件给桥读（`/api/deps` 的 bootstrap 字段）：页面据此说“上次 npm install 没成功”。
// `--check` 说好了只看不动，就不写它。
if (!CHECK) {
  try {
    fs.mkdirSync(path.dirname(statePath("bootstrap.json")), { recursive: true });
    fs.writeFileSync(statePath("bootstrap.json"), `${JSON.stringify(record, null, 2)}\n`);
  } catch (err) {
    step(`  （状态没写下来：${err?.message ?? err}）`);
  }
}

const took = ((Date.now() - started) / 1000).toFixed(1);
if (record.ok) {
  const did = record.installed.length ? `新装 ${record.installed.length} 项` : "没有要装的";
  step(`完成（${did}，${took}s）`);
} else {
  out("");
  out("⚠ 依赖没整备齐：" + record.error);
  out("  可以再跑一次： " + bootstrapCommand());
  out("  或者手动装：");
  for (const pkg of REQUIRED_PACKAGES) out(`    pi install ${installSource(pkg)}`);
}
if (CHECK) process.exit(record.ok ? 0 : 1);
