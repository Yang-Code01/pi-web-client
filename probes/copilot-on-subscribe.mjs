// 探针：订阅会话之后，执行面板拿得到 copilot 积分那一份数据吗？
//
// 症状（2026-11-19）：test 会话刚打开时「执行」面板有 Copilot 积分块，几轮之后（页面重连 /
// 切会话回来 / stepup 重同步都会重发 subscribe）就整块消失，直到下一轮结束才回来。
// 机制：bridge 的 subscribe 只发 session 帧，前端 `case "session"` 无条件 `this.copilot = null`，
// 而 copilot 帧只在 boot / agent_end / agent_settled 发 —— 订阅这条路上没人补。
//
// 用法：
//   node probes/copilot-on-subscribe.mjs                          # 默认打 127.0.0.1:7864，自动挑一个 copilot 会话
//   PI_WEB_BASE=http://127.0.0.1:17864 PI_WEB_PASS=test node probes/copilot-on-subscribe.mjs
//   node probes/copilot-on-subscribe.mjs --session <id>
//
// 红：订阅后 3 秒内既没有带 copilot 的 session 帧、也没有 copilot 帧。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { wsWrapper } from "../tools/paths.mjs";

const { default: WebSocket } = await import(pathToFileURL(wsWrapper()).href);

const BASE = (process.env.PI_WEB_BASE ?? "http://127.0.0.1:7864").replace(/\/$/, "");
const STATE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local/share"), "pi-web-client");
const PASS =
  process.env.PI_WEB_PASS ?? (fs.existsSync(path.join(STATE, "passphrase.txt")) ? fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim() : "");

const argSession = (() => {
  const i = process.argv.indexOf("--session");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: PASS }),
});
if (!login.ok) fail(`login ${login.status} ${await login.text()}`);
const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie")])[0].split(";")[0];

/**
 * 这个会话里到底有没有 copilot 用量 —— 判定跟 bridge 的 `CopilotTally` 一模一样：
 * `message` 条目且 `message.role === "assistant"` 且 `provider === "github-copilot"`，
 * 或一条 `custom` / `copilot-credits`。
 *
 * 不能只搜字符串：工具输出、模型自述里出现 “github-copilot” 的会话多得很（本项目自己就在
 * 讲它）—— 实测真的挑中了一个只提到这四个字、一分积分也没有的会话。逐行流式读，命中就停。
 */
async function hasCopilotUsage(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes("github-copilot") && !line.includes("copilot-credits")) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type === "message" && entry.message?.role === "assistant" && entry.message?.provider === "github-copilot") return true;
      if (entry?.type === "custom" && entry.customType === "copilot-credits") return true;
    }
    return false;
  } finally {
    rl.close();
  }
}

/** 挑一个真有 copilot 用量的会话 —— 探针要能在空仓库 / 纯非 copilot 机器上明确说出「没得测」。 */
async function pickCopilotSession(list) {
  for (const s of list) {
    if (!s.file || !fs.existsSync(s.file)) continue;
    if (await hasCopilotUsage(s.file)) return s;
  }
  return null;
}

const listed = await (await fetch(`${BASE}/api/sessions`, { headers: { cookie } })).json();
const pick = argSession ? (listed.sessions ?? []).find((s) => s.id === argSession) : await pickCopilotSession(listed.sessions ?? []);
if (!pick) fail(`没有找到带 copilot 用量的会话（共 ${(listed.sessions ?? []).length} 个）`);
console.log(`## 会话 ${pick.name ?? "?"} ${pick.id}`);
console.log(`##   ${pick.file}`);

const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie } });
const inbox = [];
ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (msg.type === "delta" || msg.type === "usage" || msg.type === "stats" || msg.type === "filesearch.status") return;
  inbox.push(msg);
});
await new Promise((r, j) => {
  ws.once("open", r);
  ws.once("error", j);
});
inbox.length = 0;

/**
 * 一次订阅：发出 subscribe，先等 `session` 帧（它前面可能要现算 git trust，首次会慢），
 * 再从这一刻起数 3 秒找「带 copilot 的那份数据」。
 * 修复前后允许两种形状（session 帧自带 / 紧跟一条 copilot 帧），探针只管前端能不能拿到。
 */
function subscribeOnce({ waitSessionMs = 10_000, waitCopilotMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const seen = [];
    let sessionAt = 0;
    const kinds = () => [...new Set(seen.map((m) => m.type))].join(",") || "（无帧）";
    const tick = () => {
      for (const m of inbox.splice(0)) {
        seen.push(m);
        if (m.type === "session" && m.sessionId === pick.id && !sessionAt) sessionAt = Date.now();
        const fromFrame = m.type === "session" && m.sessionId === pick.id ? m.copilot : undefined;
        const fromCopilot = m.type === "copilot" && m.sessionId === pick.id ? m : undefined;
        const view = fromFrame ?? fromCopilot;
        if (view && view.hasCopilot === true) return resolve({ ok: true, via: m.type, view, seen });
      }
      if (sessionAt && Date.now() - sessionAt > waitCopilotMs) return resolve({ ok: false, seen, kinds: kinds() });
      if (!sessionAt && Date.now() - started > waitSessionMs) return resolve({ ok: false, seen, kinds: kinds(), slowSession: true });
      setTimeout(tick, 50);
    };
    ws.send(JSON.stringify({ type: "subscribe", sessionId: pick.id }));
    tick();
  });
}

let bad = 0;
for (const round of [1, 2]) {
  let res = await subscribeOnce();
  // 刚起来的 bridge 首次算 git trust 能慢过 10 秒 —— 那是环境，不是本 bug；重试一次，不计入结论。
  if (res.slowSession) {
    console.error(`## 第 ${round} 次订阅：连上了但 session 帧迟迟不来（收到帧：${res.kinds}）—— 重试一次`);
    res = await subscribeOnce();
  }
  if (res.ok) {
    const v = res.view;
    console.log(
      `## 第 ${round} 次订阅：拿到 copilot（来自 ${res.via}）credits=${Math.round(v.credits * 100) / 100} requests=${v.requests} hasCopilot=${v.hasCopilot}`,
    );
  } else {
    bad++;
    console.error(`## 第 ${round} 次订阅：3 秒内没拿到 copilot —— 前端会把面板清空（收到帧：${res.kinds}）`);
  }
}

ws.close();
if (bad) fail(`订阅后拿不到 copilot 数据（${bad}/2 次）—— 执行面板的积分块会消失`);
console.log("OK：订阅（含重连 / 切会话）之后 copilot 面板数据都在");
process.exit(0);
