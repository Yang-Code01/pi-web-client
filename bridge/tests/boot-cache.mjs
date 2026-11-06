/**
 * pi 子进程的 V8 编译缓存（D… 见 PR）必须真的传下去。
 *
 * 每次 `pi --mode rpc` 冷启都要重新解析同一个 ~9.4 MB 的 bundle；把子进程指向一个固定的
 * `NODE_COMPILE_CACHE` 目录，下一次启动就是读已经编译好的代码。本机实测（全量扩展）：
 * 8.6 / 7.6 / 23.9 s → 6.3 / 6.3 / 10.0 s。
 *
 * 这里只钉住契约，不测速度（速度依赖机器，测了会抖）：
 *   1. `piChildEnv()` 默认给出 `<stateDir>/v8-cache`，并且目录被建出来；
 *   2. 调用方自己设了 `NODE_COMPILE_CACHE` 时，桥不覆盖它；
 *   3. `PI_WEB_*` 仍然不外泄给 pi（原有契约，别被这次改动带坏）。
 *
 * Run: npm --prefix bridge run build && node bridge/tests/boot-cache.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE = path.join(REPO, ".scratch", "boot-cache", "state");

// paths.ts 在 import 时读 process.env，所以先摆好再动态 import。
process.env.PI_WEB_STATE = STATE;
delete process.env.NODE_COMPILE_CACHE;
process.env.PI_WEB_ASK_TOKEN = "must-not-leak";

const { piChildEnv, v8CacheDir } = await import(pathToFileURL(path.join(REPO, "bridge", "dist", "paths.js")).href);

const cache = path.join(STATE, "v8-cache");
assert.equal(v8CacheDir(), cache, "cache dir lives under the bridge's state dir");

const env = piChildEnv();
assert.equal(env.NODE_COMPILE_CACHE, cache, "pi children get the compile cache");
assert.ok(fs.statSync(cache).isDirectory(), "the cache directory is created before the spawn");
assert.equal(env.PI_WEB_ASK_TOKEN, undefined, "PI_WEB_* still never reaches pi");

process.env.NODE_COMPILE_CACHE = "D:\\elsewhere";
assert.equal(piChildEnv().NODE_COMPILE_CACHE, "D:\\elsewhere", "an explicit setting wins");
delete process.env.NODE_COMPILE_CACHE;

// 状态目录不可写时只该少省几秒，不该让 spawn 直接失败。
process.env.PI_WEB_STATE = path.join(REPO, "bridge", "package.json", "impossible");
const broken = piChildEnv();
assert.equal(broken.NODE_COMPILE_CACHE, undefined, "an unusable state dir degrades, it does not throw");

console.log("boot-cache: ok");
