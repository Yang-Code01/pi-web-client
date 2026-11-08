/**
 * 设置 → 子代理：扫盘（#212）。
 *
 * 这一页要「看得见真的 agent」，桥侧就得先能回答：扫了哪几个目录、每个目录拿到几个、
 * 每个 agent 的名字/来源/frontmatter 的 model 与 thinking。要守住的事：
 *   ① frontmatter 只认第一段 `---` 之间的行级 `key: value`，没有 frontmatter 不算错；
 *   ② 扫描顺序 包内 → 用户 → 项目 → agentScanDirs，同名后者赢；
 *   ③ 排除目录（agentExcludeDirs、agentScanDirs 里 `!` 开头的条目）整个子树不扫；
 *   ④ 目录不存在只标 exists:false，settings.json 坏了只记一条 error —— 都不能抛；
 *   ⑤ 没装 pi-subagents 时 installed:false + 空列表，不崩。
 *
 *   node --experimental-transform-types bridge/tests/subagents-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter, scanSubagents } from "../src/subagents.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagents-"));
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

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** 一个 agent 文件：frontmatter 原样塞进去，正文随便。 */
function agentFile(file, frontmatter, body = "按上面的设定干活。") {
  write(file, `---\n${frontmatter}\n---\n\n${body}\n`);
}

/** 每个用例自己一棵树：agentDir / home / cwd / 包根分开，测什么写什么。 */
function tree(label) {
  const base = path.join(root, label);
  const dirs = {
    base,
    agentDir: path.join(base, "agent"),
    homeDir: path.join(base, "home"),
    cwd: path.join(base, "proj"),
    pkg: path.join(base, "pkg"),
  };
  fs.mkdirSync(dirs.agentDir, { recursive: true });
  fs.mkdirSync(dirs.homeDir, { recursive: true });
  fs.mkdirSync(dirs.cwd, { recursive: true });
  fs.mkdirSync(path.join(dirs.pkg, "agents"), { recursive: true });
  write(path.join(dirs.pkg, "package.json"), JSON.stringify({ name: "pi-subagents", version: "0.0.0" }));
  return dirs;
}

const scan = (dirs, extra = {}) =>
  scanSubagents({ agentDir: dirs.agentDir, homeDir: dirs.homeDir, cwd: dirs.cwd, packageRoots: [dirs.pkg], ...extra });

check("frontmatter：没有 --- 的文件当作没有 frontmatter", () => {
  const fm = parseFrontmatter("你是一个 worker，读完再动手。\n");
  assert.deepEqual(fm, { name: null, description: null, model: null, thinking: null });
});

check("frontmatter：成对引号被去掉，空值算没写", () => {
  const fm = parseFrontmatter(`---\nname: "quoted name"\ndescription: '带空格 的描述'\nmodel: ''\nthinking:\n---\n`);
  assert.equal(fm.name, "quoted name");
  assert.equal(fm.description, "带空格 的描述");
  assert.equal(fm.model, null);
  assert.equal(fm.thinking, null);
});

check("frontmatter：只看第一段 --- 之间，行级 key: value", () => {
  const fm = parseFrontmatter("---\nname: first\nnested:\n  model: 假模型\n---\nmodel: 后面的不算\n");
  assert.equal(fm.name, "first");
  assert.equal(fm.model, null);
});

check("frontmatter：BOM 与 CRLF 不挡路", () => {
  const fm = parseFrontmatter("\uFEFF---\r\nname: win\r\nmodel: openai/gpt-5\r\n---\r\n");
  assert.equal(fm.name, "win");
  assert.equal(fm.model, "openai/gpt-5");
});

check("扫描顺序：包内 → 用户 → 项目 → agentScanDirs，同名后者赢", () => {
  const d = tree("order");
  agentFile(path.join(d.pkg, "agents", "delegate.md"), "name: delegate\ndescription: 包内");
  agentFile(path.join(d.agentDir, "agents", "delegate.md"), "name: delegate\ndescription: 用户");
  agentFile(path.join(d.cwd, ".pi", "agents", "delegate.md"), "name: delegate\ndescription: 项目");
  write(path.join(d.cwd, ".pi", "settings.json"), JSON.stringify({ subagents: { agentScanDirs: ["extra"] } }));
  agentFile(path.join(d.cwd, ".pi", "extra", "delegate.md"), "name: delegate\nmodel: scan/model\nthinking: high");

  const out = scan(d);
  assert.equal(out.agents.length, 1);
  assert.deepEqual(out.agents[0], {
    name: "delegate",
    source: "scan",
    path: path.join(d.cwd, ".pi", "extra", "delegate.md"),
    description: null,
    model: "scan/model",
    thinking: "high",
  });

  // 每个目录都报出来，count 是「这个目录读到了几个定义」（被覆盖的也算）
  const rows = new Map(out.directories.map((row) => [row.path, row]));
  assert.equal(rows.get(path.join(d.pkg, "agents")).count, 1);
  assert.equal(rows.get(path.join(d.agentDir, "agents")).count, 1);
  assert.equal(rows.get(path.join(d.cwd, ".pi", "agents")).count, 1);
  assert.equal(rows.get(path.join(d.cwd, ".pi", "extra")).count, 1);
  assert.equal(rows.get(path.join(d.cwd, ".pi", "extra")).source, "scan");
});

check("agentExcludeDirs：按 settings 文件所在目录解析，整个子树不扫", () => {
  const d = tree("exclude");
  write(path.join(d.agentDir, "settings.json"), JSON.stringify({ subagents: { agentExcludeDirs: ["agents/skip"] } }));
  agentFile(path.join(d.agentDir, "agents", "skip", "hidden.md"), "name: hidden");
  agentFile(path.join(d.agentDir, "agents", "kept.md"), "name: kept");

  const out = scan(d);
  assert.deepEqual(out.agents.map((a) => a.name), ["kept"]);
  assert.ok(!out.directories.some((row) => row.path.includes("skip")));
});

check("agentScanDirs 里 ! 开头的条目排除那一支", () => {
  const d = tree("bang");
  write(
    path.join(d.cwd, ".pi", "settings.json"),
    JSON.stringify({ subagents: { agentScanDirs: ["../flows/*/agents", "!../flows/b/agents"] } }),
  );
  agentFile(path.join(d.cwd, "flows", "a", "agents", "flow-a.md"), "name: flow-a");
  agentFile(path.join(d.cwd, "flows", "b", "agents", "flow-b.md"), "name: flow-b");

  const out = scan(d);
  assert.deepEqual(out.agents.map((a) => a.name), ["flow-a"]);
  assert.ok(out.directories.some((row) => row.path === path.join(d.cwd, "flows", "a", "agents") && row.count === 1));
  assert.ok(!out.directories.some((row) => row.path.includes(path.join("flows", "b"))));
});

check("agentScanDirs：用户级 ~ 展开、目录不存在标 exists:false 但不抛", () => {
  const d = tree("scan-dirs");
  write(
    path.join(d.agentDir, "settings.json"),
    JSON.stringify({ subagents: { agentScanDirs: ["~/extra-agents", "~/missing-agents"] } }),
  );
  agentFile(path.join(d.homeDir, "extra-agents", "extra.md"), "name: extra\nthinking: low");

  const out = scan(d);
  const extra = out.agents.find((a) => a.name === "extra");
  assert.equal(extra.source, "scan");
  const missing = out.directories.find((row) => row.path === path.join(d.homeDir, "missing-agents"));
  assert.deepEqual({ exists: missing.exists, count: missing.count }, { exists: false, count: 0 });
  assert.deepEqual(out.errors, []);
});

check("没装 pi-subagents：installed:false、空列表、不抛", () => {
  const d = tree("absent");
  const out = scan(d, { packageRoots: [path.join(d.base, "nope")] });
  assert.equal(out.installed, false);
  assert.deepEqual(out.agents, []);
  assert.ok(out.directories.some((row) => row.source === "package" && row.exists === false));
});

check("项目 settings.json 坏了：errors 记一条，其余照扫", () => {
  const d = tree("bad-json");
  write(path.join(d.cwd, ".pi", "settings.json"), "{ 这不是 json");
  agentFile(path.join(d.cwd, ".pi", "agents", "proj.md"), "name: proj");

  const out = scan(d);
  assert.equal(out.agents.length, 1);
  assert.ok(out.errors.some((entry) => entry.includes(path.join(d.cwd, ".pi", "settings.json"))));
});

check("递归两层，.chain.md 不算 agent，没 frontmatter 的名字用文件名", () => {
  const d = tree("walk");
  const dir = path.join(d.agentDir, "agents");
  write(path.join(dir, "plain.md"), "一段提示词\n");
  write(path.join(dir, "chain.chain.md"), "---\nname: chain\n---\n");
  agentFile(path.join(dir, "sub", "one.md"), "name: one");
  agentFile(path.join(dir, "sub", "deep", "two.md"), "name: two");
  agentFile(path.join(dir, "sub", "deep", "deeper", "three.md"), "name: three");

  const out = scan(d);
  assert.deepEqual(out.agents.map((a) => a.name).sort(), ["one", "plain", "two"]);
  assert.equal(out.directories.find((row) => row.path === dir).count, 3);
});

check("~/.agents 是 skills 的根，里面的 SKILL.md 不算 agent", () => {
  const d = tree("home-dot-agents");
  agentFile(path.join(d.homeDir, ".agents", "skills", "unslop", "SKILL.md"), "name: unslop\ndescription: 界面去 AI 味");
  agentFile(path.join(d.agentDir, "agents", "real.md"), "name: real");
  const out = scan(d);
  assert.deepEqual(out.agents.map((a) => a.name), ["real"]);
  assert.equal(out.directories.some((row) => row.path === path.join(d.homeDir, ".agents")), false);
});

check("旧项目路径 .agents 让给 .pi/agents（同名时项目配置目录赢）", () => {
  const d = tree("legacy-agents");
  agentFile(path.join(d.cwd, ".agents", "dup.md"), "name: dup\ndescription: 旧的");
  agentFile(path.join(d.cwd, ".pi", "agents", "dup.md"), "name: dup\ndescription: 新的");
  agentFile(path.join(d.cwd, ".agents", "only-legacy.md"), "name: legacy-only");
  const out = scan(d);
  const dup = out.agents.find((a) => a.name === "dup");
  assert.equal(dup.path, path.join(d.cwd, ".pi", "agents", "dup.md"));
  assert.deepEqual(out.agents.map((a) => a.name).sort(), ["dup", "legacy-only"]);
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
