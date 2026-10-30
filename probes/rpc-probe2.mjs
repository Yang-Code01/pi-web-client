// 探针二：审批挂起时 abort 的确切行为、cancelled 语义
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CLI = "C:/Users/GG_Bond/AppData/Local/nvm/v23.11.1/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const OUT = path.resolve("probes/out");
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.error("##", ...a);

const child = spawn(process.execPath, [
	CLI, "--mode", "rpc", "--no-extensions",
	"--extension", path.resolve("probes/gate-probe.ts"),
	"--session-dir", path.resolve("probes/tmp/sessions2"),
	"--no-skills", "--no-prompt-templates", "--no-mcp",
], { stdio: ["pipe", "pipe", "pipe"] });

const pending = new Map();
const ui = [];
let buf = "", n = 0;
const events = [];
child.stdout.on("data", (c) => {
	buf += c.toString("utf8");
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		let line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line) continue;
		let r;
		try { r = JSON.parse(line); } catch { continue; }
		if (r.type === "response") { const p = pending.get(r.id); if (p) { pending.delete(r.id); p(r); } }
		else if (r.type === "extension_ui_request") ui.push(r);
		else events.push(r.type);
	}
});
function send(cmd) { const id = `r_${++n}`; child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n"); return id; }
function call(cmd, ms = 15000) {
	const id = `r_${++n}`;
	return new Promise((res) => {
		const t = setTimeout(() => res({ timeout: true }), ms);
		pending.set(id, (r) => { clearTimeout(t); res(r); });
		child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
	});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUi = async (pat, ms = 90000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const hit = ui.find((r) => pat.test(JSON.stringify(r)) && !r._done);
		if (hit) return hit;
		await sleep(100);
	}
	return null;
};
const waitSettled = async (ms = 90000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (events[events.length - 1] === "agent_settled") return true;
		await sleep(100);
	}
	return false;
};

await new Promise((r) => child.once("spawn", r));

// ---- A：cancelled:true 是否等价于拒绝
log("A: cancel 语义");
const p1 = await call({ type: "prompt", message: "用 bash 执行 `echo rejectme-cancel`，然后回复 A-DONE。" });
log("prompt", JSON.stringify(p1.data));
const u1 = await waitUi(/rejectme-cancel/);
log("confirm 到达:", !!u1, "timeout=", u1?.timeout);
child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: u1.id, cancelled: true }) + "\n");
u1._done = true;
const s1 = await waitSettled();
log("A settled=", s1);

// ---- B：挂起 confirm 时先 abort，再 cancelled
log("B: abort 与挂起的 confirm");
const p2 = await call({ type: "prompt", message: "用 bash 执行 `echo abortcase-2`，然后回复 B-DONE。" });
log("prompt", JSON.stringify(p2.data));
const u2 = await waitUi(/abortcase-2/);
log("confirm 到达:", !!u2);
const ab = await call({ type: "abort" }, 8000);
log("abort response:", JSON.stringify(ab).slice(0, 300));
const stillPending = !u2._done;
child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: u2.id, cancelled: true }) + "\n");
u2._done = true;
log("已补发 cancelled，等待 settled ...");
const s2 = await waitSettled(30000);
log("B settled=", s2, "abort 是否挂起=", stillPending, "abort响应=", JSON.stringify(ab).slice(0, 120));

// ---- C：abort 之后再发一条 prompt 是否正常
const p3 = await call({ type: "prompt", message: "只回复 C-OK" });
log("C prompt:", JSON.stringify(p3).slice(0, 200));
const s3 = await waitSettled(60000);
log("C settled=", s3);

// 状态
const st = await call({ type: "get_state" });
log("state.isStreaming=", st.data?.isStreaming, "msgCount=", st.data?.messageCount);
fs.writeFileSync(path.join(OUT, "probe2-notes.json"), JSON.stringify({ ui: ui.map((u) => ({ method: u.method, timeout: u.timeout })) }, null, 1));
child.stdin.end();
setTimeout(() => { try { child.kill(); } catch {} process.exit(0); }, 1200);
