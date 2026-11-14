/**
 * 守卫：`#app` 子树里不许写裸 `vh` / `vw`。
 *
 * `#app { zoom: var(--ui-scale) }`（外观「字号」）会把整棵子树连长度一起缩放一遍，而 `vw` / `vh`
 * 解析的是**视口**尺寸、不认 zoom，于是同一个值会被乘第二次：
 *
 *   字号 125% 下 `.branch-sheet { height: 82vh }` → 卡高 923px（视口 900），底栏整条落在屏幕外；
 *   字号 200% 下 `width: 94vw` → 2000px（视口 1440），右边被裁。
 *
 * 这个坑记过一次又一次（D123 全屏预览的 `100vw`、`.sys-console` / `.mail-console` / `.jc-console`
 * 三处注释、D256 的分支工作台），每次都是「已经在文档里写了」还是被写成裸的，所以不再靠记性：
 * 要写几成视口就写 `calc(var(--vh1) * N)` / `calc(var(--vw1) * N)`，写裸的直接让用例红。
 *
 * 判据：
 *  - 扫 `web/src/*.css`（主应用；`web/src/peer/` 是另一张页面、没有 zoom，不在范围内）；
 *  - 注释里的不算，`--vh1:` / `--vw1:` 那两行定义是豁免（它们本来就要写裸的）；
 *  - 行尾带 `/* 不在 #app *​/` 的豁免：那些是 `document.body.append()` 上去的浮层（`.pin-menu`、
 *    `.ws-pop`、`.perm-menu`、`.update-bar`、`.fail-toast` …），不在 zoom 子树里，裸单位是对的。
 *    新东西不要往这个豁口里塞，请挂进 `#app`（浮层本来就该跟着字号缩放）。
 *
 * Run: node web/tests/viewport-units-unit.mjs        （已挂在 `npm --prefix web run typecheck`）
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
/** 裸的视口单位；`dvh` / `svh` / `lvh` 一样是视口单位，一并不许。 */
const UNIT = /(?<![\w.-])(\d+(?:\.\d+)?)(vh|vw|dvh|svh|lvh|dvw)\b/g;
/** 豁免标记：行尾写这个注释就放过（只有「挂在 body 上」的浮层能用）。 */
const EXEMPT = /\/\*\s*不在\s*#app\s*\*\//;

let bad = 0;
const fail = (msg) => {
  console.log(` FAIL ${msg}`);
  bad += 1;
};
const ok = (msg) => console.log(`  ok   ${msg}`);

/** 去掉块注释与行注释，但保留行号（换行留着），`/* 不在 #app *​/` 这类豁免标记另判。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\n)(\s*)\/\/[^\n]*/g, (m, br) => br);
}

const files = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith(".css"))
  .sort();

if (!files.length) fail("web/src 下没找到 css —— 路径变了？");

for (const file of files) {
  const raw = fs.readFileSync(path.join(SRC, file), "utf8");
  const rawLines = raw.split("\n");
  const bare = stripComments(raw).split("\n");
  let hits = 0;
  for (let i = 0; i < bare.length; i += 1) {
    const line = bare[i];
    if (!line.trim()) continue;
    // 只有 var(--vh1) / var(--vw1) 那两行定义是天生裸的
    if (/--vh1\s*:/.test(line) || /--vw1\s*:/.test(line)) continue;
    UNIT.lastIndex = 0;
    if (!UNIT.test(line)) continue;
    if (EXEMPT.test(rawLines[i])) continue;
    hits += 1;
    fail(`${file}:${i + 1} 写了裸视口单位，改成 calc(var(--vh1) * N) / calc(var(--vw1) * N)：\n         ${rawLines[i].trim()}`);
  }
  if (!hits) ok(`${file}：没有裸 vh / vw`);
}

/** 豁免只给 body 挂载的浮层：数一下别让豁免悄悄长成一片。 */
const exempt = files.flatMap((file) =>
  fs
    .readFileSync(path.join(SRC, file), "utf8")
    .split("\n")
    .filter((l) => EXEMPT.test(l))
    .map((l) => `${file}: ${l.trim().slice(0, 70)}`),
);
if (exempt.length > 12) {
  fail(`豁免已经 ${exempt.length} 条了（上限 12）—— 又开始把浮层往 body 上挂了？请挂进 #app。`);
} else {
  ok(`豁免 ${exempt.length} 条（都是 document.body 上的浮层）`);
}

if (bad) {
  console.log(`\nviewport-units: ${bad} 处不合格`);
  process.exit(1);
}
console.log("\nviewport-units: ok —— #app 里没有裸 vh / vw");
