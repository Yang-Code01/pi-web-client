/**
 * #478 工作区按天插位 —— 桥上的唯一新接缝：`SessionManager.list()`。
 *
 * 建几个真实的工作区目录、写几份 mtime 不同的会话文件，然后调一次列表：会话所属的组
 * 应该在那一刻「按天插位」到它该在的位置。断的是 list() 产生的顺序（`workspaces` 快照），
 * 不是内部函数调用。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const DAY = 24 * 3600_000;

/** 一套隔离的场景：状态目录、会话根、几个工作区目录，各自独立，互不串味。 */
function scene(names = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wsday-"));
  const state = path.join(root, "state");
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  process.env.PI_WEB_STATE = state;
  delete process.env.PI_AGENT_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessions;

  const dirs = new Map();
  const dir = (name) => {
    if (!dirs.has(name)) {
      const p = path.join(root, "proj", name);
      fs.mkdirSync(p, { recursive: true });
      dirs.set(name, p);
    }
    return dirs.get(name);
  };
  for (const name of names) dir(name);

  const write = (id, cwd, at) => {
    const folder = path.join(sessions, `--${id}--`);
    fs.mkdirSync(folder, { recursive: true });
    const stamp = new Date(at).toISOString();
    const rows = [
      { type: "session", version: 3, id, timestamp: stamp, cwd },
      { type: "message", id: "m1", parentId: null, timestamp: stamp, message: { role: "user", content: [{ type: "text", text: `会话 ${id}` }] } },
    ];
    const file = path.join(folder, `${id}.jsonl`);
    fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    fs.utimesSync(file, new Date(at), new Date(at));
    return file;
  };

  return { root, state, sessions, dir, write };
}

/** 一个新 manager（自带空的 5 秒磁盘缓存，等于「桥刚起来」）。 */
async function manager() {
  const { SessionManager } = await import("../src/sessions.ts");
  return new SessionManager("pi", null);
}

const order = (m) => m.workspaces.snapshot().order;
const groupOf = (m, dir) => m.list().find((s) => s.cwd === dir)?.ws;

test("#478 今天有会话的新组落在「今天这一档」的末尾", async () => {
  const now = Date.now();
  const s = scene(["a", "b", "y", "z"]);
  s.write("s-a", s.dir("a"), now);
  s.write("s-b", s.dir("b"), now);
  s.write("s-y", s.dir("y"), now - 8 * DAY);
  s.write("s-z", s.dir("z"), now - 9 * DAY);
  const first = await manager();
  first.list();
  assert.deepEqual(order(first), [groupOf(first, s.dir("a")), groupOf(first, s.dir("b")), groupOf(first, s.dir("y")), groupOf(first, s.dir("z"))]);

  // 新目录、今天：应该排到第 3 位（两个旧组之前），不是追加到末尾。
  s.write("s-new", s.dir("new"), now);
  const second = await manager();
  second.list();
  assert.deepEqual(order(second), [
    groupOf(second, s.dir("a")),
    groupOf(second, s.dir("b")),
    groupOf(second, s.dir("new")),
    groupOf(second, s.dir("y")),
    groupOf(second, s.dir("z")),
  ]);
});

test("#478 子会话今天更新过，这个组就算今天", async () => {
  const now = Date.now();
  const s = scene(["b", "c", "a"]);
  s.write("s-b", s.dir("b"), now);
  s.write("s-c", s.dir("c"), now - 8 * DAY);
  const first = await manager();
  first.list();
  assert.deepEqual(order(first), [groupOf(first, s.dir("b")), groupOf(first, s.dir("c"))]);

  // a 里只有一份上周的父会话，但它的子会话今天动过 → a 也算今天，插在 b 之后、c 之前。
  s.write("s-a-parent", s.dir("a"), now - 7 * DAY);
  s.write("s-a-child", s.dir("a"), now);
  const second = await manager();
  second.list();
  assert.deepEqual(order(second), [groupOf(second, s.dir("b")), groupOf(second, s.dir("a")), groupOf(second, s.dir("c"))]);
});

test("#478 没有会话的空组算最旧：今天的新组插在它前面", async () => {
  const now = Date.now();
  const s = scene(["today"]);
  const first = await manager();
  const empty = first.workspaces.create("空壳组");
  s.write("s-today", s.dir("today"), now);
  const second = await manager();
  second.list();
  assert.deepEqual(order(second), [groupOf(second, s.dir("today")), empty.id]);
});

test("#478 归档的会话不算「这个组今天有更新」", async () => {
  const now = Date.now();
  const s = scene(["live", "gone"]);
  s.write("s-live", s.dir("live"), now);
  s.write("s-gone", s.dir("gone"), now);
  fs.writeFileSync(path.join(s.state, "manage.json"), JSON.stringify({ pin: [], order: [], archived: ["s-gone"] }));
  const m = await manager();
  m.list();
  // gone 今天唯一的活动已被归档，对它来说「最旧」；live 是今天，所以 live 在前。
  assert.deepEqual(order(m), [groupOf(m, s.dir("live")), groupOf(m, s.dir("gone"))]);
});

test("#478 同一个组第二次被看到：顺序一个格子都不动", async () => {
  const now = Date.now();
  const s = scene(["a", "b"]);
  s.write("s-a", s.dir("a"), now - 10 * DAY);
  s.write("s-b", s.dir("b"), now);
  const first = await manager();
  first.list();
  const before = order(first);
  const second = await manager();
  second.list();
  assert.deepEqual(order(second), before);
});
