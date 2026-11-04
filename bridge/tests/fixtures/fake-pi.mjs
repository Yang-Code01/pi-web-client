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
 * Scenarios are picked by the prompt text: "SLOW…" streams until aborted, "RETRY…" fails, retries
 * once and fails for good, "APPROVAL…" asks for a confirm and waits for it, "ASK…" posts a question
 * to the bridge and waits for the answer, anything else is echoed back.
 *
 * Env: FAKE_PI_LOG (jsonl of what the stub saw), FAKE_COMPACT_MS (manual compaction length).
 */
import fs from "node:fs";

const LOG = process.env.FAKE_PI_LOG || "";
const COMPACT_MS = Number(process.env.FAKE_COMPACT_MS || 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const note = (obj) => {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...obj }) + "\n");
};
const ok = (id, command, data) => out({ type: "response", command, success: true, id, ...(data === undefined ? {} : { data }) });
const fail = (id, command, error) => out({ type: "response", command, success: false, id, error });

let running = false;
let compacting = false;
let abortRequested = false;
let steering = [];
let followUp = [];
let settleWaiters = [];
let bashAborted = false;
/** Resolver of the turn's pending confirm (#82): answered by `extension_ui_response` or `abort`. */
let pendingConfirm = null;
/** The command the stub claims it is about to run, so the approval card has something to show. */
const CONFIRM_MESSAGE = "rm -rf build/";
// What the bridge started us with (launch options, #28), plus the PI_WEB_* vars it let through:
// the bridge strips its own settings, and a test can assert one did not reach pi (#76).
note({ t: "argv", pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), piWeb: Object.keys(process.env).filter((k) => k.startsWith("PI_WEB_")) });
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
  note({ t: "turn", text });
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
  if (text.startsWith("EXT")) {
    // Fire-and-forget extension UI (rpc-mode.js): none of these may be answered.
    const ui = (method, fields) => out({ type: "extension_ui_request", id: `ui-${method}-${Date.now()}`, method, ...fields });
    ui("notify", { message: "\u001b[33m索引已更新\u001b[0m", notifyType: "warning" });
    ui("setStatus", { statusKey: "lint", statusText: "\u001b[32mlint ✓\u001b[0m 3 files" });
    ui("setStatus", { statusKey: "gone", statusText: "temporary" });
    ui("setStatus", { statusKey: "gone", statusText: undefined });
    ui("setWidget", { widgetKey: "todo", widgetLines: ["TODO", "- a", "- b"], widgetPlacement: "aboveEditor" });
    ui("setWidget", { widgetKey: "foot", widgetLines: ["below line"], widgetPlacement: "belowEditor" });
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
    const answer = await fetch(process.env.PI_WEB_ASK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: process.env.PI_WEB_ASK_TOKEN, tool: "question", questions: [question] }),
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
  out({ type: "message_start", message: assistant("") });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `echo: ${text}` } });
  out({ type: "message_end", message: assistant(`echo: ${text}`) });
  out({ type: "agent_end", messages: [], willRetry: false });
}

async function run(first) {
  running = true;
  abortRequested = false;
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

async function handle(cmd) {
  const { id, type } = cmd;
  switch (type) {
    case "get_state":
      return ok(id, type, { model: { id: "fake-model", name: "Fake Model", provider: "stub" }, thinkingLevel: "off", cwd: process.cwd() });
    case "get_session_stats":
      return ok(id, type, { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.01, contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 } });
    case "get_available_models":
      return ok(id, type, { models: [{ id: "fake-model", name: "Fake Model", provider: "stub", reasoning: false, input: ["text"], contextWindow: 200000 }] });
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
      if (compacting) {
        note({ t: "prompt-rejected", text, why: "compacting" });
        return fail(id, type, "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.");
      }
      if (running) {
        if (!cmd.streamingBehavior) {
          note({ t: "prompt-rejected", text, why: "busy" });
          return fail(id, type, "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
        }
        (cmd.streamingBehavior === "steer" ? steering : followUp).push(text);
        note({ t: "prompt", text, behavior: cmd.streamingBehavior });
        queueUpdate();
        return ok(id, type, { disposition: "queued" });
      }
      note({ t: "prompt", text, behavior: cmd.streamingBehavior ?? null });
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
      note({ t: "abort", queued: steering.length + followUp.length });
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
      // `!cmd`: "sleep…" streams until abort_bash (5 s max), "fail…" exits 2, anything else echoes.
      const command = String(cmd.command ?? "");
      note({ t: "bash", command, exclude: cmd.excludeFromContext ?? false });
      bashAborted = false;
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
  let at;
  while ((at = buf.indexOf("\n")) >= 0) {
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
      pendingConfirm?.(cmd.cancelled ? "cancelled" : cmd.confirmed === true ? "approved" : "rejected");
      continue;
    }
    void handle(cmd);
  }
});
process.stdin.on("end", () => process.exit(0)); // runs the "exit" note above
