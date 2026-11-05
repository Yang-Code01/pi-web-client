/**
 * 随手问的地盘（#86）：临时会话目录算在哪、怎么清。
 *
 * 纯函数级：直接 import paths.ts，不启动桥、不 spawn pi。这里钉的是「清空是幂等的、无条件安全的」
 * —— 桥启动时正是靠这一点，在任何会话存在之前把整个目录擦掉。
 *
 *   node bridge/tests/scratch-dirs.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetScratchDir, scratchCwd, scratchRoot, scratchSessionsDir, statePath } from "../src/paths.ts";

const KEY = "PI_WEB_STATE";
const saved = process.env[KEY];
const ROOT = path.join(os.tmpdir(), `pi-web-scratch-dirs-${process.pid}`);
fs.rmSync(ROOT, { recursive: true, force: true });

let n = 0;
const ok = (msg) => console.log(`  ok ${++n}  ${msg}`);

try {
  process.env[KEY] = ROOT;

  assert.equal(scratchRoot(), path.join(ROOT, "scratch"));
  assert.equal(scratchSessionsDir(), path.join(ROOT, "scratch", "sessions"));
  assert.equal(scratchCwd(), path.join(ROOT, "scratch", "cwd"));
  ok("三个路径都挂在 PI_WEB_STATE 下面（多开的第二份桥天然各清各的）");

  // 它必须在 pi 的会话根目录**之外**，否则就会被扫进列表。
  const { sessionsRoot } = await import("../src/paths.ts");
  assert.notEqual(path.dirname(scratchSessionsDir()), sessionsRoot());
  ok("临时会话目录不在 pi 的会话根目录里");

  resetScratchDir();
  assert.ok(fs.statSync(scratchSessionsDir()).isDirectory());
  assert.ok(fs.statSync(scratchCwd()).isDirectory());
  ok("第一次清理会建出两个空目录");

  fs.writeFileSync(path.join(scratchSessionsDir(), "leftover.jsonl"), "{}\n");
  fs.writeFileSync(path.join(scratchCwd(), "note.txt"), "x");
  resetScratchDir();
  assert.deepEqual(fs.readdirSync(scratchSessionsDir()), []);
  assert.deepEqual(fs.readdirSync(scratchCwd()), []);
  ok("残留（崩溃留下的会话文件、中性目录里的东西）被一起清掉");

  fs.rmSync(scratchRoot(), { recursive: true, force: true });
  resetScratchDir();
  assert.ok(fs.existsSync(scratchSessionsDir()));
  ok("目录整个不见了也不抛，直接重建");

  // 启动路径的语义：可以对着已经清空的目录再清一次。
  resetScratchDir();
  resetScratchDir();
  assert.deepEqual(fs.readdirSync(scratchRoot()).sort(), ["cwd", "sessions"]);
  ok("重复清理是幂等的，不会把目录删没了");
} finally {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
  fs.rmSync(ROOT, { recursive: true, force: true });
}

void statePath;
console.log(`\n${n} 项通过`);
