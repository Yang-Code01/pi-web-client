// RPC 探针驱动：spawn pi --mode rpc，实测命令往返、事件流、审批往返、超时、abort。
// 产出：probes/out/raw.jsonl（全部原始记录）+ probes/out/rpc-probe.md（蒸馏报告）
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CLI = "C:/Users/GG_Bond/AppData/Local/nvm/v23.11.1/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const OUT = path.resolve("probes/out");
fs.mkdirSync(OUT, { recursive: true });
const raw = fs.createWriteStream(path.join(OUT, "raw.jsonl"), { flags: "w" });
const notes = [];
const note = (s) => {
	notes.push(s);
	console.error("## " + s);
};

const args = [
	CLI,
	"--mode", "rpc",
	"--no-extensions",
	"--extension", path.resolve("probes/gate-probe.ts"),
	"--session-dir", path.resolve("probes/tmp/sessions"),
	"--no-skills", "--no-prompt-templates", "--no-mcp",
];
note("spawn: node " + args.join(" "));

const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
let stderrBuf = "";
child.stderr.on("data", (b) => {
	stderrBuf += b.toString("utf8");
	raw.write(JSON.stringify({ _stderr: b.toString("utf8") }) + "\n");
});
child.on("exit", (code, sig) => note(`child exit code=${code} sig=${sig}`));

// ---- 严格 LF 分帧（不用 readline：它会按 U+2028/2029 切）----
const pending = new Map();
const uiRequests = [];
const events = [];
let reqN = 0;
function send(cmd) {
	const id = cmd.id ?? `req_${++reqN}`;
	const rec = { ...cmd, id };
	child.stdin.write(JSON.stringify(rec) + "\n");
	return id;
}
function call(type, extra = {}, timeoutMs = 20000) {
	const id = `req_${++reqN}`;
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			pending.delete(id);
			reject(new Error("timeout waiting response: " + type));
		}, timeoutMs);
		pending.set(id, { resolve: (r) => (clearTimeout(t), resolve(r)) });
		child.stdin.write(JSON.stringify({ type, id, ...extra }) + "\n");
	});
}
function respond(id, body) {
	child.stdin.write(JSON.stringify({ type: "extension_ui_response", id, ...body }) + "\n");
	note(">>> extension_ui_response " + JSON.stringify({ id, ...body }));
}

let buf = "";
let nonJsonLines = 0;
child.stdout.on("data", (chunk) => {
	buf += chunk.toString("utf8");
	let idx;
	while ((idx = buf.indexOf("\n")) >= 0) {
		let line = buf.slice(0, idx);
		buf = buf.slice(idx + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line) continue;
		raw.write(line + "\n");
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			nonJsonLines++;
			continue;
		}
		if (rec.type === "response") {
			const p = pending.get(rec.id);
			if (p) {
				pending.delete(rec.id);
				p.resolve(rec);
			}
			events.push({ t: "response", command: rec.command, success: rec.success });
			return;
		}
		if (rec.type === "extension_ui_request") {
			uiRequests.push(rec);
		}
		events.push({ t: rec.type, at: Date.now() });
	}
});

const t0 = Date.now();
const waitFor = (pred, ms, label, from = events.length) => {
	return new Promise((resolve) => {
		const iv = setInterval(() => {
			const hit = events.slice(from).find(pred);
			if (hit) {
				clearInterval(iv);
				clearTimeout(to);
				resolve(hit);
			}
		}, 40);
		const to = setTimeout(() => {
			clearInterval(iv);
			note(`waitFor TIMEOUT (${label}) after ${ms}ms`);
			resolve(null);
		}, ms);
	});
};

// 自动应答：默认批准；特定命令按策略拒绝 / 不回答（测超时）
const policy = (rec) => {
	const text = JSON.stringify(rec);
	if (/timeoutcase/.test(text)) return { skip: true };
	if (/rejectme/.test(text)) return { body: { confirmed: false } };
	if (/abortcase/.test(text)) return { skip: true };
	return { body: { confirmed: true } };
};
function handleUi(rec) {
	note(`<<< extension_ui_request ${rec.method} ${JSON.stringify(rec).slice(0, 300)}`);
	if (rec.method === "confirm" || rec.method === "select" || rec.method === "input" || rec.method === "editor") {
		const p = policy(rec);
		if (p.skip) {
			note("     (故意不回答)");
			return;
		}
		setTimeout(() => respond(rec.id, p.body), 150);
	}
}

async function main() {
	await new Promise((r) => child.once("spawn", r));
	note("spawned, pid=" + child.pid);

	// 1. 基本状态
	const st = await call("get_state");
	note("get_state.success=" + st.success + " keys=" + Object.keys(st.data ?? {}).join(","));
	const models = await call("get_available_models");
	note("get_available_models n=" + (models.data?.models?.length ?? "?"));
	const cmds = await call("get_commands");
	note("get_commands n=" + (cmds.data?.commands?.length ?? "?"));
	const entries0 = await call("get_entries");
	note("get_entries(before prompt) entries=" + (entries0.data?.entries?.length ?? "?") + " leafId=" + entries0.data?.leafId);

	let mark = events.length;
	const idle = async (label, ms = 150000) => {
		const hit = await waitFor((e) => e.t === "agent_settled", ms, label, mark);
		mark = events.length;
		return hit;
	};
	const runPrompt = async (label, message, extraWaitMs = 0) => {
		const r = await call("prompt", { message });
		note(`${label} prompt success=${r.success} data=${JSON.stringify(r.data)} err=${r.error ?? ""}`);
		if (r.data?.disposition === "handled") return { prompt: r, settled: null };
		const settled = await idle(label + " settled");
		if (extraWaitMs) await new Promise((res) => setTimeout(res, extraWaitMs));
		mark = events.length;
		return { prompt: r, settled };
	};

	// 2. 在被拦的 bash 之外还要有一个普通 bash（放行路径）
	const r1 = await runPrompt("P1", "只做两件事，不要解释：1) 用 bash 执行 `echo needsapproval-1`；2) 用 bash 执行 `echo hello-plain`。做完回复 DONE。");
	note("P1 settled=" + JSON.stringify(r1.settled));

	// 3. 被拒绝
	const r2 = await runPrompt("P2", "用 bash 执行 `echo rejectme`，然后回复 REJECTED-DONE。");
	note("P2 settled=" + JSON.stringify(r2.settled));

	// 4. 超时：gate 给 3s timeout，我们不回答
	const r3 = await runPrompt("P3", "用 bash 执行 `echo timeoutcase`，然后回复 TIMEOUT-DONE。");
	note("P3 settled=" + JSON.stringify(r3.settled));

	// 5. abort 能否解开挂起的 confirm
	const before5 = events.length;
	const r4 = await call("prompt", { message: "用 bash 执行 `echo abortcase`，然后回复 ABORT-DONE。" });
	note("P4 prompt success=" + r4.success + " data=" + JSON.stringify(r4.data));
	const uiHit = await waitFor(() => uiRequests.some((r) => /abortcase/.test(JSON.stringify(r))), 60000, "abortcase ui request", 0);
	note("P4 ui request arrived=" + !!uiHit);
	await new Promise((r) => setTimeout(r, 400));
	note("sending abort while confirm pending...");
	const ab = await call("abort");
	note("abort response success=" + ab.success);
	const settled4 = await waitFor((e) => e.t === "agent_settled", 45000, "agent_settled after abort", before5);
	note("abort settled=" + JSON.stringify(settled4));

	// 6. 结束后状态
	const st2 = await call("get_state");
	const entries1 = await call("get_entries");
	const msgs = await call("get_messages");
	const stats = await call("get_session_stats");
	note("get_state(after)=" + JSON.stringify(st2.data).slice(0, 500));
	note("get_messages n=" + (msgs.data?.messages?.length ?? "?"));
	note("get_session_stats=" + JSON.stringify(stats.data).slice(0, 300));

	// 7. 增量 get_entries(since)
	const firstId = entries1.data?.entries?.[0]?.id;
	const inc = await call("get_entries", { since: firstId });
	note("get_entries(since=first) entries=" + (inc.data?.entries?.length ?? "?") + " (完整=" + (entries1.data?.entries?.length ?? "?") + ")");

	// ---- 写报告 ----
	const byType = new Map();
	for (const e of events) byType.set(e.t, (byType.get(e.t) ?? 0) + 1);
	// 每个事件类型取一个完整样本
	const sampleOf = new Map();
	raw.end();
	const lines = fs.readFileSync(path.join(OUT, "raw.jsonl"), "utf8").split("\n").filter(Boolean);
	for (const l of lines) {
		let r;
		try {
			r = JSON.parse(l);
		} catch {
			continue;
		}
		if (r._stderr) continue;
		const key = r.type === "extension_ui_request" ? "extension_ui_request:" + r.method : r.type;
		if (!sampleOf.has(key)) sampleOf.set(key, l.length > 3000 ? l.slice(0, 3000) + " …(截断)" : l);
	}
	const entryTypes = new Map();
	for (const e of entries1.data?.entries ?? []) entryTypes.set(e.type, (entryTypes.get(e.type) ?? 0) + 1);

	const md = [];
	md.push("# RPC 实测报告", "", `生成时间 ${new Date().toISOString()}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, "");
	md.push("## 结论要点", "");
	md.push("- 事件类型计数：" + [...byType.entries()].map(([k, v]) => `\`${k}\`×${v}`).join("、"));
	md.push("- 非 JSON stdout 行数：" + nonJsonLines);
	md.push("- extension_ui_request 次数：" + uiRequests.length + "（methods: " + [...new Set(uiRequests.map((r) => r.method))].join(",") + "）");
	md.push("- get_entries 条目类型：" + [...entryTypes.entries()].map(([k, v]) => `\`${k}\`×${v}`).join("、"));
	md.push("");
	md.push("## 逐步日志", "", "```", ...notes, "```", "");
	md.push("## 每种记录的第一个样本", "");
	for (const [k, v] of sampleOf) {
		md.push("### " + k, "", "```json", v, "```", "");
	}
	md.push("## 关键问题答案（人工填）", "", "- 审批往返：", "- 拒绝后 agent 行为：", "- 超时是否自动解决：", "- abort 是否解开挂起 confirm：", "- 增量 get_entries(since) 是否可用：", "");
	fs.writeFileSync(path.join(OUT, "rpc-probe.md"), md.join("\n"), "utf8");
	note("报告已写入 probes/out/rpc-probe.md");

	child.stdin.end();
	setTimeout(() => {
		try {
			child.kill();
		} catch {}
		process.exit(0);
	}, 1500);
}

const uiInterval = setInterval(() => {
	for (const r of uiRequests) {
		if (r._seen) continue;
		r._seen = true;
		handleUi(r);
	}
}, 100);

main().catch((e) => {
	note("FATAL " + (e?.stack ?? e));
	console.error(stderrBuf.slice(-3000));
	clearInterval(uiInterval);
	process.exit(1);
});
