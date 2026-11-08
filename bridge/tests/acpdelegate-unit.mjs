/**
 * 子代理页的 acp_delegate 那一半（#215）：写的是 billion-context 的配置文件，不是 settings.json。
 *
 * 这份文件里还躺着 `providers`（登录/路由）与 `sessions`（压缩状态），整份覆盖一次就全没了，
 * 所以这里守住四件事：① 深合并只替换 `pi.subagents`；② 解析不了就抛错、磁盘上一字未改；
 * ③ 文件/目录不存在时按「只有 pi.subagents」创建；④ 空值 = 删键（enabled 默认开、
 * maxConcurrent 默认不限）。
 *
 *   node bridge/tests/acpdelegate-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acpConfigPath, readAcpDelegate, writeAcpDelegate } from "../src/acpdelegate.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-acp-"));
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

let caseNo = 0;
/** 每个用例一个自己的目录，互不影响（也顺便验证「目录不存在时先建」）。 */
function target(name = `case-${(caseNo += 1)}`) {
  return path.join(root, name, "billion-context.json");
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};

check("深合并只动 pi.subagents：providers / sessions / 其它 pi 键原样保留", () => {
  const file = target();
  write(file, {
    port: 8787,
    providers: { "https://api.anthropic.com": { models: { "claude-sonnet-4-5": { context: 200000, output: 8192 } } } },
    sessions: { dir: "/tmp/bc-sessions", keep: true },
    pi: { subagents: { maxDepth: 2, displayUsage: "separate" }, other: 1 },
  });
  const view = writeAcpDelegate({ enabled: false }, file);
  const after = readJson(file);
  assert.deepEqual(Object.keys(after).sort(), ["pi", "port", "providers", "sessions"]);
  assert.equal(after.port, 8787);
  assert.deepEqual(after.providers, { "https://api.anthropic.com": { models: { "claude-sonnet-4-5": { context: 200000, output: 8192 } } } });
  assert.deepEqual(after.sessions, { dir: "/tmp/bc-sessions", keep: true });
  // 没在 patch 里的键一根汗毛都不动
  assert.equal(after.pi.subagents.maxDepth, 2);
  assert.equal(after.pi.subagents.displayUsage, "separate");
  assert.equal(after.pi.other, 1);
  assert.equal(after.pi.subagents.enabled, false);
  assert.equal(view.config.enabled, false);
  assert.equal(view.error, null);
});

check("坏 JSON：抛错、磁盘一字未改、也不留临时文件", () => {
  const file = target();
  const bad = '{ "providers": { ,\n  "sessions": {} }\n';
  write(file, bad);
  assert.throws(() => writeAcpDelegate({ enabled: false }, file), /JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), bad);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["billion-context.json"]);
  const view = readAcpDelegate(file);
  assert.equal(view.exists, true);
  assert.ok(view.error, "读的时候要把坏 JSON 说成 error，前端才能禁用保存");
  assert.equal(view.config.enabled, null);
});

check("文件与目录都不存在：按「只有 pi.subagents」创建", () => {
  const file = target("fresh/deep/dir");
  assert.equal(readAcpDelegate(file).exists, false);
  const view = writeAcpDelegate({ enabled: false }, file);
  assert.deepEqual(readJson(file), { pi: { subagents: { enabled: false } } });
  assert.equal(view.exists, true);
  assert.equal(view.error, null);
  assert.equal(view.config.enabled, false);
});

check("maxDepth / maxConcurrent 只接受整数；空值 = 删键", () => {
  const file = target();
  writeAcpDelegate({ maxDepth: 3, maxConcurrent: 2 }, file);
  assert.deepEqual(readJson(file).pi.subagents, { maxDepth: 3, maxConcurrent: 2 });
  assert.equal(readAcpDelegate(file).config.maxConcurrent, 2);

  for (const patch of [{ maxDepth: "2" }, { maxDepth: 0 }, { maxDepth: 1.5 }, { maxConcurrent: -1 }]) {
    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => writeAcpDelegate(patch, file), /maxDepth|maxConcurrent/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }

  writeAcpDelegate({ maxDepth: null }, file);
  assert.deepEqual(readJson(file).pi.subagents, { maxConcurrent: 2 });
  writeAcpDelegate({ maxConcurrent: null }, file);
  // 四个键全空 = 这一支空了：连空壳一起删，而不是留一串 `"pi": { "subagents": {} }`
  assert.deepEqual(readJson(file), {});
  assert.equal(readAcpDelegate(file).config.maxConcurrent, null, "缺键 = 不限");
});

check("thinkingLevel 只接受七档", () => {
  const file = target();
  assert.throws(() => writeAcpDelegate({ thinkingLevel: "extreme" }, file), /thinkingLevel/);
  assert.equal(fs.existsSync(file), false, "被拒绝的 patch 不该顺手建出文件");
  writeAcpDelegate({ thinkingLevel: "xhigh" }, file);
  assert.equal(readAcpDelegate(file).config.thinkingLevel, "xhigh");
  writeAcpDelegate({ thinkingLevel: null }, file);
  assert.deepEqual(readJson(file), {});
});

check("enabled 三态：缺键 = null（默认开）；布尔简写 subagents:false 读成关且写别的键时别把它掰开", () => {
  const plain = target();
  write(plain, { providers: {} });
  assert.equal(readAcpDelegate(plain).config.enabled, null);

  const shorthand = target();
  write(shorthand, { providers: { p: 1 }, pi: { subagents: false } });
  assert.equal(readAcpDelegate(shorthand).config.enabled, false);
  writeAcpDelegate({ maxDepth: 2 }, shorthand);
  const after = readJson(shorthand);
  assert.deepEqual(after.pi.subagents, { enabled: false, maxDepth: 2 });
  assert.deepEqual(after.providers, { p: 1 });
});

check("不认识的键 / 非对象的 patch 一律拒绝（拼错 key 不会静默写进去）", () => {
  const file = target();
  assert.throws(() => writeAcpDelegate({ maxdepth: 2 }, file), /maxdepth/);
  assert.throws(() => writeAcpDelegate({ enabled: "false" }, file), /enabled/);
  assert.throws(() => writeAcpDelegate(null, file), /patch/);
  assert.equal(fs.existsSync(file), false);
});

check("pi 不是对象时宁可报错，也不覆盖用户手写的东西", () => {
  const file = target();
  write(file, { pi: 5, providers: { p: 1 } });
  assert.throws(() => writeAcpDelegate({ enabled: true }, file), /pi/);
  assert.deepEqual(readJson(file), { pi: 5, providers: { p: 1 } });
});

check("配置文件路径：BILI_CONFIG_FILE → XDG_CONFIG_HOME → ~/.config（billion-context 自己的顺序）", () => {
  assert.equal(acpConfigPath({ BILI_CONFIG_FILE: path.join(root, "custom.json") }), path.resolve(root, "custom.json"));
  assert.equal(
    acpConfigPath({ XDG_CONFIG_HOME: path.join(root, "xdg"), HOME: path.join(root, "home") }),
    path.join(root, "xdg", "billion-context", "billion-context.json"),
  );
  assert.equal(
    acpConfigPath({ HOME: path.join(root, "home") }),
    path.join(root, "home", ".config", "billion-context", "billion-context.json"),
  );
});

check("默认路径就是调用方传的那个文件（写与读同一处）", () => {
  const file = target();
  const view = readAcpDelegate(file);
  assert.equal(view.path, file);
  assert.equal(view.exists, false);
  assert.deepEqual(view.config, { enabled: null, maxDepth: null, maxConcurrent: null, thinkingLevel: null });
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
