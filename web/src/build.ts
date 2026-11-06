declare const __BUILD_ID__: string;

/**
 * D154：本份 dist 的构建戳，由 `vite.config.ts` 的 `define` 在构建时替换成字面量。
 *
 * `dev` 表示这是 `vite dev` 的产物 —— 那时页面本来就跑在源码上，跟 bridge 的构建戳对不上是常态，
 * 所以不拿它提示「服务已更新」。
 */
export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
