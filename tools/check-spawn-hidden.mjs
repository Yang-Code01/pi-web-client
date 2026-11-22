/**
 * 守卫：从 bridge / 技能起的子进程不许出现真实控制台窗口。
 *
 * 为什么需要它：本地的 bridge（以及 test-dev 起的测试桥）是 `detached + windowsHide` 拉起的，
 * 属于**完全没有控制台**的进程。这种进程再 spawn 一个控制台程序、又没写 `windowsHide` 时，
 * Windows 会为它新建一个真实控制台窗口，按默认终端交给 Windows Terminal，抢走键盘焦点 ——
 * 用户正在打字就被打断。详见 docs/DECISIONS.md 的 D387。
 *
 * 规则：扫到 child_process 的 spawn/spawnSync/exec/execFile/execFileSync/fork 调用时，参数里必须
 * 有 `windowsHide: true`。三种写法都认：
 *   - 直接写在参数里；
 *   - 参数是整个 options 常量（`const opts = { windowsHide: true, … }; run(cmd, args, opts)`）——
 *     按名字回文件里找那个对象字面量；
 *   - `const run = promisify(execFile)` 这类别名。
 * 确实需要可见窗口的（打开文件管理器、交给本机程序打开），在调用那一行或它上面两行内写
 * `spawn-visible-ok: <理由>` 放行 —— 理由要写清为什么这个窗口是功能本身。
 *
 * 范围：会被「没有控制台的进程」拉起来的树（bridge/src、bridge/ext、peer/src、scripts、tools、
 * .pi/skills）。`bridge/tests` 与 `probes` 不扫：它们由终端直接跑，父进程有控制台，不需要这个开关，
 * 而且量大（141 + 57 处）会淹没真正的回归；要查就显式传路径。
 *
 * 用法：
 *   node tools/check-spawn-hidden.mjs                # 扫默认范围（已挂进 npm run typecheck）
 *   node tools/check-spawn-hidden.mjs bridge/tests   # 只扫指定路径
 *   node tools/check-spawn-hidden.mjs --self-test    # 自测：反例必须红、正例必须绿
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_SCOPE = ["bridge/src", "bridge/ext", "peer/src", "scripts", "tools", ".pi/skills"];
const EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"]);
const SKIP_DIR = new Set(["node_modules", "dist", "build", ".git", ".scratch", "coverage"]);
const API = "spawn|spawnSync|exec|execFile|execFileSync|fork";
/** 扫到的文件数低于这个数就说明范围被改坏了（目录改名、SKIP_DIR 误伤），守卫不能静默变绿。 */
const MIN_FILES = 30;

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

/** 从引号位置往后找闭合引号（`'` 与 `"` 不跨行）；找不到返回 -1。 */
function stringEnd(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === quote) return i;
    if (ch === "\n" && quote !== "`") return -1;
  }
  return -1;
}

/**
 * 把字符串字面量与注释的内容换成空格（长度与换行保持不变），这样检测不会被
 * 「文档里引用的示例代码」「夹具字符串里的调用」骗到，而行号仍然对得上原文。
 * `'` / `"` 只在同一行内找闭合，找不到就当普通字符 —— 免得被正则里的引号带偏。
 */
function mask(text) {
  const out = text.split("");
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      const end = nl < 0 ? text.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? text.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = stringEnd(text, i);
      if (end < 0) {
        i++;
        continue;
      }
      blank(i, end + 1);
      i = end + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** 从开场符号开始，跳到配对的收场符号，返回括号之间的内容。 */
function balanced(text, openIndex, open, close) {
  let depth = 0;
  let i = openIndex;
  let out = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === open) {
      depth++;
      if (depth === 1) {
        i++;
        continue;
      }
    }
    if (ch === close) {
      depth--;
      if (depth === 0) return out;
    }
    out += ch;
    i++;
  }
  return out;
}

const callArgs = (text, openParen) => balanced(text, openParen, "(", ")");

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

/**
 * `const run = promisify(execFile)` 之后调用变成 `run(...)`，只认 import 名单会整片漏掉
 * （bridge/src 的 git / gitops / artifacts / whatsnew 都是这个写法）。
 */
function promisifyAliases(text, names, spaces) {
  const aliases = new Map();
  const re = /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+[ \t]*\.[ \t]*)?promisify\(\s*(?:(?:[\w$]+[ \t]*\.[ \t]*)?([\w$]+)[ \t]*\.[ \t]*)?(exec|execFile|spawn|execSync)\s*\)/g;
  for (const m of text.matchAll(re)) {
    const [, local, ns, api] = m;
    if (ns ? spaces.has(ns) : names.has(api)) aliases.set(local, api);
  }
  return aliases;
}

/** `const opts = { … }` 这类 options 常量：调用时只传个名字，得回文件里看那个对象。 */
function objectLiterals(text) {
  const objects = new Map();
  for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=[ \t]*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    objects.set(m[1], balanced(text, open, "{", "}"));
  }
  return objects;
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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * windowsHide 判定：inline、引用的 options 常量两种都算。返回 null 表示没问题，否则一句话说清哪不对。
 * 名字回找是同文件级的启发式：同名变量后写覆盖先写，局部形参也会被算进去 —— 真撞名时把 options 写成 inline。
 */
function windowsHideProblem(args, objects) {
  const direct = /windowsHide\s*:\s*(true|false)/.exec(args);
  if (direct) return direct[1] === "true" ? null : "显式写了 windowsHide: false";
  for (const [name, body] of objects) {
    if (!new RegExp(`\\b${escapeRe(name)}\\b`).test(args)) continue;
    const found = /windowsHide\s*:\s*(true|false)/.exec(body);
    if (!found) continue;
    return found[1] === "true" ? null : `传的 ${name} 里写了 windowsHide: false`;
  }
  return "没有 windowsHide";
}

/** 扫一个文件，把问题塞进 problems；返回「这个文件引用了 child_process 吗」。 */
function scanFile(file, problems) {
  const raw = fs.readFileSync(file, "utf8");
  const { names, spaces } = childProcessNames(raw);
  if (!names.size && !spaces.size) return false;
  const aliases = promisifyAliases(raw, names, spaces);
  const objects = objectLiterals(raw);
  const masked = mask(raw);
  const lines = raw.split("\n");
  const callees = [...API.split("|"), ...aliases.keys()].map(escapeRe).join("|");
  // 限定符只能贴在同一行（`cp.spawn`）：用 \s* 会让上一行结尾的 `once.` 被吃成限定符，
  // 于是紧随其后的 `spawn(` 被当成「不是 child_process 的调用」漏掉（terminal.ts:286 踩过）。
  const re = new RegExp(`(?:([\\w$]+)[ \\t]*\\.[ \\t]*)?\\b(${callees})\\b[ \\t]*\\(`, "g");
  for (const m of masked.matchAll(re)) {
    const qualifier = m[1] ?? null;
    const callee = m[2];
    const viaAlias = aliases.has(callee);
    if (qualifier ? !spaces.has(qualifier) : !viaAlias && !names.has(callee)) continue;
    const start = m.index ?? 0;
    if (/\bfunction\s*\*?\s*$/.test(masked.slice(Math.max(0, start - 40), start))) continue; // 定义处
    const problem = windowsHideProblem(callArgs(masked, start + m[0].length - 1), objects);
    if (!problem) continue;
    const line = lineOf(raw, start);
    if (marked(lines, line)) continue;
    problems.push({ file: path.relative(ROOT, file).replaceAll("\\", "/"), line, callee, problem });
  }
  return true;
}

/** 扫给定路径，返回 { problems, scanned, missing }。 */
function check(scope) {
  const problems = [];
  const missing = [];
  let scanned = 0;
  for (const entry of scope) {
    const abs = path.isAbsolute(entry) ? entry : path.join(ROOT, entry);
    if (!fs.existsSync(abs)) {
      missing.push(entry);
      continue;
    }
    for (const file of walk(abs)) if (scanFile(file, problems)) scanned++;
  }
  return { problems, scanned, missing };
}

/** 自测：反例必须红，正例 / 放行标记 / options 常量必须绿，promisify 别名必须被抓到。 */
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-hidden-"));
  const write = (name, body) => fs.writeFileSync(path.join(dir, name), body);
  write("bad.mjs", 'import { spawn } from "node:child_process";\nspawn("git", ["status"], { stdio: "ignore" });\n');
  write("bad-false.mjs", 'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["status"], { windowsHide: false });\n');
  write("good.mjs", 'import { spawn } from "node:child_process";\nspawn("git", ["status"], { stdio: "ignore",\n  windowsHide: true });\n');
  write("marked.mjs", 'import { execFileSync } from "node:child_process";\n// spawn-visible-ok: 自测用的例外\nexecFileSync("explorer", ["."]);\n');
  write(
    "alias.mjs",
    'import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\nrun("git", ["status"]);\n',
  );
  write(
    "opts.mjs",
    'import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\nconst opts = { timeout: 3000,\n  windowsHide: true };\nrun("git", ["status"], opts);\n',
  );
  write(
    "opts-bad.mjs",
    'import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\nconst opts = { windowsHide: false };\nrun("git", ["status"], opts);\n',
  );
  write("regex.mjs", 'const re = /a/;\nconst m = re.exec("a");\n');
  const { problems, scanned } = check([dir]);
  const hits = new Set(problems.map((p) => path.basename(p.file)));
  const failures = [];
  for (const name of ["bad.mjs", "bad-false.mjs", "alias.mjs", "opts-bad.mjs"]) {
    if (!hits.has(name)) failures.push(`反例 ${name} 没被抓到`);
  }
  for (const name of ["good.mjs", "marked.mjs", "opts.mjs", "regex.mjs"]) {
    if (hits.has(name)) failures.push(`正例 ${name} 被误报`);
  }
  if (scanned < 7) failures.push(`只扫到 ${scanned} 个文件（应 ≥ 7）`);
  // 两道防「静默变绿」机关也必须被这条自测盯住：范围写错 / 目录改名时要红，不是绿。
  const missing = check([path.join(dir, "no-such-dir")]).missing;
  if (missing.length !== 1) failures.push("路径不存在时没有报 missing（守卫会静默放过那片目录）");
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures.length) {
    console.error(`check-spawn-hidden --self-test 失败：\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("check-spawn-hidden --self-test: 反例 4 条全红，正例 / 放行 / options 常量 / 正则 4 条全绿。");
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  selfTest();
} else {
  const paths = argv.filter((a) => !a.startsWith("--"));
  const scope = paths.length ? paths : DEFAULT_SCOPE;
  const { problems, scanned, missing } = check(scope);
  if (missing.length) {
    console.error(`check-spawn-hidden: 这些路径不存在，守卫会静默放过它们：${missing.join("、")}`);
    process.exit(1);
  }
  if (!paths.length && scanned < MIN_FILES) {
    console.error(`check-spawn-hidden: 只扫到 ${scanned} 个引用 child_process 的文件（应当 ≥ ${MIN_FILES}）；范围被改坏了？`);
    process.exit(1);
  }
  if (problems.length) {
    console.error(`有 ${problems.length} 处子进程调用会在 bridge / 技能里弹出可见控制台窗口（见 D387）：\n`);
    for (const p of problems) console.error(`  ${p.file}:${p.line}  ${p.callee}()  ${p.problem}`);
    console.error(
      "\n修法：参数里加 `windowsHide: true`（或让它引用的 options 常量里有）；确实要可见窗口的" +
        "（打开文件管理器之类），在调用那一行或上面两行写 `spawn-visible-ok: <这是功能本身，为什么>` 。",
    );
    process.exit(1);
  }
  console.log(`check-spawn-hidden: ${scanned} 个文件里所有 child_process 调用都带了 windowsHide（或已标注放行）。`);
}
