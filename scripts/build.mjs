#!/usr/bin/env node
/**
 * D154：一次 `npm run build` 只发一个 build id。
 *
 * bridge 的 `/healthz` 与 WS `hello` 带上它，web 把自己那份内联进 JS；前端重连时一比，
 * 就知道页面里跑的是不是重启前的老 JS（不一致就提示刷新，不自动 reload）。
 *
 * 三个包分开构建时没人能保证它们拿到同一个 id，所以 id 在这里生成、通过 `PI_BUILD_ID`
 * 传给 web（vite define），并在 bridge 编译完写进 `bridge/dist/build-id.json`。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function npm(args, env) {
  const file = process.platform === "win32" ? "npm.cmd" : "npm";
  // Node 在 Windows 上不允许直接 spawn .cmd（EINVAL，CVE-2024-27980 之后），只能过 shell。
  const r = spawnSync(file, args, { cwd: root, stdio: "inherit", env, shell: process.platform === "win32" });
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

let code = npm(["--prefix", "bridge", "run", "build"], env);
if (code) process.exit(code);

// 写在 tsc 之后：tsc 不清理 dist，但 build-id 必须描述这次产物。
fs.writeFileSync(
  path.join(root, "bridge", "dist", "build-id.json"),
  JSON.stringify({ id, sha, at: new Date().toISOString() }, null, 2) + "\n",
);

code = npm(["--prefix", "peer", "run", "build"], env);
if (code) process.exit(code);

code = npm(["--prefix", "web", "run", "build"], env);
process.exit(code);
