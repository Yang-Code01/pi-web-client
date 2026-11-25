#!/usr/bin/env node
/**
 * 真脑 e2e 用的假 pi（`host-real-brain-e2e.mjs`）。
 *
 * 与 `tiny-pi.mjs` 的区别：这个会把自己演成「一轮正在跑」的样子 —— 收到 `prompt` 就报
 * `agent_start`、按节奏吐 tick，还能抛一条 `confirm` 审批。真脑据此把会话标成 running、
 * 把审批交给页面；测试就能验「换脑后这一轮还在跑」「同一个审批不会被答两次」。
 *
 * 环境变量：
 *   CHATTY_PI_ANSWERS  每次收到 extension_ui_response 就追加一行 id（测试用它数次数）
 *   CHATTY_PI_CONFIRM=1 收到 prompt 时顺带抛一条 confirm 审批
 */
import fs from "node:fs";

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const answers = process.env.CHATTY_PI_ANSWERS || "";
let buf = "";
let timer = null;
let tick = 0;

function recordAnswer(id) {
  if (!answers) return;
  try {
    fs.appendFileSync(answers, `${id}\n`);
  } catch {
    /* 记不下来就算了，别把测试进程带走 */
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const i = buf.indexOf("\n");
    if (i < 0) break;
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "die") process.exit(0);
    if (msg.type === "extension_ui_response") {
      recordAnswer(String(msg.id ?? ""));
      // 审批答完，这一轮接着跑（真 pi 也是这样：工具回来了继续）。
      continue;
    }
    if (msg.type === "prompt") {
      out({ type: "event", name: "agent_start" });
      if (process.env.CHATTY_PI_CONFIRM === "1") {
        out({
          type: "extension_ui_request",
          id: "u-confirm",
          method: "confirm",
          title: "要不要继续？",
          message: "换脑窗口里这条审批不能丢，也不能问两次。",
        });
      }
      if (timer) clearInterval(timer);
      timer = setInterval(() => out({ type: "event", name: "tick", n: ++tick }), 50);
      if (msg.id) out({ type: "response", command: "prompt", success: true, id: msg.id, data: {} });
      continue;
    }
    if (msg.type === "abort") {
      if (timer) clearInterval(timer);
      timer = null;
      out({ type: "event", name: "agent_end" });
      if (msg.id) out({ type: "response", command: "abort", success: true, id: msg.id, data: {} });
      continue;
    }
    // 模型 / 档位只在 get_state 里：真脑启动（startLive）和换脑接管（adopt）之后都靠它
    // 填输入框下的模型 chip。答空对象会让这两条路径都拿不到值（测试也就断不出来）。
    if (msg.type === "get_state") {
      out({
        type: "response",
        command: "get_state",
        success: true,
        id: msg.id,
        data: {
          model: { provider: "fake", id: "fake-model", name: "Fake Model · x1 · 1M" },
          thinkingLevel: "low",
        },
      });
      continue;
    }
    // 其余命令一律「成功、没有数据」：真脑的启动握手就靠这个。
    if (msg.id) out({ type: "response", command: String(msg.type ?? ""), success: true, id: msg.id, data: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
