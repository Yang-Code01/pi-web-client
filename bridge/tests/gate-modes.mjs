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
approvalGate({ on: (ev, fn) => (handlers[ev] = fn), getAllTools: () => tools, registerTool: () => {} });
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

console.log("GitHub: 建 PR 不拦，合并要问（#661）");
setMode("ask");
{
  // 「建 PR 是 AI 的本职活」这条规则得能被证明：它不该出现在 asked 里。
  const created = await call("bash", { command: "gh pr create --fill --title 'x'" });
  const merged = await call("bash", { command: "gh pr merge 12 --squash" });
  const apiMerge = await call("bash", { command: "gh api -X PUT repos/a/b/pulls/12/merge -f merge_method=merge" });
  expect({ blocked: false, asked: created.asked }, { blocked: false, asked: false }, "gh pr create 不问");
  // 夹具里的 confirm 一律回 false，所以「问了」就等于「拦下了」——和上面那条 `rm` 同一个口径。
  expect(merged, { blocked: true, asked: true }, "gh pr merge 要问");
  expect(apiMerge, { blocked: true, asked: true }, "走 API 合并也要问");

  // 绕过路径：全局参数插在中间、GraphQL、并分支的 /merges、反斜杠续行。
  const repoFlag = await call("bash", { command: "gh -R a/b pr merge 12" });
  const prGroupFlag = await call("bash", { command: "gh pr -R a/b merge 12 --squash" });
  const graphql = await call("bash", { command: `gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:"x"}){pullRequest{merged}}}'` });
  const autoMerge = await call("bash", { command: `gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{pullRequestId:"x"}){clientMutationId}}'` });
  const merges = await call("bash", { command: "gh api -X POST repos/a/b/merges -f base=main -f head=feat" });
  const continued = await call("bash", { command: "gh -R a/b \\\n  pr merge \\\n  12" });
  expect(repoFlag, { blocked: true, asked: true }, "gh -R a/b pr merge 要问（全局参数插中间）");
  expect(prGroupFlag, { blocked: true, asked: true }, "gh pr -R a/b merge 要问");
  expect(graphql, { blocked: true, asked: true }, "graphql mergePullRequest 要问");
  expect(autoMerge, { blocked: true, asked: true }, "graphql enablePullRequestAutoMerge 要问（自动合并就是稍后合）");
  expect(merges, { blocked: true, asked: true }, "REST /merges（并分支）要问");
  expect(continued, { blocked: true, asked: true }, "反斜杠续行拆开的 gh pr merge 要问");

  // 不能因为放宽而误伤日常的只读 gh 命令（多看几眼，代价是多一次审批框）。
  for (const command of ["gh pr view 12 --json state", "gh pr list --state open", "gh repo view a/b", "gh issue list -R a/b"]) {
    expect(await call("bash", { command }), { blocked: false, asked: false }, `${command} 不问`);
  }
}

console.log("readonly: a whitelist, not a blacklist");
setMode("readonly");
expect(await call("read", { path: "a.txt" }), { blocked: false, asked: false }, "read passes");
expect(await call("grep", { pattern: "x" }), { blocked: false, asked: false }, "grep passes");
expect(await call("question", {}), { blocked: false, asked: false }, "the web's question tool passes");
expect(await call("mcp__docs__search", {}), { blocked: false, asked: false }, "MCP tool with readOnlyHint passes");
expect(await call("codemode", { code: "…" }), { blocked: false, asked: false }, "codemode passes (its inner calls come through this hook)");
expect(await call("mail_read", { uid: 1 }), { blocked: false, asked: false }, "mail_read passes (read-only mail)");
expect(await call("mail_image", { uid: 1, index: 0 }), { blocked: false, asked: false }, "mail_image passes (reads inline image, no disk)");
expect(await call("mail_attachment", { uid: 1, index: 0 }), { blocked: true, asked: false }, "mail_attachment blocked (writes disk)");
expect(await call("mail_send", { to: "a@b.com", subject: "x", text: "y" }), { blocked: true, asked: false }, "mail_send blocked (talks outward)");
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

console.log("内网通 MCP（D439）：查的放行，发消息 / 共享要问");
setMode("ask");
expect(await call("mcp__peer__peer_contacts", {}), { blocked: false, asked: false }, "ask: 查联系人不问");
expect(await call("mcp__peer__peer_history", { peer: "p" }), { blocked: false, asked: false }, "ask: 读记录不问");
expect(await call("mcp__peer__peer_send_text", { peer: "p", text: "hi" }), { blocked: true, asked: true }, "ask: 发消息要问");
expect(await call("mcp__peer__peer_share", { peer: "p", type: "snippet" }), { blocked: true, asked: true }, "ask: 共享要问");
setMode("strict");
expect(await call("mcp__peer__peer_inbox", {}), { blocked: false, asked: false }, "strict: 看未读不问");
expect(await call("mcp__peer__peer_send_text", { peer: "p", text: "hi" }), { blocked: true, asked: true }, "strict: 发消息要问");
setMode("readonly");
expect(await call("mcp__peer__peer_status", {}), { blocked: false, asked: false }, "readonly: 看状态放行");
expect(await call("mcp__peer__peer_send_text", { peer: "p", text: "hi" }), { blocked: true, asked: false }, "readonly: 发消息直接拦下，连问都不问");
expect(await call("mcp__peer__peer_share", { peer: "p", type: "file" }), { blocked: true, asked: false }, "readonly: 共享也直接拦");
setMode("auto");
expect(await call("mcp__peer__peer_share", { peer: "p", type: "file" }), { blocked: false, asked: false }, "auto: 不问");

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
