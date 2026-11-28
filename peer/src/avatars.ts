/**
 * 内网通头像：**只存「哪一张」这个 id**。内置的 12 张是短 id，图本身在前端
 * `web/src/peer/avatars.ts`；自定义头像是 `custom:<hash>`，字节存在本机 `~/.pi-peer/avatars/`，
 * 由 `peer/src/avatar-files.ts` 负责落盘与对端拉取。
 *
 * 为什么 id 两边各写一份、不共享一个模块：peer 与 web 是两个独立包（peer 是 node 直跑的 TS，
 * web 走 vite 打包），跨包 import 会把两边的构建设置搅在一起。清单只在两处出现：
 * **这里**（校验 + 随机默认值）与 **`web/src/peer/avatars.ts`**（真正画出来）。加 / 删头像时
 * 两边一起改 —— `npm --prefix web run typecheck` 里的 `peer-avatars-check.mjs` 会对账，
 * 少一张或多一张都直接报错。
 *
 * 配置里出现名单外、又不是合法 `custom:<hash>` 的 id（手改过、旧版本、将来删掉的头像）一律当
 * 「没设」，页面上退回首字母 + 色相的老样子，不会白框。
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

/**
 * 自定义头像的 id 形状：`custom:` + 图片字节 sha256 的前 16 位。
 *
 * 为什么只带 hash 不带图：announce 走 UDP 组播，一个包最多一千多字节，128×128 的
 * 图至少也有几 KB；把图塞进广播要拆包、重传、去重，代价远大于收益。所以广播里只有
 * 一个内容地址，真要图的时候按 hash 去对方的 `/avatar` 拿（对端再缓存到本机）。
 * 只认小写 hex：拼出来的路径 / 文件名必须是确定的，不能靠调用方自己清洗。
 *
 * 长度只在这里写一次：`avatarHash()` / `CUSTOM_AVATAR_RE` 共用 `HASH_HEX`，
 * 改长度不用满仓库找正则（`peer/src/avatar-files.ts` 与 `http.ts` 都走 `avatarHash()`）；
 * 落盘文件名要截几位也从 `AVATAR_HASH_LEN` 取，别在别处写 `16`。
 */
export const AVATAR_HASH_LEN = 16;
const HASH_HEX = `[0-9a-f]{${AVATAR_HASH_LEN}}`;
const HASH_RE = new RegExp(`^${HASH_HEX}$`);
export const CUSTOM_AVATAR_RE = new RegExp(`^custom:(${HASH_HEX})$`);

/** 是自定义头像 id 就返回 hash，否则空串。 */
export function customAvatarHash(id: unknown): string {
  if (typeof id !== "string") return "";
  return CUSTOM_AVATAR_RE.exec(id)?.[1] ?? "";
}

/** 只判 hash 形状（不带 `custom:` 前缀）：文件路径、请求参数、配置里的历史都用它。 */
export function avatarHash(value: unknown): string {
  return typeof value === "string" && HASH_RE.test(value) ? value : "";
}

/** hash → 自定义头像 id；hash 不合法就返回空串。 */
export function customAvatarId(hash: unknown): string {
  const h = avatarHash(hash);
  return h ? `custom:${h}` : "";
}

const KNOWN = new Set<string>(AVATAR_IDS);

/** 名单里的内置头像或形状合法的自定义头像原样返回，否则空串（调用方按「没设」处理）。 */
export function knownAvatar(id: unknown): string {
  if (typeof id !== "string") return "";
  return KNOWN.has(id) || customAvatarHash(id) ? id : "";
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
