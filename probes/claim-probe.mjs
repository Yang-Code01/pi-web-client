// 探针：网页端「接管会话」链路 —— stepup → claim → owned/模型目录可用 → close 让回
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "file:///F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs";

const BASE = "http://127.0.0.1:7864";
const STATE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local/share"), "pi-web-client");
const PASS = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
const IDLE_SESSION = "0f4de267-e73b-4366-97b5-8162438a9b08"; // 17:58 之后没人写过
const LIVE_SESSION = "01a18dff-fd23-724b-9a44-a0da0a00947e"; // 终端里正在写的这个会话

const log = (...a) => console.log("##", ...a);
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

const res = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: PASS }),
});
if (!res.ok) fail(`login ${res.status} ${await res.text()}`);
const cookie = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")])[0].split(";")[0];

const ws = new WebSocket("ws://127.0.0.1:7864/ws", { headers: { cookie } });
const inbox = [];
const waitFor = (type, ms = 25000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const at = inbox.findIndex((m) => m.type === type);
      if (at >= 0) return resolve(inbox.splice(at, 1)[0]);
      if (Date.now() - started > ms) return reject(new Error(`timeout waiting ${type}; got ${inbox.map((m) => m.type).join(",")}`));
      setTimeout(tick, 50);
    };
    tick();
  });

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return; // 协议外的垃圾帧，忽略
  }
  if (msg.type === "delta" || msg.type === "usage" || msg.type === "stats") return;
  inbox.push(msg);
  log("<-", msg.type, msg.type === "notice" ? msg.text : msg.type === "session" ? `owned=${msg.state?.owned}` : "");
});
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
await waitFor("hello");
log("connected");

ws.send(JSON.stringify({ type: "stepup", passphrase: PASS }));
await waitFor("stepup-ok");

// 1) 空闲会话：接管应成功
ws.send(JSON.stringify({ type: "claim", sessionId: IDLE_SESSION }));
const snap = await waitFor("session");
if (snap.state?.owned !== true) fail("claim 后 owned 不是 true");
if (!snap.state?.model && !snap.state?.modelName) log("warn: state 里没有 model 字段（可能只是 get_state 没回）");
log("claim ok:", snap.state.id, "owned =", snap.state.owned, "file =", snap.state.file);

// 2) 正在被写的会话：20 秒护栏应拒绝
ws.send(JSON.stringify({ type: "claim", sessionId: LIVE_SESSION }));
const refusal = await Promise.race([waitFor("notice"), waitFor("session")]);
if (refusal.type === "session") fail("20 秒护栏没生效：正在写的会话被接管了");
log("guard ok:", refusal.text);

// 3) 让回终端
ws.send(JSON.stringify({ type: "close", sessionId: IDLE_SESSION }));
const back = await waitFor("session.state", 15000).catch(() => null);
log("close ->", back ? `owned=${back.session?.owned}` : "(没收到 session.state，检查日志)");
ws.close();
process.exit(0);
