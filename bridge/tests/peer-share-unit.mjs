/**
 * 共享卡（D439）的纯逻辑：
 * - peer 侧载荷校验（类型 / 正文上限 / 清单 / sha256）；
 * - 桥侧把「共享什么」翻成清单：文件、内容、技能 zip、会话 Markdown；
 * - sha256 → 历史里的文件条目（两张卡不抢同一份）；
 * - 四类接收的落点（另存 / 进记录 / 解压技能 / 导出 md）与安全边界（越界路径、同名技能）；
 * - 回执失败不该让「已接收」变成失败。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync, unzipSync } from "fflate";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-share-unit-"));
process.env.PI_WEB_STATE = root;

const { normalizeShare, MAX_SHARE_BODY } = await import("../../peer/src/share.ts");
const { prepareShare, sendShare, acceptShare, ackShare, resolveShareFiles, decorateShares, sessionMarkdown } = await import("../src/peer-share.ts");
const { listNotes } = await import("../src/notes.ts");

const sha = (ch) => ch.repeat(64);
/** 真实 sha256：接受端的校验是真算的，测试不能拿假哈希糊过去。 */
const realSha = (buf) => createHash("sha256").update(buf).digest("hex");
const cwd = path.join(root, "work");
fs.mkdirSync(cwd, { recursive: true });

function fakeHost(entries = [], files = {}) {
  const sent = { card: null, files: [] };
  return {
    sent,
    async history() {
      return { entries: JSON.parse(JSON.stringify(entries)) };
    },
    async fileStream(id) {
      const buf = files[id];
      if (!buf) return new Response("nope", { status: 404 });
      return new Response(buf);
    },
    async filePath(id) {
      return path.join(root, "inbox", id);
    },
    async sendShare(peer, share, via) {
      sent.card = { peer, share, via };
      return { ok: true, id: "card-1", at: 1, seq: 1 };
    },
    async sendFile(peer, file, name) {
      sent.files.push({ peer, file, name });
      return { ok: true, id: `file-${sent.files.length}` };
    },
    async shareAck() {
      return { ok: true };
    },
  };
}

test("normalizeShare 收合法载荷，拒未知类型 / 超长正文 / 坏清单", () => {
  const good = normalizeShare({ type: "snippet", title: "  一段内容  ", body: "hi", files: [] });
  assert.equal(good.title, "一段内容");
  assert.throws(() => normalizeShare({ type: "video", title: "x" }), /类型/);
  assert.throws(() => normalizeShare({ type: "snippet", title: "x", body: "字".repeat(MAX_SHARE_BODY) }), /预览太长/);
  assert.throws(() => normalizeShare({ type: "snippet", title: "x", files: [{ name: "a", size: 1, sha256: "nope" }] }), /清单/);
  assert.throws(
    () => normalizeShare({ type: "file", title: "x", files: Array.from({ length: 51 }, () => ({ name: "a", size: 1, sha256: sha("a") })) }),
    /文件太多/,
  );
});

test("prepareShare(snippet) 把正文截到 8KB 并在摘要里标出来", () => {
  const long = "长".repeat(4000); // 12000 字节
  const { share, attachments } = prepareShare({ type: "snippet", text: long });
  assert.equal(attachments.length, 0);
  assert.ok(Buffer.byteLength(share.body, "utf8") <= MAX_SHARE_BODY);
  assert.ok(share.bodyBytes > MAX_SHARE_BODY);
  assert.match(share.summary, /已截断/);
  // 截断不能切出半个字符。
  assert.ok(!/\uFFFD/.test(share.body));
});

test("prepareShare(file) 算大小与 sha256，标题回退到文件名", () => {
  const file = path.join(cwd, "报告.txt");
  fs.writeFileSync(file, "hello");
  const { share, attachments } = prepareShare({ type: "file", paths: ["报告.txt"], cwd });
  assert.equal(share.title, "报告.txt");
  assert.equal(share.files.length, 1);
  assert.equal(share.files[0].size, 5);
  assert.match(share.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(attachments.map((a) => a.path), [file]);
});

test("prepareShare(skill) 打一个 zip，清单里只有它", () => {
  const dir = path.join(cwd, ".pi", "skills", "demo");
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: demo\ndescription: 演示用\n---\n\n# demo\n");
  fs.writeFileSync(path.join(dir, "scripts", "run.mjs"), "console.log(1)\n");
  const { share, attachments } = prepareShare({ type: "skill", skillName: "demo", scope: "project", cwd });
  assert.equal(share.type, "skill");
  assert.equal(share.files.length, 1);
  assert.match(share.files[0].name, /^demo\.zip$/);
  assert.equal(share.summary, "演示用");
  assert.equal(attachments.length, 1);
  const files = unzipSync(new Uint8Array(fs.readFileSync(attachments[0].path)));
  assert.deepEqual(Object.keys(files).sort(), ["SKILL.md", "scripts/run.mjs"]);
  assert.throws(() => prepareShare({ type: "skill", skillName: "../evil", scope: "project", cwd }), /技能名不合法/);
});

test("sessionMarkdown 只带提问 / 结论 / 工具名，不带工具输出", () => {
  const file = path.join(cwd, "s1.jsonl");
  const lines = [
    { type: "session", id: "s", name: "导出测试" },
    { type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "帮我看看这个 bug" }] } },
    {
      type: "message",
      id: "m2",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "我先跑一下测试。" },
          { type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } },
        ],
      },
    },
    { type: "message", id: "m3", message: { role: "toolResult", content: [{ type: "text", text: "一整段构建日志不该出现" }] } },
  ];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const md = sessionMarkdown(file);
  assert.match(md.text, /^# /);
  assert.match(md.text, /帮我看看这个 bug/);
  assert.match(md.text, /我先跑一下测试/);
  assert.match(md.text, /\*调用工具：bash\*/);
  assert.doesNotMatch(md.text, /一整段构建日志/);
});

test("sendShare 先卡片后本体；本体失败时说清是哪一份", async () => {
  const file = path.join(cwd, "a.txt");
  fs.writeFileSync(file, "abc");
  const host = fakeHost();
  const res = await sendShare(host, { peer: "p1", type: "file", paths: [file], via: "pi" });
  assert.equal(res.id, "card-1");
  assert.equal(host.sent.card.via, "pi");
  assert.equal(host.sent.files.length, 1);

  const broken = fakeHost();
  broken.sendFile = async () => {
    throw new Error("对方拒收");
  };
  await assert.rejects(sendShare(broken, { peer: "p1", type: "file", paths: [file] }), /卡片已发出.*a\.txt.*没传过去/);
});

test("resolveShareFiles 只认同一个人、卡片之后、且没被更早的卡认领的文件", () => {
  const entries = [
    { id: "f-old", at: 1, kind: "file", from: { nodeId: "p" }, file: { sha256: sha("a") } },
    { id: "c1", at: 2, kind: "share", from: { nodeId: "p" }, share: { files: [{ sha256: sha("a") }, { sha256: sha("b") }] } },
    { id: "f1", at: 3, kind: "file", from: { nodeId: "p" }, file: { sha256: sha("a") } },
    { id: "c2", at: 4, kind: "share", from: { nodeId: "p" }, share: { files: [{ sha256: sha("a") }] } },
    { id: "f2", at: 5, kind: "file", from: { nodeId: "q" }, file: { sha256: sha("b") } },
  ];
  assert.deepEqual(resolveShareFiles(entries, "c1"), ["f1", null]);
  assert.deepEqual(resolveShareFiles(entries, "c2"), [null]);
  const decorated = decorateShares(entries);
  assert.equal(decorated.find((e) => e.id === "c1").share.files[0].entryId, "f1");
});

test("acceptShare(snippet) 存成「共享」记录并带上来源", async () => {
  const entries = [
    { id: "c", at: 10, kind: "share", from: { nodeId: "p", nickname: "小王", hostname: "王-pc" }, share: { type: "snippet", title: "一段", body: "内容", files: [] } },
  ];
  const res = await acceptShare(fakeHost(entries), { peer: "p", id: "c", cwd });
  assert.equal(res.type, "snippet");
  const note = listNotes().find((n) => n.id === res.noteId);
  assert.equal(note.kind, "shared");
  assert.equal(note.title, "一段");
  assert.equal(note.origin.peerEntryId, "c");
});

test("acceptShare(file) 可以把本体另存到指定目录；缺文件时明确拒绝", async () => {
  const data = Buffer.from("file-bytes");
  const hash = realSha(data);
  const entries = [
    { id: "c", at: 10, kind: "share", from: { nodeId: "p" }, share: { type: "file", title: "f.txt", files: [{ name: "f.txt", size: data.length, sha256: hash, role: "file" }] } },
    { id: "f1", at: 11, kind: "file", from: { nodeId: "p" }, file: { sha256: hash, name: "f.txt" } },
  ];
  const out = path.join(root, "out-file");
  const res = await acceptShare(fakeHost(entries, { f1: data }), { peer: "p", id: "c", target: out, cwd });
  assert.deepEqual(res.paths, [path.join(out, "f.txt")]);
  assert.equal(fs.readFileSync(path.join(out, "f.txt"), "utf8"), "file-bytes");

  await assert.rejects(acceptShare(fakeHost(entries.slice(0, 1)), { peer: "p", id: "c", cwd }), /还缺 1 份文件/);
});

test("acceptShare(skill) 解到项目技能目录，并拦住越界路径与同名覆盖", async () => {
  const zip = Buffer.from(zipSync({ "SKILL.md": new TextEncoder().encode("# hi\n"), "a/b.txt": new TextEncoder().encode("x") }));
  const zipSha = realSha(zip);
  const entries = [
    { id: "c", at: 10, kind: "share", from: { nodeId: "p" }, share: { type: "skill", title: "s1", files: [{ name: "s1.zip", size: zip.length, sha256: zipSha, role: "skill" }] } },
    { id: "f1", at: 11, kind: "file", from: { nodeId: "p" }, file: { sha256: zipSha } },
  ];
  const res = await acceptShare(fakeHost(entries, { f1: zip }), { peer: "p", id: "c", scope: "project", cwd });
  const dir = path.join(cwd, ".pi", "skills", "s1");
  assert.deepEqual(res.paths, [dir]);
  assert.equal(fs.readFileSync(path.join(dir, "a", "b.txt"), "utf8"), "x");
  // 同一张卡（同一 id）第二次是幂等；这里要验的是**另一张卡**装了同名技能 —— 另一张卡 = 另一个 id。
  const again = [
    { id: "c-again", at: 12, kind: "share", from: { nodeId: "p" }, share: entries[0].share },
    entries[1],
  ];
  await assert.rejects(acceptShare(fakeHost(again, { f1: zip }), { peer: "p", id: "c-again", scope: "project", cwd }), /同名技能/);

  const evil = Buffer.from(zipSync({ "../escape.txt": new TextEncoder().encode("bad"), "SKILL.md": new TextEncoder().encode("# x") }));
  const evilSha = realSha(evil);
  const evilEntries = [
    { id: "c2", at: 12, kind: "share", from: { nodeId: "p" }, share: { type: "skill", title: "s2", files: [{ name: "s2.zip", size: evil.length, sha256: evilSha, role: "skill" }] } },
    { id: "f2", at: 13, kind: "file", from: { nodeId: "p" }, file: { sha256: evilSha } },
  ];
  await assert.rejects(acceptShare(fakeHost(evilEntries, { f2: evil }), { peer: "p", id: "c2", scope: "project", cwd }), /越界路径/);
  assert.equal(fs.existsSync(path.join(cwd, ".pi", "skills", "escape.txt")), false);
});

test("acceptShare 校验本体大小与 sha256", async () => {
  const hash = realSha(Buffer.from("good"));
  const entries = [
    { id: "c", at: 10, kind: "share", from: { nodeId: "p" }, share: { type: "file", title: "f", files: [{ name: "f", size: 4, sha256: hash, role: "file" }] } },
    { id: "f1", at: 11, kind: "file", from: { nodeId: "p" }, file: { sha256: hash } },
  ];
  const target = path.join(root, "out-check");
  await assert.rejects(acceptShare(fakeHost(entries, { f1: Buffer.from("toolong") }), { peer: "p", id: "c", target, cwd }), /大小对不上/);
  await assert.rejects(acceptShare(fakeHost(entries, { f1: Buffer.from("nope") }), { peer: "p", id: "c", target, cwd }), /校验失败/);
});

test("ackShare 回执失败只给 warning，不影响已经落地的东西", async () => {
  const host = fakeHost();
  host.shareAck = async () => {
    throw new Error("对方离线");
  };
  const res = await ackShare(host, "p", "c", "p");
  assert.equal(res.ok, false);
  assert.match(res.warning, /回执没发出去/);
});

test("sendShare 认「没拿到 id」为没传成（桥只在非 2xx 抛）", async () => {
  const file = path.join(cwd, "soft.txt");
  fs.writeFileSync(file, "abc");
  const soft = fakeHost();
  // 桥的 request() 只在 HTTP 状态不是 2xx 时抛；返回体里 ok:false / 缺 id 也是没传成。
  soft.sendFile = async () => ({ ok: false, id: "" });
  await assert.rejects(sendShare(soft, { peer: "p1", type: "file", paths: [file] }), /卡片已发出.*soft\.txt.*没传过去/);
});

test("acceptShare 幂等：同一张卡、同一个落点，第二次只回 already", async () => {
  const entries = [
    { id: "idem", at: 10, kind: "share", from: { nodeId: "p-idem", nickname: "小王" }, share: { type: "snippet", title: "一段", body: "内容", files: [] } },
  ];
  const before = listNotes().length;
  const first = await acceptShare(fakeHost(entries), { peer: "p-idem", id: "idem", cwd });
  assert.equal(first.already, undefined);
  assert.equal(listNotes().length, before + 1);
  const second = await acceptShare(fakeHost(entries), { peer: "p-idem", id: "idem", cwd });
  assert.equal(second.already, true);
  assert.equal(second.noteId, first.noteId);
  assert.equal(listNotes().length, before + 1, "第二次不该再导入一条记录");
});
