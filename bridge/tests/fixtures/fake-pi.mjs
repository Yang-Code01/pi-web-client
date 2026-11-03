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
 * once and fails for good, anything else is echoed back.
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
      if (!running) return ok(id, type);
      abortRequested = true;
      await new Promise((r) => settleWaiters.push(r));
      return ok(id, type);
    }
    case "compact": {
      compacting = true;
      note({ t: "compact-start" });
      out({ type: "compaction_start", reason: "manual" });
      await sleep(COMPACT_MS);
      compacting = false;
      out({ type: "compaction_end", reason: "manual", result: { summary: "…" }, aborted: false, willRetry: false });
      note({ t: "compact-end" });
      return ok(id, type, { summary: "…" });
    }
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
    if (cmd.type === "extension_ui_response") continue;
    void handle(cmd);
  }
});
process.stdin.on("end", () => process.exit(0));
