#!/usr/bin/env node
/**
 * 并行跑 workspace / a11y 这组端到端探针。
 *
 * 串行跑一遍要 ~9 分钟：每个探针都自己起静态服务器 + 桩桥 + Chromium，单跑 40–60 秒。
 * 它们彼此独立（各自一个 PI_WEB_PORT、各自的桩桥），所以按 CPU 允许的并发跑即可。
 * 本机实测：4 路 74s，8 路 58s，10 路 55s（更吃内存）。共享一个 Chromium 反而更慢
 * （8 路 62–64s：单浏览器进程成了争用点），所以每个探针仍各起各的。
 *
 *   node probes/run-all.mjs                 # 默认 8 路
 *   node probes/run-all.mjs --jobs 6        # 机器吃紧时降并发
 *   node probes/run-all.mjs --only workspace-tabs,a11y-workspace
 *
 * 每个探针的完整输出写到 .scratch/probes/<name>.log；终端只留一行摘要 + 失败探针的尾巴。
 * 退出码：0 全过，1 有失败，2 用法/前置条件不对。前置：先 npm run build:web。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALL = [
  "workspace-tabs",
  "workspace-settings",
  "workspace-tree",
  "workspace-manage",
  "workspace-layout",
  "workspace-migrate",
  "workspace-shells",
  "workspace-drag",
  "a11y-workspace",
  "round16-pin",
  "chrome-topbar",
  "chrome-bottom",
  "chrome-sheet",
  "chrome-narrow",
  "composer-grow",
];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? fallback : fallback;
};
const jobs = Math.max(1, Number(flag("--jobs", 8)) || 8);
const timeoutMs = Math.max(10, Number(flag("--timeout", 300)) || 300) * 1000;
const only = String(flag("--only", "")).split(",").map((s) => s.trim()).filter(Boolean);
const names = only.length ? ALL.filter((n) => only.includes(n)) : ALL;

if (!names.length) {
  console.error(`没有匹配的探针；可选：${ALL.join(", ")}`);
  process.exit(2);
}
if (!fs.existsSync(path.join(REPO, "web/dist/index.html"))) {
  console.error("web/dist 不存在，先跑 npm run build:web");
  process.exit(2);
}

/** 让内核挑一个空闲端口（避开 Windows 的 excluded port range）。 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const runOne = (name, port) =>
  new Promise((resolve) => {
    const logPath = path.join(REPO, ".scratch", "probes", `${name}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "w");
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(REPO, "probes", `${name}.mjs`)], {
      cwd: REPO,
      env: { ...process.env, PI_WEB_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tail = [];
    const onData = (buf) => {
      fs.writeSync(fd, buf);
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line) continue;
        console.log(`[${name}] ${line}`);
        tail.push(line);
        if (tail.length > 8) tail.shift();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      tail.push(`(超时 ${timeoutMs / 1000}s，已终止)`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.closeSync(fd);
      resolve({ name, code, ms: Date.now() - started, logPath, tail });
    });
  });

const queue = [...names];
const results = [];
const worker = async () => {
  while (queue.length) {
    const name = queue.shift();
    const port = await freePort();
    const r = await runOne(name, port);
    results.push(r);
    console.log(`${r.code === 0 ? "ok  " : "FAIL"} ${name} (${(r.ms / 1000).toFixed(1)}s)`);
  }
};

const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, worker));
const bad = results.filter((r) => r.code !== 0).sort((a, b) => a.name.localeCompare(b.name));
console.log(`\n${results.length - bad.length}/${results.length} 通过，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const r of bad) {
  console.log(`\n—— FAIL ${r.name}（${path.relative(REPO, r.logPath)}）`);
  for (const line of r.tail) console.log(`   ${line}`);
}
process.exit(bad.length ? 1 : 0);
