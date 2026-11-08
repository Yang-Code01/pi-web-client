/**
 * Unit: `bridge/ext/open-preview.ts`（#224 复审）—— 扩展把桥的回包翻译给模型的那一层。
 *
 * 假 `pi.registerTool` 收下工具、几十行 http stub 当桥，断言：空路径 → `path`；`no-page` /
 * `untrusted-path` / `declined` 的解释来自桥的 `reply.text`（扩展不再自己写一遍同义句）；
 * `ok:true` 的文案用桥给的 `name`；缺 env → `channel`；桥 5 秒不答 → `channel`（不是英文的
 * `TimeoutError`）；桥的英文码（`tunnel` / `bad-token`）不原样吐进给模型的正文。
 *
 *   node --experimental-transform-types bridge/tests/open-preview-unit.mjs
 */
import http from "node:http";
import openPreview from "../ext/open-preview.ts";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

let tool = null;
const handlers = {};
openPreview({ registerTool: (t) => (tool = t), on: (ev, fn) => (handlers[ev] = fn) });
check("扩展注册了 open_preview 工具", tool?.name === "open_preview", String(tool?.name));

/** stub 桥：`reply` 决定回什么，`stall` 决定回不回（测超时）。 */
let reply = { status: 200, body: {} };
let stall = false;
let lastBody = null;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    lastBody = JSON.parse(raw || "{}");
    if (stall) return; // 接了连接，永远不回 —— 只能靠扩展自己的超时脱身
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
process.env.PI_WEB_LOOPBACK = BASE;
process.env.PI_WEB_LOOPBACK_TOKEN = "unit-token";

const say = (r) => r?.content?.[0]?.text ?? "";
const run = (params) => tool.execute("unit", params);

// ---- 1. 空路径：不敲桥，直接说清楚
const empty = await run({});
check("空路径 → details.reason:path", empty.details?.reason === "path", JSON.stringify(empty.details));
check("空路径 → 正文说「没有给路径」", say(empty).includes("没有给路径"), say(empty));

// ---- 2. no-page：解释来自桥的 text，扩展只补一句指令
reply = { status: 200, body: { ok: false, reason: "no-page", text: "STUB-没有页面在看。" } };
const none = await run({ path: "笔记.md" });
check("no-page → details.reason:no-page", none.details?.reason === "no-page", JSON.stringify(none.details));
check("no-page 的解释取自 reply.text", say(none).includes("STUB-没有页面在看。"), say(none));
check("no-page 补了一句「把路径写出来」", say(none).includes("把路径写出来告诉用户"), say(none));
check("请求带上了 token 与路径", lastBody?.token === "unit-token" && lastBody?.path === "笔记.md", JSON.stringify(lastBody));

// ---- 3. untrusted-path
reply = { status: 200, body: { ok: false, reason: "untrusted-path", text: "STUB-不在会话目录。" } };
const untrusted = await run({ path: "C:/别处/a.md" });
check("untrusted-path → details.reason", untrusted.details?.reason === "untrusted-path", JSON.stringify(untrusted.details));
check("untrusted-path 的解释取自 reply.text", say(untrusted).includes("STUB-不在会话目录。"), say(untrusted));

// ---- 4. declined（用户在未保存提示里选了「留在这里」）
reply = { status: 200, body: { ok: false, reason: "declined", text: "STUB-用户留在编辑器里。" } };
const declined = await run({ path: "笔记.md" });
check("declined → details.reason", declined.details?.reason === "declined", JSON.stringify(declined.details));
check("declined 的解释取自 reply.text", say(declined).includes("STUB-用户留在编辑器里。"), say(declined));

// ---- 5. ok:true：文案用桥给的 name（规则不变）
reply = { status: 200, body: { ok: true, path: "C:/w/报告.md", name: "报告.md" } };
const opened = await run({ path: "报告.md" });
check("ok:true → 文案用 name", say(opened) === "已在网页里打开「报告.md」。", say(opened));
check("ok:true → details 带 path / name", opened.details?.ok === true && opened.details?.name === "报告.md", JSON.stringify(opened.details));

// ---- 6. 桥的英文码不吐给模型（有中文 text 就用 text）
reply = { status: 403, body: { ok: false, reason: "bad-token", text: "回环凭据不对。" } };
const badToken = await run({ path: "笔记.md" });
check("bad-token 的中文 text 出现在正文", say(badToken).includes("回环凭据不对。"), say(badToken));
check("bad-token 这个英文码不在正文里", !say(badToken).includes("bad-token"), say(badToken));
check("英文码仍留在 details.reason（给日志用）", badToken.details?.reason === "bad-token", JSON.stringify(badToken.details));

reply = { status: 403, body: { ok: false, reason: "tunnel", text: "预览只接受本机回环的请求（公网隧道进不来）。" } };
const tunnelled = await run({ path: "笔记.md" });
check("tunnel 的中文 text 出现在正文", say(tunnelled).includes("预览只接受本机回环的请求"), say(tunnelled));
check("tunnel 这个英文码不在正文里", !say(tunnelled).includes("tunnel"), say(tunnelled));

// ---- 7. 缺 env：根本没通道
const savedBase = process.env.PI_WEB_LOOPBACK;
const savedToken = process.env.PI_WEB_LOOPBACK_TOKEN;
delete process.env.PI_WEB_LOOPBACK;
delete process.env.PI_WEB_LOOPBACK_TOKEN;
const noChannel = await run({ path: "笔记.md" });
check("缺 env → details.reason:channel", noChannel.details?.reason === "channel", JSON.stringify(noChannel.details));
check("缺 env → 正文说明通道没配", say(noChannel).includes("网页预览通道未配置"), say(noChannel));
process.env.PI_WEB_LOOPBACK = savedBase;
process.env.PI_WEB_LOOPBACK_TOKEN = savedToken;

// ---- 8. 桥不回（回执窗口之外也不答）：5 秒超时 → channel，正文是中文
stall = true;
const t0 = Date.now();
const hung = await run({ path: "笔记.md" });
const took = Date.now() - t0;
check("桥不答 → details.reason:channel（超时也算通道问题）", hung.details?.reason === "channel", JSON.stringify(hung.details));
check("超时在 5 秒上下返回，没挂死", took >= 4500 && took < 9000, `${took}ms`);
check("超时正文是中文、不带 TimeoutError/aborted", say(hung).includes("5 秒没有回应") && !/TimeoutError|aborted/i.test(say(hung)), say(hung));

server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
