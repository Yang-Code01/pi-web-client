/**
 * D395：桥日志的轮转（`RotatingLog`）。不起桥，只跑一个临时目录。
 *
 *   node --experimental-strip-types bridge/tests/logfile-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LOG_MAX_BYTES, RotatingLog, logMaxBytes } from "../src/logfile.ts";

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name} — ${err.message}`);
  }
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "logfile-"));
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

await check("没到上限就是一个文件，不产生 .1", async () => {
  const dir = tmp();
  const file = path.join(dir, "bridge.log");
  const log = new RotatingLog(file, 1024);
  for (let i = 0; i < 10; i += 1) log.write(`line ${i}`);
  assert.equal(read(file).trimEnd().split("\n").length, 10);
  assert.equal(fs.existsSync(`${file}.1`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("越过上限：这一代搬成 .1，新文件接着写，只留一代", async () => {
  const dir = tmp();
  const file = path.join(dir, "bridge.log");
  const log = new RotatingLog(file, 40);
  // 每行 8 字节：五行正好填满 40，不轮转。
  const first = [];
  for (let i = 0; i < 5; i += 1) {
    log.write(`first ${i}`);
    first.push(`first ${i}`);
  }
  assert.equal(fs.existsSync(`${file}.1`), false, "刚好写到上限不轮转");
  log.write("second 0");
  log.write("second 1");
  assert.equal(read(`${file}.1`), `${first.join("\n")}\n`, ".1 是轮转那一刻的上一代");
  assert.equal(read(file), "second 0\nsecond 1\n", "新文件从轮转后的那一行开始");
  assert.ok(fs.statSync(file).size <= 40, "新文件不大于上限");
  // 再写满一次：还是只有 .1，上一代的 .1 被覆盖
  for (let i = 0; i < 10; i += 1) log.write(`third ${i}`);
  assert.equal(fs.existsSync(`${file}.2`), false, "只留一代");
  assert.ok(!read(`${file}.1`).includes("first 0"), "第二代 .1 覆盖掉第一代");
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("开门就已是巨型文件（没轮转的旧版本留下的）：直接截断，不搬成 .1", async () => {
  const dir = tmp();
  const file = path.join(dir, "bridge.log");
  fs.writeFileSync(file, "x".repeat(4096));
  const log = new RotatingLog(file, 200);
  log.write("after upgrade");
  assert.equal(read(file), "after upgrade\n", "旧内容不占着盘");
  assert.equal(fs.existsSync(`${file}.1`), false, "怪物不搬家，直接扔");
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("maxBytes=0：不轮转，写多少留多少（老行为）", async () => {
  const dir = tmp();
  const file = path.join(dir, "bridge.log");
  fs.writeFileSync(file, "y".repeat(4096));
  const log = new RotatingLog(file, 0);
  log.write("append me");
  assert.equal(fs.statSync(file).size, 4096 + "append me\n".length);
  assert.equal(fs.existsSync(`${file}.1`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("目录不存在时写失败照旧抛出去（调用方在桥里已经 catch）", async () => {
  const dir = tmp();
  const log = new RotatingLog(path.join(dir, "nope", "bridge.log"), 1024);
  assert.throws(() => log.write("boom"));
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("PI_WEB_LOG_MAX_BYTES：正整数改上限，0 关掉，读不懂用默认", async () => {
  assert.equal(logMaxBytes({}), DEFAULT_LOG_MAX_BYTES);
  assert.equal(logMaxBytes({ PI_WEB_LOG_MAX_BYTES: "" }), DEFAULT_LOG_MAX_BYTES);
  assert.equal(logMaxBytes({ PI_WEB_LOG_MAX_BYTES: "0" }), 0);
  assert.equal(logMaxBytes({ PI_WEB_LOG_MAX_BYTES: "4096" }), 4096);
  assert.equal(logMaxBytes({ PI_WEB_LOG_MAX_BYTES: "abc" }), DEFAULT_LOG_MAX_BYTES);
  assert.equal(logMaxBytes({ PI_WEB_LOG_MAX_BYTES: "-5" }), DEFAULT_LOG_MAX_BYTES);
  assert.equal(DEFAULT_LOG_MAX_BYTES, 8 * 1024 * 1024);
});

if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\nlogfile: ok");
