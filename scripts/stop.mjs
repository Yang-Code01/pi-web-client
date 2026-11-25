#!/usr/bin/env node
/**
 * `npm run bridge:stop` —— 关机口。
 *
 * 用户选了「关窗保留」之后，壳、脑、会话都在后台跑，没有任何一个能找到的窗口可以关。这条命令
 * 向壳要一次整组停机：壳先让脑收会话，再带着那批 pi 一起退出。
 *
 * 只走 HTTP，不直接杀 pid：壳的停机要按顺序来（先告诉脑、再收子进程、最后关端口），
 * 拿 `kill -9` 去砍只会留下没人收的 pi。壳自己给这个接口加了同源校验，浏览器里别的页面
 * 用 `<img>` 打不进来；命令行这边把 `Origin` 写成它自己的地址就是「同源」。
 *
 * 没有壳（`PI_HOST_DISABLE=1` 起的旧桥）就没有 `/api/host/stop`：这时把话说明白，
 * 让人回终端 Ctrl-C，而不是假装停掉了。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = "pi-web-client";

function stateDir() {
  return path.resolve(
    process.env.PI_WEB_STATE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), APP),
  );
}

function port() {
  if (process.env.PI_WEB_PORT) return Number(process.env.PI_WEB_PORT);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(stateDir(), "config.json"), "utf8"));
    if (Number(cfg.port)) return Number(cfg.port);
  } catch {
    /* 没配置就用默认口 */
  }
  return 7864;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(base, ms = 700) {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(ms) });
    return res.ok ? await res.json().catch(() => ({})) : null;
  } catch {
    return null;
  }
}

const base = `http://127.0.0.1:${port()}`;
const health = await up(base, 1500);
if (!health) {
  console.log(`${base} 上没有在跑的壳 / 桥：没什么可停的。`);
  process.exit(0);
}
if (!health.brain) {
  console.log(
    `${base} 上是没有壳的旧桥（PI_HOST_DISABLE=1 起的），没有 /api/host/stop。\n` +
      `回它的终端按 Ctrl-C，或者用启动它的那个窗口关掉。`,
  );
  process.exit(2);
}

let res;
try {
  res = await fetch(`${base}/api/host/stop`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // 与壳的 sameOrigin() 对齐：命令行没有浏览器，自己写这一行就是「这个页面发的」。
      origin: base,
      "sec-fetch-site": "same-origin",
    },
    body: "{}",
    // 服务可能在收下请求后直接断开，也可能卡住不回；两种都不能让脚本挂死或抛未处理异常。
    signal: AbortSignal.timeout(5000),
  });
} catch (err) {
  const e = err instanceof Error ? err : new Error(String(err));
  const why = e.name === "TimeoutError" ? "5 秒内没有响应" : e.message;
  console.log(`停机请求没有回执（${why}），继续看 ${base} 是不是已经停了…`);
}
if (res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`停机请求被拒（HTTP ${res.status}）：${body?.code ?? ""} ${body?.message ?? ""}`.trim());
    process.exit(1);
  }
  console.log(`已发出停机请求（壳 pid ${health.pid}，脑 pid ${health.brain.pid}）：先收会话，再退出…`);
}

const until = Date.now() + 20_000;
while (Date.now() < until) {
  if (!(await up(base, 500))) {
    console.log(`${base} 已经停了：壳、脑与它们的会话都收了。`);
    process.exit(0);
  }
  await sleep(250);
}
console.error(`${base} 20 秒内还没停：看壳的日志（state 目录下的 host-*.log），别直接杀 pid。`);
process.exit(1);
