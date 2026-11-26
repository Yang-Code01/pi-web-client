/**
 * 换脑（bridge 热替换）之后，正在跑的会话要能认出自己在磁盘上的那份文件。
 *
 * 事故现场：网页里新建的会话先起了一个 pi，它在写第一个字之前就退出了（退出码 0），`state.file`
 * 却已经记下 pi 报的路径；用户再发一句时桥用 `--session <那个还不存在的路径>` 续接 —— pi 不报错，
 * 它当场 `newSession()` 造一个**新 id** 写进那个文件名里。从此桥的 id（f89e1eff…）与文件头的 id
 * （01a21885…）分叉。00:14 热替换之后新脑 `ensure(bridgeId)` 查不到 meta：items 空（历史看着没了）、
 * 名字回落成「新会话」、startedAt 变成"现在"、同一份文件在列表里出现两次。
 *
 *   node bridge/tests/session-file-id.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** 一份「文件名是桥的 id、文件头是 pi 的 id」的会话文件，跟线上那份一模一样。 */
function scene() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fileid-"));
  const state = path.join(root, "state");
  const sessions = path.join(root, "sessions");
  const cwd = path.join(root, "proj");
  for (const d of [state, sessions, cwd]) fs.mkdirSync(d, { recursive: true });
  process.env.PI_WEB_STATE = state;
  delete process.env.PI_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessions;

  const bridgeId = "f89e1eff-d02f-4d7e-880a-0a87a34589d0";
  const fileId = "01a21885-ed4c-7790-8f2d-09c1da7f9951";
  const first = "查看一下github上的 fast-anything 这个项目";
  const folder = path.join(sessions, "--F--pi-web-client--");
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `2026-11-26T15-41-35-906Z_${bridgeId}.jsonl`);
  const rows = [
    { type: "session", version: 3, id: fileId, timestamp: "2026-11-26T15:42:39.949Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-11-26T15:43:20.000Z", message: { role: "user", content: [{ type: "text", text: first }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-11-26T15:43:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "好，我去看看。" }] } },
  ];
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return { root, file, bridgeId, fileId, first };
}

test("续接只对真的存在的文件用 --session；不存在的路径会让 pi 换掉 id", async () => {
  const { sessionOpenArgs } = await import("../src/sessions.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-"));
  const there = path.join(dir, "there.jsonl");
  fs.writeFileSync(there, '{"type":"session"}\n');
  const empty = path.join(dir, "empty.jsonl");
  fs.writeFileSync(empty, "");
  const gone = path.join(dir, "gone.jsonl");
  assert.deepEqual(sessionOpenArgs(true, there, "id-1"), ["--session", there]);
  assert.deepEqual(sessionOpenArgs(true, gone, "id-1"), ["--session-id", "id-1"]);
  assert.deepEqual(sessionOpenArgs(true, empty, "id-1"), ["--session-id", "id-1"]);
  assert.deepEqual(sessionOpenArgs(true, null, "id-1"), ["--session-id", "id-1"]);
  assert.deepEqual(sessionOpenArgs(false, there, "id-1"), ["--session-id", "id-1"]);
});

test("id 分叉过：换脑后仍按文件名找到历史、名字和创建时间，列表里也只有一条", async () => {
  const s = scene();
  const { SessionManager } = await import("../src/sessions.ts");
  const mgr = new SessionManager("pi", null);
  // 换脑后 adoptLinked([bridgeId]) → ensure(bridgeId)
  const session = mgr.ensure(s.bridgeId);
  try {
    assert.ok(session.items.length >= 2, `items=${session.items.length}`);
    assert.equal(session.state.name, s.first);
    assert.equal(session.state.startedAt, "2026-11-26T15:42:39.949Z");
    assert.equal(session.state.file, s.file);
    // get_state 报回来的 file 与壳快照里的 running 一样会落到 state 上；这时列表不能列两次。
    session.state.file = s.file;
    const same = mgr.list().filter((x) => x.file === s.file);
    assert.equal(same.length, 1, `entries=${same.map((x) => x.id).join(",")}`);
    assert.equal(same[0].id, s.bridgeId);
  } finally {
    session.stopTail?.();
  }
});
