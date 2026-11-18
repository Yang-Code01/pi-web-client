/**
 * 记录包（#507 / #508）的纯逻辑：
 * - peer 的载荷校验（标题 / 正文 / 截图清单）；
 * - 截图按 sha 对齐到文件条目；
 * - 导入记录的原子性（临时目录提交、origin、状态重置）；
 * - 接受状态的 sidecar。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-note-unit-"));
process.env.PI_WEB_STATE = root;

const { importNote, listNotes, notesFile } = await import("../src/notes.ts");
const { markAccepted, readAccepted, resolveNoteShots } = await import("../src/peer-notes.ts");
const { normalizeNote } = await import("../../peer/src/note.ts");

const sha = (ch) => ch.repeat(64);

test("normalizeNote 接受合法载荷并拒绝超限 / 坏清单", () => {
  const good = normalizeNote({
    title: "  标题  ",
    body: "<p>正文</p>",
    kind: "idea",
    status: "done",
    shots: [{ name: "a.png", size: 12, sha256: sha("a") }],
    noteCreatedAt: 1,
  });
  assert.equal(good.title, "标题");
  assert.equal(good.kind, "idea");
  assert.equal(good.shots.length, 1);

  assert.throws(() => normalizeNote({ ...good, body: "x".repeat(200_001) }), /正文太长/);
  assert.throws(() => normalizeNote({ ...good, title: "标".repeat(201) }), /标题太长/);
  assert.throws(() => normalizeNote({ ...good, kind: "other" }), /分类/);
  assert.throws(() => normalizeNote({ ...good, shots: [{ name: "a.png", size: 1, sha256: "nope" }] }), /截图清单/);
  assert.throws(
    () => normalizeNote({ ...good, shots: Array.from({ length: 25 }, (_, i) => ({ name: `${i}.png`, size: 1, sha256: sha("a") })) }),
    /截图太多/,
  );
});

test("resolveNoteShots 只认记录包之后、同一个人、未被更早的卡认领过的文件", () => {
  const entries = [
    { id: "f-old", at: 1, kind: "file", from: { nodeId: "p" }, file: { sha256: sha("a") } },
    {
      id: "n1",
      at: 2,
      kind: "note",
      from: { nodeId: "p" },
      note: { shots: [{ sha256: sha("a") }, { sha256: sha("b") }, { sha256: sha("c") }] },
    },
    { id: "n2", at: 3, kind: "note", from: { nodeId: "p" }, note: { shots: [{ sha256: sha("a") }] } },
    { id: "f1", at: 4, kind: "file", from: { nodeId: "p" }, file: { sha256: sha("a") } },
    { id: "f2", at: 5, kind: "file", from: { nodeId: "p" }, file: { sha256: sha("b") } },
    { id: "f-other", at: 6, kind: "file", from: { nodeId: "q" }, file: { sha256: sha("c") } },
  ];
  assert.deepEqual(resolveNoteShots(entries, "n1"), ["f1", "f2", null]);
  // 同一个文件不能被两张卡同时认领；n2 在 n1 之后，只能拿到 null。
  assert.deepEqual(resolveNoteShots(entries, "n2"), [null]);
  assert.deepEqual(resolveNoteShots(entries, "missing"), []);
});

test("importNote 原子落盘：分类保留、状态待处理、origin 与截图都在", () => {
  const note = importNote({
    title: "来自小王的记录",
    body: "<p>复现步骤</p>",
    kind: "idea",
    shots: [
      { name: "a.png", data: Buffer.from([1, 2, 3]) },
      { name: "b.png", data: Buffer.from([4, 5]) },
    ],
    origin: { peerEntryId: "e1", nodeId: "p", nickname: "小王", hostname: "王-pc", at: 123 },
  });
  assert.equal(note.kind, "idea");
  assert.equal(note.status, "pending");
  assert.equal(note.origin?.peerEntryId, "e1");
  assert.equal(note.shots.length, 2);
  for (const file of note.shots) assert.ok(fs.existsSync(file), file);
  const listed = listNotes().find((n) => n.id === note.id);
  assert.equal(listed?.title, "来自小王的记录");
  assert.equal(JSON.parse(fs.readFileSync(notesFile(), "utf8")).notes.length, 1);
  // 再导入一条是新的 id，不覆盖上一条。
  const again = importNote({ title: "第二条", body: "", kind: "bug", shots: [], origin: { peerEntryId: "e2", nodeId: "p", nickname: "", hostname: "", at: 2 } });
  assert.notEqual(again.id, note.id);
  assert.equal(listNotes().length, 2);
});

test("接受状态放 sidecar，重复接受读得回来", () => {
  markAccepted("entry-1", "n_abc");
  const all = readAccepted();
  assert.equal(all["entry-1"].noteId, "n_abc");
  markAccepted("entry-2", "n_def");
  assert.equal(readAccepted()["entry-2"].noteId, "n_def");
});
