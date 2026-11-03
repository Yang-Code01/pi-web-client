// pi-web-client 的多开测试环境：一条命令起一套（bridge + peer），端口自动找空闲、口令固定 test。
// 只依赖 Node 内建模块；Windows / MSYS 下都能跑，避免 PowerShell 的引号、BOM、`$_` 展开问题。
//
//   node env.mjs list
//   node env.mjs ports [--peers 1]
//   node env.mjs start --dir <仓库或 worktree 绝对路径> [--name t1] [--peers 1] [--build]
//   node env.mjs stop --id t1 | --all
//
// 端口布局（base = 第一个空闲的 17864+）：bridge=base、peer=base+1、announce(UDP)=base+2、
// 第 i 个额外 peer=base+3+2i / base+4+2i。7864 永远不会被分配。

import fs from "node:fs";
import net from "node:net";
import dgram from "node:dgram";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const HOME = path.join(os.homedir(), ".pi", "agent", "state", "pi-web-test-dev");
const REGISTRY = path.join(HOME, "instances.json");
const BASE_FIRST = 17864;
const BASE_LIMIT = 18600;
const PASSPHRASE = "test";
const RESERVED = new Set([7864, 7865, 7866]);

const say = (...a) => console.log(...a);

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  } catch {
    return { instances: [] };
  }
}

function writeRegistry(data) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(data, null, 2) + "\n");
}

/** 有人在这个端口上监听吗：先真连一次，再试独占绑定（Windows 上 SO_REUSEADDR 会「绑得上但其实是抢别人端口」）。 */
function occupied(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(400, () => done(false));
  });
}

async function portFree(port, host = "0.0.0.0") {
  if (await occupied(port)) return false;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ port, host, exclusive: true });
  });
}

async function udpFree(port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    sock.once("error", () => resolve(false));
    sock.once("listening", () => sock.close(() => resolve(true)));
    sock.bind(port, "0.0.0.0");
  });
}

/** 每个实例要的端口块：bridge / peer / announce / 额外 peer… */
function block(base, peers) {
  const ports = { bridge: base, peer: base + 1, announce: base + 2, extra: [] };
  for (let i = 0; i < peers; i++) ports.extra.push({ http: base + 3 + i * 2, announce: base + 4 + i * 2 });
  return ports;
}

async function findSlot(peers) {
  const reg = readRegistry();
  const taken = new Set(RESERVED);
  for (const inst of reg.instances) {
    if (!inst.ports) continue;
    taken.add(inst.ports.bridge);
    taken.add(inst.ports.peer);
    taken.add(inst.ports.announce);
    for (const e of inst.ports.extra ?? []) {
      taken.add(e.http);
      taken.add(e.announce);
    }
  }
  for (let base = BASE_FIRST; base < BASE_LIMIT; base += 2) {
    const ports = block(base, peers);
    const all = [ports.bridge, ports.peer, ports.announce, ...ports.extra.flatMap((e) => [e.http, e.announce])];
    if (all.some((p) => taken.has(p))) continue;
    let ok = true;
    for (const p of all) {
      if (!(await portFree(p, "0.0.0.0"))) {
        ok = false;
        break;
      }
    }
    if (ok && !(await udpFree(ports.announce))) ok = false;
    for (const e of ports.extra) if (ok && !(await udpFree(e.announce))) ok = false;
    if (ok) return { base, ports };
  }
  throw new Error(`从 ${BASE_FIRST} 到 ${BASE_LIMIT} 没找到足够端口：先把不用的实例 stop 掉`);
}

function git(dir, ...args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function hasPeer(dir) {
  return fs.existsSync(path.join(dir, "peer", "package.json"));
}

function needsBuild(dir) {
  const want = ["bridge/dist/index.js", "web/dist/index.html"];
  if (hasPeer(dir)) want.push("peer/dist/index.js", "web/dist/peer.html");
  return want.filter((rel) => !fs.existsSync(path.join(dir, rel)));
}

function ensureDeps(dir) {
  const pkgs = ["bridge", "web"].concat(hasPeer(dir) ? ["peer"] : []).filter((pkg) =>
    fs.existsSync(path.join(dir, pkg, "package.json")),
  );
  const missing = pkgs.filter((pkg) => !fs.existsSync(path.join(dir, pkg, "node_modules")));
  if (!missing.length) return;
  say(`装依赖：${missing.join(" / ")}（一次性，慢一点）`);
  for (const pkg of missing) {
    const r = spawnSync("npm", ["--prefix", path.join(dir, pkg), "install", "--no-audit", "--no-fund"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (r.status !== 0) throw new Error(`npm --prefix ${pkg} install 失败`);
  }
}

function build(dir) {
  say("构建 bridge / peer / web …");
  const r = spawnSync("npm", ["run", "build"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error("npm run build 失败（先看上面的报错）");
}

async function health(url, ms = 1000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUp(url, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await health(url)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function spawnHidden(file, args, env, cwd, outPath, errPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.openSync(outPath, "a");
  const err = fs.openSync(errPath, "a");
  const child = spawn(file, args, {
    cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, err],
  });
  child.unref();
  return child.pid;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* 已经没了 */
      }
    }
  }
}

async function cmdStart(opts) {
  const dir = path.resolve(opts.dir ?? process.cwd());
  if (!fs.existsSync(path.join(dir, "package.json"))) throw new Error(`${dir} 不像 pi-web-client 的仓库根（没有 package.json）`);
  const peers = Number(opts.peers ?? 1);
  const id = String(opts.name ?? `t${readRegistry().instances.length + 1}`);

  const reg = readRegistry();
  if (reg.instances.some((i) => i.id === id)) throw new Error(`实例名 ${id} 已经在用：换个 --name，或先 stop --id ${id}`);

  const branch = git(dir, "rev-parse", "--abbrev-ref", "HEAD") || "(未知)";
  const head = git(dir, "rev-parse", "--short", "HEAD");
  const dirty = git(dir, "status", "--porcelain").length > 0;

  if (needsBuild(dir).length || opts.build) {
    ensureDeps(dir);
    build(dir);
  } else {
    say(`复用已有构建（${head}）；想强制重建加 --build`);
  }

  const { base, ports } = await findSlot(peers);
  const state = path.join(HOME, id);
  fs.mkdirSync(path.join(state, "bridge"), { recursive: true });

  // 口令固定 test：bridge 带 --passphrase 跑一次就写进 state，随后正常启动。
  const preset = spawnSync(process.execPath, [path.join(dir, "bridge", "dist", "index.js"), "--passphrase", PASSPHRASE], {
    env: { ...process.env, PI_WEB_STATE: path.join(state, "bridge") },
    encoding: "utf8",
    timeout: 20000,
  });
  if (preset.status !== 0) throw new Error(`设置口令失败：${preset.stderr || preset.stdout}`);

  const bridgePid = spawnHidden(
    process.execPath,
    [path.join(dir, "bridge", "dist", "index.js")],
    {
      ...process.env,
      PI_WEB_PORT: String(ports.bridge),
      PI_WEB_STATE: path.join(state, "bridge"),
      PI_PEER_STATE: path.join(state, "peer-a"),
      PI_PEER_PORT: String(ports.peer),
      PI_PEER_ANNOUNCE_PORT: String(ports.announce),
      PI_PEER_NICKNAME: `测试机 ${id}`,
    },
    dir,
    path.join(state, "bridge.out.log"),
    path.join(state, "bridge.err.log"),
  );

  const url = `http://127.0.0.1:${ports.bridge}`;
  if (!(await waitUp(`${url}/healthz`))) {
    killTree(bridgePid);
    throw new Error(`bridge 30 秒没起来：看 ${path.join(state, "bridge.err.log")}`);
  }

  const extraPids = [];
  if (!hasPeer(dir)) {
    say("这份代码里没有 peer/（早于 #45 合入）：只能测主页面，跳过额外 peer");
    ports.extra = [];
  }
  for (const [i, e] of (ports.extra ?? []).entries()) {
    const peerState = path.join(state, `peer-${i + 2}`);
    extraPids.push(
      spawnHidden(
        process.execPath,
        [path.join(dir, "peer", "dist", "index.js")],
        {
          ...process.env,
          PI_PEER_STATE: peerState,
          PI_PEER_PORT: String(e.http),
          PI_PEER_ANNOUNCE_PORT: String(e.announce),
          PI_PEER_NICKNAME: `同事${i + 2} ${id}`,
        },
        dir,
        path.join(state, `peer-${i + 2}.out.log`),
        path.join(state, `peer-${i + 2}.err.log`),
      ),
    );
  }

  // 用口令真的登录一次：证明预置生效，而不是只看了 pid。
  let login = 0;
  try {
    const res = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
      signal: AbortSignal.timeout(3000),
    });
    login = res.status;
  } catch {
    login = 0;
  }

  const entry = { id, dir, branch, head, dirty, url, ports, state, pids: { bridge: bridgePid, extra: extraPids }, startedAt: new Date().toISOString() };
  reg.instances = reg.instances.filter((i) => i.id !== id).concat(entry);
  writeRegistry(reg);

  say("");
  say(`实例 ${id} 已启动`);
  say(`  页面    ${url}/          （登录口令 ${PASSPHRASE}）`);
  if (hasPeer(dir)) say(`  内网通  ${url}/peer`);
  say(`  分支    ${branch} @ ${head}${dirty ? "（工作区有未提交改动）" : ""}`);
  say(`  目录    ${dir}`);
  const portLine = hasPeer(dir)
    ? `bridge=${ports.bridge} peer=${ports.peer} announce=${ports.announce}${(ports.extra ?? []).map((e) => ` 额外 peer=${e.http}`).join("")}`
    : `bridge=${ports.bridge}`;
  say(`  端口    ${portLine}`);
  say(`  状态    ${path.join(state, "bridge.out.log")}`);
  say(`  登录自检 HTTP ${login}${login === 200 || login === 204 ? "（口令 test 生效）" : "（口令没生效，看日志）"}`);
  if (dirty) say("  注意：工作区有别的未提交改动，构建用的是当前文件内容。");
}

function cmdList() {
  const reg = readRegistry();
  if (!reg.instances.length) {
    say("没有在跑的测试实例。");
    return;
  }
  for (const inst of reg.instances) {
    say(`${inst.id}\t${inst.url}\t${inst.branch}@${inst.head}\tbridge=${inst.ports.bridge}\tpeer=${inst.ports.peer}\t${inst.startedAt}`);
  }
}

async function cmdStop(opts) {
  const reg = readRegistry();
  const targets = opts.all ? reg.instances : reg.instances.filter((i) => i.id === String(opts.id));
  if (!targets.length) {
    say(opts.all ? "没有实例要停。" : `没有 id=${opts.id} 的实例（用 list 看）`);
    return;
  }
  for (const inst of targets) {
    killTree(inst.pids?.bridge);
    for (const pid of inst.pids?.extra ?? []) killTree(pid);
    await new Promise((r) => setTimeout(r, 600));
    const gone = !(await health(`${inst.url}/healthz`, 800));
    say(`${inst.id}：${gone ? "已停" : "端口仍在响应（可能是别的进程占着）"}`);
    reg.instances = reg.instances.filter((i) => i.id !== inst.id);
  }
  writeRegistry(reg);
}

async function cmdPorts(opts) {
  const peers = Number(opts.peers ?? 1);
  const { base, ports } = await findSlot(peers);
  say(JSON.stringify({ base, ports }, null, 2));
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const opts = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--all") opts.all = true;
  else if (a === "--build") opts.build = true;
  else if (a.startsWith("--")) opts[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
}

try {
  if (cmd === "start") await cmdStart(opts);
  else if (cmd === "stop") await cmdStop(opts);
  else if (cmd === "list") cmdList();
  else if (cmd === "ports") await cmdPorts(opts);
  else {
    say("用法：node env.mjs list | ports [--peers N] | start --dir <path> [--name t1] [--peers 1] [--build] | stop --id t1|--all");
    process.exitCode = 2;
  }
} catch (err) {
  say(`失败：${err.message}`);
  process.exitCode = 1;
}
