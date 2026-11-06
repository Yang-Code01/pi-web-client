import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  define: {
    // D154：跟 bridge 拿同一个 id（根目录 `scripts/build.mjs` 生成并经 PI_BUILD_ID 传下来）。
    __BUILD_ID__: JSON.stringify(process.env.PI_BUILD_ID || "dev"),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7864",
      "/raw": "http://127.0.0.1:7864",
      "/healthz": "http://127.0.0.1:7864",
      "/ws": { target: "ws://127.0.0.1:7864", ws: true },
    },
  },
  build: {
    // 两张页面：#45 的局域网界面是独立的 peer.html，不进 SPA 的路由。
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        peer: resolve(import.meta.dirname, "peer.html"),
      },
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
