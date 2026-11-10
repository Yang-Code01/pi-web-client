/**
 * A scripted stand-in for `pi --mode rpc`, so bridge behaviour around runs, queues, retries and
 * compaction can be checked without a model or an API key. Point the bridge at it with PI_BIN.
 *
 * It mimics the pi 1.4.0 rules the bridge has to respect (docs/rpc.md, docs/rpc-commands.md):
 *  - a prompt during a run without `streamingBehavior` fails with "Agent is already processing";
 *  - a prompt during compaction fails with "Cannot submit a prompt while compaction is in progress";
 *  - `abort` leaves the queue alone: queued follow-ups run once the aborted run has settled;
 *  - `agent_end` is not the end: a retry continues the run until `agent_settled`.
 *
 * Scenarios are picked by the prompt text: "SLOW…" streams until aborted, "STAY…" keeps the run
 * open for ~800 ms (so steer messages can land in the same run, #198), "HANDLED…" is consumed
 * without starting a run (`disposition: "handled"`), "RETRY…" fails and retries, and anything else
 * echoes. Every run also leaves a `run-start` line, so a test can count runs rather than guess.
 *
 * Env: FAKE_PI_LOG (jsonl of what the stub saw), FAKE_COMPACT_MS (manual compaction length).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG = process.env.FAKE_PI_LOG || "";
const COMPACT_MS = Number(process.env.FAKE_COMPACT_MS || 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const note = (obj) => {
  if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), ...obj })}\n`);
};
/** #202: prompt 里带的图片只记 mimeType —— 测试要能说清「图是跟着这条一起到的」，不搬字节。 */
const notePrompt = (cmd, text) =>
  note({
    t: "prompt",
    pid: process.pid,
    text,
    behavior: cmd.streamingBehavior ?? null,
    images: (Array.isArray(cmd.images) ? cmd.images : []).map((i) => String(i?.mimeType ?? "")),
  });
const ok = (id, command, data) => out({ type: "response", command, success: true, id, ...(data === undefined ? {} : { data }) });
const fail = (id, command, error) => out({ type: "response", command, success: false, id, error });

/** #86: this stub owns a pretend session file when --session-dir is passed, so a test can watch
 * `new_session` move it and the bridge delete the old one. */
const ARGV = process.argv.slice(2);
const argOf = (name) => {
  const i = ARGV.indexOf(name);
  return i >= 0 ? ARGV[i + 1] ?? "" : "";
};
const SESSION_DIR = argOf("--session-dir");
let sessionId = argOf("--session-id") || `fake-${process.pid}`;
let sessionFile = SESSION_DIR ? path.join(SESSION_DIR, `${sessionId}.jsonl`) : "";
/** #225: real pi always owns a session file; `FAKE_PI_SESSION=1` puts one at pi's normal layout
 * (`<PI_AGENT_DIR>/sessions/<id>.jsonl`) so the bridge's `state.file` is a transcript a test can
 * write into — that is the only way to exercise the "mentioned in the transcript" trust rule. */
if (!sessionFile && process.env.FAKE_PI_SESSION === "1") {
  sessionFile = path.join(process.env.PI_AGENT_DIR ?? os.tmpdir(), "sessions", `${sessionId}.jsonl`);
}
const touchSessionFile = () => {
  if (!sessionFile) return;
  try {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId, cwd: process.cwd() })}
`);
  } catch {
    /* the test asserts on paths it saw in the log, not on this file surviving */
  }
};
touchSessionFile();

/** #86: the stub keeps the model / thinking level it was told, so get_state can report them back. */
const FAKE_MODELS = [
  { id: "fake-model", name: "Fake Model", provider: "stub" },
  { id: "fake-model-2", name: "Fake Model 2", provider: "stub" },
];
let currentModel = FAKE_MODELS[0];
let thinkingLevel = "off";
let sessionStats = { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.01, contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 } };

let running = false;
let compacting = false;
let abortRequested = false;
/**
 * #200: 「REFUSE…」这条第一次被拒（成功响应 + disposition handled + error，形状和真 pi 拒收一致的帧），
 * 之后再发就正常跑 —— 测试才能证明「重试真的把这条补发出去了」，而不是碰巧没被拒。
 */
let refusedOnce = 0;
let steering = [];
let followUp = [];
let settleWaiters = [];
// `abort_bash` 会把它翻成 true，`bash` 处理完再翻回来 —— 必须是 let（#202 的 H 段踩到过：
// 写成 const 之后桩 pi 在收到第一条 bash 时直接抛「Assignment to constant variable」）。
let bashAborted = false;
/** Resolver of the turn's pending confirm (#82): answered by `extension_ui_response` or `abort`. */
let pendingConfirm = null;
/** The command the stub claims it is about to run, so the approval card has something to show. */
const CONFIRM_MESSAGE = "rm -rf build/";
// What the bridge started us with (launch options, #28), plus the PI_WEB_* vars it let through:
// the bridge strips its own settings, and a test can assert one did not reach pi (#76).
note({
  t: "argv",
  pid: process.pid,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  piWeb: Object.keys(process.env).filter((k) => k.startsWith("PI_WEB_")),
  // Values a test needs to call the bridge back itself (loopback origin + per-child token).
  loopback: process.env.PI_WEB_LOOPBACK ?? null,
  loopbackToken: process.env.PI_WEB_LOOPBACK_TOKEN ?? null,
});
// One line per process that went away, so "it really exited" is provable from the log (#76).
let exited = false;
const noteExit = () => {
  if (exited) return;
  exited = true;
  note({ t: "exit", pid: process.pid });
};
process.on("exit", noteExit);
process.on("SIGTERM", () => process.exit(0));

const queueUpdate = () => out({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
const assistant = (text, extra = {}) => ({
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
  model: "fake-model",
  stopReason: "stop",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  ...extra,
});

async function turn(text) {
  note({ t: "turn", pid: process.pid, text });
  if (text.startsWith("STAY")) {
    // #198：一轮要撑得够久，后面几条「插话」才有机会落进**同一轮**；否则 echo 快到来不及排队。
    out({ type: "message_start", message: assistant("") });
    let streamed = "";
    for (let i = 0; i < 8; i++) {
      streamed += "…";
      out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "…" } });
      await sleep(100);
    }
    out({ type: "message_end", message: assistant(streamed) });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  if (text.startsWith("SLOW")) {
    out({ type: "message_start", message: assistant("") });
    let streamed = "";
    while (!abortRequested) {
      streamed += "…";
      out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "…" } });
      await sleep(150);
    }
    out({ type: "message_end", message: assistant(streamed, { stopReason: "aborted" }) });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  if (text.startsWith("SILENT")) {
    // 完全静默（#81）：`agent_start` 之后一个事件都不发。默认连 abort 都不理 —— 真卡死的样子，
    // 只有结束进程才能收场；"soft" 那一份收到 abort 就正常收尾（宽限期内的正常结束）；"ask" 那一份
    // 先挂一个审批再静默（等人点的会话不是卡死）。
    if (/ask/i.test(text)) out({ type: "extension_ui_request", id: `ui-confirm-${Date.now()}`, method: "confirm", title: "运行命令", message: "npm run build" });
    if (/soft/i.test(text)) {
      while (!abortRequested) await sleep(100);
      out({ type: "message_end", message: assistant("", { stopReason: "aborted" }) });
      out({ type: "agent_end", messages: [], willRetry: false });
      return;
    }
    await new Promise(() => {}); // never settles: the process must be ended from outside
  }
  if (text.startsWith("TOOLHANG")) {
    // 工具在途后静默（#81）：工具开始了，之后一个事件都没有 —— 一个 40 分钟的构建就是这个样子。
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("", { content: [{ type: "toolCall", id: "call-hang", name: "bash", arguments: { command: "npm install" } }], stopReason: "toolUse" }) });
    out({ type: "tool_execution_start", toolCallId: "call-hang", toolName: "bash", args: { command: "npm install" } });
    while (!abortRequested) await sleep(100);
    out({ type: "tool_execution_end", toolCallId: "call-hang", isError: false, result: "ok" });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  if (text.startsWith("NOWARGS")) {
    // #344: 一个在途工具，参数比一行长得多（子代理任务、ask 的整段 JSON 都是这样）——「现在」卡要把它压成一行。
    const long = "很长的问题文本 ".repeat(24);
    const args = { questions: [{ id: "q1", header: "折叠哪里", prompt: long, options: [{ value: "a", label: "A" }] }] };
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("", { content: [{ type: "toolCall", id: "call-long", name: "ask_user_question", arguments: args }], stopReason: "toolUse" }) });
    out({ type: "tool_execution_start", toolCallId: "call-long", toolName: "ask_user_question", args });
    while (!abortRequested) await sleep(100);
    out({ type: "tool_execution_end", toolCallId: "call-long", isError: false, result: "answered" });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  if (text.startsWith("BGCHILD")) {
    const runId = process.env.FAKE_PI_CHILD_RUN_ID || `del_fake_${process.pid}`;
    const root = path.join(os.tmpdir(), "acp-delegate");
    const activity = path.join(root, `${runId}.activity`);
    const session = path.join(root, `${runId}.session.jsonl`);
    const newline = String.fromCharCode(10);
    const tick = String.fromCharCode(96);
    const at = () => new Date().toISOString();
    const usage = (totalTokens, totalCost) => ({
      input: totalTokens - 5,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: totalCost, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
    });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(activity, "child session fixture");
    const planTasks = [
      { id: 1, subject: "Inspect child session", status: "completed" },
      { id: 2, subject: "Summarize findings", activeForm: "Summarizing findings", status: "in_progress", blockedBy: [1] },
    ];
    const entries = [
      { type: "session", id: `child-${process.pid}`, timestamp: at(), cwd: process.cwd() },
      { type: "message", id: "child-u1", parentId: null, timestamp: at(), message: { role: "user", content: [{ type: "text", text: "child task" }] } },
      { type: "message", id: "child-plan-call", parentId: "child-u1", timestamp: at(), message: { role: "assistant", content: [{ type: "toolCall", id: "child-call-plan", name: "todo", arguments: { action: "create", tasks: planTasks } }] } },
      { type: "message", id: "child-plan-result", parentId: "child-plan-call", timestamp: at(), message: { role: "toolResult", toolCallId: "child-call-plan", toolName: "todo", content: [{ type: "text", text: "Plan updated" }], details: { action: "create", tasks: planTasks } } },
      { type: "message", id: "child-a1", parentId: "child-plan-result", timestamp: at(), message: { role: "assistant", content: [{ type: "text", text: "child-first" }, { type: "toolCall", id: "child-call-live", name: "child_lookup", arguments: { query: "current step" } }], usage: usage(15, 0.01) } },
    ];
    fs.writeFileSync(session, `${entries.map((entry) => JSON.stringify(entry)).join(newline)}${newline}`);
    const append = (id, parentId, answer, count, cost) => fs.appendFileSync(session, `${JSON.stringify({
      type: "message", id, parentId, timestamp: at(), message: { role: "assistant", content: [{ type: "text", text: answer }], usage: usage(count, cost) },
    })}${newline}`);
    const updatedPlanTasks = [
      { id: 1, subject: "Inspect child session", status: "completed" },
      { id: 2, subject: "Summarize findings", status: "completed", blockedBy: [1] },
    ];
    setTimeout(() => fs.appendFileSync(session, `${JSON.stringify({
      type: "custom", id: "child-plan-state", parentId: "child-a1", timestamp: at(), customType: "rpiv-todo-state", data: { action: "update", tasks: updatedPlanTasks },
    })}${newline}`), 550);
    setTimeout(() => append("child-a2", "child-plan-state", "child-second", 15, 0.01), 1200);
    setTimeout(() => append("child-a3", "child-a2", "child-third", 15, 0.01), 3200);
    const quotedRunId = [tick, runId, tick].join("");
    const resultText = [
      `Delegated to **researcher** (runId ${quotedRunId}).`,
      "Task: inspect child updates",
      `Running in the background at ${tick}${root}${tick}.`,
      `Live activity is streaming to ${tick}${activity}${tick}.`,
    ].join(newline);
    const callId = `call-${runId}`;
    const args = { agent: "researcher", task: "inspect child updates" };
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("", { content: [{ type: "toolCall", id: callId, name: "acp_delegate", arguments: args }], stopReason: "toolUse" }) });
    out({ type: "tool_execution_start", toolCallId: callId, toolName: "acp_delegate", args });
    out({
      type: "tool_execution_end",
      toolCallId: callId,
      toolName: "acp_delegate",
      isError: false,
      result: {
        content: [{ type: "text", text: resultText }],
        details: { kind: "delegate", runId, agent: "researcher", task: "inspect child updates" },
      },
    });
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("子代理已启动。", { stopReason: "stop" }) });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  if (text.startsWith("BGSTART")) {
    // D170: 派一个后台子代理，这一轮正常收尾 —— 会话自己 settle 了，runner 还在跑。
    // 形状照真 pi 来：`result` 是 `{ content, details }`（pi docs/json.md），活动路径在结果文本的
    // 第二段里并且**带缩进** —— 只认行首的解析器在这里就会把提示条弄丢。
    const activity = path.join(os.tmpdir(), "acp-delegate", "del_fake.activity");
    fs.mkdirSync(path.dirname(activity), { recursive: true });
    fs.writeFileSync(activity, "[tool] bash rg -n continueState web/src\n[tool] read bridge/src/sessions.ts\n");
    out({ type: "message_start", message: assistant("") });
    out({ type: "tool_execution_start", toolCallId: "call-bg", toolName: "acp_delegate", args: { agent: "researcher", task: "look at the files" } });
    out({
      type: "tool_execution_end",
      toolCallId: "call-bg",
      toolName: "acp_delegate",
      isError: false,
      result: {
        content: [{ type: "text", text: "Delegated to **researcher** (runId `del_fake`).\nTask: look at the files\nRunning in the background at `" + path.join(os.tmpdir(), "acp-delegate") + "`.\n  Live activity is streaming to `" + activity + "`." }],
        details: { kind: "delegate", runId: "del_fake", agent: "researcher", task: "look at the files" },
      },
    });
    out({ type: "message_end", message: assistant("子代理已启动，我先合入别的分支。", { stopReason: "stop" }) });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  if (text.startsWith("BGDONE")) {
    // runner 的完成通知。真 pi 走的是 `role: "custom"` 的注入消息（桥专门处理这一档），
    // 不是普通用户发言 —— 结束判定只认 user 角色的话，提示条就永远收不掉。
    const answer = path.join(os.tmpdir(), "acp-delegate", "del_fake.out");
    fs.writeFileSync(answer, "## 结论\n三条接口都已对齐，没有破坏性变更。\n");
    out({ type: "message_start", message: { role: "custom", content: [{ type: "text", text: "[acp_delegate completed] **researcher** (runId `del_fake`, exit 0)\n全部通过。" }] } });
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("收到，继续收尾。", { stopReason: "stop" }) });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  if (text.startsWith("EXT")) {
    // Fire-and-forget extension UI (rpc-mode.js): none of these may be answered.
    const ui = (method, fields) => out({ type: "extension_ui_request", id: `ui-${method}-${Date.now()}`, method, ...fields });
    ui("notify", { message: "\u001b[33m索引已更新\u001b[0m", notifyType: "warning" });
    ui("setStatus", { statusKey: "lint", statusText: "\u001b[32mlint ✓\u001b[0m 3 files" });
    ui("setStatus", { statusKey: "gone", statusText: "temporary" });
    ui("setStatus", { statusKey: "gone", statusText: undefined });
    ui("setWidget", { widgetKey: "todo", widgetLines: ["TODO", "- a", "- b"], widgetPlacement: "aboveEditor" });
    ui("setWidget", { widgetKey: "foot", widgetLines: ["below line"], widgetPlacement: "belowEditor" });
    // pi-subagents 在 RPC 模式下把状态快照当成 widget 推过来（一行哨兵 JSON）：桥应当认出来丢掉，
    // 不然页面上就是输入框上方一坨被 400 字截断的原文（真事，用户截图报的）。
    ui("setWidget", { widgetKey: "subagent-async", widgetLines: ['PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","version":1}'], widgetPlacement: "aboveEditor" });
    ui("setTitle", { title: "pi — fake title" });
    ui("set_editor_text", { text: "prefilled by extension" });
  }
  if (text.startsWith("APPROVAL")) {
    // One approval on screen until somebody answers it: what the bridge's expiry rule is about (#82).
    out({ type: "message_start", message: assistant("") });
    const id = `ui-confirm-${Date.now()}`;
    note({ t: "confirm-asked", id, message: CONFIRM_MESSAGE });
    const reply = await new Promise((resolve) => {
      pendingConfirm = resolve;
      out({ type: "extension_ui_request", id, method: "confirm", title: "需要确认", message: CONFIRM_MESSAGE });
    });
    pendingConfirm = null;
    note({ t: "confirm-reply", id, reply });
    out({ type: "message_end", message: assistant(`confirm: ${reply}`, { stopReason: reply === "aborted" ? "aborted" : "stop" }) });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  if (text.startsWith("ASK")) {
    // What the `question` extension really does in rpc mode: post to the bridge and wait for the
    // browser (#82). The bridge holds this request open exactly as long as the ask is pending.
    out({ type: "message_start", message: assistant("") });
    const question = { id: "q1", label: "Q1", prompt: "选哪个", options: [{ value: "a", label: "A" }], allowOther: true };
    const answer = await fetch(`${process.env.PI_WEB_LOOPBACK}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: process.env.PI_WEB_LOOPBACK_TOKEN, tool: "question", questions: [question] }),
    })
      .then((r) => r.json())
      .catch(() => ({ cancelled: true }));
    note({ t: "ask-reply", cancelled: Boolean(answer.cancelled), answers: answer.answers ?? null });
    out({ type: "message_end", message: assistant(`ask: ${answer.cancelled ? "cancelled" : "answered"}`, { stopReason: answer.cancelled ? "aborted" : "stop" }) });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  if (text.startsWith("RETRY")) {
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("", { stopReason: "error", errorMessage: "429 Too Many Requests" }) });
    out({ type: "agent_end", messages: [], willRetry: true });
    out({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1500, errorMessage: "429 Too Many Requests" });
    await sleep(1500);
    out({ type: "agent_start" });
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("", { stopReason: "error", errorMessage: "401 invalid api key" }) });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "auto_retry_end", success: false, attempt: 2, finalError: "401 invalid api key" });
    return;
  }
  if (text.startsWith("PLANLOOP")) {
    // #341: 一轮里三次 todo 调用 —— 聊天记录必须把它们折成一张卡（不是三张）。
    const a = { id: 1, subject: "甲", status: "pending" };
    const b = { id: 2, subject: "乙", status: "pending" };
    const steps = [
      { args: { action: "create", tasks: [a, b] }, details: { action: "create", params: {}, tasks: [a, b], nextId: 3 } },
      { args: { action: "update", id: 1, status: "in_progress" }, details: { action: "update", params: { id: 1, status: "in_progress" }, tasks: [{ ...a, status: "in_progress" }, b], nextId: 3 } },
      { args: { action: "update", id: 1, status: "completed" }, details: { action: "update", params: { id: 1, status: "completed" }, tasks: [{ ...a, status: "completed" }, b], nextId: 3 } },
    ];
    for (const [i, step] of steps.entries()) {
      const id = `call-plan-loop-${i}`;
      out({ type: "message_start", message: assistant("") });
      out({ type: "message_end", message: assistant("", { content: [{ type: "toolCall", id, name: "todo", arguments: step.args }], stopReason: "toolUse" }) });
      out({ type: "tool_execution_start", toolCallId: id, toolName: "todo", args: step.args });
      out({ type: "tool_execution_end", toolCallId: id, toolName: "todo", isError: false, result: { content: [{ type: "text", text: "Plan updated" }], details: step.details } });
    }
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("Plan loop done.") });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  if (text.startsWith("PLAN")) {
    const tasks = [
      { id: 1, subject: "检查现有实现", status: "completed" },
      { id: 2, subject: "实现计划快照", activeForm: "实现计划快照", status: "in_progress" },
      { id: 3, subject: "验证回放", status: "pending", blockedBy: [2] },
      { id: 4, subject: "已移除任务", status: "deleted" },
    ];
    const initial = { action: "create", params: {}, tasks: tasks.map((task) => ({ ...task, status: "pending" })), nextId: 5 };
    const details = { action: "update", params: { id: 2, status: "in_progress" }, tasks, nextId: 5 };
    if (sessionFile) {
      touchSessionFile();
      let parentId = null;
      try {
        const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
        parentId = JSON.parse(lines.at(-1)).id ?? null;
      } catch { /* a new fake session only has its header */ }
      const addEntry = (type, fields) => {
        const entry = { type, id: `fake-plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, parentId, timestamp: new Date().toISOString(), ...fields };
        fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
        parentId = entry.id;
        return entry.id;
      };
      for (let round = 1; round <= 70; round += 1) {
        const userId = addEntry("message", { message: { role: "user", content: [{ type: "text", text: `earlier round ${round}` }] } });
        const assistantId = addEntry("message", { parentId: userId, message: assistant(`earlier answer ${round}`) });
        parentId = assistantId;
        if (round === 2) addEntry("custom", { customType: "rpiv-todo-state", data: initial });
      }
      const userId = addEntry("message", { message: { role: "user", content: [{ type: "text", text }] } });
      const callId = "call-plan-snapshot";
      const assistantId = addEntry("message", {
        parentId: userId,
        message: assistant("", { content: [{ type: "toolCall", id: callId, name: "todo", arguments: { action: "update", id: 2, status: "in_progress" } }], stopReason: "toolUse" }),
      });
      const resultId = addEntry("message", {
        parentId: assistantId,
        message: { role: "toolResult", toolCallId: callId, toolName: "todo", content: [{ type: "text", text: "Updated #2" }], details },
      });
      parentId = resultId;
      addEntry("custom", { customType: "rpiv-todo-state", data: details });
    }

    const beforeStepId = "call-plan-before";
    const beforeStepArgs = { path: "context.md" };
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("", { content: [{ type: "toolCall", id: beforeStepId, name: "read", arguments: beforeStepArgs }], stopReason: "toolUse" }) });
    out({ type: "tool_execution_start", toolCallId: beforeStepId, toolName: "read", args: beforeStepArgs });
    out({ type: "tool_execution_end", toolCallId: beforeStepId, toolName: "read", isError: false, result: "Prior to plan update" });
    const callId = "call-plan-snapshot";
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("", { content: [{ type: "toolCall", id: callId, name: "todo", arguments: { action: "update", id: 2, status: "in_progress" } }], stopReason: "toolUse" }) });
    out({ type: "tool_execution_start", toolCallId: callId, toolName: "todo", args: { action: "update", id: 2, status: "in_progress" } });
    out({ type: "tool_execution_end", toolCallId: callId, toolName: "todo", isError: false, result: { content: [{ type: "text", text: "Updated #2" }], details } });
    const stepId = "call-plan-step";
    const stepArgs = { path: "plan.md" };
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("", { content: [{ type: "toolCall", id: stepId, name: "read", arguments: stepArgs }], stopReason: "toolUse" }) });
    out({ type: "tool_execution_start", toolCallId: stepId, toolName: "read", args: stepArgs });
    out({ type: "tool_execution_end", toolCallId: stepId, toolName: "read", isError: false, result: "Plan step evidence" });
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("Plan snapshot updated.") });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  if (text.startsWith("METRICS")) {
    // Two assistant message-end stats frames in one run let the browser smoke verify live cost growth.
    sessionStats = { tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30 }, cost: 0.02, contextUsage: { tokens: 2000, contextWindow: 200000, percent: 1 } };
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("first update") });
    await sleep(800);
    sessionStats = { tokens: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, total: 60 }, cost: 0.05, contextUsage: { tokens: 5000, contextWindow: 200000, percent: 2.5 } };
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("second update") });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  // #86：pi 每调一次工具都会先发一条「文字为空、只有工具调用」的 assistant 消息。
  // 页面上不能因此多出一堆「随手问 / …」。
  if (/^TOOLS/.test(text)) {
    const calls = ["web_search", "fetch_content", "fetch_content"];
    for (const name of calls) {
      const id = `call-${name}-${Math.random().toString(36).slice(2, 7)}`;
      out({ type: "message_start", message: assistant("") });
      out({ type: "message_end", message: assistant("", { content: [{ type: "toolCall", id, name, arguments: { q: text } }], stopReason: "toolUse" }) });
      out({ type: "tool_execution_start", toolCallId: id, toolName: name, args: { q: text } });
      out({ type: "tool_execution_end", toolCallId: id, isError: false, result: "ok" });
    }
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("查到了：晴。") });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  // 「⚡ 总结本轮错误」探针（D164）：一次 turn 里几颗会失败的工具，形状照真实会话抄。
  if (/^FAILS/.test(text)) {
    const calls = [
      ["bash", "cd F:/pi-web-client-wt/feat-setti && git status", "bash: cd: F:/pi-web-client-wt/feat-setti: No such file or directory"],
      ["bash", "cd F:/pi-web-client-wt/feat-setti && ls", "bash: cd: F:/pi-web-client-wt/feat-setti: No such file or directory"],
      ["bash", "netstat -ano | grep :7864", "bash: netstat: command not found"],
      ["edit", "web/src/notseheet.ts", "File not found: web/src/notseheet.ts"],
    ];
    for (const [name, argText, res] of calls) {
      const id = `call-fail-${Math.random().toString(36).slice(2, 7)}`;
      const args = name === "bash" ? { command: argText } : { path: argText };
      out({ type: "message_start", message: assistant("") });
      out({ type: "message_end", message: assistant("", { content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" }) });
      out({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
      out({ type: "tool_execution_end", toolCallId: id, toolName: name, isError: true, result: `${res}

Command exited with code 1` });
    }
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_end", message: assistant("改完了。") });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  // 「发到会话复盘」（D164 延伸）：回答末尾按提示词要求回写规矩。
  // 形状照真模型来：标记包在粗体里、前面夹一段解释 —— 前端在正文里找标记，不认整行的格式。
  if (text.startsWith("[pi-web:review]")) {
    // 类行的形状是 `- bash|path|cd <path> · bash · cd <path> —— …`，键取第一个分隔符之前那一段，
    // 这样回写的键和界面算出来的完全一样（否则规矩会挂到一个界面上不存在的键上）。
    const sep = ` ${String.fromCharCode(183)} `;
    const row = text.split("\n").find((l) => l.startsWith("- ") && l.includes("|")) ?? "";
    const key = row ? row.slice(2).split(sep)[0] : "bash|path|cd <path>";
    note({ t: "review", key, classes: (text.match(/^- [a-z]+\|/gm) ?? []).length });
    const body = [
      "## 这一轮栽在哪",
      `主因在路径：\`${key}\` 那一类，两次都是仓库名手打错了。`,
      "",
      "## 规矩",
      `- **[pi-web:rule] ${key} :: 先 test -d 再 cd，方向先验再动手**`,
    ].join("\n");
    out({ type: "message_start", message: assistant("") });
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: body } });
    out({ type: "message_end", message: assistant(body) });
    out({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  out({ type: "message_start", message: assistant("") });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `echo: ${text}` } });
  out({ type: "message_end", message: assistant(`echo: ${text}`) });
  out({ type: "agent_end", messages: [], willRetry: false });
}

async function run(first) {
  running = true;
  abortRequested = false;
  // 一轮一行（`turn` 只说明哪句话被处理，`run-start` 才说明它们是不是同一轮 —— #198）。
  note({ t: "run-start", pid: process.pid, text: first });
  out({ type: "agent_start" });
  await turn(first);
  // Queued messages keep the same run going, unless it was aborted.
  while (!abortRequested && (steering.length || followUp.length)) {
    const next = steering.length ? steering.shift() : followUp.shift();
    queueUpdate();
    await turn(next);
  }
  const aborted = abortRequested;
  running = false;
  out({ type: "agent_settled", aborted });
  for (const w of settleWaiters.splice(0)) w();
  // pi's abort does not clear the queue: what is left starts a new run once idle.
  if (aborted && (steering.length || followUp.length)) {
    const next = steering.length ? steering.shift() : followUp.shift();
    queueUpdate();
    note({ t: "resume-queue", text: next });
    void run(next);
  }
}

/**
 * `FAKE_PI_BOOT_MS`: hold the first command back for that long, so a test can pretend the real pi is
 * spending seconds loading extensions before it answers `get_state` (D122). The bridge must not make
 * the caller wait for that.
 */
const BOOT_MS = Number(process.env.FAKE_PI_BOOT_MS || 0);
let booted = !BOOT_MS;

async function handle(cmd) {
  const { id, type } = cmd;
  if (!booted) {
    booted = true;
    note({ t: "boot-slow", ms: BOOT_MS });
    await sleep(BOOT_MS);
  }
  switch (type) {
    case "new_session": {
      // #86: the real pi starts a fresh session inside the same process. Same pid on purpose —
      // that is exactly what the test proves the bridge did instead of respawning.
      const before = sessionFile;
      sessionId = `fake-${Date.now().toString(36)}`;
      sessionFile = SESSION_DIR ? path.join(SESSION_DIR, `${sessionId}.jsonl`) : "";
      touchSessionFile();
      note({ t: "new_session", pid: process.pid, before, file: sessionFile, sessionId });
      return ok(id, type, { cancelled: false });
    }
    case "get_state":
      return ok(id, type, { model: currentModel, thinkingLevel, cwd: process.cwd(), sessionId, sessionFile });
    case "set_model": {
      const provider = String(cmd.provider ?? "stub");
      const modelId = String(cmd.modelId ?? cmd.model ?? "");
      const known = FAKE_MODELS.find((m) => m.id === modelId);
      currentModel = { id: modelId, name: known?.name ?? `Fake ${modelId}`, provider };
      note({ t: "set_model", pid: process.pid, provider, modelId });
      return ok(id, type, currentModel);
    }
    case "set_thinking_level":
      thinkingLevel = String(cmd.level ?? "off");
      note({ t: "set_thinking_level", pid: process.pid, level: thinkingLevel });
      return ok(id, type);
    case "get_session_stats":
      return ok(id, type, sessionStats);
    case "get_available_models": {
      const LEVEL_MAP = { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
      return ok(id, type, { models: FAKE_MODELS.map((m) => ({ ...m, reasoning: true, thinkingLevelMap: LEVEL_MAP, input: ["text"], contextWindow: 200000 })) });
    }
    case "get_commands":
      return ok(id, type, { commands: [] });
    case "set_steering_mode":
    case "set_follow_up_mode":
      note({ t: type, mode: cmd.mode });
      return ok(id, type);
    case "set_auto_compaction":
    case "set_auto_retry":
      note({ t: type, enabled: cmd.enabled });
      return ok(id, type);
    case "set_session_name":
      return ok(id, type);
    case "prompt": {
      const text = String(cmd.message ?? "");
      if (text.startsWith("REFUSE") && refusedOnce++ === 0) {
        note({ t: "prompt-rejected", text, why: "refused" });
        return ok(id, type, { disposition: "handled", error: "fake: this prompt is refused" });
      }
      if (compacting) {
        note({ t: "prompt-rejected", text, why: "compacting" });
        return fail(id, type, "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.");
      }
      // #198：RPC 的 `disposition: "handled"` —— pi 把这句话就地处理掉、一轮都没起（斜杠命令这类）。
      // 桥据此知道「不会有 agent_start 来了」，后面那条不必干等 10 秒。
      if (text.startsWith("HANDLED")) {
        notePrompt(cmd, text);
        return ok(id, type, { disposition: "handled" });
      }
      // #199：把应答压住一会儿——泵正等着这条的回执，后面几条就老老实实留在桥的 `bootQueue` 里，
      // 恰好是「就绪瞬间只交出第一条」那个时间窗（真实 pi 里这段是模型还没接上的那几百毫秒）。
      if (text.startsWith("HOLD")) {
        notePrompt(cmd, text);
        await sleep(1500);
        ok(id, type, { disposition: "started" });
        void run(text);
        return;
      }
      if (running) {
        if (!cmd.streamingBehavior) {
          note({ t: "prompt-rejected", text, why: "busy" });
          return fail(id, type, "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
        }
        (cmd.streamingBehavior === "steer" ? steering : followUp).push(text);
        notePrompt(cmd, text);
        queueUpdate();
        return ok(id, type, { disposition: "queued" });
      }
      notePrompt(cmd, text);
      ok(id, type, { disposition: "started" });
      void run(text);
      return;
    }
    case "clear_queue": {
      const data = { steering: [...steering], followUp: [...followUp] };
      steering = [];
      followUp = [];
      note({ t: "clear_queue", ...data });
      queueUpdate();
      return ok(id, type, data);
    }
    case "abort": {
      // `pid`: several sessions share this log, so a test can tell whose abort this was (#81).
      note({ t: "abort", pid: process.pid, queued: steering.length + followUp.length });
      // The turn cannot settle while it waits on a dialog, so abort answers it (pi does this too).
      pendingConfirm?.("aborted");
      if (!running) return ok(id, type);
      abortRequested = true;
      await new Promise((r) => settleWaiters.push(r));
      return ok(id, type);
    }
    case "compact": {
      compacting = true;
      note({ t: "compact-start", instructions: cmd.customInstructions ?? null });
      out({ type: "compaction_start", reason: "manual" });
      await sleep(COMPACT_MS);
      compacting = false;
      out({ type: "compaction_end", reason: "manual", result: { summary: "…" }, aborted: false, willRetry: false });
      note({ t: "compact-end" });
      return ok(id, type, { summary: "…" });
    }
    case "bash": {
      // `!cmd`: "sleep…" streams until abort_bash (5 s max), "quiet…" stays silent for the same kind
      // of while, "fail…" exits 2, anything else echoes.
      const command = String(cmd.command ?? "");
      note({ t: "bash", command, exclude: cmd.excludeFromContext ?? false });
      bashAborted = false;
      if (command.startsWith("quiet")) {
        // 静默的 `!` 命令（#81）：一个字也不输出，只是耗着 —— 命令在途就不算卡死。
        for (let i = 0; i < 100 && !bashAborted; i++) await sleep(100);
        return ok(id, type, { output: "", exitCode: bashAborted ? undefined : 0, cancelled: bashAborted, truncated: false });
      }
      if (command.startsWith("sleep")) {
        let output = "";
        for (let i = 0; i < 50 && !bashAborted; i++) {
          const delta = `tick ${i}\n`;
          output += delta;
          out({ type: "bash_execution_update", id, delta });
          await sleep(100);
        }
        return ok(id, type, { output, exitCode: bashAborted ? undefined : 0, cancelled: bashAborted, truncated: false });
      }
      const output = `ran: ${command}\n`;
      out({ type: "bash_execution_update", id, delta: output });
      return ok(id, type, { output, exitCode: command.startsWith("fail") ? 2 : 0, cancelled: false, truncated: false });
    }
    case "abort_bash":
      bashAborted = true;
      note({ t: "abort_bash" });
      return ok(id, type);
    default:
      return fail(id, type ?? "parse", `fake pi: unsupported command ${type}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  // 不用 `while ((at = …) >= 0)`：循环体里的 `continue` 也要先重算位置。
  for (let at = buf.indexOf("\n"); at >= 0; at = buf.indexOf("\n")) {
    const line = buf.slice(0, at).replace(/\r$/, "");
    buf = buf.slice(at + 1);
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      out({ type: "response", command: "parse", success: false, error: "Failed to parse command" });
      continue;
    }
    if (cmd.type === "extension_ui_response") {
      note({ t: "ui-response", id: cmd.id, confirmed: cmd.confirmed, cancelled: cmd.cancelled });
      let reply = "rejected";
      if (cmd.cancelled) reply = "cancelled";
      else if (cmd.confirmed === true) reply = "approved";
      pendingConfirm?.(reply);
      continue;
    }
    void handle(cmd);
  }
});
process.stdin.on("end", () => process.exit(0)); // runs the "exit" note above
