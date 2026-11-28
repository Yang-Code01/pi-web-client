/**
 * 内网通头像素材：12 张手画的圆形小 IP，全部内联成 SVG data URI（不发请求、不落盘、
 * 打包进去就完事）。id 清单与 `peer/src/avatars.ts` 一一对应，`peer-avatars-check.mjs`
 * 会在 typecheck 里对账。
 *
 * 画法（跟 `~/.agents/skills/ip-as-logo` 那套简化规则对齐，但尺寸换成 64×64 圆槽）：
 * - 每张只有 4–7 个大形状，圆角、圆钝、没有尖角、没有描边、没有高光。
 * - 颜色：2 个角色色（身体 / 肚子或耳朵内侧）+ 1 个背景色。眼睛统一用同一个墨色
 *   `INK`，它不属于任何一张的语义配色，只是「五官」的颜色。
 * - 角色整体略偏左下（圆心 x=28 而不是 32），在圆槽里看起来也不呆板。
 *
 * 为什么不用方块：页面里头像的槽位（`.av`）一直是圆的，圆槽里塞方图会在四角露出背景边。
 */
const INK = "#243040";

interface Art {
  /** 与 `peer/src/avatars.ts` 的 AVATAR_IDS 一致。 */
  id: string;
  /** 背景色：整张图的底。 */
  bg: string;
  /** 两个角色色。 */
  c1: string;
  c2: string;
  /** 画在背景上的形状（只用 c1 / c2 / ink 三种颜色）。 */
  parts: string;
}

const ART: Art[] = [
  {
    id: "cat",
    bg: "#2f4858",
    c1: "#f08a4b",
    c2: "#ffd8b0",
    parts: `
      <circle cx="15" cy="26" r="8.5" fill="C1"/><circle cx="41" cy="26" r="8.5" fill="C1"/>
      <circle cx="15" cy="26" r="4" fill="C2"/><circle cx="41" cy="26" r="4" fill="C2"/>
      <circle cx="28" cy="42" r="20" fill="C1"/>
      <ellipse cx="28" cy="50" rx="11" ry="8" fill="C2"/>
      <circle cx="22" cy="38" r="2.6" fill="INK"/><circle cx="34" cy="38" r="2.6" fill="INK"/>`,
  },
  {
    id: "bear",
    bg: "#3b4a3f",
    c1: "#c98b5e",
    c2: "#f4dfc4",
    parts: `
      <circle cx="13" cy="25" r="7.5" fill="C1"/><circle cx="41" cy="25" r="7.5" fill="C1"/>
      <circle cx="28" cy="42" r="20" fill="C1"/>
      <ellipse cx="28" cy="49" rx="10" ry="7" fill="C2"/>
      <circle cx="28" cy="46" r="2.4" fill="INK"/>
      <circle cx="21" cy="37" r="2.6" fill="INK"/><circle cx="35" cy="37" r="2.6" fill="INK"/>`,
  },
  {
    id: "rabbit",
    bg: "#514466",
    c1: "#f7f3fb",
    c2: "#cdb4e8",
    parts: `
      <ellipse cx="20" cy="22" rx="6.5" ry="15" fill="C1" transform="rotate(-8 20 22)"/>
      <ellipse cx="38" cy="22" rx="6.5" ry="15" fill="C1" transform="rotate(8 38 22)"/>
      <ellipse cx="20" cy="23" rx="3" ry="10" fill="C2" transform="rotate(-8 20 22)"/>
      <ellipse cx="38" cy="23" rx="3" ry="10" fill="C2" transform="rotate(8 38 22)"/>
      <circle cx="28" cy="45" r="18" fill="C1"/>
      <circle cx="22" cy="42" r="2.6" fill="INK"/><circle cx="34" cy="42" r="2.6" fill="INK"/>`,
  },
  {
    id: "penguin",
    bg: "#6c8ea8",
    c1: "#26324b",
    c2: "#f2ece0",
    parts: `
      <circle cx="28" cy="40" r="21" fill="C1"/>
      <ellipse cx="28" cy="46" rx="13" ry="15" fill="C2"/>
      <circle cx="23" cy="38" r="2.6" fill="INK"/><circle cx="33" cy="38" r="2.6" fill="INK"/>`,
  },
  {
    id: "dog",
    bg: "#4b3f36",
    c1: "#e0a96d",
    c2: "#f7e3c8",
    parts: `
      <ellipse cx="10" cy="40" rx="6.5" ry="13" fill="C1"/><ellipse cx="46" cy="40" rx="6.5" ry="13" fill="C1"/>
      <circle cx="28" cy="40" r="19" fill="C1"/>
      <ellipse cx="28" cy="47" rx="9.5" ry="7" fill="C2"/>
      <circle cx="28" cy="44" r="2.3" fill="INK"/>
      <circle cx="22" cy="35" r="2.5" fill="INK"/><circle cx="34" cy="35" r="2.5" fill="INK"/>`,
  },
  {
    id: "frog",
    bg: "#3f5140",
    c1: "#7fc47c",
    c2: "#e8f3b8",
    parts: `
      <circle cx="16" cy="26" r="8" fill="C1"/><circle cx="40" cy="26" r="8" fill="C1"/>
      <ellipse cx="28" cy="40" rx="21" ry="17" fill="C1"/>
      <ellipse cx="28" cy="48" rx="12" ry="8" fill="C2"/>
      <circle cx="16" cy="26" r="3.2" fill="INK"/><circle cx="40" cy="26" r="3.2" fill="INK"/>`,
  },
  {
    id: "chick",
    bg: "#7a6a4a",
    c1: "#f7c948",
    c2: "#fdeeb8",
    parts: `
      <circle cx="28" cy="20" r="4.5" fill="C2"/>
      <circle cx="28" cy="40" r="19" fill="C1"/>
      <ellipse cx="13" cy="42" rx="6" ry="8" fill="C2"/>
      <circle cx="23" cy="36" r="2.5" fill="INK"/><circle cx="33" cy="36" r="2.5" fill="INK"/>
      <circle cx="28" cy="43" r="3" fill="C2"/>`,
  },
  {
    id: "whale",
    bg: "#2f4257",
    c1: "#5aa9d6",
    c2: "#d8ecf7",
    parts: `
      <circle cx="56" cy="26" r="7" fill="C1"/><circle cx="58" cy="42" r="7" fill="C1"/>
      <ellipse cx="26" cy="40" rx="23" ry="17" fill="C1"/>
      <ellipse cx="26" cy="47" rx="14" ry="9" fill="C2"/>
      <circle cx="18" cy="36" r="2.6" fill="INK"/><circle cx="29" cy="36" r="2.6" fill="INK"/>`,
  },
  {
    id: "owl",
    bg: "#3f4a5c",
    c1: "#b08d57",
    c2: "#efe3cb",
    parts: `
      <circle cx="28" cy="40" r="20" fill="C1"/>
      <ellipse cx="28" cy="47" rx="13" ry="13" fill="C2"/>
      <circle cx="20" cy="32" r="7.5" fill="C2"/><circle cx="36" cy="32" r="7.5" fill="C2"/>
      <circle cx="20" cy="32" r="3" fill="INK"/><circle cx="36" cy="32" r="3" fill="INK"/>`,
  },
  {
    id: "octopus",
    bg: "#40384f",
    c1: "#e0708f",
    c2: "#fbd0dc",
    parts: `
      <ellipse cx="17" cy="52" rx="7" ry="9" fill="C1"/><ellipse cx="33" cy="54" rx="7.5" ry="9" fill="C1"/>
      <ellipse cx="28" cy="34" rx="19" ry="16" fill="C1"/>
      <ellipse cx="28" cy="38" rx="10" ry="8" fill="C2"/>
      <circle cx="22" cy="31" r="2.5" fill="INK"/><circle cx="34" cy="31" r="2.5" fill="INK"/>`,
  },
  {
    id: "pig",
    bg: "#4a3c47",
    c1: "#f0a0b4",
    c2: "#ffdce4",
    parts: `
      <circle cx="14" cy="26" r="7" fill="C1"/><circle cx="42" cy="26" r="7" fill="C1"/>
      <circle cx="28" cy="41" r="19" fill="C1"/>
      <ellipse cx="28" cy="46" rx="8" ry="6" fill="C2"/>
      <circle cx="25" cy="46" r="1.4" fill="INK"/><circle cx="31" cy="46" r="1.4" fill="INK"/>
      <circle cx="22" cy="35" r="2.5" fill="INK"/><circle cx="34" cy="35" r="2.5" fill="INK"/>`,
  },
  {
    id: "dino",
    bg: "#3c4b52",
    c1: "#6fbf73",
    c2: "#d8efc9",
    parts: `
      <circle cx="47" cy="18" r="4.5" fill="C1"/><circle cx="51" cy="30" r="4.5" fill="C1"/>
      <rect x="9" y="16" width="40" height="42" rx="19" fill="C1"/>
      <ellipse cx="26" cy="47" rx="12" ry="9" fill="C2"/>
      <circle cx="21" cy="35" r="2.6" fill="INK"/><circle cx="33" cy="35" r="2.6" fill="INK"/>`,
  },
];

export const AVATAR_IDS: string[] = ART.map((a) => a.id);

function svgOf(a: Art): string {
  const body = a.parts
    .replaceAll("C1", a.c1)
    .replaceAll("C2", a.c2)
    .replaceAll("INK", INK)
    .replace(/\n\s+/g, " ");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<defs><clipPath id="c"><circle cx="32" cy="32" r="32"/></clipPath></defs>` +
    `<g clip-path="url(#c)"><rect width="64" height="64" fill="${a.bg}"/>${body}</g></svg>`
  );
}

const URLS = new Map<string, string>();
for (const a of ART) URLS.set(a.id, `data:image/svg+xml,${encodeURIComponent(svgOf(a))}`);

/**
 * 头像 id → 可以直接塞进 `<img src>` 的地址。未知 id（老配置、手改过、将来删掉的头像）
 * 返回 null，调用方退回「首字母 + 色相」的老样子。
 *
 * 自定义头像（`custom:<hash>`）的字节在对方的 peer 上，URL 需要知道是谁的：`key` 就是
 * nodeId，桥会转给 peer 按 hash 取（本机有缓存就发缓存）。`key` 缺省时只给内置头像地址。
 */
export function avatarUrl(id: string | null | undefined, key?: string | null): string | null {
  if (!id) return null;
  const builtin = URLS.get(id);
  if (builtin) return builtin;
  const hash = customAvatarHash(id);
  if (!hash || !key) return null;
  // 参数名跟 peer 的 `/avatar?h=` 一致，桥只做转发（评审 7-22）。
  return `/api/peer/avatar/${encodeURIComponent(key)}?h=${hash}`;
}

/**
 * `custom:<hash>` 的 hash 长度。这是**线上格式**（announce / URL / 配置三处都按它走），
 * 源头在 `peer/src/avatars.ts` 的 `AVATAR_HASH_LEN`；两个包不互相 import，所以这里再写一份。
 * `web/peer-avatars-check.mjs` 会比对两边的数字，改一处没改另一处时 typecheck 直接红。
 */
export const AVATAR_HASH_LEN = 16;
const CUSTOM_AVATAR_RE = new RegExp(`^custom:([0-9a-f]{${AVATAR_HASH_LEN}})$`);

/** `custom:<hash>` → hash，其余（内置 id / 空）返回空串。 */
export function customAvatarHash(id: string | null | undefined): string {
  return CUSTOM_AVATAR_RE.exec(id ?? "")?.[1] ?? "";
}

/** 随机挑一张（可以排除当前这张，页面上「随机换一个」就不会抽到自己）。 */
export function randomAvatarId(except?: string | null): string {
  const pool = except ? AVATAR_IDS.filter((id) => id !== except) : AVATAR_IDS;
  return pool[Math.floor(Math.random() * pool.length)];
}
