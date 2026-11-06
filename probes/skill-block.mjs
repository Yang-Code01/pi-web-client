/**
 * 技能调用在聊天记录里必须读成人敲的那句，而不是 pi 展开的 XML（无票，用户报的）。
 *
 * pi 写盘前把 `/skill:grill-me 看看 #72` 展开成
 * `<skill name="grill-me" location="…">整篇 SKILL.md</skill>` + args，桥现在把它折回命令并给 item
 * 打上 skill 标记，前端画成一颗 chip。这里用真实 Chromium + 一份手写的会话文件（放的是展开后的
 * 原文，跟真实会话一模一样）验证四处：气泡、刻度带悬停行、复制按钮、普通消息不受影响。
 *
 * 不碰正式 7864，也不起 pi 子进程（不花模型调用）。
 *
 * 跑：node probes/skill-block.mjs           截图为 .scratch/skill-block/shot.png
 */
import path from "node:path";
import fs from "node:fs";
import { execSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const PORT = Number(process.env.SKILL_BLOCK_PORT ?? 7890);
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
