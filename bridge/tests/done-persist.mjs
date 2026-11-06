/**
 * D162 的纯逻辑验证：`finished.json` 读回、mtime 取代「打开时刻」、桥停机期间终端续写使完成过期、
 * 停止 tail 后再恢复不会把「完成」当成外部写入。
 *
 * 不需要真 pi / 浏览器；用 `bridge/dist/sessions.js`，先 `npm run build:bridge`。
 *
 *   npm run test:done
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-done-"));
process.env.PI_WEB_STATE = STATE;

const now = Date.now();
const fresh = "aaaa1111";
const stale = "bbbb2222";
const resumed = "cccc3333";

const resumedFile = path.join(STATE, `${resumed}.jsonl`);
fs.writeFileSync(resumedFile, `${JSON.stringify({ type: "session", id: resumed })}\n`);
const resumedMtime = fs.statSync(resumedFile).mtimeMs;

// fresh: 文件最后写入 39s 前，完成标记 38s 前（写完才 settle）—— 应当保留。
// stale: 完成标记 60s 前，文件 10s 前又被写过（桥停机期间终端续写）—— 应当过期。
// resumed: 完成标记比文件晚 500ms；后面用它模拟 tail 停止期间的一次小写入与一次终端续写。
fs.writeFileSync(
  path.join(STATE, "finished.json"),
  JSON.stringify({ [fresh]: now - 38000, [stale]: now - 60000, [resumed]: resumedMtime + 500 }),
);

const { Session } = await import("../dist/sessions.js");
const meta = (id, mtime, file) => ({
  file,
  id,
  cwd: process.cwd(),
  startedAt: new Date().toISOString(),
  name: null,
  nameAt: null,
  firstUserText: null,
  mtime,
});

const checks = [];
const check = (name, pass) => checks.push([name, pass]);

const a = new Session(process.execPath, meta(fresh, now - 39000, path.join(STATE, `${fresh}.jsonl`)));
const b = new Session(process.execPath, meta(stale, now - 10000, path.join(STATE, `${stale}.jsonl`)));

check("fresh: done 从 finished.json 读回", a.state.done === true);
check("fresh: updatedAt 取文件 mtime，不是打开时刻", a.state.updatedAt === now - 39000);
check("stale: 文件比完成标记新 → done=false", b.state.done === false);

// 停止 tail（sleep / 让回终端）后再恢复：我们自己的 pi 在 settle 之后可能还写一次文件。
const c = new Session(process.execPath, meta(resumed, resumedMtime, resumedFile));
check("resumed: 构造时完成仍在", c.state.done === true);

c.startTail();
c.stopTail();
// 300ms after the mark: still inside the filesystem skew, must not count as a terminal write.
fs.utimesSync(resumedFile, (resumedMtime + 300) / 1000, (resumedMtime + 300) / 1000);
c.startTail();
check("resumed: stopTail 后恢复 tail 不清完成", c.state.done === true);
c.stopTail();

// 3s after the mark: the bridge was down and the terminal kept writing — that 完成 is stale.
fs.utimesSync(resumedFile, (resumedMtime + 3000) / 1000, (resumedMtime + 3000) / 1000);
c.startTail();
check("resumed: 停机期间被续写 → 完成过期", c.state.done === false);
c.stopTail();

const persisted = JSON.parse(fs.readFileSync(path.join(STATE, "finished.json"), "utf8"));
check("stale: 过期的完成标记被清出 finished.json", !(stale in persisted));
check("resumed: 过期后完成标记也被清掉", !(resumed in persisted));
check("fresh: 未过期的完成标记仍在文件里", fresh in persisted);

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}`);
  if (!pass) ok = false;
}
fs.rmSync(STATE, { recursive: true, force: true });
if (!ok) assert.fail(`${checks.filter(([, p]) => !p).length} check(s) failed`);
console.log(`ALL OK — ${checks.length} checks`);
