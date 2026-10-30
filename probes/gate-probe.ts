/**
 * 探针扩展：验证 RPC 模式下 tool_call 审批能否真的往返。
 * 注意：RPC 模式下 stdout 是协议流，扩展里绝对不能 console.log，只能 console.error。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function log(...args: unknown[]) {
	console.error("[gate]", ...args);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		log("session_start", JSON.stringify({ reason: event.reason, hasUI: ctx.hasUI, mode: (ctx as any).mode }));
		ctx.ui.notify("gate loaded", "info");
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		const cmd = String(input?.command ?? input?.path ?? "");
		log("tool_call", event.toolName, JSON.stringify(cmd).slice(0, 200));

		// 只有命令里带 needsapproval 才拦，其余放行
		if (!/needsapproval|rejectme|timeoutcase|abortcase/.test(cmd)) return undefined;

		const timeout = /timeoutcase/.test(cmd)
			? 3000 // 这条不回答，验证 agent 侧超时自动解决
			: 60000;

		log("asking confirm, timeout=", timeout);
		const ok = await ctx.ui.confirm("危险命令", "要执行：" + cmd, { timeout });
		log("confirm returned", JSON.stringify(ok));

		if (!ok) {
			ctx.ui.notify("已拒绝", "warning");
			return { block: true, reason: "用户在网页拒绝了这条命令" };
		}
		ctx.ui.notify("已允许", "info");
		return undefined;
	});
}
