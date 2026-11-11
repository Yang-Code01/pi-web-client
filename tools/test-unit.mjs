#!/usr/bin/env node
/**
 * 所有「不需要模型、不需要浏览器」的单测跑一遍（CI 与本地同一个入口）。
 *
 * 为什么要有这个文件，而不是在 package.json 里写 50 条 `&&`：
 *   - 新加一个 `*-unit.mjs` 不用再改两处（脚本 + workflow），扫目录就够了；
 *   - 一条挂了不影响其余跑完，最后汇总（`&&` 链会在第一个红处停下，CI 只看到一个问题）；
 *   - 每条单独进程、单独超时：某个测试把定时器忘在那儿也不会拖死整轮。
 *
 * 收谁：`bridge/tests/` 与 `web/tests/` 下文件名以 `unit.mjs` 结尾的（`ask-unit.mjs`、`exec-view-unit.mjs`…）。
 * **不收** `*-ui.mjs` 与 `*-e2e.mjs`：那些要真 pi、真模型轮次或 Chromium，是另一条线（`npm run test:*:ui`）。
 *
 *   node tools/test-unit.mjs               全跑
 *   node tools/test-unit.mjs --only chat   只跑文件名含 chat 的
 *   node tools/test-unit.mjs --bail        第一条红就停
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./paths.mjs";

const TIMEOUT_MS = Number(process.env.UNIT_TIMEOUT_MS ?? 120_000);
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const bail = process.argv.includes("--bail");

const DIRS = ["bridge/tests", "web/tests"];
const files = [];
for (const dir of DIRS) {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs)) {
    if (!name.endsWith("unit.mjs")) continue;
    const rel = path.join(dir, name);
    if (only && !rel.includes(only)) continue;
    files.push(rel);
  }
}
files.sort();

if (!files.length) {
  console.error(`没找到单测${only ? `（--only ${only}）` : ""}：${DIRS.join(" / ")} 下的 *unit.mjs`);
  process.exit(2);
}

const run = (rel) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--experimental-transform-types", rel], {
      cwd: REPO,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ rel, code, signal, ms: Date.now() - started, out });
    });
  });

const failed = [];
const t0 = Date.now();
for (const rel of files) {
  const r = await run(rel);
  const secs = (r.ms / 1000).toFixed(1).padStart(5);
  if (r.code === 0) {
    console.log(`  ok    ${rel} (${secs}s)`);
    continue;
  }
  const why = r.signal ? `被 ${r.signal} 杀掉（超过 ${TIMEOUT_MS / 1000}s）` : `退出码 ${r.code}`;
  console.log(`  FAIL  ${rel} (${secs}s) ${why}`);
  // 只留尾巴：单测的失败信息都在最后几行，前面是无关的日志。
  console.log(r.out.trimEnd().split("\n").slice(-15).map((l) => `        ${l}`).join("\n"));
  failed.push(rel);
  if (bail) break;
}

const total = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
if (failed.length) {
  console.log(`\n${files.length} 个单测，${failed.length} 个失败（${total}）：`);
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\n${files.length} 个单测全部通过（${total}）`);
