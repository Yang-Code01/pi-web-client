#!/usr/bin/env node
/**
 * D154：一次 `npm run build` 只发一个 build id。
 *
 * bridge 的 `/healthz` 与 WS `hello` 带上它，web 把自己那份内联进 JS；前端重连时一比，
 * 就知道页面里跑的是不是重启前的老 JS（不一致就提示刷新，不自动 reload）。
 *
 * 三个包分开构建时没人能保证它们拿到同一个 id，所以 id 在这里生成、通过 `PI_BUILD_ID`
 * 传给 web（vite define），并在 bridge 编译完写进 `bridge/dist/build-id.json`。
 *
 *   node scripts/build.mjs                 # 三个包，共用一个 id
 *   node scripts/build.mjs --only bridge   # 只编一个（`npm run build:bridge` 走这里）
 *
 * 单编 bridge 也刷新 build-id.json：`bridge/tests/*` 和 probes 都只跑 `build:bridge`，
 * 否则 `/healthz` 会一直报上一份产物的 id。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const PACKAGES = ["bridge", "peer", "web"];

function argOf(name) {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

const only = argOf("--only");
if (only && !PACKAGES.includes(only)) {
  console.error(`--only 只认 ${PACKAGES.join(" / ")}，收到 ${only}`);
  process.exit(2);
}
const targets = only ? [only] : PACKAGES;

function npm(args, env) {
  // Node 在 Windows 上不允许直接 spawn .cmd（EINVAL，CVE-2024-27980 之后），只能过 shell；
  // 整条命令当一个字符串传，避免 DEP0190 的「args 不转义」。
  const win = process.platform === "win32";
  const r = win
    ? spawnSync(`npm ${args.join(" ")}`, { cwd: root, stdio: "inherit", env, shell: true })
    : spawnSync("npm", args, { cwd: root, stdio: "inherit", env });
  if (r.error) {
    console.error(r.error.message);
    return 1;
  }
  return r.status ?? 1;
}

function shortSha() {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "nogit";
  }
}

const sha = shortSha();
const id = `${sha}-${Date.now().toString(36)}`;
const env = { ...process.env, PI_BUILD_ID: id };

/**
 * pull 之后子包的依赖变了、但没跑 `npm install`：不挡的话 tsc / vite 只会报一句
 * `Cannot find module …`，看不出该做什么。这里拿仓库里的 `package-lock.json` 跟 npm 装完留下的
 * `node_modules/.package-lock.json` 比一遍：锁文件里的每个包都要以同一版本在场。
 * 可选依赖（`optional: true`，比如别的平台的 esbuild 二进制）本来就可能没装，不算。
 * 返回问题描述；没问题是 null。没有锁文件的包不查。
 */
function staleDeps(pkg) {
  const readLock = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")).packages ?? {};
    } catch {
      return null;
    }
  };
  const want = readLock(path.join(root, pkg, "package-lock.json"));
  if (!want) return null;
  const have = readLock(path.join(root, pkg, "node_modules", ".package-lock.json"));
  if (!have) return "还没装过依赖";
  const off = [];
  for (const [key, meta] of Object.entries(want)) {
    if (!key.startsWith("node_modules/") || meta.optional || meta.link) continue;
    const got = have[key]?.version;
    if (got !== meta.version) off.push(`${key.slice("node_modules/".length)} ${got ?? "没装"} → ${meta.version}`);
  }
  if (!off.length) return null;
  return `${off.length} 个依赖跟锁文件对不上：${off.slice(0, 3).join("；")}${off.length > 3 ? "；…" : ""}`;
}

const stale = targets.map((pkg) => [pkg, staleDeps(pkg)]).filter(([, why]) => why);
if (stale.length) {
  for (const [pkg, why] of stale) console.error(`✗ ${pkg}：${why}`);
  console.error("依赖有变化（多半是刚 pull 过），先在仓库根目录跑一次 npm install，再 npm start。");
  process.exit(1);
}

for (const pkg of targets) {
  const code = npm(["--prefix", pkg, "run", "build"], env);
  if (code) process.exit(code);
  // 写在 tsc 之后：tsc 不清理 dist，但 build-id 必须描述这次产物。
  if (pkg === "bridge") {
    try {
      fs.writeFileSync(
        path.join(root, "bridge", "dist", "build-id.json"),
        JSON.stringify({ id, sha, at: new Date().toISOString() }, null, 2) + "\n",
      );
    } catch (e) {
      console.error(`写 bridge/dist/build-id.json 失败：${e.message}`);
      process.exit(1);
    }
  }
}
