import fs from "node:fs";
import { WebSocket } from "ws";
const STATE = "F:/pi-web-client/.scratch/test-state";
const pass = fs.readFileSync(`${STATE}/passphrase.txt`, "utf8").trim();
const r = await fetch("http://127.0.0.1:7867/api/login", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({passphrase:pass})});
const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
const ws = new WebSocket("ws://127.0.0.1:7867/ws", { headers: { cookie } });
ws.on("open", () => {
  console.log("open");
  ws.send(JSON.stringify({ type: "create", cwd: "F:/pi-web-client", name: "dbg" }));
});
ws.on("message", (b) => {
  const m = JSON.parse(b.toString());
  const brief = m.type === "message.delta" ? `${m.type} ${JSON.stringify(m.text)}` : JSON.stringify(m).slice(0, 220);
  console.log("<<", brief);
  if (m.type === "session" || m.type === "session.state") {
    const id = m.session?.id ?? m.id;
    if (!globalThis.sent) { globalThis.sent = 1; setTimeout(() => { console.log(">> prompt"); ws.send(JSON.stringify({type:"prompt", sessionId:id, text:"只回复两个字：你好"})); }, 500); }
  }
});
setTimeout(() => { console.log("done"); ws.close(); process.exit(0); }, 45000);
