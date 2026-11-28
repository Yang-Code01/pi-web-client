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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  askReplace,
  forceRequested,
  localBase,
  looksLikeBridge,
} from "../../scripts/preflight.mjs";

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
// `npm start --force`：npm 把这个 flag 吃成自己的配置，只留一个环境变量给脚本。
assert.equal(forceRequested([], { npm_config_force: "true" }), true);
assert.equal(forceRequested([], { npm_config_force: "false" }), false);

// 7. 认人：命令行里带桥入口（哪份检出、正斜杠反斜杠都算），别的程序一律不算。
assert.equal(looksLikeBridge("node C:\\repo\\bridge\\dist\\host.js"), true);
assert.equal(looksLikeBridge("node /repo/bridge/dist/host.js"), true);
assert.equal(looksLikeBridge('"C:\\\\Program Files\\\\node.exe" F:/wt/x/bridge/dist/index.js'), true);
assert.equal(looksLikeBridge("node --enable-source-maps /repo/bridge/dist/index.js --port 7864"), true);
assert.equal(looksLikeBridge("node /repo/other/server.js"), false);
assert.equal(looksLikeBridge("node /repo/bridge/dist/helper.js"), false);
assert.equal(looksLikeBridge(""), false);
// 只看子串会误伤：备份文件、只有第一个词是 node 才算、以及「命令行里恰好提到入口名」的命令不是桥。
assert.equal(looksLikeBridge("node /repo/bridge/dist/host.js.bak"), false);
assert.equal(looksLikeBridge("node /repo/bridge/dist/host.js.old"), false);
assert.equal(looksLikeBridge("git add bridge/dist/index.js"), false);
assert.equal(looksLikeBridge("type bridge\\dist\\host.js"), false);
// 第一个词不是 node：入口名只是被当成参数提到，不能因此 taskkill 别人。
assert.equal(looksLikeBridge("echo node bridge/dist/index.js"), false);
assert.equal(looksLikeBridge("npm run x -- bridge/dist/index.js"), false);
assert.equal(looksLikeBridge("python C:/x/node bridge/dist/host.js"), false);
assert.equal(looksLikeBridge("node.exe /repo/bridge/dist/index.js"), true);
assert.equal(looksLikeBridge('"C:\\Program Files\\nodejs\\node.exe" F:\\wt\\feat\\x\\bridge\\dist\\host.js'), true);
// 开发态直接跑源码（tsx / --experimental-strip-types）也算自己人，否则 --force 也停不了它。
assert.equal(looksLikeBridge("node C:/repo/node_modules/tsx/dist/cli.mjs C:/repo/bridge/src/host.ts"), true);
assert.equal(looksLikeBridge("node --experimental-strip-types /repo/bridge/src/index.ts"), true);

// 8. 探活 / 停机打的地址跟着监听地址走：只听某个 LAN IP 时就打它（否则认不出壳、会误当旧桥硬杀），
//    通配地址换成回环（通配不是能连的目标）。
assert.equal(localBase("192.168.1.5", 7864), "http://192.168.1.5:7864");
assert.equal(localBase("0.0.0.0", 7864), "http://127.0.0.1:7864");
// `::` 是 v6 通配：回环是 `[::1]`。Linux 上 `bindv6only=1` 时 `::1` 能连、`127.0.0.1` 连不上。
assert.equal(localBase("::", 7864), "http://[::1]:7864");
assert.equal(localBase("[::]", 7864), "http://[::1]:7864");
assert.equal(localBase(undefined, 7864), "http://127.0.0.1:7864");
assert.equal(localBase("::1", 7864), "http://[::1]:7864");
assert.equal(localBase("fe80::1", 7864), "http://[fe80::1]:7864");

// 9. 默认端口 / 默认地址在两边各写一份（TS 与 mjs 没法共享常量，硬要共享得上 allowJs 或另起
//    package）。没人盯着就会一边改一边不改：preflight 放行的端口跟壳真正监听的端口对不上，
//    用户看到的是「检查通过、起来就 EADDRINUSE」。这里直接盯源码里的兜底字面量。
{
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const hostSrc = fs.readFileSync(path.join(REPO, "bridge/src/host.ts"), "utf8");
  assert.match(
    hostSrc,
    new RegExp(`return ${DEFAULT_PORT};`),
    `bridge/src/host.ts 的 readPort() 兜底不再是 ${DEFAULT_PORT}：两处默认端口必须一起改`,
  );
  assert.ok(
    hostSrc.includes(`return "${DEFAULT_HOST}";`),
    `bridge/src/host.ts 的 readHost() 兜底不再是 ${DEFAULT_HOST}：两处默认地址必须一起改`,
  );
}

console.log("preflight-unit: ok");
