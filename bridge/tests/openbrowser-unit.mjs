/**
 * 「npm start 之后自己开页面」的判断（`bridge/src/openbrowser.ts`）。
 *
 * 只测纯函数：不该在这里真的拉起浏览器 —— 那会在跑测试的机器上弹出窗口，
 * 而真正是否开得成由系统默认浏览器决定。
 *
 *   node --experimental-strip-types bridge/tests/openbrowser-unit.mjs
 */
import assert from "node:assert/strict";
import { browserCommand, shouldOpenPage } from "../src/openbrowser.ts";

// ------------------------------------------------ 什么时候开

assert.equal(shouldOpenPage({}, true), true, "接在终端上手敲的启动：开");
assert.equal(shouldOpenPage({}, false), false, "输出走管道/文件（看门狗、热部署、测试环境）：不开");

for (const flag of ["1", "true", "TRUE"]) {
  assert.equal(shouldOpenPage({ PI_WEB_OPEN: flag }, false), true, `PI_WEB_OPEN=${JSON.stringify(flag)} 强制开`);
}
for (const flag of ["0", "false", " False "]) {
  assert.equal(shouldOpenPage({ PI_WEB_OPEN: flag }, true), false, `PI_WEB_OPEN=${JSON.stringify(flag)} 强制关`);
}
assert.equal(shouldOpenPage({ PI_WEB_OPEN: "" }, true), true, "空字符串按没写处理");
assert.equal(shouldOpenPage({ PI_WEB_OPEN: "maybe" }, false), false, "看不懂的值回落到终端判断");
assert.equal(shouldOpenPage({ PI_WEB_OPEN: "maybe" }, true), true, "看不懂的值不越权关掉");

// ------------------------------------------------ 用什么命令开

const url = "http://127.0.0.1:7864";
const win = browserCommand(url, "win32");
assert.equal(win.cmd, "cmd.exe");
assert.deepEqual(win.args, ["/c", "start", "", url], "空的窗口标题占住 start 的第一个参数，URL 才不被当成标题");

const mac = browserCommand(url, "darwin");
assert.deepEqual(mac, { cmd: "open", args: [url] });

const linux = browserCommand(url, "linux");
assert.deepEqual(linux, { cmd: "xdg-open", args: [url] });

console.log("ok openbrowser-unit");
