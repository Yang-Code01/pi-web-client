/**
 * 渲染偏好（D227）：`markdown.mermaid` 的项目 → 全局 → pi 出厂值。
 *
 * 这里测的是**解析**，不是画图：网页那边画不画得出来由 `probes/mermaid-render.mjs` 用真浏览器把关。
 * 两件事在这一层才看得见：未授信的项目 `.pi/settings.json` 不算答案（pi 根本不加载它），
 * 以及一层写着非法值等于没写、下一层照旧有发言权。
 *
 * 用真 pi 的 settings / trust 模块做文件读写；不起桥、不起 pi 进程。
 *
 *   npm run build:bridge && node bridge/tests/renderprefs-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "renderprefs-unit");
const AGENT = path.join(ROOT, "agent");
const PROJECT = path.join(ROOT, "project");
const PLAIN = path.join(ROOT, "plain");

// 必须在 import 桥模块之前指好目录：agentDir() 每次调用都读环境变量。
delete process.env.PI_BIN;
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });
fs.mkdirSync(path.join(PROJECT, ".pi"), { recursive: true });
fs.mkdirSync(PLAIN, { recursive: true });
process.env.PI_AGENT_DIR = AGENT;
process.env.PI_WEB_STATE = path.join(ROOT, "state");

const { resolvePi } = await import("../dist/pi.js");
const { mermaidPref, MERMAID_KEY, MERMAID_DEFAULT } = await import("../dist/renderprefs.js");
const { dotted, scopedSetting, trustInfo, setTrust } = await import("../dist/pisettings.js");
const { defaultPermission } = await import("../dist/permissiondefault.js");

const CLI = resolvePi().cli;
const globalPath = path.join(AGENT, "settings.json");
const projectPath = path.join(PROJECT, ".pi", "settings.json");

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};
const wipe = () => {
  fs.rmSync(globalPath, { force: true });
  fs.rmSync(projectPath, { force: true });
};

test("dotted：点号、缺层、中途不是对象", () => {
  const json = { markdown: { mermaid: "off" }, web: { defaultPermission: "auto" }, n: 1 };
  assert.equal(dotted(json, "markdown.mermaid"), "off");
  assert.equal(dotted(json, "web.defaultPermission"), "auto");
  assert.equal(dotted(json, "markdown"), json.markdown);
  assert.equal(dotted(json, "markdown.codeBlockIndent"), undefined);
  assert.equal(dotted(json, "nope.deep.deeper"), undefined);
  assert.equal(dotted(json, "n.deep"), undefined);
  assert.equal(dotted(null, "markdown.mermaid"), undefined);
  assert.equal(dotted({}, "markdown.mermaid"), undefined);
});

test("两层都没有：用 pi 的出厂值 streaming", async () => {
  wipe();
  const pref = await mermaidPref(CLI, PLAIN);
  assert.deepEqual({ mode: pref.mode, source: pref.source }, { mode: MERMAID_DEFAULT, source: "fallback" });
  assert.equal(pref.mode, "streaming");
});

test("全局写了就听全局的", async () => {
  wipe();
  write(globalPath, { markdown: { mermaid: "off" } });
  const pref = await mermaidPref(CLI, PLAIN);
  assert.equal(pref.mode, "off");
  assert.equal(pref.source, "global");
  assert.equal(pref.path, globalPath);
});

test("非法值等于没写：回落而不是照抄", async () => {
  wipe();
  write(globalPath, { markdown: { mermaid: "yes" } });
  const pref = await mermaidPref(CLI, PLAIN);
  assert.equal(pref.mode, "streaming");
  assert.equal(pref.source, "fallback");
});

test("项目没授信：它的 settings.json 不算答案（pi 也不加载它）", async () => {
  wipe();
  write(globalPath, { markdown: { mermaid: "off" } });
  write(projectPath, { markdown: { mermaid: "final" } });
  const trust = await trustInfo(CLI, PROJECT);
  assert.equal(trust.effective, false, "这一步的前提是项目确实未被信任");
  const pref = await mermaidPref(CLI, PROJECT);
  assert.equal(pref.mode, "off");
  assert.equal(pref.source, "global");
});

test("授信之后项目覆盖全局", async () => {
  wipe();
  write(globalPath, { markdown: { mermaid: "off" } });
  write(projectPath, { markdown: { mermaid: "final" } });
  const info = await trustInfo(CLI, PROJECT);
  const index = info.options.findIndex((o) => o.trusted);
  assert.ok(index >= 0, "pi 应该给出一个「信任」选项");
  await setTrust(CLI, PROJECT, index);
  const pref = await mermaidPref(CLI, PROJECT);
  assert.equal(pref.mode, "final");
  assert.equal(pref.source, "project");
  assert.equal(pref.path, projectPath);
});

test("键名与 pi 的 settings.md 对齐（不是 web. 命名空间）", () => {
  assert.equal(MERMAID_KEY, "markdown.mermaid");
});

test("同一个 scopedSetting 也撑着默认权限（D161 的重构没走味）", async () => {
  wipe();
  write(globalPath, { web: { defaultPermission: "auto" } });
  const fallback = await defaultPermission(CLI, PLAIN);
  assert.deepEqual(fallback, { mode: "auto", source: "global", path: globalPath });
  wipe();
  assert.deepEqual(await defaultPermission(CLI, PLAIN), { mode: "ask", source: "fallback", path: null });
});

test("scopedSetting：accept 拒了就当没有这一层", async () => {
  wipe();
  write(globalPath, { markdown: { mermaid: "off" } });
  const hit = await scopedSetting(CLI, PLAIN, MERMAID_KEY, (v) => v === "final");
  assert.deepEqual(hit, { value: null, source: "none", path: null });
});
