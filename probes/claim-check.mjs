// 只读检查：某个会话当前是不是 owned（用来验证 close 之后确实让回了）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "file:///F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs";
const STATE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local/share"), "pi-web-client");
const PASS = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
const id = process.argv[2];
const res = await fetch("http://127.0.0.1:7864/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: PASS }) });
const cookie = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")])[0].split(";")[0];
const ws = new WebSocket("ws://127.0.0.1:7864/ws", { headers: { cookie } });
await new Promise((r) => ws.once("open", r));
ws.send(JSON.stringify({ type: "subscribe", sessionId: id }));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.type !== "session") return;
  console.log(JSON.stringify({ id: msg.state.id, owned: msg.state.owned, running: msg.state.running, items: msg.items?.length ?? 0 }, null, 2));
  ws.close();
  process.exit(0);
});
setTimeout(() => { console.error("no session message"); process.exit(1); }, 10000);
