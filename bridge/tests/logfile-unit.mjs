/**
 * D395：桥日志的轮转（`RotatingLog`）。不起桥，只跑一个临时目录。
 *
 *   node --experimental-strip-types bridge/tests/logfile-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LOG_MAX_BYTES, DEFAULT_MAX_LINES_PER_SECOND, LogStorm, RotatingLog, logMaxBytes, logMaxLinesPerSecond } from "../src/logfile.ts";

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

/** 假时钟 + 可控定时器：风暴的窗口与尾巴都靠它们，测试里不真等一秒。 */
function harness(maxPerSecond) {
  const out = [];
  const clock = { t: 1000 };
  const timers = [];
  const storm = new LogStorm((line) => out.push(line), maxPerSecond, {
    now: () => clock.t,
    schedule: (fn, ms) => {
      const handle = { fn, ms };
      timers.push(handle);
      return handle;
    },
    cancel: (handle) => {
      const i = timers.indexOf(handle);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  /** 让时间前进，并把到点的定时器跑掉（跟真实 setTimeout 一样：先摘掉再从表里消失）。 */
  const tick = (ms) => {
    clock.t += ms;
    for (const handle of [...timers]) {
      const i = timers.indexOf(handle);
      if (i >= 0) timers.splice(i, 1);
      handle.fn();
    }
  };
  return { out, clock, timers, storm, tick };
}

await check("风暴罩子：阀值内一行不少地透传", async () => {
  const { out, clock, storm } = harness(5);
  for (const name of ["a", "b", "c", "d", "e"]) {
    clock.t += 100;
    storm.write(name);
  }
  assert.deepEqual(out, ["a", "b", "c", "d", "e"], "一秒 5 行（= 阀值）不算风暴");
});

await check("风暴罩子：超了只写一条头，中间全吞，安静下来写一条尾", async () => {
  const { out, clock, storm, tick } = harness(3);
  storm.write("a");
  storm.write("b");
  storm.write("c");
  storm.write("d"); // 第 4 行 → 进风暴，自己也被吞
  storm.write("e");
  storm.write("f");
  assert.equal(out.length, 4, "三条正常 + 一条风暴头");
  assert.match(out[3], /^⚠️ 日志风暴：一秒内超过 3 行/);
  assert.ok(out[3].includes("d"), "头里带样本行，能认出是哪一条在刷");
  // 第二个窗口还在刷：只说「还在」，不再逐条写
  tick(1000);
  for (let i = 0; i < 30; i += 1) storm.write(`still-${i}`);
  assert.equal(out.length, 4, "风暴期间一行都不再落 sink");
  // 第三个窗口真的安静下来：一条尾巴带上吞了多少，随后恢复正常逐行写
  tick(1000);
  storm.write("calm"); // 这一行还在被吞的那一段里
  assert.equal(out.length, 4);
  tick(1000); // 窗口收尾，发现上一轮只有 1 行 → 收工
  assert.equal(out.length, 5, "一条尾巴");
  assert.match(out[4], /^⚠️ 日志风暴结束：.*吞掉 34 行/);
  assert.ok(out[4].includes("calm"), "尾巴带最后一条样本");
  storm.write("after");
  assert.equal(out[5], "after", "之后一行不吞");
});

await check("风暴罩子：刷完直接彻底安静，结尾那行也得落下来（靠窗口定时器）", async () => {
  const { out, storm, tick, timers } = harness(3);
  for (let i = 0; i < 10; i += 1) storm.write(`flood-${i}`);
  assert.equal(out.length, 4, "三条正常 + 一条风暴头");
  assert.equal(timers.length, 1, "风暴里挂着一个窗口定时器");
  tick(1000); // 这一个窗口还在刷（10 行）→ 不收工，重新挂一个
  assert.equal(out.length, 4, "窗口过去了但上一轮还在刷，不收工");
  assert.equal(timers.length, 1, "定时器续上");
  tick(1000); // 这 1 秒一行没写 → 安静
  assert.equal(out.length, 5, "没人再写，尾巴也照样落下来");
  assert.match(out[4], /^⚠️ 日志风暴结束：.*吞掉 7 行/);
  assert.equal(timers.length, 0, "结束了就把定时器摘掉");
});

await check("风暴罩子：样本截到 200 字符，长行不把日志自己撑爆", async () => {
  const { out, storm } = harness(1);
  storm.write("x".repeat(5000));
  storm.write("y".repeat(5000));
  const head = out.at(-1);
  assert.match(head, /^⚠️ 日志风暴/);
  assert.ok(head.length < 400, `样本被截断（实际 ${head.length} 字符）`);
  assert.ok(head.includes("…"), "截断处有个省略号");
});

await check("风暴罩子：maxPerSecond=0 整个罩子关掉，一行不少", async () => {
  const { out, storm } = harness(0);
  for (let i = 0; i < 50; i += 1) storm.write(`n${i}`);
  assert.equal(out.length, 50);
});

await check("PI_WEB_LOG_MAX_LINES_PER_S：正整数改阀值，0 关掉，读不懂用默认", async () => {
  assert.equal(logMaxLinesPerSecond({}), DEFAULT_MAX_LINES_PER_SECOND);
  assert.equal(logMaxLinesPerSecond({ PI_WEB_LOG_MAX_LINES_PER_S: "0" }), 0);
  assert.equal(logMaxLinesPerSecond({ PI_WEB_LOG_MAX_LINES_PER_S: "20" }), 20);
  assert.equal(logMaxLinesPerSecond({ PI_WEB_LOG_MAX_LINES_PER_S: "abc" }), DEFAULT_MAX_LINES_PER_SECOND);
  assert.equal(logMaxLinesPerSecond({ PI_WEB_LOG_MAX_LINES_PER_S: "-1" }), DEFAULT_MAX_LINES_PER_SECOND);
});

if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\nlogfile: ok");
