/**
 * 「⚡ AI 出错记录」的去重与分类（D164）。这一层的价值全在「同一类只加次数」——
 * 归并键错了，账本会从 4 类膨胀成 40 类，功能就退化成又一个日志列表。
 *
 * Run: node --experimental-transform-types web/tests/failures-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  entryKey,
  firstLine,
  normalizeSig,
  ripeEntries,
  entryState,
  failureMarkdown,
} from "../src/failures.ts";
import { exitCodeOf } from "../src/diagnose.ts";

// ---------------------------------------------------------------- 分类

test("cd 到不存在的目录 → path", () => {
  assert.equal(classify("bash", "bash: cd: F:/pi-web-client-wt/feat-setti: No such file or directory", 1), "path");
});

test("edit 目标不存在 → path", () => {
  assert.equal(classify("edit", "File not found: web/src/notseheet.ts", null), "path");
});

test("grep 没命中 → nocmd（半正常，不是坏）", () => {
  assert.equal(classify("bash", "bash: netstat: command not found", 127), "nocmd");
});

test("429 先于退出码认出来", () => {
  assert.equal(classify("model", "429 rate limit exceeded", 1), "rate");
});

test("上下文超限", () => {
  assert.equal(classify("model", "This model's maximum context length is 128000 tokens", null), "context");
});

test("普通 exit → exit，并解析出码", () => {
  const out = "npm ERR! something broke\n\nCommand exited with code 2";
  assert.equal(classify("bash", out, 2), "exit");
  assert.equal(exitCodeOf(out), 2);
});

test("被中断单独成一类（不算待修）", () => {
  assert.equal(classify("bash", "aborted by user", null), "abort");
});

test("认不出来 → other", () => {
  assert.equal(classify("mcp", "weird failure", null), "other");
});

// ---------------------------------------------------------------- 归并形状

test("路径不同、命令相同 → 同一把钥匙", () => {
  const a = normalizeSig("cd F:/pi-web-client-wt/feat-setti && git status", "bash");
  const b = normalizeSig("cd ../pi-web-client-wt/feat-settings && git status", "bash");
  assert.equal(a, b);
  assert.equal(entryKey("bash", "path", a), entryKey("bash", "path", b));
});

test("数字不同也算同一类（监听端口、退出码不该分裂）", () => {
  assert.equal(normalizeSig("netstat -ano | grep :7864", "bash"), normalizeSig("netstat -ano | grep :7888", "bash"));
});

test("管道只取最后一段：前面的过滤器不改结论", () => {
  const s = normalizeSig("git log --oneline | head -20", "bash");
  assert.ok(s.startsWith("head"));
});

test("不同工具、不同分类 → 不同钥匙", () => {
  assert.notEqual(entryKey("bash", "path", "x"), entryKey("edit", "path", "x"));
  assert.notEqual(entryKey("bash", "path", "x"), entryKey("bash", "exit", "x"));
});

// ---------------------------------------------------------------- 账本视图

const occ = (at) => ({ sid: "s1", name: "会话", at, cmd: "cd /nope", exit: 1, out: "bash: cd: /nope: No such file or directory" });
const entry = (over = {}) => ({
  key: "k1", tool: "bash", code: "path", sig: "cd <path>", count: 3,
  first: "2026-11-07T01:00:00Z", last: "2026-11-07T02:00:00Z",
  why: "", fix: "", occ: [occ("2026-11-07T02:00:00Z")], ...over,
});

test("待修 = 没标修复、没忽略、不是中断", () => {
  const ledger = {
    version: 1, ws: "w", label: "repo", sessions: {},
    entries: [entry(), entry({ key: "k2", fixedAt: "x" }), entry({ key: "k3", ignoredAt: "x" }), entry({ key: "k4", code: "abort" })],
  };
  assert.deepEqual(ripeEntries(ledger).map((e) => e.key), ["k1"]);
});

test("状态：忽略压过修复，再犯会复活修复（桥端清 fixedAt）", () => {
  assert.equal(entryState(entry()), "open");
  assert.equal(entryState(entry({ fixedAt: "x" })), "fixed");
  assert.equal(entryState(entry({ ignoredAt: "x", fixedAt: "x" })), "ignored");
  assert.equal(entryState(entry({ code: "abort" })), "abort");
});

test("交接稿带次数、形状与最近发生的原文", () => {
  const md = failureMarkdown(entry({ why: "路径拼错" }), "pi-web-client");
  assert.match(md, /3 次/);
  assert.match(md, /路径拼错/);
  assert.match(md, /No such file or directory/);
  assert.match(md, /pi-web-client/);
});

test("首行取错误行，不吃 ANSI 与空行", () => {
  assert.equal(firstLine("\n\n\u001b[31mbash: cd: /x: No such file\u001b[0m\nmore"), "bash: cd: /x: No such file");
});
