/**
 * `mcpNameTaken`（D379）：pi 的 `mcp add` 撞名只打一行 `Replaced`，所以「会不会覆盖」得先自己判。
 *
 *   node --experimental-strip-types --test bridge/tests/extmgr-names-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-names-"));
process.env.PI_AGENT_DIR = agent;
process.env.PI_CODING_AGENT_DIR = agent;
fs.writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: { exa: { url: "https://mcp.exa.ai/mcp" }, foo_bar: { command: "npx", args: ["-y", "foo"] } } }));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-names-cwd-"));
fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
fs.writeFileSync(path.join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { "project-one": { command: "uvx", args: ["one"] } } }));

const { mcpFilePath, mcpNameTaken } = await import("../src/extmgr.ts");

test("已装的名字判得出来，并指回那个文件", () => {
  const hit = mcpNameTaken("exa", cwd);
  assert.equal(hit, path.join(agent, "mcp.json"));
});

test("大小写、- 与 _ 都算同一个 server（和 pi 一致）", () => {
  assert.ok(mcpNameTaken("EXA", cwd));
  assert.ok(mcpNameTaken("foo-bar", cwd), "foo_bar 已在，foo-bar 撞它");
  assert.ok(mcpNameTaken("foo_bar", cwd));
});

test("项目档也算：装全局时不会静默遮住项目的同名项", () => {
  assert.equal(mcpNameTaken("project-one", cwd), path.join(cwd, ".pi", "mcp.json"));
});

test("没装过就是 null，空名字不当成撞名", () => {
  assert.equal(mcpNameTaken("nope", cwd), null);
  assert.equal(mcpNameTaken("  ", cwd), null);
});

test("前缀相近但不同名不算撞（exa vs exa-search）", () => {
  assert.equal(mcpNameTaken("exa-search", cwd), null);
  assert.equal(mcpNameTaken("ex", cwd), null);
});

test("这次要写哪个 mcp.json：项目的按 cwd 算，全局的按 agent 目录算", () => {
  assert.equal(mcpFilePath(true, cwd), path.join(cwd, ".pi", "mcp.json"));
  assert.equal(mcpFilePath(false, cwd), path.join(agent, "mcp.json"));
  // 没有 cwd 的项目安装没有落点，退回全局（桥端 `local` 只在 cwd 存在时才算项目档）
  assert.equal(mcpFilePath(true, null), path.join(agent, "mcp.json"));
});
