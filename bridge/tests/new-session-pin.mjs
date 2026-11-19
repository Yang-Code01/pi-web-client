/**
 * D327：新建即置顶。不管从哪个入口建出来，新会话都落到 pin 列表**末尾**，已经置顶的会话不动。
 *
 * 真桥 + 桩 pi，全部从 WS 外面观察：
 *   1. `create` 不带 `pin`（左栏按钮 / 交给 agent / `/new` 发的就是这个）→ 桥广播 manage，新会话在 pin 末尾；
 *   2. 再建一个 → 排在前一个后面，前一个仍在 pin 里（只加不减）；
 *   3. `/import` 一个会话文件 → 也置顶到末尾；
 *   4. 随手问（scratch.open）不是用户的会话（#86）→ 不进 pin。
 *
 * Run: npm --prefix bridge run build && node bridge/tests/new-session-pin.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { freePort } from "../../tools/free-port.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "new-session-pin");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed += 1;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* the bridge is not up yet */
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

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

  const seen = [];
  const waits = new Set();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    seen.push(msg);
    for (const w of [...waits]) {
      if (w.pred(msg)) {
        waits.delete(w);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", (e) => j(new Error(`ws: ${e.message}`)));
  });
  /** Only frames from `from` on: an earlier hit must not satisfy a later step. */
  const waitFor = (pred, ms, label, from = 0) => {
    const hit = seen.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const entry = { pred, resolve };
      entry.timer = setTimeout(() => {
        waits.delete(entry);
        reject(new Error(`timeout: ${label}`));
      }, ms);
      waits.add(entry);
    });
  };
  const pinOf = (m) => (m.type === "manage" || m.type === "hello" ? m.manage?.pin : undefined);

  const create = async (name) => {
    const mark = seen.length;
    ws.send(JSON.stringify({ type: "create", cwd: REPO, name }));
    const frame = await waitFor((m) => m.type === "session" && m.state?.name === name, 20000, `session 帧 ${name}`, mark);
    const id = frame.sessionId ?? frame.state?.id;
    const manage = await waitFor((m) => m.type === "manage" && Array.isArray(pinOf(m)) && pinOf(m).includes(id), 5000, `manage 帧含 ${name}`, mark);
    return { id, pin: pinOf(manage) };
  };

  log("1) 普通 create（不带 pin）");
  const a = await create("新会话甲");
  check(a.pin.at(-1) === a.id, `新会话在 pin 末尾（pin=${JSON.stringify(a.pin)}）`);

  log("2) 再建一个：排在后面，前一个不被挤掉");
  const b = await create("新会话乙");
  check(b.pin.at(-1) === b.id, `第二个在末尾（pin=${JSON.stringify(b.pin)}）`);
  check(b.pin.indexOf(a.id) === b.pin.length - 2, "第一个仍置顶，紧挨在它前面");

  log("3) /import 进来的会话也置顶");
  const importId = crypto.randomUUID();
  const src = path.join(ROOT, "import-me.jsonl");
  fs.writeFileSync(src, `${JSON.stringify({ type: "session", version: 3, id: importId, timestamp: new Date().toISOString(), cwd: REPO })}\n`);
  {
    const mark = seen.length;
    ws.send(JSON.stringify({ type: "import", path: src }));
    const res = await waitFor((m) => m.type === "import.result", 10000, "import.result", mark);
    check(!res.error && res.sessionId === importId, `导入成功（${res.error ?? res.sessionId}）`);
    const manage = await waitFor((m) => m.type === "manage" && (pinOf(m) ?? []).includes(importId), 5000, "manage 帧含导入的会话", mark);
    const pin = pinOf(manage);
    check(pin.at(-1) === importId, `导入的会话在 pin 末尾（pin=${JSON.stringify(pin)}）`);
    check(pin.includes(a.id) && pin.includes(b.id), "之前置顶的都还在");
  }

  log("4) 随手问不进 pin");
  {
    const mark = seen.length;
    ws.send(JSON.stringify({ type: "scratch.open" }));
    const s = await waitFor((m) => m.type === "scratch", 20000, "scratch 帧", mark);
    await sleep(500);
    const manages = seen.slice(mark).filter((m) => m.type === "manage");
    check(!manages.some((m) => (pinOf(m) ?? []).includes(s.sessionId)), "scratch 会话没有被置顶");
  }

  ws.close();
} catch (err) {
  failed += 1;
  console.error("ERROR", err?.message ?? err);
  console.error(bridgeOut.join("").slice(-1500));
} finally {
  bridge.kill();
}
log(failed ? `FAILED (${failed})` : "PASS");
process.exit(failed ? 1 : 0);
