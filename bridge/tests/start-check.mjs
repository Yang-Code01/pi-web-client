#!/usr/bin/env node
/**
 * `npm start` 前的扩展检查（`node scripts/bootstrap.mjs --start`，D224）。
 *
 * 桩 pi（PI_BIN）只会 `list`：打印 FAKE_LIST 指定的包，并在 FAKE_COUNT 文件里记一次调用，
 * 用来确认「齐了就记住，下次不再跑 18 秒的 pi list」。状态目录、pi 的 agent 目录都在临时目录里，
 * 不碰用户真实的 `~/.pi/agent`。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BOOTSTRAP = path.join(ROOT, "scripts", "bootstrap.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-start-check-"));

// findPi() 按 <cli 所在目录>/../.. 读 package.json 的版本。
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9" }));
const cliDir = path.join(tmp, "pkg", "dist");
fs.mkdirSync(cliDir, { recursive: true });
const FAKE_PI = path.join(cliDir, "cli.mjs");
fs.writeFileSync(
  FAKE_PI,
  `import fs from "node:fs";
if (process.argv[2] !== "list") process.exit(2);
if (process.env.FAKE_COUNT) fs.appendFileSync(process.env.FAKE_COUNT, "x");
if (process.env.FAKE_FAIL) { console.error("boom"); process.exit(3); }
process.stdout.write(fs.readFileSync(process.env.FAKE_LIST, "utf8"));
`,
);

const pkgDir = (name, version) => {
  const dir = path.join(tmp, "pkgs", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  return dir;
};
const ALL = [
  ["pi-subagents", "0.86.0"],
  ["@juicesharp/rpiv-ask-user-question", "2.15.0"],
  ["@juicesharp/rpiv-todo", "2.15.0"],
  ["pi-web-access", "0.1.0"],
];
const listText = (names) =>
  "User packages:\n" +
  ALL.filter(([n]) => names.includes(n))
    .map(([n, v]) => `  npm:${n}\n    ${pkgDir(n, v)}\n`)
    .join("");

let n = 0;
function start({ installed = ALL.map(([name]) => name), env = {} } = {}) {
  n += 1;
  const state = env.PI_WEB_STATE ?? path.join(tmp, `state-${n}`);
  const agent = env.PI_CODING_AGENT_DIR ?? path.join(tmp, `agent-${n}`);
  fs.mkdirSync(agent, { recursive: true });
  const list = path.join(tmp, `list-${n}.txt`);
  fs.writeFileSync(list, listText(installed));
  const count = path.join(tmp, `count-${n}.txt`);
  const childEnv = { ...process.env, PI_BIN: FAKE_PI, PI_WEB_STATE: state, PI_CODING_AGENT_DIR: agent, FAKE_LIST: list, FAKE_COUNT: count, ...env };
  delete childEnv.CI;
  delete childEnv.PI_AGENT_DIR;
  if (!("PI_WEB_NO_AUTOINSTALL" in env)) delete childEnv.PI_WEB_NO_AUTOINSTALL;
  const r = spawnSync(process.execPath, [BOOTSTRAP, "--start"], { encoding: "utf8", env: childEnv, timeout: 60_000 });
  const calls = fs.existsSync(count) ? fs.readFileSync(count, "utf8").length : 0;
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls, state, agent };
}

// 1. 都装了：放行，并记住这次结果。
const ok = start();
assert.equal(ok.code, 0, ok.out);
assert.equal(ok.calls, 1);
assert.match(ok.out, /扩展齐了/);

// 2. 什么都没变：不再跑 pi list，直接放行。
const again = start({ env: { PI_WEB_STATE: ok.state, PI_CODING_AGENT_DIR: ok.agent } });
assert.equal(again.code, 0, again.out);
assert.equal(again.calls, 0, "缓存命中时不该再问 pi list");

// 3. pi 的 settings.json 变了（装 / 卸过扩展）：重新问。
fs.writeFileSync(path.join(ok.agent, "settings.json"), JSON.stringify({ packages: [] }));
const changed = start({ env: { PI_WEB_STATE: ok.state, PI_CODING_AGENT_DIR: ok.agent } });
assert.equal(changed.calls, 1, "settings.json 变了要重新确认");

// 4. 缺 rpiv-todo：拦下，说缺哪个、先跑 npm install。
const miss = start({ installed: ["pi-subagents", "@juicesharp/rpiv-ask-user-question", "pi-web-access"] });
assert.equal(miss.code, 1, miss.out);
assert.match(miss.out, /rpiv-todo/);
assert.match(miss.out, /npm install/);
assert.doesNotMatch(miss.out, /rpiv-ask-user-question/, "只列缺的");

// 5. 缺了不记缓存：补上之前每次都要拦。
const missAgain = start({ installed: ["pi-subagents"], env: { PI_WEB_STATE: miss.state } });
assert.equal(missAgain.code, 1);

// 6. 关了自动安装：npm install 不会装，所以给手动 pi install 的命令。
const noAuto = start({ installed: ["pi-subagents"], env: { PI_WEB_NO_AUTOINSTALL: "1" } });
assert.equal(noAuto.code, 1, noAuto.out);
assert.match(noAuto.out, /pi install npm:@juicesharp\/rpiv-todo@2\.15\.0/);

// 7. pi list 跑不起来：说一声，照常启动（不因为查不了就挡人）。
const fail = start({ env: { FAKE_FAIL: "1" } });
assert.equal(fail.code, 0, fail.out);
assert.match(fail.out, /没法确认/);

// 8. pi 太旧：拦下（npm install 会升级 pi）。
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.1.0" }));
const old = start();
assert.equal(old.code, 1, old.out);
assert.match(old.out, /0\.1\.0/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("start-check: 8 cases passed");
