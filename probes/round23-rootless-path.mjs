/**
 * Probe: D113 — Windows 上无盘符根路径（`/openwiki/a.md`）不再落到 bridge 所在盘（#64）。
 *
 * 规则（bridge/src/preview.ts `openPreview` / `rootlessCandidates`）：
 *   有 base（链接所在文档）→ base 所在 git 仓库根；然后 会话 cwd → cwd 所在仓库根 → 原行为（当前盘根）。
 *   第一个存在的文件胜出；全找不到时报错列出所有候选。不在子目录里搜索。
 *
 * 断言：
 *   1. 文档里点 `/docs/b.md`：按文档所在仓库根打开（cwd 是仓库外的父目录也一样）
 *   2. 聊天里的 `/docs/b.md`（无 base）：cwd 就是仓库时按 cwd 打开
 *   3. cwd 在仓库子目录时，`/docs/b.md` 回退到 cwd 所在仓库根
 *   4. cwd 是仓库外的父目录、又没有 base：打不开，报错里列出候选（不搜子目录）
 *   5. `\docs\b.md` 反斜杠写法同样生效；`//server/x` 不算无盘符根路径
 *   6. 带盘符的绝对路径与相对路径行为不变
 *
 * Run (Windows only): node --experimental-strip-types probes/round23-rootless-path.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const { openPreview, isRootless, rootlessCandidates } = await import(pathToFileURL(path.resolve(here, "../bridge/src/preview.ts")).href);

if (process.platform !== "win32") {
  console.log("SKIP: D113 only applies on Windows");
  process.exit(0);
}

let failed = 0;
const ok = (cond, msg) => {
  console.log(cond ? "PASS" : "FAIL", msg);
  if (!cond) failed++;
};
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// <tmp>/parent/repo/{.git/, docs/a.md, docs/b.md, sub/}
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "d70-"));
const repo = path.join(parent, "repo");
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
fs.writeFileSync(path.join(repo, "docs", "a.md"), "# a\n[b](/docs/b.md)\n");
fs.writeFileSync(path.join(repo, "docs", "b.md"), "# b\n");
const docA = path.join(repo, "docs", "a.md");
const docB = path.join(repo, "docs", "b.md");
const sess = (cwd) => ({ cwd, file: null });

try {
  // 1
  const i1 = openPreview(sess(parent), "/docs/b.md", docA);
  ok(same(i1.abs, docB), `doc link resolves from the doc's repo: ${i1.abs}`);

  // 2
  const i2 = openPreview(sess(repo), "/docs/b.md");
  ok(same(i2.abs, docB), `chat path resolves from cwd: ${i2.abs}`);

  // 3
  const i3 = openPreview(sess(path.join(repo, "sub")), "/docs/b.md");
  ok(same(i3.abs, docB), `chat path falls back to cwd's repo root: ${i3.abs}`);

  // 4
  let msg = "";
  try {
    openPreview(sess(parent), "/docs/b.md");
  } catch (e) {
    msg = String(e.message);
  }
  ok(msg.startsWith("文件不存在：") && msg.includes(path.join(parent, "docs", "b.md")) && msg.includes(" ／ "), `no base + cwd outside repo: lists candidates, no search → ${msg}`);

  // 5
  const i5 = openPreview(sess(parent), "\\docs\\b.md", docA);
  ok(same(i5.abs, docB), `backslash rootless works too: ${i5.abs}`);
  ok(!isRootless("//server/share/x.md") && !isRootless("\\\\server\\share\\x.md"), "UNC is not rootless");
  ok(isRootless("/a.md") && isRootless("\\a.md") && !isRootless("C:/a.md") && !isRootless("a/b.md"), "isRootless classification");

  // 6
  const i6 = openPreview(sess(parent), docB);
  ok(same(i6.abs, docB), "drive-absolute path unchanged");
  const i7 = openPreview(sess(repo), "docs/b.md");
  ok(same(i7.abs, docB), "relative path still resolves from cwd");

  // candidate order + legacy last
  const c = rootlessCandidates("/docs/b.md", path.join(repo, "sub"), docA);
  ok(same(c[0], docB) && same(c[c.length - 1], path.resolve("/docs/b.md")), `candidate order: ${c.join(" | ")}`);
} finally {
  fs.rmSync(parent, { recursive: true, force: true });
}

console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exitCode = failed ? 1 : 0;
