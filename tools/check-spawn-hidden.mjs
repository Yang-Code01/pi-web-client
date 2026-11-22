/**
 * 守卫：从 bridge / 技能起的子进程不许出现真实控制台窗口。
 *
 * 为什么需要它：本地的 bridge（以及 test-dev 起的测试桥）是 `detached + windowsHide` 拉起的，
 * 属于**完全没有控制台**的进程。这种进程再 spawn 一个控制台程序、又没写 `windowsHide` 时，
 * Windows 会为它新建一个真实控制台窗口，按默认终端交给 Windows Terminal，抢走键盘焦点 ——
 * 用户正在打字就被打断。实测（console-less 父进程 spawn 一个 node，前后各数一遍可见顶层窗口）：
 * 不加 `windowsHide` 新增 3 个可见窗口，加了是 0。详见 docs/DECISIONS.md 的 D387。
 *
 * 规则：扫到 child_process 的 spawn/spawnSync/exec/execFile/execFileSync/fork 调用时，参数里必须
 * 有 `windowsHide: true`。确实需要可见窗口的（打开文件管理器、交给本机程序打开），在调用那一行
 * 或它上面两行内写 `spawn-visible-ok: <理由>` 放行 —— 理由要写清为什么这个窗口是功能本身。
 *
 * 用法：node tools/check-spawn-hidden.mjs   （已挂进 `npm run typecheck`）
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCOPE = ["bridge/src", "peer/src", "scripts", "tools", ".pi/skills"];
const EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"]);
const SKIP_DIR = new Set(["node_modules", "dist", "build", ".git", ".scratch", "coverage"]);
const API = "spawn|spawnSync|exec|execFile|execFileSync|fork";

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIR.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (EXT.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

/** 这个文件从 child_process 里拿了哪些名字（直接 import 的函数名 + 命名空间别名）。 */
function childProcessNames(text) {
  const names = new Set();
  const spaces = new Set();
  for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g)) {
    for (const raw of m[1].split(",")) {
      const piece = raw.trim().replace(/^type\s+/, "");
      if (!piece) continue;
      const local = piece.split(/\s+as\s+/).pop()?.trim();
      if (local) names.add(local);
    }
  }
  for (const m of text.matchAll(/import\s*\*\s*as\s+([\w$]+)\s*from\s*["'](?:node:)?child_process["']/g)) spaces.add(m[1]);
  for (const m of text.matchAll(/import\s+([\w$]+)\s+from\s*["'](?:node:)?child_process["']/g)) spaces.add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\(\s*["'](?:node:)?child_process["']\s*\)/g)) {
    for (const raw of m[1].split(",")) {
      const local = raw.trim().split(/\s*:\s*/).pop()?.trim();
      if (local) names.add(local);
    }
  }
  for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*["'](?:node:)?child_process["']\s*\)/g)) spaces.add(m[1]);
  return { names, spaces };
}

/** 从 `(` 开始，跳过字符串与注释，拿到配对的 `)` 之间那段参数文本。 */
function callArgs(text, openParen) {
  let depth = 0;
  let i = openParen;
  let out = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote) break;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "(") {
      depth++;
      if (depth === 1) {
        i++;
        continue;
      }
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) return out;
    }
    out += ch;
    i++;
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** 这一行，或者它上面两行里，有没有放行标记。 */
function marked(lines, line) {
  for (let n = line; n >= Math.max(1, line - 2); n--) if (lines[n - 1]?.includes("spawn-visible-ok")) return true;
  return false;
}

const problems = [];
let scanned = 0;
for (const rel of SCOPE) {
  for (const file of walk(path.join(ROOT, rel))) {
    const text = fs.readFileSync(file, "utf8");
    const { names, spaces } = childProcessNames(text);
    if (!names.size && !spaces.size) continue;
    scanned++;
    const lines = text.split("\n");
    // 限定符只能贴在同一行（`cp.spawn`）：用 \s* 会让上一行结尾的 `once.` 被吃成限定符，
    // 于是紧随其后的 `spawn(` 被当成「不是 child_process 的调用」漏掉（terminal.ts:286 踩过）。
    const re = new RegExp(`(?:([\\w$]+)[ \\t]*\\.[ \\t]*)?\\b(${API})\\b[ \\t]*\\(`, "g");
    for (const m of text.matchAll(re)) {
      const qualifier = m[1] ?? null;
      const callee = m[2];
      if (qualifier ? !spaces.has(qualifier) : !names.has(callee)) continue;
      const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
      if (/\bfunction\s*\*?\s*$/.test(before)) continue; // 定义处，不是调用
      const openParen = (m.index ?? 0) + m[0].length - 1;
      const args = callArgs(text, openParen);
      if (/windowsHide\s*:\s*true/.test(args)) continue;
      const line = lineOf(text, m.index ?? 0);
      if (marked(lines, line)) continue;
      const why = /windowsHide\s*:\s*false/.test(args) ? "显式写了 windowsHide: false" : "没有 windowsHide";
      problems.push({ file: path.relative(ROOT, file).replaceAll("\\", "/"), line, callee, why });
    }
  }
}

if (problems.length) {
  console.error(`有 ${problems.length} 处子进程调用会在 bridge / 技能里弹出可见控制台窗口（见 D387）：\n`);
  for (const p of problems) console.error(`  ${p.file}:${p.line}  ${p.callee}()  ${p.why}`);
  console.error(
    "\n修法：参数里加 `windowsHide: true`；确实要可见窗口的（打开文件管理器之类），" +
      "在调用那一行或上面两行写 `spawn-visible-ok: <这是功能本身，为什么>` 。",
  );
  process.exit(1);
}
console.log(`check-spawn-hidden: ${scanned} 个文件里所有 child_process 调用都带了 windowsHide（或已标注放行）。`);
