#!/usr/bin/env node
/**
 * 并行跑 `bridge/tests/` 下的端到端测试。
 *
 * 为什么要有这个：135 个测试每个都自己起一份桥 + 一个 Chromium，串行跑一遍要一个多小时，
 * 而它们大多数彼此独立（各自的端口由 freePort() 向系统要，各自的状态目录在 `.scratch/<自己名字>`）。
 * 实测串行 vs 6 路并行的对比见 docs/DECISIONS.md D298。
 *
 *   node tools/run-tests.mjs                      # 默认并发 min(6, CPU-1)
 *   node tools/run-tests.mjs --jobs 4             # 机器吃紧时降并发
 *   node tools/run-tests.mjs --only ask-ui,share-bug
 *   node tools/run-tests.mjs --skip peer-ui,rename-check
 *   node tools/run-tests.mjs --list               # 只列不跑
 *   node tools/run-tests.mjs --json               # 顺手把每个用例的耗时写到 .scratch/tests/results.json
 *
 * 不并行的那些（碰真 ~/.pi/agent、系统服务、或要独占某样东西）在 SERIAL 里列着，理由写在那儿。
 * 每个测试的完整输出进 `.scratch/tests/<name>.log`；终端只留一行结果，失败时再打尾巴。
 * 退出码：0 全过，1 有失败，2 用法/前置条件不对。
 *
 * 前置：`npm run build`（bridge/dist + web/dist 都要）。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort } from "./free-port.mjs";
import { REPO } from "./paths.mjs";

const TESTS = path.join(REPO, "bridge", "tests");
const LOGS = path.join(REPO, ".scratch", "tests");

/**
 * 必须串行跑的：要么改真的用户目录，要么动系统状态，要么独占一个别人也在用的东西。
 * `--serial a,b` 可以临时加，`--parallel-everything` 可以无视（自己承担后果）。
 */
const SERIAL = new Map([
  ["rename-check", "直接读写真的 ~/.pi/agent 里的会话文件"],
  ["session-dirs", "同上：真的 ~/.pi/agent 下的项目目录"],
  ["ext-manager", "netsh / sc.exe 查本机服务，并发会互相看到对方的临时服务"],
  ["sysmanage-ui", "系统管理页读的是本机真实状态（磁盘、进程数），并发时数字会互相干扰"],
  ["peer-ui", "同时开多份内网通节点，同机节点会互相发现、抢好友关系"],
  ["peer-e2e", "同上"],
  ["peer-history", "同上"],
  ["peer-outbox", "同上"],
  ["peer-read-watermark", "同上"],
  ["peer-updates-e2e", "同上：还占用 7981 组播端口和 7881-7883 三个固定端口"],
]);

/** 默认不跑：这些不是「自起一份桥」的测试，并发跑它们没有意义/会打架。 */
const SKIP_BY_DEFAULT = new Map([
  ["e2e", "连的是手工起在 7867 的那份实例（PI_WEB_PORT=7867 … npm start），不是自己起桥"],
  ["browser", "同上：PI_WEB_BASE 默认 7867，还要 .scratch/test-state 里的口令文件"],
  ["model-check", "同上"],
  ["dbg", "手写调试用的一次性脚本"],
  ["dbg2", "手写调试用的一次性脚本"],
  ["dbg3", "手写调试用的一次性脚本"],
]);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? fallback : fallback;
};
const csv = (name) =>
  String(flag(name, ""))
    .split(",")
    .map((s) => s.trim().replace(/\.mjs$/, ""))
    .filter(Boolean);

/**
 * 杀掉子进程**整棵**。
 * 测试被杀时，它拉起的桥、真的 pi、Chromium 都是孙进程；只管直接子进程（`child.kill`）的话
 * 它们会留在这儿继续吃 CPU、占端口 —— 这些残留会把后面跑的用例成片挤成
 * `timeout waiting for bridge up`，看着像「并行让测试变慢」，其实是上一轮没清干净。
 * Windows 没有进程组，交给 `taskkill /T`；POSIX 用 spawn 时 detached 出来的进程组。
 */
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

const cpus = os.cpus().length;
const jobs = Math.max(1, Number(flag("--jobs", Math.min(6, Math.max(2, cpus - 1)))) || 6);
const timeoutMs = Math.max(10, Number(flag("--timeout", 300)) || 300) * 1000;
const only = csv("--only");
const skip = new Set(csv("--skip"));
const extraSerial = new Set(csv("--serial"));
const everything = argv.includes("--parallel-everything");

/** node 的 flag 从 package.json 的 scripts 里抄，别在这儿再维护一份。 */
function flagsByFile() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  } catch (err) {
    console.error(`读不了 ${path.join(REPO, "package.json")}：${err.message}`);
    process.exit(2);
  }
  const map = new Map();
  for (const cmd of Object.values(pkg.scripts ?? {})) {
    // 有些脚本是 `npm run build:bridge && node --experimental-strip-types bridge/tests/x.mjs`，所以别用 ^ 锚在开头
    const m = /(?:^|&&|;|\|)\s*node((?:\s+--\S+)*)\s+bridge\/tests\/([\w.-]+)\.mjs/.exec(String(cmd));
    if (!m) continue;
    const flags = m[1].trim() ? m[1].trim().split(/\s+/) : [];
    // 同一个文件被多个脚本引用时，取 flag 最少的那组（都能跑，少的就是默认）
    const prev = map.get(m[2]);
    if (!prev || flags.length < prev.length) map.set(m[2], flags);
  }
  return map;
}

const flags = flagsByFile();

/**
 * 现装的 node 认不认这个 flag —— 不认就直接丢掉。
 * 反例：`--experimental-transform-types` 在 node 26 已经移除（`bad option`），但 package.json 里的
 * `test:context` 还写着它；照抄就会让一个好测试 0.1 秒就死。这里让 node 自己回答，只问一次。
 */
const supported = new Map();
function flagsFor(name) {
  const raw = flags.get(name) ?? [];
  return raw.filter((f) => {
    if (!f.startsWith("--")) return true;
    if (!supported.has(f)) {
      const r = spawnSync(process.execPath, [f, "-e", ""], { stdio: "ignore", windowsHide: true });
      supported.set(f, r.status === 0);
      if (r.status !== 0) console.warn(`（现装的 node 不认 ${f}，跑 ${name} 时已略过；package.json 里那份该清掉了）`);
    }
    return supported.get(f);
  });
}
const all = fs
  .readdirSync(TESTS)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => f.replace(/\.mjs$/, ""))
  .map((name) => ({ name, serial: !everything && (SERIAL.has(name) || extraSerial.has(name)) }))
  .filter((t) => !SKIP_BY_DEFAULT.has(t.name) || only.includes(t.name))
  .filter((t) => !only.length || only.includes(t.name))
  .filter((t) => !skip.has(t.name));

if (!all.length) {
  console.error(only.length ? `没有匹配的测试：${only.join(", ")}` : "bridge/tests 下没有可跑的测试");
  process.exit(2);
}
if (argv.includes("--list")) {
  for (const t of all) console.log(`${t.serial ? "串行" : "并行"}  ${t.name}${flags.get(t.name)?.length ? `  (${flags.get(t.name).join(" ")})` : ""}`);
  console.log(`\n共 ${all.length} 个；并发 ${jobs}，其中串行 ${all.filter((t) => t.serial).length} 个`);
  process.exit(0);
}
for (const p of ["bridge/dist/index.js", "web/dist/index.html"]) {
  if (!fs.existsSync(path.join(REPO, p))) {
    console.error(`${p} 不存在，先跑 npm run build`);
    process.exit(2);
  }
}
fs.mkdirSync(LOGS, { recursive: true });

const runOne = async (t) => {
  // 每份桥都给一个自己的内网通端口：默认都抢 7865，并行时会互相 EADDRINUSE。
  // 测试自己设了 PI_PEER / PI_PEER_PORT 的照旧覆盖这里（peer-* 那几个）。
  const peerPort = String(await freePort());
  return new Promise((resolve) => {
    const logPath = path.join(LOGS, `${t.name}.log`);
    const fd = fs.openSync(logPath, "w");
    const started = Date.now();
    const child = spawn(process.execPath, [...flagsFor(t.name), path.join(TESTS, `${t.name}.mjs`)], {
      cwd: REPO,
      env: { ...process.env, PI_PEER_PORT: peerPort },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // POSIX 上单独一个进程组，超时好整组杀（见 killTree）
      detached: process.platform !== "win32",
    });
    const tail = [];
    const onData = (buf) => {
      fs.writeSync(fd, buf);
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > 12) tail.shift();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKill);
      try {
        fs.closeSync(fd);
      } catch {}
      resolve({ name: t.name, code, ms: Date.now() - started, logPath, tail });
    };
    let hardKill;
    const timer = setTimeout(() => {
      tail.push(`(超时 ${timeoutMs / 1000}s，已终止整棵进程树)`);
      killTree(child);
      // 子进程被杀了，但它拉起的那份桥可能还拿着 stdout 管道，“close” 永远不来。
      // 别让它把整个跑测试的进程拖住：5 秒后直接算失败结果。
      hardKill = setTimeout(() => {
        tail.push("(杀死后 5s 仍未退出，不再等它)");
        finish(-1);
      }, 5000);
    }, timeoutMs);
    child.on("close", (code) => finish(code));
  });
};

const parallel = all.filter((t) => !t.serial);
const serial = all.filter((t) => t.serial);
const results = [];
const queue = [...parallel];
let done = 0;

const report = (r) => {
  results.push(r);
  done += 1;
  const secs = (r.ms / 1000).toFixed(1);
  console.log(`${r.code === 0 ? "ok  " : "FAIL"} [${String(done).padStart(3)}/${all.length}] ${r.name} ${secs}s`);
};

const t0 = Date.now();
const worker = async () => {
  while (queue.length) {
    const t = queue.shift();
    if (!t) return;
    report(await runOne(t));
  }
};
await Promise.all(Array.from({ length: Math.min(jobs, parallel.length) }, worker));

for (const t of serial) {
  console.log(`—— 串行 ${t.name}：${SERIAL.get(t.name) ?? "按 --serial 指定"}`);
  report(await runOne(t));
}

const total = (Date.now() - t0) / 1000;
const bad = results.filter((r) => r.code !== 0);
if (argv.includes("--json")) {
  const out = path.join(LOGS, "results.json");
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        jobs,
        wallMs: Date.now() - t0,
        sumMs: results.reduce((s, r) => s + r.ms, 0),
        tests: results.map((r) => ({ name: r.name, code: r.code, ms: r.ms })).sort((a, b) => b.ms - a.ms),
      },
      null,
      2,
    ),
  );
  console.log(`逐条耗时：${path.relative(REPO, out)}`);
}
const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log(
  `\n${results.length - bad.length}/${results.length} 通过，用时 ${total.toFixed(1)}s（并发 ${jobs}，串行 ${serial.length} 个）`,
);
console.log(`最慢的五个：${slowest.map((r) => `${r.name} ${(r.ms / 1000).toFixed(1)}s`).join("、")}`);
console.log(`各测日志：${path.relative(REPO, LOGS)}/<name>.log`);
for (const r of bad) {
  console.log(`\n—— FAIL ${r.name}（${(r.ms / 1000).toFixed(1)}s，${path.relative(REPO, r.logPath)}）`);
  for (const line of r.tail) console.log(`   ${line}`);
}
process.exit(bad.length ? 1 : 0);
