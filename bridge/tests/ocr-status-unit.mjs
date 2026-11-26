/**
 * `ocr version` 探活：装着的 ocr 不许被报成「没装」。
 *
 * 用户报过「明明装了 ocr，代码评审面板有时候还是让我装」。真机上一发 `ocr version`
 * 是 `node launcher → Go 二进制` 两层启动，冷的时候 5~7 秒（实测 0.4s~6.6s，18 分钟一次的
 * 后台更新检查还会再拖一下），而探活只给 5 秒 —— 慢一发就变成 installed:false，
 * 面板上就是那句「还没装 ocr」。
 *
 * 这里用一个「慢但正常」的假 ocr（PATH 里放一个要睡够久的 shim，跟生产走同一条
 * `cmd.exe /c ocr` 解析路径）来钉住这件事：
 *   1. 慢启动但能正常回版本 → installed 必须是 true（今天会红）
 *   2. 探过一回就记住，再问不许再 spawn 一次（面板一次打开会问好几次）
 *   3. 真的找不到命令（ENOENT）→ 才许说没装
 *   4. 超时 / 其它失败 → 不许冒充「没装」，只能把错误原样带回去
 *
 *   node --experimental-strip-types bridge/tests/ocr-status-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ocr-status-"));
process.env.PI_WEB_STATE = path.join(tmp, "state");
const spawnLog = path.join(tmp, "spawns.txt");
const fakeBin = path.join(tmp, "bin");
fs.mkdirSync(fakeBin, { recursive: true });

const VERSION_LINE = "open-code-review v1.14.4 (d4f568f7) windows/amd64";
// 睡够过老的那条 5 秒线，但别睡到把测试拖成分钟级。
const SLEEP_MS = 7_000;

function writeShim(dir, sleepMs) {
  const posix = process.platform !== "win32";
  const file = path.join(dir, posix ? "ocr" : "ocr.cmd");
  const body = posix
    ? `#!/bin/sh\necho x >> ${JSON.stringify(spawnLog)}\nsleep ${sleepMs / 1000}\necho ${JSON.stringify(VERSION_LINE)}\n`
    : [
        "@echo off",
        `echo x >> "${spawnLog}"`,
        `ping -n ${Math.round(sleepMs / 1000) + 1} 127.0.0.1 >nul`,
        `echo ${VERSION_LINE}`,
        "echo built at: 2026-11-26T02:19:59Z",
      ].join("\r\n");
  fs.writeFileSync(file, body);
  if (posix) fs.chmodSync(file, 0o755);
  return file;
}

writeShim(fakeBin, SLEEP_MS);
// 与生产同一条路：Windows 上 ocrInvocation() 也是过 `cmd.exe /c ocr`，靠 PATH 找。
const realPath = process.env.PATH ?? "";
process.env.PATH = `${fakeBin}${path.delimiter}${realPath}`;

const { ocrStatus, ocrStatusFromFailure } = await import("../src/review.ts");

const spawnCount = () => (fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length : 0);

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

// ---- 1. 慢启动 = 还装着
let slow;
await check(`冷启动 ${SLEEP_MS}ms 的 ocr 照样算装好了`, async () => {
  const started = Date.now();
  slow = await ocrStatus();
  const took = Date.now() - started;
  assert.equal(slow?.installed, true, `${SLEEP_MS}ms 才回版本就被判成没装：${JSON.stringify(slow)}（耗时 ${took}ms）`);
  assert.equal(slow.version, "1.14.4");
  assert.equal(slow.tooOld, false);
  assert.equal(spawnCount(), 1, "探活应当只 spawn 一次");
});

// ---- 2. 探过就记住：面板一次打开会问好几遍（WS review.get + HTTP /api/review/state）
await check("探过一回再问：秒回且不再 spawn", async () => {
  assert.ok(slow, "上一条没跑通，这条没有意义");
  const before = spawnCount();
  const started = Date.now();
  const again = await ocrStatus();
  const took = Date.now() - started;
  assert.deepEqual(again, slow);
  assert.ok(took < 200, `再问一次花了 ${took}ms，说明又 spawn 了一遍`);
  assert.equal(spawnCount(), before, "又 spawn 了一次 `ocr version`");
});

// ---- 3. 并发问也只有一个在 spawn
await check("并发问三遍只 spawn 一次", async () => {
  const before = spawnCount();
  const all = await Promise.all([ocrStatus({ refresh: true }), ocrStatus({ refresh: true }), ocrStatus({ refresh: true })]);
  assert.equal(spawnCount() - before, 1, `三路并发 spawn 了 ${spawnCount() - before} 次`);
  for (const s of all) assert.equal(s.installed, true, JSON.stringify(s));
});

// ---- 4. 真找不到命令才说没装
await check("命令真的不存在（ENOENT）→ installed:false / error:missing", async () => {
  process.env.OCR_BIN = path.join(tmp, "nope", "ocr");
  try {
    const out = await ocrStatus({ refresh: true });
    assert.equal(out.installed, false, JSON.stringify(out));
    assert.equal(out.error, "missing");
  } finally {
    delete process.env.OCR_BIN;
  }
});

// ---- 5. 负数不缓存：装好之后不必等缓存过期
await check("一次 missing 不会把结论焊死", async () => {
  const out = await ocrStatus();
  assert.equal(out.installed, true, JSON.stringify(out));
});

// ---- 6. 超时 / 其它失败不许冒充「没装」
await check("超时不被说成没装", () => {
  const out = ocrStatusFromFailure("timeout", "20 秒没有回应");
  assert.equal(out.installed, true, "超时就把人推去装 ocr —— 正是这次报的毛病");
  assert.equal(out.error, "timeout");
});

await check("找不到命令才说没装", () => {
  const out = ocrStatusFromFailure("ocr_missing", "没装 ocr");
  assert.equal(out.installed, false);
  assert.equal(out.error, "missing");
});

await check("版本太老单独一类（劝升，不是劝装）", () => {
  const out = ocrStatusFromFailure("ocr_too_old", "ocr 版本太老（需要 1.9.0+）");
  assert.equal(out.installed, true);
  assert.equal(out.tooOld, true);
  assert.equal(out.error, "too-old");
});

// ---- 顺手核对：假 ocr 走的确实是生产那条解析路径
await check("假 ocr 与生产同一条解析路径（cmd.exe /c ocr）", () => {
  const probe = spawnSync(process.platform === "win32" ? "cmd.exe" : "sh", process.platform === "win32" ? ["/c", "ocr", "version"] : ["-c", "ocr version"], { encoding: "utf8", env: process.env });
  assert.equal(probe.status, 0, probe.stderr || `exit ${probe.status}`);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} 条失败`);
  process.exit(1);
}
console.log("\n全部通过");
