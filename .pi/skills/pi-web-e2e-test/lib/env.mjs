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
