/**
 * Permission modes of the approval gate (#29), driven directly: a fake `pi` collects the gate's
 * handlers, a fake `ctx.ui.confirm` records what would have been asked.
 *
 *   node bridge/tests/gate-modes.mjs          (Node ≥ 22.18 strips the .ts types itself)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import approvalGate from "../ext/approval-gate.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-modes-"));
const allow = path.join(dir, "allow.json");
process.env.PI_WEB_ALLOW_FILE = allow;
const setMode = (mode, patterns = []) => fs.writeFileSync(allow, JSON.stringify({ mode, patterns }));

const handlers = {};
const tools = [
  { name: "mcp__docs__search", annotations: { readOnlyHint: true } },
  { name: "mcp__db__drop_table", annotations: { destructiveHint: true } },
  { name: "todo_write" },
];
approvalGate({ on: (ev, fn) => (handlers[ev] = fn), getAllTools: () => tools });
const asked = [];
const ctx = { cwd: dir, hasUI: true, ui: { confirm: async (title, message) => (asked.push(`${title} | ${message}`), false) } };
const call = async (toolName, input = {}) => {
  asked.length = 0;
  const r = await handlers.tool_call({ toolName, input }, ctx);
  return { blocked: Boolean(r?.block), asked: asked.length > 0 };
};
let n = 0;
let failed = false;
const expect = (got, want, label) => {
  const ok = got.blocked === want.blocked && got.asked === want.asked;
  if (!ok) failed = true;
  console.log(`${ok ? "  ok" : "  FAIL"} ${++n}  ${label}  (blocked=${got.blocked} asked=${got.asked})`);
};

console.log("readonly: a whitelist, not a blacklist");
setMode("readonly");
expect(await call("read", { path: "a.txt" }), { blocked: false, asked: false }, "read passes");
expect(await call("grep", { pattern: "x" }), { blocked: false, asked: false }, "grep passes");
expect(await call("question", {}), { blocked: false, asked: false }, "the web's question tool passes");
expect(await call("mcp__docs__search", {}), { blocked: false, asked: false }, "MCP tool with readOnlyHint passes");
expect(await call("codemode", { code: "…" }), { blocked: false, asked: false }, "codemode passes (its inner calls come through this hook)");
expect(await call("bash", { command: "ls" }), { blocked: true, asked: false }, "bash blocked");
expect(await call("write", { path: "a.txt" }), { blocked: true, asked: false }, "write blocked");
expect(await call("mcp__db__drop_table", {}), { blocked: true, asked: false }, "MCP tool without the hint blocked (used to pass)");
expect(await call("todo_write", {}), { blocked: true, asked: false }, "extension tool blocked (used to pass)");

console.log("strict: everything that is not known to only look asks");
setMode("strict");
expect(await call("read", { path: "a.txt" }), { blocked: false, asked: false }, "read does not ask");
expect(await call("bash", { command: "ls" }), { blocked: true, asked: true }, "bash asks (denied here)");
expect(await call("mcp__db__drop_table", { table: "t" }), { blocked: true, asked: true }, "MCP tool asks (used to pass)");
console.log(`      asked: ${asked[0]}`);
setMode("strict", ["tool:mcp__db__drop_table"]);
expect(await call("mcp__db__drop_table", { table: "t" }), { blocked: false, asked: false }, "\"always\" for a tool remembers the tool");
expect(await call("todo_write", {}), { blocked: true, asked: true }, "…and only that tool");

console.log("ask (default) and auto are unchanged");
setMode("ask");
expect(await call("mcp__db__drop_table", {}), { blocked: false, asked: false }, "ask: non-shell, non-write tool passes as before");
expect(await call("bash", { command: "rm -rf x" }), { blocked: true, asked: true }, "ask: rm still asks");
setMode("auto");
expect(await call("bash", { command: "rm -rf x" }), { blocked: false, asked: false }, "auto: nothing asks");

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
