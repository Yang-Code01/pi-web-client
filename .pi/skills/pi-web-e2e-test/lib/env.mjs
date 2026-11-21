import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PASSPHRASE = "test";

export function registryPath() {
  return path.join(os.homedir(), ".pi", "agent", "state", "pi-web-test-dev", "instances.json");
}

export function readRegistry(file = registryPath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(data)) return data;
    return Array.isArray(data.instances) ? data.instances : [];
  } catch {
    return [];
  }
}

export function findEnvCli(repoDir) {
  return path.join(repoDir, ".pi", "skills", "pi-web-client-test-dev", "bin", "env.mjs");
}

function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeout == null ? 300000 : options.timeout,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: options.env || process.env
  });
  return {
    status: result.status == null ? -1 : result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error || null
  };
}

/** Start an isolated bridge + peer through the project's test-dev CLI. */
export function startEnv(options) {
  const repoDir = path.resolve(options.repoDir);
  const name = options.name;
  const cli = findEnvCli(repoDir);
  if (!fs.existsSync(cli)) {
    throw new Error(`找不到测试环境 CLI：${cli}\n这个技能需要在 pi-web-client 仓库里使用。`);
  }
  const args = [cli, "start", "--dir", repoDir, "--name", name, "--no-open"];
  if (options.build) args.push("--build");
  const log = options.log || (() => {});
  log(`启动测试环境 ${name}：node ${args.join(" ")}`);
  const result = runNode(args, { cwd: repoDir, timeout: options.timeoutMs });
  const output = `${result.stdout}${result.stderr}`;
  if (result.error && result.error.code === "ETIMEDOUT") {
    throw new Error(`测试环境启动超时（${name}）\n${output.slice(-4000)}`);
  }
  if (result.status !== 0) {
    throw new Error(`测试环境启动失败（${name}，退出码 ${result.status}）\n${output.slice(-5000)}`);
  }
  const entry = readRegistry().find((item) => item.id === name);
  if (!entry || !entry.url) {
    throw new Error(`测试环境已启动，但注册表里没有 ${name}\n${output.slice(-4000)}`);
  }
  const login = output.match(/登录自检 HTTP (\d+)/);
  return {
    ...entry,
    loginStatus: login ? Number(login[1]) : null,
    output
  };
}

export function stopEnv(id, options = {}) {
  if (!id) return { skipped: true };
  const repoDir = path.resolve(options.repoDir || process.cwd());
  const cli = findEnvCli(repoDir);
  if (!fs.existsSync(cli)) return { skipped: true, reason: "no env cli" };
  const result = runNode([cli, "stop", "--id", id], {
    cwd: repoDir,
    timeout: options.timeoutMs == null ? 60000 : options.timeoutMs
  });
  return {
    id,
    status: result.status,
    output: `${result.stdout}${result.stderr}`.trim()
  };
}

export function listEnv(repoDir = process.cwd()) {
  const cli = findEnvCli(repoDir);
  if (!fs.existsSync(cli)) return { status: -1, output: "", instances: [] };
  const result = runNode([cli, "list"], { cwd: repoDir, timeout: 30000 });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`.trim(),
    instances: readRegistry()
  };
}

/** Parse the page URL from an already-running instance (for reuse in --env). */
export function normalizeBaseUrl(value) {
  if (!value) return "";
  let url = String(value).trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, "");
  return url;
}

/** 进程还活着吗（Windows 上 kill(pid, 0) 一样是「只探测不发信号」）。 */
export function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function gitLine(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

/** 仓库当前是哪个提交、有没有未提交改动 —— 用来对实例起时的登记做比较。 */
export function codeStamp(repoDir) {
  const dir = path.resolve(repoDir);
  return {
    head: gitLine(dir, "rev-parse", "--short", "HEAD"),
    dirty: gitLine(dir, "status", "--porcelain").length > 0
  };
}

function newestMtime(root) {
  let newest = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * 产物比源码旧（或缺失）就是过期 —— 与 test-dev 的 needsBuild() 同一套判据。
 * 有这条就够判断「跑着的实例是不是这份代码」：web/src 改过而 dist 没重建，不能复用。
 */
export function staleBuild(repoDir) {
  const dir = path.resolve(repoDir);
  const pairs = [
    ["bridge/src", "bridge/dist/index.js"],
    ["web/src", "web/dist/index.html"],
    ["peer/src", "peer/dist/index.js"]
  ];
  return pairs
    .filter(([src]) => fs.existsSync(path.join(dir, src)))
    .filter(([src, out]) => {
      const file = path.join(dir, out);
      if (!fs.existsSync(file)) return true;
      return newestMtime(path.join(dir, src)) > fs.statSync(file).mtimeMs;
    })
    .map(([, out]) => out);
}

/** Windows 上同一个目录可能写成 F:\\x\\y 或 f:/x/y/，比较前先归一。 */
export function sameDir(a, b) {
  const norm = (value) =>
    path
      .resolve(String(value || ""))
      .replace(/[\\/]+$/, "")
      .replace(/\\/g, "/")
      .toLowerCase();
  return norm(a) === norm(b);
}

/**
 * 从实例表里挑一个可以直接复用的测试环境：同一个目录、进程还活着、代码没变。
 * alive 由调用方注入（单测里不需要真进程），排序偏好 e2e 自己起的、最近启动的。
 */
export function chooseReusableEnv(instances, options = {}) {
  const { repoDir, head = "", stale = [], alive = () => true } = options;
  if (!repoDir || stale.length) return null;
  const usable = (instances || []).filter((item) => {
    if (!item || !item.id || !item.url) return false;
    if (!sameDir(item.dir, repoDir)) return false;
    if (item.head && head && item.head !== head) return false;
    return alive(item);
  });
  usable.sort((a, b) => {
    const own = (item) => (String(item.id).startsWith("e2e-") ? 0 : 1);
    if (own(a) !== own(b)) return own(a) - own(b);
    return String(b.startedAt || "").localeCompare(String(a.startedAt || ""));
  });
  return usable[0] || null;
}

export async function healthz(baseUrl, timeoutMs = 2500) {
  if (!baseUrl) return false;
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 没给 --env 时，先看看这个目录是不是已经有一份在跑的实例。
 * 复用省掉一次 build + 启动（几十秒），代价是用例会改那份实例的状态，而且跑完不停它。
 * healthz 可注入，测试里不必真起服务器。
 */
export async function findReusableEnv({
  repoDir,
  log = () => {},
  healthz: probe = healthz,
  instances,
  head,
  stale
} = {}) {
  const stamp = codeStamp(repoDir);
  const pick = chooseReusableEnv(instances ?? readRegistry(), {
    repoDir,
    head: head ?? stamp.head,
    stale: stale ?? staleBuild(repoDir),
    alive: (item) => pidAlive(item?.pids?.bridge)
  });
  if (!pick) return null;
  const url = normalizeBaseUrl(pick.url);
  if (!(await probe(url))) {
    log(`发现有同目录实例 ${pick.id}，但 ${url} 不响应健康检查，另起一份`);
    return null;
  }
  log(
    `复用已在跑的测试环境 ${pick.id}（${url}，同目录同代码）；跑完不会停它。要停：node .pi/skills/pi-web-client-test-dev/bin/env.mjs stop --id ${pick.id}`
  );
  return { ...pick, url, reused: true };
}
