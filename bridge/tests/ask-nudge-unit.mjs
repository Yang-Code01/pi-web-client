/**
 * Unit: `bridge/ext/ask-nudge.ts` —— 正文提问没走表单时，停下前拉回来重问一次。
 *
 * 断言：三种提问结构能认出（❓Q1 / 行首 Q1 / 结尾问用户），正常总结、代码块、修辞问句不误伤；
 * 本轮已经调过 ask_user_question 的不再提醒；末尾不是 assistant 正文的不提醒；同一段问句只提醒
 * 一次、整会话最多两次；开关默认开、只有显式 false 才关；条件满足时追加 display:false 的
 * custom_message、continue:true，并保留前面处理器的 entries。
 *
 *   node --experimental-transform-types bridge/tests/ask-nudge-unit.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import askNudge, {
  MAX_NUDGES,
  NUDGE_TYPE,
  hashOf,
  looksLikeTextQuestion,
  nudgeCount,
  nudgeEnabled,
  nudgeText,
  nudgedHashes,
  pendingQuestion,
} from "../ext/ask-nudge.ts";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

let n = 0;
const id = () => `e${++n}`;
const user = (text = "go") => ({ type: "message", id: id(), message: { role: "user", content: text } });
const assistant = (text) => ({ type: "message", id: id(), message: { role: "assistant", content: [{ type: "text", text }] } });
const askCall = (name = "ask_user_question") => ({
  type: "message",
  id: id(),
  message: { role: "assistant", content: [{ type: "toolCall", id: id(), name, arguments: {} }] },
});
const askResult = (name = "ask_user_question") => ({
  type: "message",
  id: id(),
  message: { role: "toolResult", toolName: name, toolCallId: id(), content: [{ type: "text", text: "ok" }] },
});
const toolResult = () => ({ type: "message", id: id(), message: { role: "toolResult", toolName: "bash", toolCallId: id(), content: [] } });
const nudged = (text = "x") => ({ type: "custom_message", id: id(), customType: NUDGE_TYPE, content: text, display: false, details: { hash: hashOf(text) } });

// ---- looksLikeTextQuestion
const grill = [
  "读了一遍现状再问。",
  "❓ **Q1** - **你看到的是哪一种**：三种情况，处理方式完全不同。",
  "➡️ 我赌 (a)。",
  "❓ **Q2** - **你的会话会不会跨天**：这决定规则还成不成立。",
].join("\n");
check("❓Q1 格式 → 命中", !!looksLikeTextQuestion(grill));
check("行首 Q1 + 问号 → 命中", !!looksLikeTextQuestion("Q1. 你要哪一种？\nQ2. 什么时候要？"));
check("结尾问用户 → 命中", !!looksLikeTextQuestion("改完了，测试也过了。要不要我把这条规则也写进 AGENTS.md？"));
check("第二人称选择问句 → 命中", !!looksLikeTextQuestion("你更倾向哪个方案？"));
check("普通总结 → 不命中", looksLikeTextQuestion("改完了：测试 12/12 通过，已提交。") === null);
check("代码块里的问号 → 不命中", looksLikeTextQuestion("示例：\n```js\nconst ok = a ? b : c;\n```\n就这些。") === null);
check("没有第二人称的疑问 → 不命中", looksLikeTextQuestion("为什么会这样？因为缓存没清。") === null);
check("空文本 → 不命中", looksLikeTextQuestion("   ") === null);

// ---- pendingQuestion
check("末尾是正文提问 → 命中", !!pendingQuestion([user(), assistant("要不要我顺手把测试也补了？")]));
check("本轮调过 ask 工具 → 不命中", pendingQuestion([user(), assistant("我先问一下。"), askCall(), askResult(), assistant("收到。")]) === null);
check("本轮只有 ask 的 toolCall → 不命中", pendingQuestion([user(), assistant("我先问一下。"), askCall(), assistant("收到。")]) === null);
check("旧名字 question 也算问过", pendingQuestion([user(), askCall("question"), askResult("question"), assistant("收到。")]) === null);
check("上一轮问过、这一轮又在正文问 → 命中", !!pendingQuestion([user("a"), askCall(), askResult(), assistant("收到。"), user("b"), assistant("那你要哪一个？")]));
check("末尾是工具结果 → 不命中", pendingQuestion([user(), assistant("我查一下。"), toolResult()]) === null);
check("末尾是空正文 → 不命中", pendingQuestion([user(), assistant("")]) === null);
check("没有 assistant → 不命中", pendingQuestion([user()]) === null);
{
  const hit = pendingQuestion([user(), assistant(grill)]);
  check("命中时给出问句摘要与去重 hash", hit?.snippet.includes("Q1") && hit?.hash === hashOf(hit.snippet), hit?.hash);
}

// ---- 去重 / 计数
{
  const hit = pendingQuestion([user(), assistant(grill)]);
  const branch = [user(), assistant(grill), nudged(hit.snippet)];
  check("提醒 hash 能回收", nudgedHashes(branch).has(hit.hash));
  check("提醒计数", nudgeCount(branch) === 1);
}
check("没有提醒时 hash 为空", nudgedHashes([user()]).size === 0);

// ---- 文案
check("文案要求用 ask_user_question", /ask_user_question/.test(nudgeText({ text: "", snippet: "Q1 你要哪个？", hash: "x" })));
check("文案带原问句", nudgeText({ text: "", snippet: "Q1 你要哪个？", hash: "x" }).includes("Q1 你要哪个？"));
check("文案禁止再用正文问", /不要再用正文问/.test(nudgeText({ text: "", snippet: "x", hash: "x" })));

// ---- nudgeEnabled
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-nudge-"));
const file = path.join(dir, "settings.json");
check("没有文件 → 默认开", nudgeEnabled(file) === true);
check("没给路径 → 默认开", nudgeEnabled("") === true);
fs.writeFileSync(file, "{ broken");
check("坏 JSON → 默认开", nudgeEnabled(file) === true);
fs.writeFileSync(file, JSON.stringify({ web: { defaultPermission: "ask" } }));
check("没有这个键 → 默认开", nudgeEnabled(file) === true);
fs.writeFileSync(file, JSON.stringify({ web: { askNudge: "false" } }));
check("字符串 false 不算关", nudgeEnabled(file) === true);
fs.writeFileSync(file, JSON.stringify({ web: { askNudge: false } }));
check("web.askNudge=false → 关", nudgeEnabled(file) === false);

// ---- handler
const handlers = {};
askNudge({ on: (ev, fn) => (handlers[ev] = fn) });
const settle = handlers.agent_before_settle;
check("注册了 agent_before_settle", typeof settle === "function");
const ctx = (branch) => ({ sessionManager: { getBranch: () => branch } });
const prior = { type: "custom", customType: "other", data: 1 };
const ev = (over = {}) => ({ outcome: "completed", entries: [prior], continue: false, context: { canContinue: true }, ...over });
const pending = [user(), assistant("工作做完了。那你要选哪一种方案？")];

process.env.PI_WEB_SETTINGS_FILE = file;
fs.writeFileSync(file, JSON.stringify({ web: { askNudge: true } }));
{
  const r = await settle(ev(), ctx(pending));
  const added = r?.entries?.at(-1);
  check("条件满足 → continue:true", r?.continue === true);
  check("追加 display:false 的提醒", added?.type === "custom_message" && added.customType === NUDGE_TYPE && added.display === false);
  check("提醒带 hash", typeof added?.details?.hash === "string" && !!added.details.hash);
  check("保留前面处理器的 entries", r?.entries?.[0] === prior && r.entries.length === 2);
}
check("中断的运行不续跑", (await settle(ev({ outcome: "aborted" }), ctx(pending))) === undefined);
check("出错的运行不续跑", (await settle(ev({ outcome: "error" }), ctx(pending))) === undefined);
check("不能续跑时不续跑", (await settle(ev({ context: { canContinue: false } }), ctx(pending))) === undefined);
check("正常总结不续跑", (await settle(ev(), ctx([user(), assistant("测试 12/12 通过，已提交。")]))) === undefined);
check("本轮问过表单不续跑", (await settle(ev(), ctx([user(), askCall(), askResult(), assistant("收到。")]))) === undefined);
{
  const hit = pendingQuestion(pending);
  const same = [user(), assistant("工作做完了。那你要选哪一种方案？"), nudged(hit.snippet), assistant("工作做完了。那你要选哪一种方案？")];
  check("同一段问句提醒过 → 不续跑", (await settle(ev(), ctx(same))) === undefined);
}
{
  const hit = pendingQuestion(pending);
  const twice = [nudged(hit.snippet), nudged("another")];
  check("整会话到上限 → 不续跑", nudgeCount(twice) === MAX_NUDGES && (await settle(ev(), ctx([...pending, ...twice]))) === undefined);
}
check("读不到分支不抛", (await settle(ev(), { sessionManager: { getBranch: () => { throw new Error("x"); } } })) === undefined);
fs.writeFileSync(file, JSON.stringify({ web: { askNudge: false } }));
check("开关关 → 不续跑", (await settle(ev(), ctx(pending))) === undefined);
delete process.env.PI_WEB_SETTINGS_FILE;
check("没给设置路径 → 默认开，仍续跑", (await settle(ev(), ctx(pending)))?.continue === true);

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
