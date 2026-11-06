/**
 * 技能调用在聊天记录里必须读成人敲的那句，而不是 pi 展开的 XML（无票，用户报的）。
 *
 * pi 写盘前把 `/skill:grill-me 看看 #72` 展开成
 * `<skill name="grill-me" location="…">整篇 SKILL.md</skill>` + args，桥现在把它折回命令并给 item
 * 打上 skill 标记，前端画成一颗 chip。这里用真实 Chromium + 一份手写的会话文件（放的是展开后的
 * 原文，跟真实会话一模一样）验证四处：气泡、刻度带悬停行、复制按钮、普通消息不受影响。
 *
 * 前半段读的是文件里已有的东西；后半段走真正的发送路径（填输入框 → Enter → 乐观气泡 →
 * 桥的 adopt 把正文重建一次），因为「发送时就有 chip」和「回读之后不跳」是两件事。
 *
 * 不碰正式 7864（`PI_WEB_PORT=7864` 会被拒绝），也不起活的 pi（不花模型调用）。
 * 跑之前要先 `npm run build`：探针跑的是 bridge/dist/index.js，dist 比 src 旧就直接退。
 *
 * 跑：node probes/skill-block.mjs           截图为 .scratch/skill-block/shot.png
 */
import path from "node:path";
import fs from "node:fs";
import { execSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

// 跟其它探针一样认 `PI_WEB_PORT`（子进程也是用它），但 7864 是用户真在用的那份 —— 误杀比测试
// 失败代价大得多，所以显式拒绝。
const PORT = Number(process.env.PI_WEB_PORT ?? 7890);
if (PORT === 7864) {
  console.error("refusing to run on 7864 (the live bridge): set PI_WEB_PORT to a free port");
  process.exit(2);
}
const ROOT = path.join(REPO, ".scratch/skill-block");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "skill-block-probe";
const LOCATION = "C:\\Users\\GG_Bond\\.pi\\agent\\skills\\grill-me\\SKILL.md";
const SKILL_TEXT = `我想要的：/skill:grill-me 看看 #72`;
const SKILL_BLOCK = [
  `<skill name="grill-me" location="${LOCATION}">`,
  "References are relative to C:\\Users\\GG_Bond\\.pi\\agent\\skills\\grill-me.",
  "",
  'Call the Skill tool with "grilling".',
  "</skill>",
].join("\n");
const STORED = `${SKILL_BLOCK}\n\n看看 #72`; // 这一行就是 pi 写进会话文件的东西

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// 探针驱动的是构建产物：dist 比 src 旧的话，测的是上一个提交，失败原因会骗人。
const DIST = path.join(REPO, "bridge/dist/index.js");
if (!fs.existsSync(DIST)) {
  console.error("bridge/dist/index.js 不存在：先 npm run build");
  process.exit(2);
}
const newestSource = () => {
  let newest = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs|css|html)$/.test(e.name)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  for (const d of ["bridge/src", "web/src"]) if (fs.existsSync(path.join(REPO, d))) walk(path.join(REPO, d));
  return newest;
};
if (newestSource() > fs.statSync(DIST).mtimeMs) {
  console.error("dist 比 src 旧：先 npm run build，否则测的是上一个提交");
  process.exit(2);
}

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, path.join(SESSIONS, "--skill-block-probe--"), WORK]) fs.mkdirSync(d, { recursive: true });

const at = new Date().toISOString();
const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: at, message });
fs.writeFileSync(
  path.join(SESSIONS, "--skill-block-probe--", `${SID}.jsonl`),
  [
    { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
    { type: "session_info", id: "n0", parentId: null, timestamp: at, name: "skill-block" },
    entry("u1", "n0", { role: "user", content: [{ type: "text", text: STORED }] }),
    entry("a1", "u1", { role: "assistant", content: [{ type: "text", text: "先看 #72 的分组。" }], model: "probe" }),
    entry("u2", "a1", { role: "user", content: [{ type: "text", text: "还有一件事" }] }),
    entry("a2", "u2", { role: "assistant", content: [{ type: "text", text: "你说。" }], model: "probe" }),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);

function killPort(port) {
  try {
    const pids = new Set();
    const out = execSync("netstat -ano", { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+(\S+)\s+\S+\s+(\d+)$/);
      if (m && Number(m[1]) === port && /:0$/.test(m[2])) pids.add(Number(m[3]));
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      } catch {}
    }
  } catch {}
}
killPort(PORT);

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(150);
  }
  console.error(bridgeOut.join("").slice(-3000));
  throw new Error(`timeout waiting for ${label}`);
}

let browser = null;
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

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 15000, "session card");
  await page.locator(".session-card").first().click();
  await page.locator(".msg.user").first().waitFor({ timeout: 15000 });
  await sleep(600);

  const bubbles = await page.locator(".msg.user").evaluateAll((nodes) =>
    nodes.map((n) => ({
      text: (n.querySelector(".body")?.textContent ?? "").trim(),
      inner: (n.querySelector(".body")?.innerText ?? "").trim(),
      chip: n.querySelector(".msg-skill")?.textContent ?? null,
      chipTitle: n.querySelector(".msg-skill")?.getAttribute("title") ?? "",
    })),
  );
  console.log("BUBBLES:", JSON.stringify(bubbles));
  check("技能消息读成命令 + args", bubbles[0]?.text === "/skill:grill-me 看看 #72", `"${bubbles[0]?.text}"`);
  check("气泡里没有展开的 XML", !(bubbles[0]?.text ?? "").includes("<skill"), bubbles[0]?.text ?? "");
  check("命令画成 chip", bubbles[0]?.chip === "/skill:grill-me", String(bubbles[0]?.chip));
  check("chip 的 tooltip 是 SKILL.md 路径", (bubbles[0]?.chipTitle ?? "").includes(LOCATION), bubbles[0]?.chipTitle ?? "");
  check("args 原样跟在 chip 后面", (bubbles[0]?.inner ?? "").replace(/\s+/g, " ").startsWith("/skill:grill-me 看看 #72"), bubbles[0]?.inner ?? "");

  check("普通消息不受影响", bubbles[1]?.text === "还有一件事", `"${bubbles[1]?.text}"`);
  check("普通消息没有 chip", bubbles[1]?.chip === null, String(bubbles[1]?.chip));

  // 整份 transcript 里不该再出现展开块（包括折叠区、悬停行）
  const transcript = await page.evaluate(() => document.body.textContent ?? "");
  check("整页都没有 <skill", !transcript.includes("<skill"), transcript.replace(/\s+/g, " ").slice(0, 80));

  // 复制按钮拿到的必须是折回来的那句，不是整篇 SKILL.md
  await page.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = async (t) => {
      window.__copied = t;
    };
  });
  await page.locator(".msg.user .msg-copy:not(.msg-fork)").first().click();
  await sleep(300);
  const copied = await page.evaluate(() => window.__copied);
  check("复制按钮给的是命令", copied === "/skill:grill-me 看看 #72", JSON.stringify(copied));

  // 右侧刻度带：刻度的 tooltip 与悬停行都读命令
  await page.locator(".turn-tick").first().waitFor({ timeout: 8000 });
  const tickTitle = await page.locator(".turn-tick").first().getAttribute("title");
  check("刻度 tooltip 是命令", tickTitle === "第 1 轮：/skill:grill-me 看看 #72", String(tickTitle));
  // 悬停行靠 `.turn-rail:hover` 才 display:grid，pointerenter 不行，得真把鼠标挪到刻度带上。
  const rail = await page.locator(".turn-rail").boundingBox();
  await page.mouse.move(rail.x + rail.width / 2, rail.y + 6);
  await sleep(500);
  const hovered = await page.locator(".turn-list").first().evaluate((n) => getComputedStyle(n).display);
  check("悬停行真的弹出来了", hovered !== "none", hovered);
  const rowText = (await page.locator(".turn-list .turn-row .txt").first().textContent()) ?? "";
  const rowTitle = await page.locator(".turn-list .turn-row").first().getAttribute("title");
  check("悬停行读命令", rowText.trim() === "/skill:grill-me 看看 #72", rowText.trim());
  check("悬停行 tooltip 也是命令", rowTitle === "第 1 轮：/skill:grill-me 看看 #72", String(rowTitle));

  // ── 真正的发送路径 ─────────────────────────────────────────────────────────
  // 上面几条读的是「文件里已有的东西」。这一条走人真正走的那条路：填输入框 → Enter → app.ts
  // 先插一颗乐观气泡（芯片来自 `skillOf`，不等桥回来），1.5 秒后再看它有没有变型或重影。
  //
  // 局限：这里没有活的 pi（temp AGENT 目录里没有登录），桥端 `prompt()` 在
  // `if (!this.rpc?.alive) throw`（bridge/src/sessions.ts:1516）就抛了，**不会**走到
  // `item.add` → `adopt()` 那条重建路径 —— 所以下面两条只证明「乐观气泡当场就是对的」。
  // 真起一个 stub pi 能覆盖 adopt，但它得先把 get_state / get_session_stats / get_commands
  // 的应答形状也仿对，风险（改写整个 transcript）大于收益；这条留给 D164「代价」那节记着。
  const before = await page.locator(".msg.user").count();
  await page.locator(".composer textarea").click();
  await page.locator(".composer textarea").fill("/skill:grill-me 再说一句");
  await page.keyboard.press("Enter");
  await sleep(300);
  const sent = await page.locator(".msg.user").count();
  const optimistic = await page.locator(".msg.user").last().evaluate((n) => ({
    text: (n.querySelector(".body")?.textContent ?? "").trim(),
    chip: n.querySelector(".msg-skill")?.textContent ?? null,
  }));
  check("按 Enter 后气泡立刻出现", sent === before + 1, `${before} → ${sent}`);
  check("乐观气泡当场就有芯片（不等文件回读）", optimistic.chip === "/skill:grill-me", String(optimistic.chip));
  check("乐观气泡的正文是命令 + args", optimistic.text === "/skill:grill-me 再说一句", JSON.stringify(optimistic.text));

  await sleep(1500);
  const after = await page.locator(".msg.user").count();
  const settled = await page.locator(".msg.user").last().evaluate((n) => ({
    text: (n.querySelector(".body")?.textContent ?? "").trim(),
    chips: n.querySelectorAll(".msg-skill").length,
  }));
  check("1.5 秒后没有多出第二条气泡", after === sent, `${sent} → ${after}`);
  check("1.5 秒后正文与芯片都没变", settled.text === "/skill:grill-me 再说一句" && settled.chips === 1, JSON.stringify(settled));

  await page.screenshot({ path: path.join(ROOT, "shot.png"), clip: { x: 0, y: 0, width: 1280, height: 620 } });
  console.log(`SHOT: ${path.join(ROOT, "shot.png")}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  bridge.kill();
  await sleep(400);
  killPort(PORT);
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
