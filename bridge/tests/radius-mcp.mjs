/**
 * D229 / pi 1.5.1：登录 Radius 之后把 Radius MCP 接上。
 *
 * 终端里 `/login radius` 成功后会问 `Configure Radius MCP in <mcp.json>?`；网页这边同样问，但
 * 写什么由桥重新算 —— 页面只说「要」。这份用例盯的是「算什么、写出来长什么样、什么时候不再问」：
 *   A. 空配置 → 计划是全局 mcp.json 里的 `radius`，指向 Radius 网关的 /mcp，auth 绑到这份登录；
 *   B. 写进去之后同一次调用不再问（pi 的判据）；
 *   C. 已经有别的服务占用 `radius` 这个命名空间 → 换个名字，不覆盖人家；
 *   D. 已经有一个**别的登录**的 Radius 服务 → 把 auth 改成现在这份登录，不新增一个。
 *
 * 用真 pi 的 radius-mcp / mcp 模块做读写，不起桥、不登录（登录本身要真的浏览器授权）。
 *
 *   npm run build:bridge && node bridge/tests/radius-mcp.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "radius-mcp-unit");
const AGENT = path.join(ROOT, "agent");
const PROJECT = path.join(ROOT, "project");

delete process.env.PI_BIN;
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(AGENT, { recursive: true });
fs.mkdirSync(PROJECT, { recursive: true });
process.env.PI_AGENT_DIR = AGENT;

const { resolvePi } = await import("../dist/pi.js");
const { addRadiusMcp, radiusMcpPlan, RADIUS_PROVIDER } = await import("../dist/pilogin.js");

const CLI = resolvePi().cli;
const mcpPath = path.join(AGENT, "mcp.json");
const servers = () => (fs.existsSync(mcpPath) ? JSON.parse(fs.readFileSync(mcpPath, "utf8")).mcpServers ?? {} : {});
const writeServers = (list) => fs.writeFileSync(mcpPath, `${JSON.stringify({ mcpServers: list }, null, 2)}\n`);

test("provider id 与 pi 一致", () => {
  assert.equal(RADIUS_PROVIDER, "radius");
});

test("空配置：计划落在全局 mcp.json，名字是 radius", async () => {
  fs.rmSync(mcpPath, { force: true });
  const plan = await radiusMcpPlan(CLI, PROJECT);
  assert.ok(plan, "该问一句");
  assert.equal(plan.mcpPath, mcpPath);
  assert.equal(plan.name, "radius");
});

test("写进去：url 指向 Radius 网关的 /mcp，auth 绑到这份登录", async () => {
  fs.rmSync(mcpPath, { force: true });
  const out = await addRadiusMcp(CLI, PROJECT);
  assert.equal(out.name, "radius");
  const server = servers().radius;
  assert.ok(server, "mcp.json 里出现了 radius");
  assert.match(String(server.url), /\/mcp$/);
  assert.deepEqual(server.auth, { provider: "radius" });
  assert.equal(server.oauth, undefined, "auth 取代了 MCP 自己的 OAuth 登录");
});

test("写完就不再问", async () => {
  assert.equal(await radiusMcpPlan(CLI, PROJECT), null);
});

test("名字被别的服务占了：换一个，不覆盖人家", async () => {
  writeServers({ radius: { command: "node", args: ["someone-elses.js"] } });
  const plan = await radiusMcpPlan(CLI, PROJECT);
  assert.ok(plan);
  assert.notEqual(plan.name, "radius");
  assert.match(plan.name, /^radius-mcp/);
  await addRadiusMcp(CLI, PROJECT);
  const after = servers();
  assert.deepEqual(after.radius, { command: "node", args: ["someone-elses.js"] }, "别人的服务没被改");
  assert.ok(after[plan.name], `新的服务写成 ${plan.name}`);
});

test("已经有一个别的登录的 Radius 服务：改 auth，不新增", async () => {
  const url = String(servers()[Object.keys(servers()).find((n) => n !== "radius")].url);
  writeServers({ "radius-mcp": { url, auth: { provider: "someone-else" } } });
  const plan = await radiusMcpPlan(CLI, PROJECT);
  assert.ok(plan);
  assert.equal(plan.name, "radius-mcp");
  await addRadiusMcp(CLI, PROJECT);
  const after = servers();
  assert.equal(Object.keys(after).length, 1, "没有多出一个服务");
  assert.deepEqual(after["radius-mcp"].auth, { provider: "radius" });
  assert.equal(await radiusMcpPlan(CLI, PROJECT), null);
});
