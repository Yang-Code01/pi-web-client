/**
 * #384 Context 面板 · A 段：companion 扩展本体（bridge/ext/context-log.ts）。
 *
 * 直接 import + 伪 pi API 驱动：session_start 换文件、context_with_system 分类记账、
 * 落盘 JSONL 的形状（seq 递增、六类合计、perMessage）。桥侧转发（ctxlog WS 消息）由
 * sessions 的 e2e 缝把关，这里只管扩展自己的行为。
 *
 *   node --experimental-transform-types bridge/tests/context-log-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-log-"));
const logDir = path.join(tmp, "ctxlog");
const extFile = path.join(tmp, "context-log.ts");
fs.writeFileSync(extFile, fs.readFileSync(path.join(REPO, "bridge", "ext", "context-log.ts"), "utf8").replace('"__LOG_DIR__"', JSON.stringify(logDir)));

const { default: contextLog } = await import(pathToFileURL(extFile).href);

const load = () => {
  const handlers = {};
  contextLog({ on: (ev, fn) => (handlers[ev] = fn) });
  return handlers;
};

const ctx = (id) => ({
  cwd: tmp,
  sessionManager: { getSessionId: () => id },
});

/** 伪一条 LLM 请求的消息列表（形状对齐 pi 的 TranscriptMessage）。 */
const msgs = (arr) => arr;

test("session_start 建目录、session_shutdown 收摊（再调用不写）", async () => {
  const h = load();
  await h.session_start({ reason: "startup" }, ctx("abc123"));
  const dir = path.join(logDir, "abc123");
  assert.ok(fs.existsSync(dir), "会话目录按 id 前缀落位");
  const f = path.join(dir, "abc123.ctx.jsonl");
  await h.context_with_system({ messages: msgs([{ role: "user", content: "hello world 1234" }]) }, ctx("abc123"));
  assert.ok(fs.existsSync(f), "首次 LLM 调用后日志文件出现");
  const n1 = fs.readFileSync(f, "utf8").trim().split("\n").length;
  assert.equal(n1, 1, "一次 LLM 调用写一行");
  await h.session_shutdown?.({}, ctx("abc123"));
  await h.context_with_system({ messages: msgs([{ role: "user", content: "after shutdown" }]) }, ctx("abc123"));
  const n2 = fs.readFileSync(f, "utf8").trim().split("\n").length;
  assert.equal(n2, 1, "shutdown 后不再写");
});

test("六类分类：system→sys、user→user、assistant→asst、toolResult→toolr、块数组也吃", async () => {
  const h = load();
  await h.session_start({ reason: "startup" }, ctx("cat123"));
  await h.context_with_system(
    {
      messages: msgs([
        { role: "system", content: [{ type: "text", text: "你是 pi".repeat(20) }] },
        { role: "user", content: "读一下 README" },
        { role: "assistant", content: [{ type: "text", text: "好的，这就去" }, { type: "toolCall", toolCallId: "t1", tool: "read", args: {} }] },
        { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "x".repeat(400) }] },
      ]),
    },
    ctx("cat123"),
  );
  const f = path.join(logDir, "cat123", "cat123.ctx.jsonl");
  const rows = fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.v, 1);
  assert.equal(r.seq, 1);
  assert.ok(r.ts > 0);
  assert.ok(r.cats.sys > 0, "system 记进 sys");
  assert.ok(r.cats.user > 0, "user 记进 user");
  assert.ok(r.cats.asst > 0, "assistant 记进 asst");
  assert.ok(r.cats.toolr > 0, "toolResult 记进 toolr");
  assert.equal(r.cats.tools, 0, "这条没有工具声明");
  assert.equal(r.cats.inject, 0, "没有注入");
  assert.equal(r.messages, 4, "perMessage 计数");
  assert.ok(Array.isArray(r.perMessage) && r.perMessage.length === 4);
  assert.equal(typeof r.total, "number");
  assert.ok(r.total >= r.cats.sys + r.cats.user + r.cats.asst + r.cats.toolr, "total 是六类合计（含零类）");
});

test("seq 跨请求递增；换会话归零、文件分开", async () => {
  const h = load();
  await h.session_start({ reason: "new" }, ctx("seq111"));
  await h.context_with_system({ messages: msgs([{ role: "user", content: "q1" }]) }, ctx("seq111"));
  await h.context_with_system({ messages: msgs([{ role: "user", content: "q2" }]) }, ctx("seq111"));
  await h.session_start({ reason: "new" }, ctx("seq222"));
  await h.context_with_system({ messages: msgs([{ role: "user", content: "q1" }]) }, ctx("seq222"));
  const a = fs.readFileSync(path.join(logDir, "seq111", "seq111.ctx.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const b = fs.readFileSync(path.join(logDir, "seq222", "seq222.ctx.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(a.map((r) => r.seq), [1, 2]);
  assert.deepEqual(b.map((r) => r.seq), [1], "新会话重新从 1 开始");
});

test("CJK 与 ASCII 的估算权重不同（中文 ÷1.5、英文 ÷4）", async () => {
  const h = load();
  await h.session_start({ reason: "new" }, ctx("est111"));
  await h.context_with_system({ messages: msgs([{ role: "user", content: "你好世界" }]) }, ctx("est111"));
  await h.context_with_system({ messages: msgs([{ role: "user", content: "abcdefgh" }]) }, ctx("est111"));
  const rows = fs.readFileSync(path.join(logDir, "est111", "est111.ctx.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows[0].cats.user, Math.ceil(4 / 1.5), "4 个汉字 ÷1.5");
  assert.equal(rows[1].cats.user, Math.ceil(8 / 4), "8 个字母 ÷4");
});
