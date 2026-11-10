/**
 * 「pi 装在哪」这张候选表（`bridge/src/pi.ts` 的 `piCandidates`）：拼路径的规矩，不跑真 pi。
 *
 * 为什么值得单测：这条表错了不会报错，只会**假装**机器上没装 pi —— 于是 `npm install` 去重装，
 * 撞上 npm ≥ 12 的 `allow-remote=none` 就整段失败；桥起来后 `resolvePi()` 更是直接抛异常。
 * 曾经三处一起错：POSIX 的全局包在 `<前缀>/lib/node_modules`（表里写的是 `bin/node_modules`）、
 * `npm root -g` 的结果再拼一层 `node_modules`、`bin/pi` 这个 symlink 被 `statSync` 的大小挡掉。
 *
 *   node --experimental-transform-types bridge/tests/pi-candidates-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { piCandidates, readVersion } from "../src/pi.ts";

const PKG_IN_NM = path.join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
/** 假探针：不问真 npm、不读真 PATH，只看拼出来的路径。 */
const fake = (over = {}) => ({
  platform: "linux",
  execPath: "/opt/node/bin/node",
  pathEnv: "",
  env: {},
  npmRoot: null,
  ...over,
});

// ---------------------------------------------------------------- POSIX 前缀

{
  const got = piCandidates(fake());
  const want = path.join("/opt/node", "lib", "node_modules", PKG_IN_NM);
  assert.ok(got.includes(want), `POSIX 全局包在 <前缀>/lib/node_modules：${got.join(", ")}`);
  assert.ok(
    !got.some((c) => c.includes(path.join("bin", "node_modules", "@earendil-works"))),
    "`<前缀>/bin/node_modules` 是 POSIX 上的错位置",
  );
}

// nvm：当前 node 自己那一份排最前，别的版本也留着（跑桥的 node 未必是装 pi 的那个）。
{
  const nvm = "/home/me/.nvm/versions/node";
  const prevExecPath = "/home/me/.nvm/versions/node/v24.1.0/bin/node";
  const got = piCandidates(fake({ execPath: prevExecPath, env: { HOME: "/home/me", NVM_DIR: nvm } }));
  assert.equal(got[0], path.join(nvm, "v24.1.0", "lib", "node_modules", PKG_IN_NM), "当前版本先试");
}

// ---------------------------------------------------------------- npm root -g

{
  const got = piCandidates(fake({ npmRoot: () => "/usr/lib/node_modules" }));
  assert.ok(got.includes(path.join("/usr/lib/node_modules", PKG_IN_NM)));
  assert.ok(
    !got.some((c) => c.includes(`${path.sep}node_modules${path.sep}node_modules${path.sep}`)),
    `npm root -g 已经是 node_modules 那一层，不能再拼一次：${got.join(", ")}`,
  );
}

// 和 POSIX 前缀算出来是同一个位置时只留一条（Set 去重）。
{
  const got = piCandidates(fake({ npmRoot: () => "/opt/node/lib/node_modules" }));
  const want = path.join("/opt/node", "lib", "node_modules", PKG_IN_NM);
  assert.equal(got.filter((c) => c === want).length, 1);
}

// ---------------------------------------------------------------- PATH 上的启动器

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-candidates-"));
  try {
    // POSIX：npm 把 bin/pi 做成指向 cli.js 的软链。内容只有几行，但 statSync 会跟到 bundle 上。
    const pkgRoot = path.join(tmp, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(path.join(pkgRoot, "dist", "bundle"), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ version: "9.9.9" }));
    const cli = path.join(pkgRoot, "dist", "bundle", "cli.js");
    fs.writeFileSync(cli, '#!/usr/bin/env node\nimport "./cli-runtime.js";\n');
    fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
    fs.symlinkSync(cli, path.join(tmp, "bin", "pi"));

    const got = piCandidates(fake({ pathEnv: path.join(tmp, "bin"), env: { HOME: "" } }));
    // 比 realpath：macOS 的 /tmp 本身就是软链，realpathSync 会换成 /private/var/...
    assert.ok(got.includes(fs.realpathSync(cli)), `软链要跟到真 cli.js：${got.join(", ")}`);

    // Windows：启动器脚本里写死真路径，读出来。
    const cmd = path.join(tmp, "bin", "pi.cmd");
    fs.writeFileSync(cmd, `@node.exe "C:\\apps\\pi\\${PKG_IN_NM}" %*\r\n`);
    const win = piCandidates(fake({ platform: "win32", pathEnv: path.join(tmp, "bin") }));
    // 分隔符在 POSIX 上跑测试时会混（内容里是 `\`，path.join 给的是 `/`），只看头尾。
    assert.ok(
      win.some((c) => /^C:[\\/]apps[\\/]pi[\\/]/.test(c) && c.includes("pi-coding-agent")),
      `pi.cmd 里的路径：${win.join(", ")}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- Windows nvm / APPDATA

{
  const appdata = "C:/Users/me/AppData";
  const got = piCandidates(fake({ platform: "win32", env: { APPDATA: appdata, LOCALAPPDATA: `${appdata}/Local` } }));
  assert.ok(got.some((c) => c.includes(`npm${path.sep}node_modules`)), "APPDATA\\npm\\node_modules");
  assert.ok(
    !got.some((c) => c.includes(`${path.sep}lib${path.sep}node_modules`)),
    "Windows 上没有 lib/node_modules 这一层",
  );
}

// PI_BIN 永远第一优先。
{
  const got = piCandidates(fake({ env: { PI_BIN: "/custom/cli.js" } }));
  assert.equal(got[0], "/custom/cli.js");
}

// readVersion 从 cli.js 往上三层找 package.json（`pi update` 换掉包之后要重读，所以是函数）。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-version-"));
  try {
    const pkgRoot = path.join(tmp, "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(path.join(pkgRoot, "dist", "bundle"), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const cli = path.join(pkgRoot, "dist", "bundle", "cli.js");
    fs.writeFileSync(cli, "//\n");
    assert.equal(readVersion(cli), "1.2.3");
    assert.equal(readVersion("/nope/cli.js"), "unknown");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("ok — pi candidate paths");
