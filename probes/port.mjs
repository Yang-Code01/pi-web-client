/**
 * 探针的静态服务器端口：从给定端口往后找第一个空的。
 *
 * 为什么需要它：Windows 上刚关掉的监听端口会留在 TIME_WAIT 里（Node 不设 SO_REUSEADDR），
 * 同一个探针连跑两次就会 `EADDRINUSE` 红掉一次 —— 那是上一轮自己留下的，不是代码坏了。
 * 端口要能在拼 `BASE` 之前定下来，所以先探空再 listen，而不是 listen 失败再重试。
 */
import net from "node:net";

/** 从 `start` 起找第一个能监听的端口（最多试 20 个）。 */
export async function freePort(start) {
  for (let port = start; port < start + 20; port++) {
    const server = net.createServer();
    const free = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`从 ${start} 起连试 20 个端口都被占着`);
}
