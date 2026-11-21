/**
 * 许可清单（`THIRD-PARTY-NOTICES.md` / `web/src/legal/bundle-notices.txt` / `bridge/src/notices.ts`）。
 *
 * 守的是三件会静默坏掉的事：
 * 1. 生成的文件跟依赖锁文件对得上（`tools/notices.mjs --check` —— typecheck 里也跑一次）；
 * 2. 清单里**真有**打包进 web/dist 那三个组件的版权行（漏了就等于没随附声明）；
 * 3. 桥找得到这份文件（`/api/notices` 的内容），找不到时如实回 null 而不是空串。
 *
 *   node --experimental-strip-types bridge/tests/notices-unit.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { noticesPath, noticesText } from "../src/notices.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// 1. 生成物与锁文件同步：不一致时脚本会打印第一处差异并以 1 退出。
const out = execFileSync(process.execPath, [path.join(ROOT, "tools/notices.mjs"), "--check"], { encoding: "utf8" });
assert.match(out, /notices 已同步/);

// 2. 清单内容：每个打进产物的组件都要有版本、许可名和版权行。
const md = fs.readFileSync(path.join(ROOT, "THIRD-PARTY-NOTICES.md"), "utf8");
for (const [name, license, holder] of [
  ["highlight.js 11.12.0", "BSD-3-Clause", "Ivan Sagalaev"],
  ["@xterm/xterm 5.5.0", "MIT", "xterm.js authors"],
  ["@xterm/addon-fit 0.10.0", "MIT", "xterm.js authors"],
]) {
  const at = md.indexOf(`### ${name} — ${license}`);
  assert.ok(at >= 0, `清单里缺 ${name} — ${license}`);
  const block = md.slice(at, md.indexOf("\n### ", at + 1) < 0 ? undefined : md.indexOf("\n### ", at + 1));
  assert.ok(block.includes(holder), `${name} 的段落里没有版权人 ${holder}`);
  assert.ok(block.includes("Permission is hereby granted") || block.includes("Redistribution and use"), `${name} 没附许可正文`);
}
// 桥端还有一个 MPL-2.0（web-push）：必须写明源码地址，不能只写个名字。
assert.match(md, /### web-push [\d.]+ — MPL-2\.0/, "清单里缺 web-push 的 MPL-2.0 声明");
assert.match(md, /MPL-2\.0：按该许可证要求，源码可从上方地址获取/, "MPL-2.0 少了源码指引");

// 3. 构建产物页首：只写打包进 dist 的三个，不多写桥端依赖。
const banner = fs.readFileSync(path.join(ROOT, "web/src/legal/bundle-notices.txt"), "utf8");
assert.match(banner, /highlight\.js 11\.12\.0 — BSD-3-Clause — Copyright/);
assert.match(banner, /@xterm\/xterm 5\.5\.0 — MIT/);
assert.ok(!banner.includes("web-push"), "页首声明不该出现没进产物的桥端依赖");

// 4. 桥读得到：路径候选第一项应指向仓库根那份文件。
assert.ok(noticesPath().some((p) => p.endsWith("THIRD-PARTY-NOTICES.md")));
const text = noticesText();
assert.ok(text && text.includes("# 第三方组件许可与版权声明"), "noticesText() 读不到仓库根那份清单");

console.log(`ok notices（清单 ${(md.length / 1024).toFixed(1)} KB，页首 ${banner.split("\n").length} 行）`);
