#!/usr/bin/env node
/**
 * D110 门禁：界面文案不许绕过 `tr()`。
 *
 * 三件事：
 *   1. `web/src/**` 里出现中文、却**没**包进 `tr(...)` 的字符串 —— 换语言时会漏成中文。
 *   2. zh（代码里的 tr 键）与 `en.ts` / `ja.ts` 的键集合必须完全一致。
 *   3. 词典里不许有空串。
 *
 * 用法：
 *   node i18n-check.mjs           检查，发现问题 exit 1
 *   node i18n-check.mjs --keys    只打印键清单（翻译时用来对齐）
 *   node i18n-check.mjs --json    打印键清单为 JSON
 *
 * 为什么用 TS 编译器而不是正则：要判断「这个字面量是不是 tr() 的第一个参数」「是不是
 * `=== "已复制"` 这种比较」「是不是 el() 的 class 参数」，正则分不清，误报会多到没人看。
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SRC = path.join(here, "src");
const DICT = path.join(SRC, "i18n");

const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\uff00-\uffef]/;
const args = new Set(process.argv.slice(2));

/** 判断调用名：`tr(...)`、`foo.tr(...)` 都算。 */
function calleeName(node) {
  if (!ts.isCallExpression(node)) return "";
  const c = node.expression;
  return ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
}

/** 是不是 `LANGS` 那张表里的语言自称。 */
function inLangNames(node) {
  for (let n = node; n; n = n.parent) {
    if (ts.isVariableDeclaration(n)) return ts.isIdentifier(n.name) && n.name.text === "LANGS";
    if (ts.isStringLiteral(n) || ts.isArrayLiteralExpression(n)) continue;
    return false;
  }
  return false;
}

/** 挂在模块级 `const X = [...]` / `const X = {...}` 上的字面量（标签表）。 */
function inModuleConst(node) {
  for (let n = node; n; n = n.parent) {
    if (ts.isStringLiteral(n) || ts.isArrayLiteralExpression(n)) continue;
    if (ts.isVariableDeclaration(n)) {
      return Boolean(n.parent?.parent?.parent && ts.isSourceFile(n.parent.parent.parent));
    }
    if (ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n) || ts.isPropertyAssignment(n)) continue;
    if (ts.isVariableDeclarationList(n)) continue;
    return false;
  }
  return false;
}

/** 这个字面量是不是 `tr("…")` 的键（第一个参数）。 */
function isTrKey(node) {
  const parent = node.parent;
  return parent && ts.isCallExpression(parent) && calleeName(parent) === "tr" && parent.arguments[0] === node;
}

/** 往上找最近的调用，判断它是不是「拿中文当逻辑用」的那种（比较、includes、split…）。 */
function inLogicCall(node) {
  const LOGIC = new Set([
    "includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "split", "replace", "replaceAll",
    "match", "search", "test", "exec", "has", "get", "set", "removeItem", "getItem", "setItem",
  ]);
  for (let n = node; n; n = n.parent) {
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) return true;
    }
    if (ts.isCaseClause(n)) return true;
    if (ts.isImportDeclaration(n)) return true;
    if (ts.isPropertyAssignment(n) && n.name === node) return true; // 对象键
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (LOGIC.has(name) && n.arguments.includes(node)) return true;
      // el("div", "some-class", …)：第二个参数是样式类
      if (name === "el" && n.arguments[1] === node) return true;
      // console.* / new Error 里保留中文（日志给开发看）
      const expr = n.expression;
      if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && ["console", "Error"].includes(expr.expression.text)) return true;
    }
    if (ts.isNewExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e) && e.text === "Error") return true;
    }
    // 模块级 const 数组里的标签表（SIZES / TEXT_STEPS / ACCENT_LABELS）：值的语言在**使用处**
    // 由 tr(label) 决定，所以这里不算「漏翻」，但要算进键集合（否则词典里会多出一堆废键）。
    if (ts.isArrayLiteralExpression(n) && inModuleConst(n)) return false;
    if (ts.isSourceFile(n)) return false;
  }
  return false;
}

function walk(file, out) {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text;
      if (CJK.test(text)) {
        if (isTrKey(node)) {
          out.keys.add(text);
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          if (!out.context.has(text)) out.context.set(text, { file: path.relative(here, file), line, src: src.split("\n")[line - 1].trim().slice(0, 200) });
        } else if (inLangNames(node)) {
          // LANGS 的标签是各自语言的原生写法（简体中文 / English / 日本語），永远不翻译。
        } else if (inModuleConst(node)) {
          // 模块级标签表（SIZES / TEXT_STEPS / ACCENT_LABELS）：值的语言在使用处由 tr(label) 决定，
          // 所以这里既不算漏翻，也要算成键（否则词典里会多出「代码里没有」的废键）。
          out.keys.add(text);
        } else if (!inLogicCall(node)) out.bare.push({ file: path.relative(here, file), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, start: node.getStart(sf), end: node.getEnd(), text });
      }
    } else if (ts.isTemplateExpression(node) && CJK.test(node.getText(sf))) {
      // 模板串：整段算一个键（占位符由 codemod 换成 {p1}…，位置对应 templateSpans 顺序）。
      // 没走 tr() 的模板串同样要报：只查普通字面量的话，`${count} 条待处理` 这种会漏掉。
      if (!isTrKey(node) && !inLogicCall(node)) {
        out.bare.push({ file: path.relative(here, file), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, start: node.getStart(sf), end: node.getEnd(), text: node.getText(sf).replace(/\s+/g, " ").slice(0, 60) });
      }
      if (isTrKey(node)) {
        const key = node.head.text + node.templateSpans.map((s, i) => `{p${i + 1}}` + s.literal.text).join("");
        out.keys.add(key);
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (!out.context.has(key)) out.context.set(key, { file: path.relative(here, file), line, src: src.split("\n")[line - 1].trim().slice(0, 200) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** 读 en.ts / ja.ts 的键：它们都是 `export const en: Dict = { "键": "值", … }`。 */
function dictKeys(lang) {
  const file = path.join(DICT, `${lang}.ts`);
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const keys = new Map();
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isStringLiteral(node.name) || ts.isIdentifier(node.name) ? node.name.text : null;
      if (name) keys.set(name, node.initializer.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

const out = { keys: new Set(), bare: [], context: new Map() };
for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (entry.isDirectory()) continue;
  if (!/\.tsx?$/.test(entry.name)) continue;
  walk(path.join(SRC, entry.name), out);
}
// i18n 自己的兜底文案（errText 的「出错了」、fmtRelative 的「刚刚」）也是键，别当成多余键。
// en.ts / ja.ts 是词典，不扫。
walk(path.join(DICT, "index.ts"), out);

// 后端错误码走 `bridge.err.<code>`，键是拼出来的，不在代码里出现。
const zhKeys = [...out.keys].filter((k) => !k.startsWith("bridge.err.")).sort();

if (args.has("--context")) {
  // 翻译用：每行 `键 <TAB> 位置 <TAB> 源码片段`，方便判断这句话在界面上长什么样。
  for (const k of zhKeys) {
    const c = out.context.get(k);
    // 键里的换行/制表符会打乱 TSV 的行结构，转义后再输出（翻译时原样写回）。
    const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
    console.log([esc(k), c ? `${c.file}:${c.line}` : "", esc(c?.src ?? "")].join("\t"));
  }
  console.error(`\n${zhKeys.length} keys`);
  process.exit(0);
}
if (args.has("--templates")) {
  // 模板串（`${count} 条待处理`）没法自动包，只能人看：单独列出来，位置 + 原文。
  for (const b of out.bare) {
    if (!b.text.startsWith("`")) continue;
    console.log(`${b.file}:${b.line}	${b.text}`);
  }
  process.exit(0);
}
if (args.has("--json")) {
  console.log(JSON.stringify({ keys: zhKeys, bare: out.bare, en: [...dictKeys("en").keys()], ja: [...dictKeys("ja").keys()] }, null, 2));
  process.exit(0);
}
if (args.has("--keys")) {
  for (const k of zhKeys) console.log(k);
  console.error(`\n${zhKeys.length} keys`);
  process.exit(0);
}

let bad = 0;
const en = dictKeys("en");
const ja = dictKeys("ja");
const problems = [];

for (const { file, line, text } of out.bare) problems.push(`${file}:${line}  中文没走 tr(): ${JSON.stringify(text.slice(0, 60))}`);

for (const k of zhKeys) {
  // `tr()` 把 `|` 当「上下文后缀」的分隔符（`"保存|按钮"`）：键里自带的 `|` 一旦缺译文，
  // 兜底句会被截断（md.ts 的 NAME 正则就这么烂过一次），所以缺键时单独提示。
  if (k.includes("|") && !en.has(k) && !ja.has(k)) problems.push(`键里有 | 会被 tr() 截断: ${JSON.stringify(k)}`);
  if (!en.has(k)) problems.push(`en.ts 缺键: ${JSON.stringify(k)}`);
  if (!ja.has(k)) problems.push(`ja.ts 缺键: ${JSON.stringify(k)}`);
  for (const [lang, dict] of [["en", en], ["ja", ja]]) {
    const v = dict.get(k);
    if (v !== undefined && /^""$/.test(v)) problems.push(`${lang}.ts 空串: ${JSON.stringify(k)}`);
  }
}
for (const [lang, dict] of [["en", en], ["ja", ja]]) {
  for (const k of dict.keys()) {
    if (!zhKeys.includes(k) && !k.startsWith("bridge.err.")) problems.push(`${lang}.ts 多余的键（代码里没有）: ${JSON.stringify(k)}`);
  }
}

if (problems.length) {
  console.error(`i18n-check: ${problems.length} 个问题\n`);
  for (const p of problems.slice(0, 80)) console.error("  " + p);
  if (problems.length > 80) console.error(`  … 还有 ${problems.length - 80} 条`);
  bad = 1;
} else {
  console.log(`i18n-check: ok — ${zhKeys.length} keys × 3 langs`);
}
process.exit(bad);
