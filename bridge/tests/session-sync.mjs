/**
 * What a page sees of a session — issues #13 #18 #19 (+ `/compact <instructions>`, #22's bridge half).
 *
 *  A. #13  A branched session file shows only the branch pi would resume (leaf → root by parentId);
 *          when the terminal switches branch the page gets the whole new transcript.
 *  B. #19  A message sent from one page reaches every page watching the session, tagged with the
 *          sender's clientId so the sender can adopt its optimistic bubble.
 *  C. #18  notify / setStatus / setWidget / setTitle / set_editor_text from an extension reach the
 *          page (ANSI stripped), survive a re-subscribe, and are never answered back to pi.
 *  D.      `compact` carries custom instructions through to pi.
 *
 * Uses the scripted pi in fixtures/fake-pi.mjs. Needs a built bridge:
 *   npm run build:bridge && node bridge/tests/session-sync.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7895;
const ROOT = path.join(REPO, ".scratch", "session-sync");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });

// A session with two branches off the first answer; the last line (u3/a3 branch) is the leaf.
const BRANCH_ID = "zz-branch-session";
const branchFile = path.join(AGENT, "sessions", "--fixture--", `2026-01-01T00-00-00-000Z_${BRANCH_ID}.jsonl`);
fs.mkdirSync(path.dirname(branchFile), { recursive: true });
const old = new Date(Date.now() - 3600_000).toISOString();
const msg = (id, parentId, role, text) => ({
  type: "message",
  id,
  parentId,
  timestamp: old,
  message: role === "user" ? { role, content: [{ type: "text", text }] } : { role, content: [{ type: "text", text }], model: "m", stopReason: "stop" },
});
const rows = [
  { type: "session", version: 3, id: BRANCH_ID, timestamp: old, cwd: REPO },
  msg("u1", null, "user", "first question"),
  msg("a1", "u1", "assistant", "first answer"),
  msg("u2", "a1", "user", "abandoned question"),
  msg("a2", "u2", "assistant", "abandoned answer"),
  msg("u3", "a1", "user", "current question"),
  msg("a3", "u3", "assistant", "current answer"),
];
fs.writeFileSync(branchFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
fs.utimesSync(branchFile, new Date(old), new Date(old));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = false;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed = true;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const piLog = () =>
  fs.existsSync(PI_LOG)
    ? fs.readFileSync(PI_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

const bridgeOut = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
    FAKE_PI_LOG: PI_LOG,
    FAKE_COMPACT_MS: "300",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout: ${label}`);
}

/** One page: a socket plus everything it was sent. */
async function page(cookie, label) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const seen = [];
  const waits = [];
  ws.on("message", (buf) => {
    const m = JSON.parse(buf.toString());
    seen.push(m);
    for (const w of [...waits]) {
      if (w.pred(m)) {
        waits.splice(waits.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  });
  await new Promise((r) => ws.on("open", r));
  const waitFor = (pred, ms, what, from = 0) => {
    const hit = seen.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        waits.splice(waits.indexOf(w), 1);
        reject(new Error(`timeout (${label}): ${what}`));
      }, ms);
      waits.push(w);
    });
  };
  const send = (m) => ws.send(JSON.stringify(m));
  await waitFor((m) => m.type === "hello", 5000, "hello");
  return { ws, seen, waitFor, send };
}

let pages = [];
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const a = await page(cookie, "page A");
  const b = await page(cookie, "page B");
  pages = [a, b];

  // ------------------------------------------------------------------ A. branches (#13)
  log("A. a branched file shows the current branch only");
  a.send({ type: "subscribe", sessionId: BRANCH_ID });
  const snap = await a.waitFor((m) => m.type === "session" && m.sessionId === BRANCH_ID, 10000, "snapshot");
  const texts = (items) => items.filter((it) => it.kind === "user" || it.kind === "assistant").map((it) => it.text);
  check(
    JSON.stringify(texts(snap.items)) === JSON.stringify(["first question", "first answer", "current question", "current answer"]),
    `leaf branch only (${JSON.stringify(texts(snap.items))})`,
  );
  // The terminal goes back to the other branch and continues there.
  const markA = a.seen.length;
  fs.appendFileSync(branchFile, JSON.stringify(msg("u4", "a2", "user", "back on the old branch")) + "\n");
  const resent = await a.waitFor((m) => m.type === "items" && m.sessionId === BRANCH_ID, 5000, "branch switch resend", markA);
  check(
    JSON.stringify(texts(resent.items)) ===
      JSON.stringify(["first question", "first answer", "abandoned question", "abandoned answer", "back on the old branch"]),
    `branch switch resends the whole transcript (${JSON.stringify(texts(resent.items))})`,
  );
  // A plain append on the same branch is still incremental.
  const markA2 = a.seen.length;
  fs.appendFileSync(branchFile, JSON.stringify(msg("a4", "u4", "assistant", "appended answer")) + "\n");
  const added = await a.waitFor((m) => m.type === "item.add" && m.sessionId === BRANCH_ID, 5000, "append", markA2);
  check(added.item.text === "appended answer", "same-branch append arrives as item.add");
  check(!a.seen.slice(markA2).some((m) => m.type === "items" && m.sessionId === BRANCH_ID), "no full resend for a plain append");

  // ------------------------------------------------------------------ B. user message reaches every page (#19)
  log("B. a message from page A shows up on page B");
  a.send({ type: "create", cwd: REPO, name: "session-sync" });
  const created = await a.waitFor((m) => m.type === "session" && m.sessionId && m.sessionId !== BRANCH_ID, 20000, "created");
  const sid = created.sessionId;
  b.send({ type: "subscribe", sessionId: sid });
  await b.waitFor((m) => m.type === "session" && m.sessionId === sid, 5000, "B subscribed");
  a.send({ type: "prompt", sessionId: sid, text: "hello from A", clientId: "local:test-1" });
  const onB = await b.waitFor((m) => m.type === "item.add" && m.sessionId === sid && m.item?.kind === "user", 5000, "user item on B");
  check(onB.item.text === "hello from A", "page B receives the user message");
  check(onB.clientId === "local:test-1", "broadcast carries the sender's clientId");
  const onA = await a.waitFor((m) => m.type === "item.add" && m.sessionId === sid && m.item?.kind === "user", 5000, "user item on A");
  check(onA.item.id === onB.item.id, "both pages get the same bridge id");
  await b.waitFor((m) => m.type === "item.replace" && m.sessionId === sid && m.item?.text === "echo: hello from A", 5000, "answer on B");

  // ------------------------------------------------------------------ C. extension UI (#18)
  log("C. extension notify / status / widget / title / editor text");
  const markC = b.seen.length;
  a.send({ type: "prompt", sessionId: sid, text: "EXT please" });
  await b.waitFor((m) => m.type === "item.replace" && m.sessionId === sid && m.item?.text === "echo: EXT please", 5000, "EXT turn done", markC);
  const sliceC = b.seen.slice(markC);
  const note = sliceC.find((m) => m.type === "notice" && /索引已更新/.test(m.text));
  check(note?.level === "warn" && note.text === "索引已更新", `notify → warn notice, ANSI stripped (${JSON.stringify(note?.text)})`);
  const lastExt = [...sliceC].reverse().find((m) => m.type === "ext.ui" && m.sessionId === sid)?.ext;
  check(JSON.stringify(lastExt?.status) === JSON.stringify([{ key: "lint", text: "lint ✓ 3 files" }]), `status: set, cleared, ANSI stripped (${JSON.stringify(lastExt?.status)})`);
  check(
    lastExt?.widgets?.length === 2 &&
      lastExt.widgets.some((w) => w.key === "todo" && w.placement === "aboveEditor" && w.lines.join("|") === "TODO|- a|- b") &&
      lastExt.widgets.some((w) => w.key === "foot" && w.placement === "belowEditor"),
    "widgets keep lines and placement",
  );
  // 哨兵载荷不进页面：pi-subagents 那一行 `PI_SUBAGENT_ASYNC_JSON:{…}` 是给客户端解析的，
  // 原样铺出来只是一坨被截断的 JSON；「子代理在跑」另有 D170 的 .bg-bar。
  check(!(lastExt?.widgets ?? []).some((w) => w.key === "subagent-async" || w.lines.join("").includes("PI_SUBAGENT_ASYNC_JSON")), "protocol-payload widget is dropped");
  check(lastExt?.title === "pi — fake title", "title");
  const editor = sliceC.find((m) => m.type === "editor.set" && m.sessionId === sid);
  check(editor?.text === "prefilled by extension", "set_editor_text → editor.set");
  const markC2 = b.seen.length;
  b.send({ type: "subscribe", sessionId: sid });
  const resub = await b.waitFor((m) => m.type === "session" && m.sessionId === sid, 5000, "re-subscribe", markC2);
  check(resub.ext?.status?.length === 1 && resub.ext?.widgets?.length === 2 && resub.ext?.title === "pi — fake title", "snapshot carries the extension UI for late joiners");
  check(!piLog().some((e) => e.t === "ui-response"), "fire-and-forget requests were not answered");

  // ------------------------------------------------------------------ D. compact instructions
  log("D. /compact <instructions>");
  a.send({ type: "compact", sessionId: sid, instructions: "keep the API decisions" });
  await until(() => piLog().some((e) => e.t === "compact-end"), 5000, "compaction");
  check(piLog().find((e) => e.t === "compact-start")?.instructions === "keep the API decisions", "customInstructions reached pi");
} catch (err) {
  failed = true;
  console.error("ERROR", err.message);
  console.error(bridgeOut.join("").slice(-3000));
} finally {
  for (const p of pages) {
    try {
      p.ws.close();
    } catch {}
  }
  bridge.kill();
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
