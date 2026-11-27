#!/usr/bin/env node
/**
 * e2e 用的假 pi：按 RPC 的帧法读 stdin、回 response、定时吐 event。
 * 它不模拟 pi 的任何语义，只保证「管道通了」这件事可观测。
 */
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const i = buf.indexOf("\n");
    if (i < 0) break;
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "die") process.exit(0);
    // 收到的每一帧都回一条 response：id 原样带回，测试据此判断「写进去了」。
    process.stdout.write(
      JSON.stringify({
        type: "response",
        command: msg.type,
        success: true,
        ...(msg.id ? { id: msg.id } : {}),
        data: { echo: msg.text ?? null },
      }) + "\n",
    );
  }
});
// 管道被关（壳那边 end）就当退出，跟 pi 读 stdin 到 EOF 的行为一致。
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

// 问卷：TINY_PI_ASK=1 时开场抛一条，测试用来看「换脑后它还在不在」。
if (process.env.TINY_PI_ASK === "1") {
  process.stdout.write(
    JSON.stringify({
      type: "extension_ui_request",
      id: "u-ask",
      method: "select",
      title: "换脑前问过的问题",
      options: [{ label: "甲" }, { label: "乙" }],
    }) + String.fromCharCode(10),
  );
}

// 只管播报、不等回答的 UI 帧（setStatus / setWidget / notify）：TINY_PI_STATUS=N 开场连发 N 条。
// pi 的扩展在一个长会话里会发上万条这种帧；壳要是把它们也当「没答的问卷」留着，attach 的
// 回帧会大到控制通道吞不下（> 8 MiB 被整行丢掉），新脑永远等不到 attached。
const statusCount = Number(process.env.TINY_PI_STATUS || 0);
if (statusCount > 0) {
  const pad = "x".repeat(Number(process.env.TINY_PI_STATUS_BYTES || 2048));
  let chunk = "";
  for (let i = 0; i < statusCount; i += 1) {
    const method = i % 3 === 0 ? "setStatus" : i % 3 === 1 ? "setWidget" : "notify";
    chunk +=
      JSON.stringify({ type: "extension_ui_request", id: `u-fire-${i}`, method, statusKey: "k", statusText: pad }) +
      String.fromCharCode(10);
  }
  process.stdout.write(chunk);
}

let n = 0;
setInterval(() => {
  process.stdout.write(JSON.stringify({ type: "event", name: "tick", n: ++n }) + "\n");
}, 60);
