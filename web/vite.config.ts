import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 构建产物页首的许可证声明。版权行由 `tools/notices.mjs` 生成（不手写）：
 * highlight.js 是 BSD-3、xterm 是 MIT，两家的许可都要求「分发时保留声明」，
 * 而它们的 ESM 里没有可被 esbuild legalComments 认出的 `/*!` 头（xterm 发的是压缩后的 UMD），
 * 所以只能自己拼到 chunk 开头。这份文件跟 THIRD-PARTY-NOTICES.md 同一源头、由 typecheck 校验。
 */
const bundleNotices = readFileSync(resolve(import.meta.dirname, "src/legal/bundle-notices.txt"), "utf8").trimEnd();

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
      output: { banner: `/*!\n${bundleNotices}\n*/` },
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
