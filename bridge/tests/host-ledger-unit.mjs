/**
 * 用量账本的单元测试（不用起进程）。
 *
 * 断言的都是账本对外的行为：记进去的能读回来、重启后还在、后写的覆盖先写的、
 * 压缩之后只省字节不改答案。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { UsageLedger } from "../src/host/ledger.ts";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "usage.jsonl");

test("记一笔就能读回来", () => {
  const file = tmp();
  const ledger = new UsageLedger(file);
  ledger.record("s1", { input: 1200, output: 300, total: 1500, updatedAt: "2026-11-22T03:00:00.000Z" });
  assert.deepEqual(ledger.get("s1"), { input: 1200, output: 300, total: 1500, updatedAt: "2026-11-22T03:00:00.000Z" });
  assert.equal(ledger.size, 1);
});

test("后写的覆盖先写的", () => {
  const ledger = new UsageLedger(tmp());
  ledger.record("s1", { total: 1, updatedAt: "a" });
  ledger.record("s1", { total: 2, updatedAt: "b" });
  assert.equal(ledger.get("s1")?.total, 2);
  assert.equal(ledger.size, 1);
});

test("换个实例（= 换一代脑、甚至整组重启）还读得到", () => {
  const file = tmp();
  new UsageLedger(file).record("s1", { total: 42, updatedAt: "x" });
  new UsageLedger(file).record("s2", { total: 7, updatedAt: "y" });
  const again = new UsageLedger(file);
  assert.equal(again.get("s1")?.total, 42);
  assert.equal(again.get("s2")?.total, 7);
  assert.equal(again.size, 2);
});

test("半截行不致命", () => {
  const file = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ s: "s1", u: { total: 5, updatedAt: "x" } })}\n{"s":"s2","u":`);
  const ledger = new UsageLedger(file);
  assert.equal(ledger.get("s1")?.total, 5);
  assert.equal(ledger.size, 1);
});

test("压缩只省字节，不改答案", () => {
  const file = tmp();
  const ledger = new UsageLedger(file);
  for (let i = 0; i < 200; i += 1) ledger.record("s1", { total: i, updatedAt: `t${i}` });
  ledger.record("s2", { total: 9, updatedAt: "z" });
  const before = fs.statSync(file).size;
  assert.equal(ledger.compactIfBig(1024), true);
  assert.ok(fs.statSync(file).size < before);
  const again = new UsageLedger(file);
  assert.equal(again.get("s1")?.total, 199);
  assert.equal(again.get("s2")?.total, 9);
  assert.equal(again.size, 2);
});

test("压缩写盘失败时保留原账本", () => {
  const file = tmp();
  const ledger = new UsageLedger(file);
  for (let i = 0; i < 20; i += 1) ledger.record("s1", { total: i, updatedAt: `t${i}` });
  const before = fs.readFileSync(file, "utf8");
  const original = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("disk full");
  };
  try {
    assert.equal(ledger.compact(), false, "压缩失败要如实返回 false");
  } finally {
    fs.renameSync = original;
  }
  assert.equal(fs.readFileSync(file, "utf8"), before, "失败时原账本一个字节都不能少");
  assert.equal(new UsageLedger(file).get("s1")?.total, 19, "换一个实例仍然读得到最后一条");
  assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false, "临时文件不能留下");
});

test("很小的时候不压缩", () => {
  const ledger = new UsageLedger(tmp());
  ledger.record("s1", { total: 1, updatedAt: "x" });
  assert.equal(ledger.compactIfBig(1024 * 1024), false);
});

test("父目录不存在时自己建出来", () => {
  const ledger = new UsageLedger(path.join(tmp(), "no", "such", "file.jsonl"));
  const said = [];
  ledger.record("s1", { total: 1, updatedAt: "x" }, (m) => said.push(m));
  assert.deepEqual(said, []);
  assert.equal(ledger.get("s1")?.total, 1);
});

test("写不进去只回调日志，不抛", () => {
  // 拿一个目录当文件：append 必失败（EISDIR）。
  const ledger = new UsageLedger(os.tmpdir());
  const said = [];
  ledger.record("s1", { total: 1, updatedAt: "x" }, (m) => said.push(m));
  assert.equal(said.length, 1);
  assert.match(said[0], /账本写不进去/);
});
