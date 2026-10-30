/**
 * Ask-user, end to end, against its own throwaway bridge (never the real one on 7864).
 *
 *   node bridge/tests/ask-e2e.mjs
 *
 * Part 1 — the HTTP face: the child's route must reject anything that is not loopback + token,
 *          and the cookie gate must still cover everything else.
 * Part 2 — the real thing: a live pi child is told to call `question` / `questionnaire`; the test
 *          answers over WS exactly like the browser does and checks what the model got back.
 *
 * Part 2 costs two model turns. Set ASK_E2E_GUARD_ONLY=1 to run only part 1.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = "F:/pi-web-client";
const DIST = path.join(ROOT, "bridge", "dist", "index.js");
const PORT = Number(process.env.ASK_E2E_PORT ?? 7891);
const STATE = process.env.ASK_E2E_STATE ?? path.join(ROOT, ".scratch", "ask-e2e-state");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "ask-e2e-pass";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------- part 1
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
const env = {
  ...process.env,
  PI_WEB_STATE: STATE,
  PI_WEB_PORT: String(PORT),
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_TUNNEL: "0",
  PI_WEB_ROOT: path.join(ROOT, "web", "dist"),
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });

const bridge = spawn(process.execPath, [DIST], { env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

const waitHealthy = async () => {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`bridge did not come up:\n${bridgeLog}`);
};

const post = (body, headers = {}) =>
  fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

try {
  await waitHealthy();
  log("bridge up on", PORT);

  const q = [{ id: "q1", label: "Q1", prompt: "选哪个", options: [{ value: "a", label: "A" }], allowOther: true }];

  const noToken = await post({ questions: q });
  check("POST /api/ask without a token → 403", noToken.status === 403, String(noToken.status));

  const badToken = await post({ token: "not-a-real-token", questions: q });
  check("POST /api/ask with a bogus token → 403", badToken.status === 403, String(badToken.status));

  const publicTunnel = await post({ token: "x", questions: q }, { "cf-connecting-ip": "203.0.113.9" });
  check("POST /api/ask through the tunnel → 403", publicTunnel.status === 403, String(publicTunnel.status));

  const gate = await fetch(`${BASE}/api/sessions`);
  check("the cookie gate still covers /api/sessions → 401", gate.status === 401, String(gate.status));

  const health = await (await fetch(`${BASE}/healthz`)).json();
  check("/healthz still public", health.ok === true);

  // ---------------------------------------------------------------- part 2
  if (process.env.ASK_E2E_GUARD_ONLY !== "1") {
    const login = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: PASS }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    check("login ok", login.ok, String(login.status));

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
    const seen = [];
    ws.on("message", (buf) => seen.push(JSON.parse(buf.toString())));
    await new Promise((r) => ws.on("open", r));

    ws.send(JSON.stringify({ type: "create", cwd: ROOT, name: "ask-e2e" }));
    let sessionId = null;
    for (let i = 0; i < 300 && !sessionId; i++) {
      const hit = seen.find((m) => m.type === "session" && m.state?.id);
      if (hit) sessionId = hit.state.id;
      else await sleep(200);
    }
    check("live session created", Boolean(sessionId), String(sessionId));
    if (!sessionId) throw new Error("no session");
    log("session", sessionId);

    /**
     * One turn: send the prompt, then answer every ask that shows up until the turn ends.
     * Polling a growing event log is the only reliable shape here — the model may call the tool
     * more than once, and stale events from earlier turns must not be mistaken for new ones.
     */
    async function runTurn(text, decide, label) {
      const start = seen.length;
      ws.send(JSON.stringify({ type: "prompt", sessionId, text }));
      const asks = [];
      const answered = new Set();
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        const batch = seen.slice(start);
        for (const m of batch) {
          if (m.type === "ask.add" && m.sessionId === sessionId && !answered.has(m.ask.id)) {
            answered.add(m.ask.id);
            asks.push(m.ask);
            log(`${label}: ask.add`, m.ask.id, `${m.ask.questions.length} question(s)`);
            ws.send(JSON.stringify({ type: "answer", sessionId, askId: m.ask.id, ...decide(m.ask) }));
          }
        }
        const statuses = batch.filter((m) => m.type === "pi.status" && m.sessionId === sessionId);
        const started = statuses.some((m) => m.running === true);
        const finished = started && statuses.at(-1)?.running === false;
        if (finished && asks.length) break;
        if (finished && !asks.length) {
          // Give a late ask.add a moment; a turn with no ask at all is a failure to report.
          await sleep(1500);
          break;
        }
        await sleep(300);
      }
      const batch = seen.slice(start);
      const toolItem = [...batch]
        .reverse()
        .map((m) => (m.type === "item.replace" ? m.item : null))
        .find((it) => it && it.kind === "tool" && /^question/.test(String(it.name ?? "")));
      return { asks, toolItem, batch };
    }

    // -- question: answer it ------------------------------------------------
    const t1 = await runTurn(
      "只调用 question 工具一次，问我「选左边还是右边？」，选项只要「左边」和「右边」。不要做任何别的事，不要执行命令。",
      (ask) => {
        const options = ask.questions[0].options ?? [];
        const right = options.find((o) => String(o.label).includes("右")) ?? options[1] ?? options[0];
        return { answers: [{ id: ask.questions[0].id, value: right.value, label: right.label }] };
      },
      "turn1",
    );
    const first = t1.asks[0];
    check("the model's question reaches the browser", Boolean(first));
    check("it is a single question with both options", first?.questions.length === 1 && (first?.questions[0]?.options ?? []).length === 2, JSON.stringify(first?.questions[0]?.options));
    check(
      "the model received the chosen option",
      Boolean(t1.toolItem && /selected/.test(String(t1.toolItem.result ?? "")) && /右|left|right/i.test(String(t1.toolItem.result ?? ""))),
      String(t1.toolItem?.result ?? "(no question tool result)").slice(0, 160),
    );

    // -- questionnaire: cancel it ------------------------------------------
    const t2 = await runTurn(
      "只调用 questionnaire 工具一次，问我两个问题：1) 主题，选项「商务」「休闲」；2) 语气，选项「正式」「轻松」。不要做任何别的事。",
      () => ({ answers: [], cancelled: true }),
      "turn2",
    );
    const multi = t2.asks.find((a) => a.questions.length === 2);
    check("the questionnaire carries both questions", Boolean(multi), `${t2.asks.length} ask(s): ${t2.asks.map((a) => a.questions.length).join(",")}`);
    const cancels = t2.batch.filter((m) => m.type === "ask.remove");
    check("cancelling settles the ask", cancels.length > 0 && cancels.every((m) => m.status === "cancelled"), JSON.stringify(cancels.map((m) => m.status)));
    check(
      "the model was told the user cancelled",
      Boolean(t2.toolItem && /cancel/i.test(String(t2.toolItem.result ?? ""))),
      String(t2.toolItem?.result ?? "(no questionnaire tool result)").slice(0, 160),
    );

    if (process.env.ASK_E2E_DUMP) {
      fs.writeFileSync(path.join(ROOT, ".scratch", "ask-e2e-seen.json"), JSON.stringify(seen, null, 1));
      log("dumped", seen.length, "ws messages");
    }
    ws.close();
  }
} catch (err) {
  check(`unexpected: ${err?.message ?? String(err)}`, false);
  console.log(bridgeLog.slice(-2000));
} finally {
  bridge.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}
