#!/usr/bin/env node
/**
 * 启动前的端口检查（`scripts/preflight.mjs`）的纯函数部分：认人与提问（D441）。
 *
 * 进程边界上的行为（真起一份桩、真停掉它）在 `bridge/tests/start-preflight.mjs`；
 * 这里考两件不需要真进程的事：
 *   - 「命令行里是桥入口才算自己人」这条判断（认错了就会去杀别人的服务）；
 *   - 提问函数：回车=是、n=否、看不懂重问、EOF=没回答 —— 仓库里没有 pty，就注入假 TTY。
 */
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { askReplace, forceRequested, looksLikeBridge } from "../../scripts/preflight.mjs";

/** 假 TTY：输入按行喂（喂完就 EOF），输出收成字符串。 */
function fakeTty(lines) {
  const input = Readable.from(lines.map((l) => `${l}\n`));
  input.isTTY = true;
  let text = "";
  const output = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  output.isTTY = true;
  return { input, output, text: () => text };
}

// 1. 回车 = 替换（默认 Y），提示里要看得见 [Y/n]。
{
  const tty = fakeTty([""]);
  assert.equal(await askReplace({ stdin: tty.input, stdout: tty.output }), true);
  assert.match(tty.text(), /\[Y\/n\]/);
}

// 2. n 就是不动手。
{
  const tty = fakeTty(["n"]);
  assert.equal(await askReplace({ stdin: tty.input, stdout: tty.output }), false);
}

// 3. 大写 / 全词也认。
{
  const tty = fakeTty(["Y"]);
  assert.equal(await askReplace({ stdin: tty.input, stdout: tty.output }), true);
  const tty2 = fakeTty(["no"]);
  assert.equal(await askReplace({ stdin: tty2.input, stdout: tty2.output }), false);
}

// 4. 看不懂就再问一次，别把「maybe」当成默认 Y。
{
  const tty = fakeTty(["maybe", "n"]);
  assert.equal(await askReplace({ stdin: tty.input, stdout: tty.output }), false);
  assert.equal(tty.text().match(/\[Y\/n\]/g)?.length, 2, "重问应当把提示再打一遍");
}

// 5. EOF（Ctrl-D / 输入结束）算「没回答」：既不替换也不静默替换。
{
  const tty = fakeTty([]);
  assert.equal(await askReplace({ stdin: tty.input, stdout: tty.output }), null);
}

// 6. `--force` / `PI_START_FORCE=1`（非交互场景的明确授权）。
assert.equal(forceRequested(["--force"], {}), true);
assert.equal(forceRequested([], { PI_START_FORCE: "1" }), true);
assert.equal(forceRequested([], { PI_START_FORCE: "" }), false);
assert.equal(forceRequested(["--port", "7865"], {}), false);

// 7. 认人：命令行里带桥入口（哪份检出、正斜杠反斜杠都算），别的程序一律不算。
assert.equal(looksLikeBridge("node C:\\repo\\bridge\\dist\\host.js"), true);
assert.equal(looksLikeBridge("node /repo/bridge/dist/host.js"), true);
assert.equal(looksLikeBridge('"C:\\\\Program Files\\\\node.exe" F:/wt/x/bridge/dist/index.js'), true);
assert.equal(looksLikeBridge("node /repo/other/server.js"), false);
assert.equal(looksLikeBridge("node /repo/bridge/dist/helper.js"), false);
assert.equal(looksLikeBridge(""), false);

console.log("preflight-unit: ok");
