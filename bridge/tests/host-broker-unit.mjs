/**
 * 壳里的 broker：pi 输出行的分帧、未确认缓冲、跨代重放窗口与所有权。
 * 不起进程、不碰网络 —— 这是壳/脑分层里唯一值得单独钉住的一块逻辑。
 *
 *   node --experimental-transform-types --test bridge/tests/host-broker-unit.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Broker, LineSplitter } from "../src/host/broker.ts";

const enc = (s) => Buffer.from(s, "utf8");

test("按 0x0A 切行，一个 chunk 里的多行一次收下", () => {
  const b = new Broker();
  b.attach("s1");
  const lines = b.push("s1", enc('{"a":1}\n{"b":2}\n'));
  assert.deepEqual(lines.map((l) => l.line), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(lines.map((l) => l.seq), [1, 2]);
});

test("半个行留在缓冲里，补齐后才出一条", () => {
  const b = new Broker();
  b.attach("s1");
  assert.deepEqual(b.push("s1", enc('{"a":')), []);
  const out = b.push("s1", enc("1}\n"));
  assert.deepEqual(out.map((l) => l.line), ['{"a":1}']);
});

test("多字节字符被 chunk 切开也不碎（UTF-8 安全）", () => {
  const bytes = enc('{"t":"热热热"}\n');
  // 在每个字节边界都切一次：只要分帧按字节缓冲、整行才解码，就不会出现 U+FFFD。
  for (let cut = 1; cut < bytes.length; cut++) {
    const b = new Broker();
    b.attach("s1");
    const lines = [...b.push("s1", bytes.subarray(0, cut)), ...b.push("s1", bytes.subarray(cut))];
    assert.deepEqual(lines.map((l) => l.line), ['{"t":"热热热"}'], `切在第 ${cut} 字节`);
    assert.ok(!lines.some((l) => l.line.includes("\uFFFD")));
  }
});

test("行尾的 CRLF 不当成内容", () => {
  const b = new Broker();
  b.attach("s1");
  assert.deepEqual(b.push("s1", enc('{"a":1}\r\n')).map((l) => l.line), ['{"a":1}']);
});

test("ack 之后 pending 只留未确认的", () => {
  const b = new Broker();
  b.attach("s1");
  b.push("s1", enc("1\n2\n3\n"));
  b.ack("s1", 2);
  const p = b.pending("s1");
  assert.deepEqual(p.lines.map((l) => l.line), ["3"]);
  assert.equal(p.fromSeq, 3);
  assert.equal(p.toSeq, 3);
});

test("未确认缓冲超过上限就降级：不跨代，也不无限吃内存", () => {
  const b = new Broker({ maxBytes: 64 });
  b.attach("s1");
  const chunk = enc("x".repeat(40) + "\n");
  b.push("s1", chunk);
  b.push("s1", chunk);
  const p = b.pending("s1");
  assert.equal(p.overflowed, true);
  assert.deepEqual(p.lines, []);
  assert.ok(b.bufferedBytes("s1") <= 64, `bufferedBytes=${b.bufferedBytes("s1")}`);
});

test("超过上限后继续来行也不会把 bufferedBytes 顶上去", () => {
  const b = new Broker({ maxBytes: 32 });
  b.attach("s1");
  for (let i = 0; i < 20; i++) b.push("s1", enc("y".repeat(20) + "\n"));
  assert.equal(b.pending("s1").overflowed, true);
  assert.ok(b.bufferedBytes("s1") <= 32);
});

test("所有权原子切换：老脑的写被拒，新脑的写被收，seq 不倒退", () => {
  const b = new Broker();
  b.attach("s1");
  b.setOwner("s1", "a");
  const first = b.enqueueWrite("s1", "a", '{"type":"prompt"}');
  assert.equal(first, 1);
  b.setOwner("s1", "b");
  assert.equal(b.enqueueWrite("s1", "a", '{"type":"prompt"}'), null);
  const second = b.enqueueWrite("s1", "b", '{"type":"abort"}');
  assert.equal(second, 2);
});

test("换了 owner，未确认的行还在（跨代重放）", () => {
  const b = new Broker();
  b.attach("s1");
  b.setOwner("s1", "a");
  b.push("s1", enc("1\n2\n"));
  b.ack("s1", 1);
  b.setOwner("s1", "b");
  assert.deepEqual(b.pending("s1").lines.map((l) => l.line), ["2"]);
});

test("written 推进 lastWritten，脑重启后从这里接", () => {
  const b = new Broker();
  b.attach("s1");
  b.setOwner("s1", "a");
  const s1 = b.enqueueWrite("s1", "a", "one");
  const s2 = b.enqueueWrite("s1", "a", "two");
  assert.equal(b.lastWritten("s1"), 0);
  b.written("s1", s1);
  assert.equal(b.lastWritten("s1"), s1);
  b.written("s1", s2);
  assert.equal(b.lastWritten("s1"), s2);
  // 乱序 ack 不回退
  b.written("s1", s1);
  assert.equal(b.lastWritten("s1"), s2);
});

test("未 attach 的会话收行直接丢，不建账（壳不会为幽灵会话吃内存）", () => {
  const b = new Broker();
  assert.deepEqual(b.push("nope", enc("1\n")), []);
  assert.equal(b.ownerOf("nope"), null);
  assert.equal(b.enqueueWrite("nope", "a", "x"), null);
});

test("detach 把缓冲与 owner 一起清掉", () => {
  const b = new Broker();
  b.attach("s1");
  b.setOwner("s1", "a");
  b.push("s1", enc("1\n"));
  b.detach("s1");
  assert.equal(b.ownerOf("s1"), null);
  assert.equal(b.bufferedBytes("s1"), 0);
  assert.deepEqual(b.pending("s1").lines, []);
});

test("LineSplitter 单独可用：跨 chunk 的半个多字节字符", () => {
  const sp = new LineSplitter();
  const bytes = enc("热\n");
  assert.deepEqual(sp.push(bytes.subarray(0, 2)).lines, []);
  const rest = sp.push(bytes.subarray(2));
  assert.deepEqual(rest.lines, ["热"]);
  assert.equal(rest.seqs[0], 1);
});
