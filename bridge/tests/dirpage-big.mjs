/**
 * 两万条以上的目录（issue #499 的规模上限）：按大小排序要真的生效。
 *
 * 桥端每轮只量 STAT_MAX（20000）条，剩下的靠前端隔一会儿重问、下一轮接着量。
 * 以前 `fillStats` 的完成判据是「条目数 ≤ STAT_MAX」，这种目录永远判不完，
 * `statsPending` 恒为 true，按大小 / 时间排序就永远退回名字序。
 *
 * 真造 20001 个文件，在 Windows 上要十几秒 —— 所以单独一条，不挂在 test:dirpage 里。
 *
 *   node --experimental-strip-types bridge/tests/dirpage-big.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDirPage } from "../src/dirs.ts";

const N = 20_001;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-dirpage-big-"));
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const size = ((i * 7919) % 977) + 1; // 1..977 字节，名字序和大小序完全错开
  fs.writeFileSync(path.join(root, `f${String(i).padStart(6, "0")}.txt`), "x".repeat(size));
}
console.log(`ok   造了 ${N} 个文件（${Date.now() - t0} ms）`);

let page;
let calls = 0;
const t1 = Date.now();
for (; calls < 12; calls++) {
  page = await listDirPage(root, { sort: "size", dir: "desc", limit: 50 });
  if (!page.statsPending) break;
}
console.log(`ok   量完用了 ${calls + 1} 轮（${Date.now() - t1} ms）`);

assert.equal(page.total, N, "total 是过滤后的总数，不随分页变");
assert.equal(page.statsPending, undefined, "十几轮之后还在 statsPending —— 完成判据又退回了「条目数 ≤ STAT_MAX」");

const sizes = page.entries.filter((e) => e.kind === "file").map((e) => e.size);
assert.ok(sizes.every((s) => typeof s === "number"), "按大小排序时每一条都要有 size");
for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i - 1] >= sizes[i], `第 ${i} 条大小没排对：${sizes[i - 1]} < ${sizes[i]}`);
assert.notDeepEqual(page.entries.map((e) => e.name).slice(0, 3), ["f000000.txt", "f000001.txt", "f000002.txt"], "还是名字序，说明统计没量完、排序被挡住了");

fs.rmSync(root, { recursive: true, force: true });
console.log("dirpage-big: ok");
