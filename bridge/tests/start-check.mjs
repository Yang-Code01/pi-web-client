#!/usr/bin/env node
/**
 * `npm start` 前的扩展检查（`node scripts/bootstrap.mjs --start`，D224）与整备脚本的
 * 「升到下限」这一半（D393）。
 *
 * 桩 pi（PI_BIN）只认 `list` / `install`：`list` 打印 FAKE_LIST 指定的包，并在 FAKE_COUNT
 * 文件里记一次调用（用来确认「齐了就记住，下次不再跑 18 秒的 pi list」）；`install` 把参数
 * 追加进 FAKE_INSTALL，什么也不装。桩 npm（`npm_execpath` 指向一个叫 `npm-cli.js` 的文件）
 * 只记一笔就退出 0，所以整备脚本的第三段（三个子包的依赖）不会真的去装东西。
 *
 * 状态目录、pi 的 agent 目录都在临时目录里，不碰用户真实的 `~/.pi/agent`。
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
const cmd = process.argv[2];
if (cmd === "list") {
  if (process.env.FAKE_COUNT) fs.appendFileSync(process.env.FAKE_COUNT, "x");
  if (process.env.FAKE_FAIL) { console.error("boom"); process.exit(3); }
  process.stdout.write(fs.readFileSync(process.env.FAKE_LIST, "utf8"));
  process.exit(0);
}
if (cmd === "install") {
  if (process.env.FAKE_INSTALL) fs.appendFileSync(process.env.FAKE_INSTALL, process.argv.slice(3).join(" ") + "\\n");
  process.exit(0);
}
process.exit(2);
`,
);

// 桩 npm：bootstrap 认 `npm_execpath` 里那个以 npm-cli.js 结尾、且真的存在的文件。
const fakeNpm = path.join(tmp, "stub", "npm-cli.js");
fs.mkdirSync(path.dirname(fakeNpm), { recursive: true });
fs.writeFileSync(fakeNpm, `import fs from "node:fs";\nif (process.env.FAKE_NPM_LOG) fs.appendFileSync(process.env.FAKE_NPM_LOG, process.argv.slice(2).join(" ") + "\\n");\n`);

const pkgDir = (name, version) => {
  const dir = path.join(tmp, "pkgs", ...name.split("/"), version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  return dir;
};
/** 装着的包：`"name"` 用它在下限表里那一版，`["name", "1.2.3"]` 指定一版。 */
const ALL = [
  ["pi-subagents", "0.90.0"],
  ["@juicesharp/rpiv-ask-user-question", "2.15.0"],
  ["@juicesharp/rpiv-todo", "2.15.0"],
  ["pi-web-access", "0.1.0"],
];
const versionOf = (name, override) => {
  const hit = ALL.find(([n]) => n === name);
  return override ?? hit?.[1] ?? "0.0.0";
};
const listText = (installed) =>
  "User packages:\n" +
  installed
    .map((item) => (Array.isArray(item) ? item : [item, versionOf(item)]))
    .map(([n, v]) => `  npm:${n}\n    ${pkgDir(n, v)}`)
    .join("\n");

let n = 0;
function run({ installed = ALL.map(([name]) => name), env = {}, args = ["--start"], npmEnv } = {}) {
  n += 1;
  const state = env.PI_WEB_STATE ?? path.join(tmp, `state-${n}`);
  const agent = env.PI_CODING_AGENT_DIR ?? path.join(tmp, `agent-${n}`);
  fs.mkdirSync(agent, { recursive: true });
  const list = path.join(tmp, `list-${n}.txt`);
  fs.writeFileSync(list, listText(installed));
  const count = path.join(tmp, `count-${n}.txt`);
  const instFile = path.join(tmp, `install-${n}.txt`);
  const childEnv = {
    ...process.env,
    PI_BIN: FAKE_PI,
    PI_WEB_STATE: state,
    PI_CODING_AGENT_DIR: agent,
    FAKE_LIST: list,
    FAKE_COUNT: count,
    FAKE_INSTALL: instFile,
    FAKE_NPM_LOG: path.join(tmp, `npm-${n}.txt`),
    npm_execpath: npmEnv ?? fakeNpm,
    ...env,
  };
  delete childEnv.CI;
  delete childEnv.PI_AGENT_DIR;
  if (!("PI_WEB_NO_AUTOINSTALL" in env)) delete childEnv.PI_WEB_NO_AUTOINSTALL;
  const r = spawnSync(process.execPath, [BOOTSTRAP, ...args], { encoding: "utf8", env: childEnv, timeout: 120_000 });
  const calls = fs.existsSync(count) ? fs.readFileSync(count, "utf8").length : 0;
  const installs = fs.existsSync(instFile) ? fs.readFileSync(instFile, "utf8").trim().split("\n").filter(Boolean) : [];
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls, installs, state, agent };
}
const start = (opts) => run({ ...opts, args: ["--start"] });
const bootstrap = (opts) => run({ ...opts, args: [] });

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

// 6. 关了自动安装：npm install 不会装，所以给手动 pi install 的命令 —— 只给缺的。
const noAuto = start({ installed: ["pi-subagents"], env: { PI_WEB_NO_AUTOINSTALL: "1" } });
assert.equal(noAuto.code, 1, noAuto.out);
assert.match(noAuto.out, /pi install npm:@juicesharp\/rpiv-todo@2\.15\.0/);
assert.doesNotMatch(noAuto.out, /pi install npm:pi-subagents/, "齐的不该叫人再装");

// 6b. 换了 pi 的 agent 目录（PI_CODING_AGENT_DIR），哪怕 settings.json 一模一样，也要重新确认。
const agentA = path.join(tmp, "agent-A");
const agentB = path.join(tmp, "agent-B");
for (const dir of [agentA, agentB]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), "{}");
  fs.utimesSync(path.join(dir, "settings.json"), 1_700_000_000, 1_700_000_000);
}
const stateAB = path.join(tmp, "state-AB");
const onA = start({ env: { PI_WEB_STATE: stateAB, PI_CODING_AGENT_DIR: agentA } });
assert.equal(onA.code, 0, onA.out);
const onB = start({ installed: ["pi-subagents"], env: { PI_WEB_STATE: stateAB, PI_CODING_AGENT_DIR: agentB } });
assert.equal(onB.calls, 1, "换了 agent 目录不能沿用上一个目录的「齐了」");
assert.equal(onB.code, 1, onB.out);

// 7. pi list 跑不起来：说一声，照常启动（不因为查不了就挡人）。
const fail = start({ env: { FAKE_FAIL: "1" } });
assert.equal(fail.code, 0, fail.out);
assert.match(fail.out, /没法确认/);

// 8. 低于下限也是「没备齐」：拦下来，并且说清是旧、不是缺（D393）。
const belowFloor = start({
  installed: [["pi-subagents", "0.86.0"], "@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo", "pi-web-access"],
  env: { PI_WEB_NO_AUTOINSTALL: "1" },
});
assert.equal(belowFloor.code, 1, belowFloor.out);
assert.match(belowFloor.out, /0\.86\.0/, "要说出现在是哪个版本");
assert.match(belowFloor.out, /0\.90\.0/, "要说出该升到哪个版本");
assert.match(belowFloor.out, /pi install npm:pi-subagents@0\.90\.0/, "给一条能直接粘贴的命令");
assert.doesNotMatch(belowFloor.out, /rpiv/, "其余齐的不该被一起点名");

// 8b. 比下限新：跟齐了一样放行 —— 不降级、不提示。
for (const newer of ["0.90.0", "0.92.0", "1.0.0"]) {
  const up = start({
    installed: [["pi-subagents", newer], "@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo", "pi-web-access"],
  });
  assert.equal(up.code, 0, `${newer} 应该放行：${up.out}`);
  assert.doesNotMatch(up.out, /旧/, "新于下限不该提「旧」");
}

// 8c. 到了下限就算齐：记住结论，下一次不再跑 pi list（这一查要十几秒）。
const atFloor = start({
  installed: ["pi-subagents", "@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo", "pi-web-access"],
});
assert.equal(atFloor.code, 0, atFloor.out);
const againAtFloor = start({ env: { PI_WEB_STATE: atFloor.state, PI_CODING_AGENT_DIR: atFloor.agent } });
assert.equal(againAtFloor.code, 0, againAtFloor.out);
assert.equal(againAtFloor.calls, 0, "到了下限就记住，不该每次启动都问一遍 pi list");

// 9. 整备脚本（不带 --start）：低于下限就真的 pi install 到下限那一版。
const upgraded = bootstrap({
  installed: [["pi-subagents", "0.86.0"], "@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo", "pi-web-access"],
});
assert.equal(upgraded.code, 0, upgraded.out);
assert.deepEqual(upgraded.installs, ["npm:pi-subagents@0.90.0"], "只升这一个，落点是下限那版");
assert.match(upgraded.out, /0\.86\.0/, "说清从哪一版升上来");

// 9b. 齐了（含比下限新的）：一次 pi install 都不跑。
for (const version of ["0.90.0", "0.92.0"]) {
  const noop = bootstrap({
    installed: [[`pi-subagents`, version], "@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo", "pi-web-access"],
  });
  assert.equal(noop.code, 0, noop.out);
  assert.deepEqual(noop.installs, [], `${version} 不该被升或降`);
}

// 9c. --check 判「旧」不及格，但一个字节都不往全局目录写。
const checkOld = run({
  installed: [["pi-subagents", "0.86.0"], "@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo", "pi-web-access"],
  args: ["--check"],
});
assert.equal(checkOld.code, 1, checkOld.out);
assert.deepEqual(checkOld.installs, [], "--check 不许装东西");
assert.match(checkOld.out, /0\.90\.0/);

// 10. pi 太旧：拦下（npm install 会升级 pi）。
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.1.0" }));
const old = start();
assert.equal(old.code, 1, old.out);
assert.match(old.out, /0\.1\.0/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("start-check: ok");
