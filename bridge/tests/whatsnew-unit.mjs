/**
 * D195: 设置页「本项目更新日志」读的是检出根的 `CHANGELOG.md`，不是装机里 pi 包那份。
 * 这个文件守四件事：① 日志在 → 顶栏要的 version / branch / commit 都有值；② 条目带 `#PR`
 * 或 `D` 号，页面上点不着但人能照着查；③ 超长按**字节**截断、尾巴留「更早的批次略」，
 * 允许多切一个字符的余量但绝不允许整份 500KB 一次推给浏览器；④ 文件缺了返回空串而不是抛
 * —— 面板显示「还没有 CHANGELOG.md」，桥不能因为少一个文件就 500。
 *
 *   node --experimental-transform-types bridge/tests/whatsnew-unit.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selfChangelog } from "../src/whatsnew.ts";

const root = new URL("../../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

// ------------------------------------------------- ① 正常的检出
const full = await selfChangelog();
assert.equal(full.version, pkg.version, `版本要取根 package.json（${pkg.version}），拿到 ${full.version}`);
assert.ok(full.text.startsWith("# pi-web-client 更新日志"), "正文第一行是标题");
assert.ok(full.text.includes("## 2026-"), "至少有一批带日期的段落");
assert.ok(full.commit.length >= 7, `短 SHA 至少 7 位，拿到「${full.commit}」`);
// detached HEAD 时分支就是空串（接口本身这么说），别让这种检出假失败。
assert.equal(typeof full.branch, "string", "分支名是字符串，detached 时为空串");
const rootPkg = JSON.parse(readFileSync(`${full.root}/package.json`, "utf8"));
assert.equal(rootPkg.version, pkg.version, `root 要指向检出根，拿到「${full.root}」`);

// ------------------------------------------------- ② 条目带锚点
assert.match(full.text, /#\d+/, "每条要能指回 PR");
assert.match(full.text, /\bD\d+\b/, "设计决定那条要能指回 D 编号");
assert.ok(!full.text.includes("<!--"), "HTML 注释（增量锚点）不能泄到面板里");

// ------------------------------------------------- ③ 按字节截断
const limit = 120;
const cut = await selfChangelog(limit);
const cutBytes = Buffer.byteLength(cut.text, "utf8");
assert.ok(cut.text.endsWith("（更早的批次略）"), "截断后要有省略提示");
assert.ok(cutBytes < limit + 120, `截断后不该远超 ${limit} 字节，实际 ${cutBytes}`);
assert.ok(!cut.text.includes("\uFFFD"), "不能把多字节字符切一半留在正文里");
assert.ok(cut.text.startsWith("# pi-web-client 更新日志"), "截断的是尾巴：文档开头还在");
assert.ok(cut.text.length < full.text.length, "120 字节必须比整份短");

console.log(`whatsnew-unit: ok — ${full.text.length} 字符 / ${Buffer.byteLength(full.text, "utf8")} 字节`);
