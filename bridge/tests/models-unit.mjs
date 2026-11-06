/**
 * D150 · `fetchModels` 的两条路与两种失败，都不需要真 pi、不需要模型：
 *
 *  - 完整那趟不带 `-ne`（要看得到扩展注册的模型）；
 *  - 快那趟带 `-ne --no-session`（1–2 s，先给面板）；
 *  - 子进程中途退出 → 立刻报错并带上它的 stderr，而不是干等满超时；
 *  - 一直不回 → 到点报超时。
 *
 *   node bridge/tests/models-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchModels } from "../src/pi.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fixtures", "fake-pi.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-models-"));
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name} — ${err.message}`);
  }
};

/** The fake notes every child it starts; the last argv line is the one this call used. */
const argvOf = (logPath) => {
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return lines.filter((l) => l.t === "argv").at(-1).argv;
};

const LOG = path.join(tmp, "pi.jsonl");
process.env.FAKE_PI_LOG = LOG;

// 1. 完整那趟：不带 -ne ------------------------------------------------------
const full = await fetchModels(FAKE);
check("full pass keeps extensions on", () => {
  assert.deepEqual(argvOf(LOG), ["--mode", "rpc"]);
});
check("full pass maps the model list", () => {
  assert.equal(full.length, 2);
  const [first] = full;
  assert.equal(first.id, "fake-model");
  assert.equal(first.provider, "stub");
  assert.deepEqual(first.levels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(first.contextWindow, 200000);
  assert.equal(first.supportsImages, false);
});

// 2. 快那趟：-ne --no-session ------------------------------------------------
const fast = await fetchModels(FAKE, { fast: true });
check("fast pass skips extensions and the session file", () => {
  assert.deepEqual(argvOf(LOG), ["--mode", "rpc", "-ne", "--no-session"]);
  assert.equal(fast.length, 2);
});

// 3. 子进程还没回就退出 ------------------------------------------------------
const die = path.join(tmp, "die.mjs");
fs.writeFileSync(die, 'process.stderr.write("boom: extension crashed\\n");\nprocess.exit(3);\n');
const died = await fetchModels(die).then(
  () => null,
  (err) => err,
);
check("a child that exits is an error, not a wait", () => {
  assert.ok(died, "should reject");
  assert.match(died.message, /退出了（code 3）/);
  assert.match(died.message, /boom: extension crashed/);
});

// 4. 一直不回就超时 ----------------------------------------------------------
const hang = path.join(tmp, "hang.mjs");
fs.writeFileSync(hang, "process.stdin.resume();\nsetInterval(() => {}, 1e9);\n");
const started = Date.now();
const hung = await fetchModels(hang, { timeoutMs: 1200 }).then(
  () => null,
  (err) => err,
);
check("a silent child times out with the budget in the message", () => {
  assert.ok(hung, "should reject");
  assert.match(hung.message, /超时（1s）/);
  assert.ok(Date.now() - started < 8000, "must not wait for the 45 s default");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall ok");
process.exit(failures ? 1 : 0);
