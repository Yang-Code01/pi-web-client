#!/usr/bin/env node
/**
 * 门禁：内网通头像清单两边必须一致。
 *
 * peer 侧 `peer/src/avatars.ts` 的 `AVATAR_IDS` 决定「配置里能存哪些 id、随机默认挑哪张」，
 * 前端 `web/src/peer/avatars.ts` 决定「每张长什么样」。两边各写一份（跨包 import 会把两个
 * 构建设置搅在一起），所以加 / 删头像时最容易只改一边：
 *   - 只改 peer：随机可能抽到一张前端画不出来的，那个人的头像变成首字母。
 *   - 只改前端：多出来的那张永远选不到。
 * 这里直接对账，不一致就 exit 1（挂在 `npm run typecheck` 里）。
 *
 * 为什么用正则而不是 TS 编译器：两边都是**字面量清单**（`[...] as const` 与 `id: "…"`），
 * 形状稳定得很；解析整个模块反而会被 import 出去的东西绊住。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 用 fileURLToPath 而不是手撕 `new URL().pathname`：后者在 Windows 上要自己剥盘符前的 `/`，
// 而且不解 `%20` 之类的转义——仓库路径里有空格或中文时这里就找不到文件，门禁静默跳过。
const here = path.dirname(fileURLToPath(import.meta.url));
const PEER = path.join(here, "..", "peer", "src", "avatars.ts");
const WEB = path.join(here, "src", "peer", "avatars.ts");

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    // peer 不在（比如只 checkout 了 web）：门禁没法判，直接跳过而不是报错。
    return null;
  }
}

const peerSrc = read(PEER);
const webSrc = read(WEB);
if (peerSrc === null || webSrc === null) {
  console.log("peer-avatars-check: 跳过（缺 peer/ 或 web/ 那一份）");
  process.exit(0);
}

function ids(raw) {
  return raw.map((s) => s.trim()).filter(Boolean);
}

// peer：`export const AVATAR_IDS = ["cat", …] as const;`
const peerBlock = peerSrc.match(/export const AVATAR_IDS = \[([\s\S]*?)\] as const;/);
if (!peerBlock) {
  console.error("peer-avatars-check: peer/src/avatars.ts 里找不到 `AVATAR_IDS = [...] as const`");
  process.exit(1);
}
const peerIds = ids([...peerBlock[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]));

// web：每一张都有一行 `id: "cat",`（`\r` 容错：本仓库 .gitattributes 强制 LF，但别让
// 本地工具改成 CRLF 之后门禁误报「peer 有、web 没画」）
const webIds = ids([...webSrc.matchAll(/^\s*id: "([a-z0-9-]+)",\r?$/gm)].map((m) => m[1]));

const missingInWeb = peerIds.filter((id) => !webIds.includes(id));
const extraInWeb = webIds.filter((id) => !peerIds.includes(id));
const dupes = (list) => list.filter((id, i) => list.indexOf(id) !== i);

if (missingInWeb.length || extraInWeb.length || dupes(peerIds).length || dupes(webIds).length || !peerIds.length) {
  if (!peerIds.length) console.error("peer-avatars-check: peer 侧清单是空的");
  if (missingInWeb.length) console.error(`peer 有、web 没画：${missingInWeb.join(", ")}`);
  if (extraInWeb.length) console.error(`web 画了、peer 不认：${extraInWeb.join(", ")}`);
  if (dupes(peerIds).length) console.error(`peer 侧有重复 id：${dupes(peerIds).join(", ")}`);
  if (dupes(webIds).length) console.error(`web 侧有重复 id：${dupes(webIds).join(", ")}`);
  process.exit(1);
}

console.log(`peer-avatars-check: ok（${peerIds.length} 张）`);
