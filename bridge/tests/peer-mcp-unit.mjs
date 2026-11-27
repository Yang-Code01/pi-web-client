/**
 * 内网通 MCP（D439）的两半：
 * 1. 注册：全局 mcp.json 里加一条 `peer`（deferred、路径正确），关掉要记住、别人的同名条目不许覆盖；
 * 2. 协议：`peer/mcp/peer-mcp.mjs` 的 stdio 握手、工具清单、以及「桥不在时」的错误话术。
 *
 * 协议那半边真的起进程、真的走 HTTP —— 桥用一个小桩服务代替，只回工具会读到的那几个端点。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-mcp-unit-"));
process.env.PI_WEB_STATE = path.join(root, "state");
process.env.PI_AGENT_DIR = path.join(root, "agent");
fs.mkdirSync(process.env.PI_AGENT_DIR, { recursive: true });

const { ensurePeerMcp, peerMcpFile, peerMcpServerPath, peerMcpState, setPeerMcpEnabled } = await import("../src/peer-mcp.ts");

const servers = () => JSON.parse(fs.readFileSync(peerMcpFile(), "utf8")).mcpServers ?? {};

test("注册：第一次写进全局 mcp.json，exposure 是 deferred，路径指到 peer/mcp/peer-mcp.mjs", () => {
  const before = peerMcpState();
  assert.equal(before.present, false);
  assert.equal(before.enabled, true);
  const res = ensurePeerMcp();
  assert.deepEqual(res, { ok: true, changed: true });
  const entry = servers().peer;
  assert.equal(entry.command, "node");
  assert.deepEqual(entry.args, [peerMcpServerPath()]);
  assert.equal(entry.exposure, "deferred");
  assert.match(entry.description, /内网通/);
  assert.ok(fs.existsSync(peerMcpServerPath()), "服务脚本要在仓库里");
  // 第二次不该再写一遍。
  assert.equal(ensurePeerMcp().changed, false);
});

test("关掉：摘条目并记住，重启（ensure）不会再写回来", () => {
  const state = setPeerMcpEnabled(false);
  assert.equal(state.enabled, false);
  assert.equal(state.present, false);
  assert.equal(servers().peer, undefined);
  assert.deepEqual(ensurePeerMcp(), { ok: true, changed: false });
  assert.equal(servers().peer, undefined);
  const back = setPeerMcpEnabled(true);
  assert.equal(back.present, true);
  assert.equal(servers().peer.exposure, "deferred");
});

test("别人的同名服务不覆盖：报错并原样留着", () => {
  setPeerMcpEnabled(false);
  const file = peerMcpFile();
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { peer: { command: "someone-elses-server" } } }, null, 2));
  assert.throws(() => setPeerMcpEnabled(true), /已经有别的/);
  assert.equal(servers().peer.command, "someone-elses-server");
  // 状态里能看出这条不是我们的。
  assert.equal(peerMcpState().ours, false);
  fs.rmSync(file);
});

// ---------------------------------------------------------------- 协议

/** 桩桥：只实现工具用到的那几个端点。 */
function stubBridge() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      calls.push({ method: req.method, path: url.pathname, body: body ? JSON.parse(body) : null });
      const send = (data, code = 200) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === "/api/peer" && req.method === "GET") {
        return send({
          enabled: true,
          running: true,
          reason: "",
          status: { nodeId: "me-1", nickname: "我", hostname: "me-pc", port: 7865, config: { inbox: "C:/inbox" } },
          mcp: { enabled: true, present: true, ours: true, file: "mcp.json", path: "peer-mcp.mjs" },
        });
      }
      if (url.pathname === "/api/peer/contacts") {
        return send({ contacts: [{ nodeId: "p-1", nickname: "小王", hostname: "wang-pc", online: true, friend: true }] });
      }
      if (url.pathname === "/api/peer/threads") {
        return send({ threads: [{ nodeId: "p-1", nickname: "小王", hostname: "wang-pc", unread: 2, last: { at: 1, kind: "share", from: { nodeId: "p-1" }, share: { type: "file", title: "报告" } } }] });
      }
      if (url.pathname === "/api/peer/messages") {
        return send({
          entries: [
            { id: "a", at: 1, kind: "text", from: { nodeId: "p-1", nickname: "小王" }, text: "在吗" },
            { id: "b", at: 2, kind: "share", from: { nodeId: "p-1" }, share: { type: "session", title: "会话导出", files: [{ name: "s.md" }] } },
          ],
        });
      }
      if (url.pathname === "/api/peer/send" && req.method === "POST") return send({ ok: true, id: "m-9", seq: 3 });
      if (url.pathname === "/api/peer/share" && req.method === "POST") return send({ ok: true, id: "s-1", files: ["f-1"] });
      return send({ error: `没有这个端点 ${url.pathname}` }, 404);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, port: server.address().port })));
}

/** 起一个 peer-mcp 进程，按行收发 JSON-RPC。 */
function startMcp(port) {
  const child = spawn(process.execPath, [path.join(repo, "peer", "mcp", "peer-mcp.mjs")], {
    env: { ...process.env, PI_WEB_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const entry = waiting.get(msg.id);
      if (entry) {
        waiting.delete(msg.id);
        entry(msg);
      }
    }
  });
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const mine = ++id;
      waiting.set(mine, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
      setTimeout(() => reject(new Error(`${method} 超时`)), 8000);
    });
  return { child, request };
}

test("协议：握手 / 工具清单 / 调工具都通", async () => {
  const { server, calls, port } = await stubBridge();
  const mcp = startMcp(port);
  try {
    const init = await mcp.request("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "peer");

    const list = await mcp.request("tools/list");
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["peer_contacts", "peer_history", "peer_inbox", "peer_send_text", "peer_share", "peer_status"]);
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.description.length > 20, `${tool.name} 要有像样的描述（deferred 要靠它被搜到）`);
    }

    const sent = await mcp.request("tools/call", { name: "peer_send_text", arguments: { peer: "p-1", text: "你好" } });
    assert.match(sent.result.content[0].text, /已交给内网通投递/);
    assert.deepEqual(calls.at(-1).body, { peer: "p-1", text: "你好", via: "pi" });

    const shared = await mcp.request("tools/call", {
      name: "peer_share",
      arguments: { peer: "p-1", type: "snippet", text: "一段内容", title: "标题" },
    });
    assert.match(shared.result.content[0].text, /共享卡已发出/);
    assert.equal(calls.at(-1).body.type, "snippet");
    assert.equal(calls.at(-1).body.via, "pi");

    const inbox = await mcp.request("tools/call", { name: "peer_inbox", arguments: {} });
    assert.match(inbox.result.content[0].text, /小王/);
    assert.match(inbox.result.content[0].text, /接收/);

    const history = await mcp.request("tools/call", { name: "peer_history", arguments: { peer: "p-1" } });
    assert.match(history.result.content[0].text, /在吗/);
    assert.match(history.result.content[0].text, /【共享·session】/);

    const status = await mcp.request("tools/call", { name: "peer_status", arguments: {} });
    assert.match(status.result.content[0].text, /已注册/);

    const unknown = await mcp.request("tools/call", { name: "peer_nope", arguments: {} });
    assert.equal(unknown.result.isError, true);
  } finally {
    mcp.child.kill();
    server.close();
  }
});

test("协议：桥连不上时说人话，不抛裸 fetch failed", async () => {
  const mcp = startMcp(17999);
  try {
    const res = await mcp.request("tools/call", { name: "peer_status", arguments: {} });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /连不上本机的 pi 网页桥/);
  } finally {
    mcp.child.kill();
  }
});
