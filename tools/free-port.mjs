/**
 * 测试用的端口：交给系统分配。
 *
 * 以前每个测试文件写死一个端口（7892、7899…），在本机上是**必然失败**的：Windows 会把一段段
 * 端口占给 Hyper-V / WSL，落进去的 `listen` 直接 `EACCES: permission denied`：
 *
 *   netsh interface ipv4 show excludedportrange protocol=tcp
 *         7877        7976
 *         7977        8076      ← 7892、7899 都在这里
 *         8077        8176
 *
 * 于是测试先空转 100×200 ms 等 /healthz，再抛一句读不懂的 `fetch failed / ECONNREFUSED`。
 * 绑 0 让内核挑一个它自己认为可用的端口，保留区、以及两个测试撞端口这两件事一起解决。
 *
 * 用法：`const PORT = Number(process.env.SOME_PORT ?? (await freePort()));`
 * —— 显式给了环境变量就照旧听那个端口（手工复现时要用固定端口）。
 */
import net from "node:net";

/** 返回一个刚被系统分配、随即释放的本地端口。 */
export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
