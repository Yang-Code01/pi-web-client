/**
 * 「发到会话复盘」这一路上前端的两个纯函数（D164 延伸）：
 *
 * 1. `reviewClasses` —— 把这一轮失败归成「几类」，按次数降序。归错了，发到会话的那段
 *    账本视角就是错的，模型会照着错误的类去写规矩。
 * 2. `parseRules` —— 从模型回答里捡回它写的规矩。模型不会乖乖只写一行 plain text：
 *    它会加列表符号、塞进代码块、在中间夹解释。捡漏一条，那一类下次还得重蹈。
 *
 *   node --experimental-transform-types web/tests/rules-unit.mjs
 */
import assert from "node:assert/strict";
import { parseRules, ruleFor, ruleLine, ruleParts, RULE_MARK } from "../src/rules.ts";
import { reviewBody, reviewClasses, REVIEW_MARK } from "../src/failures.ts";

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

// ---------------------------------------------------------------- 归成几类

const fail = (tool, cmd, at = "2026-11-07T12:00:00Z", out = "") => ({ callId: `${tool}-${cmd}-${at}`, tool, cmd, out, at });

check("同一条命令重犯 3 次 → 1 类、3 次", () => {
  const list = [
    fail("bash", "cd F:/pi-web-clinet", "2026-11-07T12:00:00Z", "bash: cd: F:/pi-web-clinet: No such file or directory"),
    fail("bash", "cd F:/pi-web-clinet", "2026-11-07T12:05:00Z", "bash: cd: F:/pi-web-clinet: No such file or directory"),
    fail("bash", "cd F:/pi-web-clinet", "2026-11-07T12:09:00Z", "bash: cd: F:/pi-web-clinet: No such file or directory"),
  ];
  const classes = reviewClasses(list);
  assert.equal(classes.length, 1);
  assert.equal(classes[0].n, 3);
  assert.equal(classes[0].tool, "bash");
  assert.equal(classes[0].sig, "cd <path>");
});

check("参数不同的同一种错算一类，别按字面拆", () => {
  const list = [
    fail("bash", "cd F:/a", "2026-11-07T12:00:00Z", "bash: cd: F:/a: No such file or directory"),
    fail("bash", "cd F:/b", "2026-11-07T12:01:00Z", "bash: cd: F:/b: No such file or directory"),
  ];
  assert.equal(reviewClasses(list).length, 1);
});

check("按次数降序：最该被复盘的那类排第一", () => {
  const list = [
    fail("bash", "grep -n x web/src/style.css", "2026-11-07T12:00:00Z", "grep: web/src/style.css: No such file or directory"),
    fail("bash", "cd F:/pi-web-clinet", "2026-11-07T12:00:00Z", "bash: cd: F:/pi-web-clinet: No such file or directory"),
    fail("bash", "cd F:/pi-web-clinet", "2026-11-07T12:02:00Z", "bash: cd: F:/pi-web-clinet: No such file or directory"),
  ];
  const classes = reviewClasses(list);
  assert.equal(classes[0].sig, "cd <path>");
  assert.equal(classes[0].n, 2);
});

check("成功后不再失败的调用不该混进来（入参只收失败）", () => {
  assert.deepEqual(reviewClasses([]), []);
});

check("reviewBody 只认首行的标记，正文原样交出", () => {
  const text = `${REVIEW_MARK} 你这一轮栽了 5 次，归成 3 类。\n\n1. …`;
  assert.equal(reviewBody(text), "你这一轮栽了 5 次，归成 3 类。\n\n1. …");
  assert.equal(reviewBody("普通的一句话"), null);
  assert.equal(reviewBody("你这一轮栽了 5 次 " + REVIEW_MARK), null);
});

// ---------------------------------------------------------------- 捡回规矩

check("裸行：标记 + 键 + :: + 一句话", () => {
  const out = parseRules(`${RULE_MARK} bash|path|cd <path> :: 先 test -d 再 cd，别靠猜`);
  assert.deepEqual(out, [{ key: "bash|path|cd <path>", rule: "先 test -d 再 cd，别靠猜" }]);
});

check("包在列表项、引用、粗体、代码里都认得", () => {
  const text = [
    "- [pi-web:rule] bash|path|cd <path> :: 先 test -d 再 cd",
    "> [pi-web:rule] bash|nocmd|tail <file> :: 读日志前先 ls 一遍",
    "**" + "[pi-web:rule] bash|path|grep <path> :: 缩小范围或加超时**",
    "```",
    "[pi-web:rule] bash|path|npm <dir> :: 别手打仓库路径",
    "```",
  ].join("\n");
  const out = parseRules(text);
  assert.equal(out.length, 4);
  assert.equal(out[2].rule, "缩小范围或加超时");
});

check("夹解释的回答里只捡带标记的行，别的句子不进账", () => {
  const text = [
    `## 这一轮怎么栽的`,
    `先说结论：${"路径拼错"}是主因。`,
    `${RULE_MARK} bash|path|cd <path> :: 先 test -d 再 cd`,
    `这句解释不该被当成规矩。`,
  ].join("\n");
  const out = parseRules(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "bash|path|cd <path>");
});

check("提示词里的格式示例不会变成真规矩", () => {
  const text = [
    `[pi-web:rule] <键> :: <一句规矩，不超过 70 字>`,
    `[pi-web:rule] 键 :: 做法`,
  ].join("\n");
  assert.deepEqual(parseRules(text), []);
});

check("同一个键只留第一条；后写的覆盖由桥端做，前端不重复发", () => {
  const text = [
    `${RULE_MARK} bash|path|cd <path> :: 第一条`,
    `${RULE_MARK} bash|path|cd <path> :: 第二条`,
  ].join("\n");
  assert.equal(parseRules(text).length, 1);
  assert.equal(parseRules(text)[0].rule, "第一条");
});

check("没有 :: 的行跳过（模型偶尔会写成空格分隔）", () => {
  assert.deepEqual(parseRules(`${RULE_MARK} bash|path|cd <path> 先 test -d 再 cd`), []);
});

check("太长的一句话截断，别把整段解释塞进账本", () => {
  const out = parseRules(`${RULE_MARK} bash|path|cd <path> :: ${"啊".repeat(180)}`);
  assert.equal(out[0].rule.length, 100);
});

check("多行里夹空行、首尾空白都收得干净", () => {
  const out = parseRules(`\n\n   ${RULE_MARK}   bash|path|cd <path>   ::   先 test -d 再 cd   \n\n`);
  assert.deepEqual(out, [{ key: "bash|path|cd <path>", rule: "先 test -d 再 cd" }]);
});

check("键拆成三段：界面靠它认「挂在哪一类」", () => {
  assert.deepEqual(ruleParts("bash|path|cd <path>"), { tool: "bash", code: "path", sig: "cd <path>" });
});

check("ruleLine 与桥端带进提示词的形状一致", () => {
  const r = { key: "bash|path|cd <path>", tool: "bash", code: "path", sig: "cd <path>", rule: "先 test -d 再 cd", at: "2026-11-07T00:00:00Z" };
  assert.equal(ruleLine(r), "bash · cd <path> —— 先 test -d 再 cd");
});

check("ruleFor 按键取，找不到回 null", () => {
  const book = { version: 1, ws: "w", reviewed: {}, rules: [{ key: "a|b|c", tool: "a", code: "b", sig: "c", rule: "r", at: "2026-11-07T00:00:00Z" }] };
  assert.equal(ruleFor(book, "a|b|c").rule, "r");
  assert.equal(ruleFor(book, "x|y|z"), null);
  assert.equal(ruleFor(null, "a|b|c"), null);
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
