/**
 * #384 Context 面板 · A 段：companion 扩展本体（bridge/ext/context-log.ts）。
 *
 * 直接 import + 伪 pi API 驱动：session_start 换文件、context_with_system 分类记账、
 * 显式事件（压缩 / 换模型）、工具活动（文件 / 命令）落盘，以及三类行共用一个 seq、
 * 跨会话归零、隐私脱敏。桥侧转发（ctxlog WS 消息）由 sessions 的 e2e 缝把关，这里只管
 * 扩展自己的行为。
 *
 *   node --experimental-transform-types --test bridge/tests/context-log-unit.mjs
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

const msgs = (arr) => arr;
const logFile = (id) => path.join(logDir, id, `${id}.ctx.jsonl`);
const rows = (id) => (fs.existsSync(logFile(id)) ? fs.readFileSync(logFile(id), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** 一次 LLM 请求；默认只带一条 user 消息。 */
const request = (h, id, messages = msgs([{ role: "user", content: "hello world 1234" }])) => h.context_with_system({ messages }, ctx(id));

test("session_start 建目录、写 request 行；shutdown 后不再写", async () => {
  const h = load();
  await h.session_start({ reason: "startup" }, ctx("abc123"));
  assert.ok(fs.existsSync(path.join(logDir, "abc123")), "会话目录按 id 前缀落位");
  await request(h, "abc123");
  const r = rows("abc123");
  assert.equal(r.length, 1, "一次 LLM 调用写一行");
  assert.equal(r[0].v, 1);
  assert.equal(r[0].seq, 1);
  assert.equal(r[0].kind, "request");
  assert.ok(r[0].ts > 0);
  assert.equal(typeof r[0].total, "number");
  assert.ok(r[0].cats.user > 0);
  await h.session_shutdown({}, ctx("abc123"));
  await request(h, "abc123", msgs([{ role: "user", content: "after shutdown" }]));
  assert.equal(rows("abc123").length, 1, "shutdown 后不再写");
});

test("六类分类：system / toolsAdded / user / assistant / toolResult / 块数组都吃", async () => {
  const h = load();
  await h.session_start({ reason: "startup" }, ctx("cat123"));
  await request(h, "cat123", msgs([
    { role: "system", content: [{ type: "text", text: "你是 pi".repeat(20) }], toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object" } }] },
    { role: "user", content: "读一下 README" },
    { role: "assistant", content: [{ type: "text", text: "好的，这就去" }, { type: "toolCall", toolCallId: "t1", tool: "read", args: {} }] },
    { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "x".repeat(400) }] },
  ]));
  const r = rows("cat123");
  assert.equal(r.length, 1);
  const x = r[0];
  assert.equal(x.kind, "request");
  assert.ok(x.cats.sys > 0, "system 记进 sys");
  assert.ok(x.cats.tools > 0, "toolsAdded 记进 tools");
  assert.ok(x.cats.user > 0, "user 记进 user");
  assert.ok(x.cats.asst > 0, "assistant 记进 asst");
  assert.ok(x.cats.toolr > 0, "toolResult 记进 toolr");
  assert.equal(x.cats.inject, 0, "没有注入");
  assert.equal(x.messages, 4, "perMessage 计数");
  assert.equal(x.perMessage.length, 4);
  assert.equal(x.total, x.cats.sys + x.cats.tools + x.cats.user + x.cats.inject + x.cats.asst + x.cats.toolr);
});

test("三类行共用一个 seq；换会话归零，pending 工具调用也清掉", async () => {
  const h = load();
  await h.session_start({ reason: "new" }, ctx("seq111"));
  await request(h, "seq111", msgs([{ role: "user", content: "q1" }])); // 1 request
  await h.session_compact({ compactionEntry: { tokensBefore: 100 }, reason: "manual", willRetry: false }); // 2 event
  await h.tool_execution_start({ toolCallId: "c1", toolName: "bash", args: { command: "npm install" } }, ctx("seq111"));
  await h.tool_execution_end({ toolCallId: "c1", isError: false, durationMs: 10, result: "ok" }, ctx("seq111")); // 3 activity
  await h.model_select({ model: { id: "b" }, previousModel: { id: "a" }, source: "set" }); // 4 event
  await h.tool_execution_start({ toolCallId: "c2", toolName: "read", args: { path: "a.ts" } }, ctx("seq111"));
  await h.tool_execution_end({ toolCallId: "c2", isError: false, result: { content: [] } }, ctx("seq111")); // 5 activity
  await request(h, "seq111", msgs([{ role: "user", content: "q2" }])); // 6 request
  await h.session_compact({ compactionEntry: { tokensBefore: 200 }, reason: "threshold", willRetry: false }); // 7 event, atSeq=6

  const a = rows("seq111");
  assert.deepEqual(a.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(a.map((r) => r.kind), ["request", "event", "activity", "event", "activity", "request", "event"]);
  assert.equal(a[1].atSeq, 1, "压缩事件挂在第一次请求之后");
  assert.equal(a[3].atSeq, 1, "换模型事件也在同一位置");
  assert.equal(a[2].atSeq, 1, "活动行同样记住当时的 lastRequestSeq");
  assert.equal(a[6].atSeq, 6, "第二次请求之后的事件 atSeq 跟着更新");

  // 换会话：seq 归零，旧会话里没结束的工具调用不会串到新文件。
  await h.tool_execution_start({ toolCallId: "old", toolName: "bash", args: { command: "git status" } }, ctx("seq111"));
  await h.session_start({ reason: "new" }, ctx("seq222"));
  await h.tool_execution_end({ toolCallId: "old", isError: false, result: "ok" }, ctx("seq222"));
  assert.equal(rows("seq222").length, 0, "pending 被 session_start 清掉，旧调用不写进新会话");
  await request(h, "seq222", msgs([{ role: "user", content: "fresh" }]));
  const b = rows("seq222");
  assert.deepEqual(b.map((r) => r.seq), [1], "新会话重新从 1 开始");
  assert.equal(b[0].kind, "request");
});

test("显式事件：压缩带 tokensBefore、失败不落 error 正文、换模型只记 id", async () => {
  const h = load();
  await h.session_start({ reason: "new" }, ctx("evt111"));
  await request(h, "evt111");
  await h.session_compact({ compactionEntry: { tokensBefore: 12345, summary: "绝密摘要" }, reason: "threshold", willRetry: false });
  await h.session_compact_failed({ reason: "overflow", errorMessage: "boom", aborted: true, willRetry: false });
  await h.model_select({ model: { id: "b", name: "Big", provider: "x" }, previousModel: { id: "a", name: "Small" }, source: "set" });
  const r = rows("evt111");
  assert.equal(r.length, 4);
  assert.equal(r[1].event, "compact");
  assert.equal(r[1].before, 12345);
  assert.equal(r[1].reason, "threshold");
  assert.equal(r[1].atSeq, 1);
  assert.equal(r[1].willRetry, false);
  assert.ok(!JSON.stringify(r[1]).includes("绝密摘要"), "压缩摘要不落盘");
  assert.equal(r[2].event, "compact_failed");
  assert.equal(r[2].aborted, true);
  assert.ok(!JSON.stringify(r[2]).includes("boom"), "errorMessage 不落盘");
  assert.equal(r[3].event, "model");
  assert.equal(r[3].model, "b");
  assert.equal(r[3].previous, "a");
  assert.ok(!JSON.stringify(r[3]).includes("provider"), "整个 model 对象不落盘");
});

test("工具活动：命令只留程序名、文件只留路径与行数，正文 / 输出 / 参数都不落盘", async () => {
  const h = load();
  await h.session_start({ reason: "new" }, ctx("act111"));
  await request(h, "act111");

  // 命令：start 带完整 command，end 故意不带 toolName（fake-pi 的形状），也不落 result。
  await h.tool_execution_start({ toolCallId: "c1", toolName: "bash", args: { command: "SECRET_TOKEN=abc sudo npm install --verbose" } }, ctx("act111"));
  await h.tool_execution_end({ toolCallId: "c1", isError: false, durationMs: 12.6, result: "super secret output" }, ctx("act111"));
  const c = rows("act111")[1];
  assert.equal(c.kind, "activity");
  assert.equal(c.activity, "command");
  assert.equal(c.program, "npm", "跳过环境变量与 sudo，只取程序名");
  assert.equal(c.status, "ok");
  assert.equal(c.durationMs, 13, "耗时取整");
  assert.equal(c.atSeq, 1);
  assert.equal(c.parent, undefined);
  const craw = JSON.stringify(c);
  assert.deepEqual(
    Object.keys(c).sort(),
    ["activity", "atSeq", "durationMs", "kind", "program", "seq", "status", "ts", "v"].sort(),
    "命令活动只落这些字段，没有 args / result / 完整命令行",
  );
  for (const secret of ["SECRET_TOKEN", "--verbose", "super secret output"]) {
    assert.ok(!craw.includes(secret), `命令活动不该落 ${secret}`);
  }

  // 读文件：end 带 result 对象，也不能落正文。
  await h.tool_execution_start({ toolCallId: "c2", toolName: "read", args: { path: "src/app.ts" } }, ctx("act111"));
  await h.tool_execution_end({ toolCallId: "c2", isError: false, result: { content: [{ type: "text", text: "file body" }] } }, ctx("act111"));
  const fr = rows("act111")[2];
  assert.equal(fr.activity, "file");
  assert.equal(fr.op, "read");
  assert.equal(fr.path, "src/app.ts");
  assert.equal(fr.added, 0);
  assert.equal(fr.removed, 0);
  assert.equal(fr.status, "ok");
  assert.ok(!JSON.stringify(fr).includes("file body"), "文件正文不落盘");

  // edit 用 pi 的 edits[] 形状；失败状态也要记。
  await h.tool_execution_start({ toolCallId: "c3", toolName: "edit", args: { path: "src/a.ts", edits: [{ oldText: "a\nb", newText: "c" }] } }, ctx("act111"));
  await h.tool_execution_end({ toolCallId: "c3", toolName: "edit", isError: true, result: "edit failed" }, ctx("act111"));
  const fe = rows("act111")[3];
  assert.equal(fe.op, "edit");
  assert.equal(fe.added, 1);
  assert.equal(fe.removed, 2, "a\\nb 是 2 行");
  assert.equal(fe.status, "failed");
  assert.ok(!JSON.stringify(fe).includes("edit failed"));

  // write 用 content 行数；顶层 oldText/newText 与 edits[] 同时出现时只数 edits[]。
  await h.tool_execution_start({ toolCallId: "c4", toolName: "write", args: { path: "new.ts", content: "x\ny\nz" } }, ctx("act111"));
  await h.tool_execution_end({ toolCallId: "c4", isError: false, result: "ok" }, ctx("act111"));
  const fw = rows("act111")[4];
  assert.equal(fw.op, "write");
  assert.equal(fw.added, 3);
  assert.equal(fw.removed, 0);

  // 没登记在 FILE_TOOLS / 命令白名单里的工具不写行；没有 start 的 end 也不写行。
  const before = rows("act111").length;
  await h.tool_execution_start({ toolCallId: "c5", toolName: "custom", args: { path: "x" } }, ctx("act111"));
  await h.tool_execution_end({ toolCallId: "c5", isError: false, result: "ok" }, ctx("act111"));
  await h.tool_execution_end({ toolCallId: "ghost", isError: false, result: "ok" }, ctx("act111"));
  assert.equal(rows("act111").length, before, "未知工具 / 无 start 的调用不落盘");
});

test("CJK 与 ASCII 的估算权重不同（中文 ÷1.5、英文 ÷4）", async () => {
  const h = load();
  await h.session_start({ reason: "new" }, ctx("est111"));
  await request(h, "est111", msgs([{ role: "user", content: "你好世界" }]));
  await request(h, "est111", msgs([{ role: "user", content: "abcdefgh" }]));
  const r = rows("est111");
  assert.equal(r[0].cats.user, Math.ceil(4 / 1.5), "4 个汉字 ÷1.5");
  assert.equal(r[1].cats.user, Math.ceil(8 / 4), "8 个字母 ÷4");
  assert.deepEqual(r.map((x) => x.kind), ["request", "request"]);
});
