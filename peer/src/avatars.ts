/**
 * 内网通头像：**只存「哪一张」这个 id**，图本身在前端 `web/src/peer/avatars.ts`。
 *
 * 为什么 id 两边各写一份、不共享一个模块：peer 与 web 是两个独立包（peer 是 node 直跑的 TS，
 * web 走 vite 打包），跨包 import 会把两边的构建设置搅在一起。清单只在两处出现：
 * **这里**（校验 + 随机默认值）与 **`web/src/peer/avatars.ts`**（真正画出来）。加 / 删头像时
 * 两边一起改 —— `npm --prefix web run typecheck` 里的 `peer-avatars-check.mjs` 会对账，
 * 少一张或多一张都直接报错。
 *
 * 配置里出现名单外的 id（手改过、旧版本、将来删掉的头像）一律当「没设」，页面上退回
 * 首字母 + 色相的老样子，不会白框。
 */
export const AVATAR_IDS = [
  "cat",
  "bear",
  "rabbit",
  "penguin",
  "dog",
  "frog",
  "chick",
  "whale",
  "owl",
  "octopus",
  "pig",
  "dino",
] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

const KNOWN = new Set<string>(AVATAR_IDS);

/** 名单里就原样返回，否则空串（调用方按「没设」处理）。 */
export function knownAvatar(id: unknown): string {
  return typeof id === "string" && KNOWN.has(id) ? id : "";
}

/**
 * 第一次启动（配置里还没有头像）时随机挑一张。
 *
 * 只挑这一次：挑完由 index.ts 立刻 `saveConfig` 落盘，之后每次启动都用同一张，
 * 否则每重启一次自己的头像就变一次，别人那边看着莫名其妙。
 */
export function randomAvatar(): string {
  return AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)];
}
