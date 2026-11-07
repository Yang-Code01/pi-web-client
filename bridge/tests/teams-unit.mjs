/**
 * Teams 接入里不碰网络的那一半：HTML→纯文本、`/mcp` 的协议形状、以及两条策略
 * （发给自己不用问、发给别人必须有人在页面上点「发送」）。
 *
 *   npm run test:teams        （先 build bridge 再跑；这里 import 的是 dist，不是 src）
 *
 * 读 dist 而不是 src：新 Node 只做类型擦除，src 里的 `constructor(readonly code: string)` 这类
 * 参数属性擦不掉。build 出来的 JS 也能证明 tsc 真的把这两个模块编过了。
 *
 * 没有网络、没有浏览器、没有 pi：`client.send` / `client.chats` / `ready` 全部替换成桩，
 * 所以这里断的是桥自己的判断，不是 Teams 的接口。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 状态目录必须换到临时目录：构造 TeamsService 会读 teams.json，后面 setTarget 还会写它。
const state = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-unit-"));
process.env.PI_WEB_STATE = state;

const { SELF_CHAT, TeamsError, htmlToText } = await import("../dist/teams/client.js");
const { handleMcp } = await import("../dist/mcp.js");
const { teamsTools } = await import("../dist/teams/tools.js");
const { TeamsService } = await import("../dist/teams/service.js");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

/** 把一次 JSON-RPC 调用走完 `handleMcp`，返回 reply。 */
function rpc(tools, method, params, id = 1) {
  return handleMcp({ jsonrpc: "2.0", id, method, params }, tools);
}

// ---------------------------------------------------------------- htmlToText
await check("htmlToText：段落与换行变成纯文本", () => {
  assert.equal(htmlToText("<p>第一行</p><p>第二行<br>第三行</p>"), "第一行\n第二行\n第三行");
});

await check("htmlToText：实体解码，@提及只留名字", () => {
  assert.equal(htmlToText('<at id="0">张三</at> 说 &quot;你好&quot; &amp; &#39;再见&#39;'), '张三 说 "你好" & \'再见\'');
});

await check("htmlToText：空输入与纯空白", () => {
  assert.equal(htmlToText(""), "");
  assert.equal(htmlToText("<p>   </p>"), "");
});

// ---------------------------------------------------------------- MCP 协议
const stubTools = [
  {
    name: "teams_echo",
    title: "echo",
    description: "echo back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    run: async (args) => ({ value: `echo:${args.text ?? ""}` }),
  },
  {
    name: "teams_boom",
    title: "boom",
    description: "always fails",
    inputSchema: { type: "object" },
    run: async () => {
      throw new TeamsError("TEAMS_AUTH_EXPIRED", "登录过期了", "401");
    },
  },
];

await check("mcp：initialize 回协议版本和服务器名", async () => {
  const reply = await rpc(stubTools, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi", version: "0" } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.result.protocolVersion, "2025-06-18");
  assert.equal(reply.body.result.serverInfo.name, "pi-web-teams");
  assert.ok(reply.body.result.capabilities.tools);
});

await check("mcp：不认识的协议版本回我们最新的那个", async () => {
  const reply = await rpc(stubTools, "initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "pi", version: "0" } });
  assert.equal(reply.body.result.protocolVersion, "2025-06-18");
});

await check("mcp：tools/list 把 inputSchema 原样交出去", async () => {
  const reply = await rpc(stubTools, "tools/list", {});
  const names = reply.body.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["teams_echo", "teams_boom"]);
  assert.equal(reply.body.result.tools[0].inputSchema.properties.text.type, "string");
});

await check("mcp：tools/call 成功 → 一条 text content", async () => {
  const reply = await rpc(stubTools, "tools/call", { name: "teams_echo", arguments: { text: "hi" } });
  assert.equal(reply.body.result.isError, undefined);
  assert.equal(reply.body.result.content[0].type, "text");
  assert.equal(reply.body.result.content[0].text, "echo:hi");
});

await check("mcp：工具抛 TeamsError → isError + 错误码，而不是把协议打断", async () => {
  const reply = await rpc(stubTools, "tools/call", { name: "teams_boom", arguments: {} });
  assert.equal(reply.body.result.isError, true);
  assert.match(reply.body.result.content[0].text, /TEAMS_AUTH_EXPIRED/);
  assert.match(reply.body.result.content[0].text, /登录过期了/);
});

await check("mcp：未知方法 -32601、未知工具 -32602", async () => {
  const method = await rpc(stubTools, "resources/read", {});
  assert.equal(method.body.error.code, -32601);
  const tool = await rpc(stubTools, "tools/call", { name: "nope", arguments: {} });
  assert.equal(tool.body.error.code, -32602);
});

await check("mcp：通知（没有 id）不产生响应体", async () => {
  const reply = await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, stubTools);
  assert.equal(reply, null);
});

await check("mcp：坏 JSON 回 -32700，非对象回 -32600", async () => {
  const bad = await handleMcp("{nope", stubTools);
  assert.equal(bad.body.error.code, -32700);
  const notObject = await handleMcp(null, stubTools);
  assert.equal(notObject.body.error.code, -32600);
});

// ---------------------------------------------------------------- 工具清单
await check("teams_* 四个工具都在，且发消息那个说明了确认规则", async () => {
  const svc = new TeamsService(
    () => {},
    async () => true,
  );
  const tools = teamsTools(svc);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["teams_chats", "teams_read", "teams_find", "teams_send"],
  );
  const send = tools.find((t) => t.name === "teams_send");
  assert.match(send.description, /48:notes/);
  assert.match(send.description, /确认/);
  assert.equal(send.inputSchema.required.includes("text"), true);
});

// ---------------------------------------------------------------- 发送策略
/** 一个不碰网络的 service：ready 直接过，client 的三个方法换成桩。 */
function fakeService({ confirm = async () => true, chats = [] } = {}) {
  const asked = [];
  const sent = [];
  const svc = new TeamsService(
    () => {},
    async (req) => {
      asked.push(req);
      return confirm(req);
    },
  );
  svc.ready = async () => {};
  svc.client.chats = async () => chats;
  svc.client.find = async () => [];
  svc.client.send = async (id, text) => {
    sent.push({ id, text });
    return { id: `m-${sent.length}`, time: new Date().toISOString() };
  };
  return { svc, asked, sent };
}

await check("发给自己：不问，直接发", async () => {
  const { svc, asked, sent } = fakeService();
  const out = await svc.send(SELF_CHAT, "hello");
  assert.equal(asked.length, 0);
  assert.equal(out.chat.self, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "hello");
});

await check("发给别人：页面点「取消」→ TEAMS_NOT_CONFIRMED，一条都没发出去", async () => {
  const { svc, asked, sent } = fakeService({ chats: [{ id: "19:abc@thread.v2", title: "张三", kind: "chat", lastActivity: null, preview: "" }], confirm: async () => false });
  await assert.rejects(() => svc.send("张三", "hi"), (err) => err.code === "TEAMS_NOT_CONFIRMED");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].to.id, "19:abc@thread.v2");
  assert.equal(sent.length, 0);
});

await check("发给别人：页面点「发送」→ 解析到会话 id 再发", async () => {
  const { svc, asked, sent } = fakeService({ chats: [{ id: "19:abc@thread.v2", title: "张三", kind: "chat", lastActivity: null, preview: "" }] });
  const out = await svc.send("张三", "hi");
  assert.equal(asked.length, 1);
  assert.deepEqual(sent, [{ id: "19:abc@thread.v2", text: "hi" }]);
  assert.equal(out.chat.title, "张三");
});

await check("空消息不触发任何确认", async () => {
  const { svc, asked } = fakeService();
  await assert.rejects(() => svc.send(SELF_CHAT, "   "), (err) => err.code === "TEAMS_EMPTY");
  assert.equal(asked.length, 0);
});

await check("推送目标落盘：setTarget 之后重新构造也读得回来", async () => {
  const { svc } = fakeService();
  svc.setTarget("19:zzz@thread.v2", "李四");
  assert.equal(svc.settingsView().target, "19:zzz@thread.v2");
  assert.deepEqual(svc.target(), { id: "19:zzz@thread.v2", title: "李四", self: false, kind: "chat" });
  const again = new TeamsService(
    () => {},
    async () => true,
  );
  assert.equal(again.settingsView().target, "19:zzz@thread.v2");
});

await check("关闭推送后 notify 直接拒绝，不去碰浏览器", async () => {
  const { svc } = fakeService();
  svc.setNotify(false);
  assert.deepEqual(await svc.notify("x"), { ok: false, reason: "off" });
});

await check("从没登录过：工具调用不自己起窗口，直接 TEAMS_OFF", async () => {
  const { svc } = fakeService();
  let spawned = 0;
  svc.ready = Object.getPrototypeOf(svc).ready.bind(svc); // 用真实现，别用桩
  svc.browser.ensure = async () => {
    spawned += 1;
  };
  svc.browser.reachable = async () => false;
  await assert.rejects(() => svc.send(SELF_CHAT, "hi"), (err) => err.code === "TEAMS_OFF");
  assert.equal(spawned, 0);
});

await check("频道不发也不读：先报 TEAMS_CHANNEL_UNSUPPORTED，不去点确认", async () => {
  const { svc, asked, sent } = fakeService();
  svc.resolve = async () => ({ id: "19:chan@thread.tacv2", title: "项目频道", self: false, kind: "channel" });
  await assert.rejects(() => svc.send("项目频道", "hi"), (err) => err.code === "TEAMS_CHANNEL_UNSUPPORTED");
  assert.equal(asked.length, 0);
  assert.equal(sent.length, 0);
  await assert.rejects(() => svc.messages("项目频道", 5), (err) => err.code === "TEAMS_CHANNEL_UNSUPPORTED");
});

await check("teams_read 截断超长消息，并留下原长", async () => {
  const long = "x".repeat(2000);
  const svc = { messages: async () => ({ chat: { id: "48:notes", title: "与你自己的聊天", self: true, kind: "self" }, messages: [{ id: "m", from: "a", name: "A", time: "", text: long }] }) };
  const tool = teamsTools(svc).find((t) => t.name === "teams_read");
  const out = await tool.run({ chat: "48:notes" });
  assert.ok(out.value.messages[0].text.length < 2000);
  assert.match(out.value.messages[0].text, /原文 2000 字/);
});

await check("窗口没开时 status 只说 off，不会顺手把浏览器拉起来", async () => {
  const { svc } = fakeService();
  const st = await svc.status();
  assert.equal(st.state, "off");
  assert.equal(st.reachable, false);
});

console.log(results.join("\n"));
console.log(process.exitCode ? "\n有失败用例" : `\n全部通过（${results.length}）`);
