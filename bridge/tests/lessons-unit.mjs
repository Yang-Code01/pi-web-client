/**
 * 「这个工作区的老毛病」——账本压成几行系统提示词，以及当场叫住模型的那句话。
 *
 * 这层的价值全在「收哪些、不收哪些」：把偶发失败、已修、已忽略的也塞进去，就是在教模型
 * 疑神疑鬼；少收一条，同一类坑就还得再踩一次。
 *
 *   node --experimental-transform-types bridge/tests/lessons-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allowRemind, lessonFile, lessonLine, lessonText, reminderText, resetReminders, ripeForLesson } from "../src/lessons.ts";
import { mergeFailures } from "../src/failures.ts";

process.env.PI_WEB_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-lessons-"));

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

const entry = (over = {}) => ({
  key: `k${Math.random().toString(36).slice(2)}`,
  tool: "bash",
  code: "path",
  sig: "cd <path>",
  count: 5,
  first: "2026-11-01T00:00:00Z",
  last: "2026-11-07T00:00:00Z",
  why: "",
  fix: "",
  fixedAt: null,
  ignoredAt: null,
  occ: [],
  ...over,
});
const ledger = (...entries) => ({ version: 1, ws: "w", label: "repo", entries, sessions: {} });

check("空账本不产生任何注入", () => {
  assert.equal(lessonText(ledger()), "");
  assert.deepEqual(ripeForLesson(ledger()), []);
});

check("只收反复、未修、未忽略、非中断的类", () => {
  const l = ledger(
    entry({ key: "hot", count: 7 }),
    entry({ key: "rare", count: 2 }),
    entry({ key: "fixed", count: 9, fixedAt: "x" }),
    entry({ key: "gone", count: 9, ignoredAt: "x" }),
    entry({ key: "abort", count: 9, code: "abort" }),
  );
  assert.deepEqual(ripeForLesson(l).map((e) => e.key), ["hot"]);
});

check("按次数降序，最多 6 行", () => {
  const l = ledger(...Array.from({ length: 9 }, (_, i) => entry({ key: `k${i}`, count: i + 3 })));
  const picked = ripeForLesson(l);
  assert.equal(picked.length, 6);
  assert.equal(picked[0].count, 11);
});

check("教训行带次数、形状和这一类该怎么绕开", () => {
  const line = lessonLine(entry({ count: 4, sig: "cd <path>" }));
  assert.match(line, /^- 4 次 · bash · cd <path> —— /);
  assert.match(line, /mkdir -p/); // path 类的通用改法
});

check("没有通用改法时退回账本里的修法或诊断", () => {
  const line = lessonLine(entry({ code: "exit", fix: "先看 Traceback 最后三行" }));
  assert.match(line, /Traceback/);
});

check("整段有抬头、有上限，不会变成第二个日志", () => {
  const text = lessonText(ledger(...Array.from({ length: 6 }, (_, i) => entry({ key: `k${i}`, count: 9, sig: "x".repeat(400) }))));
  assert.match(text, /^## 这个工作区过去反复踩的坑/);
  assert.ok(text.length <= 1200, `太长：${text.length}`);
  assert.ok(text.split("\n").length <= 8);
});

check("落到磁盘：有老毛病才写文件，文件内容就是注入的那段", () => {
  const ws = "F:/pi-web-lessons-test";
  assert.equal(lessonFile(ws), null); // 还没入账，不写
  const item = (at) => ({ key: "k1", at, tool: "bash", code: "path", sig: "cd <path>", exit: 1, cmd: "cd /nope", out: "bash: cd: /nope: No such file or directory", why: "目录不存在", fix: "" });
  mergeFailures({ ws, sid: "s1", sname: "会话", at: "2026-11-07T00:00:00Z", items: [item("2026-11-01T00:00:00Z"), item("2026-11-03T00:00:00Z"), item("2026-11-05T00:00:00Z")] });
  const file = lessonFile(ws);
  assert.ok(file && file.includes("lessons"), String(file));
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /3 次 · bash · cd <path>/);
  assert.match(text, /mkdir -p/);
});

check("提醒文案：自称自动、带上次诊断、叫它换做法", () => {
  const text = reminderText({ tool: "bash", sig: "cd <path>", why: "目录不存在", n: 9 });
  assert.match(text, /^\[自动提醒 · 老毛病重犯\]/);
  assert.match(text, /已出现 9 次/);
  assert.match(text, /目录不存在/);
  assert.match(text, /别重复同样的尝试/);
});

check("提醒文案：什么都没有时返回空串（宁可不叫）", () => {
  assert.equal(reminderText({}), "");
  assert.equal(reminderText({ tool: "  " }), "");
});

check("节流：同一类只叫一次，一个会话最多 3 次", () => {
  resetReminders();
  assert.equal(allowRemind("s1", "a"), true);
  assert.equal(allowRemind("s1", "a"), false);
  assert.equal(allowRemind("s1", "b"), true);
  assert.equal(allowRemind("s1", "c"), true);
  assert.equal(allowRemind("s1", "d"), false);
  assert.equal(allowRemind("s2", "a"), true); // 换会话重新算
  assert.equal(allowRemind("", "a"), false);
});

console.log(failures ? `\n${failures} 条失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
