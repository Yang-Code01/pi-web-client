/**
 * 一轮里自动加载的多个技能必须收进一个折叠组（用户要求）：不展开时永远只有一行
 * 「自动加载 N 个技能 · 名字…」，点开才是每张技能卡的全文；换一条用户消息就是新一轮、另起一组。
 *
 * 验证走的是回放路径（手写会话文件 + 真实 Chromium）：`withSkillItems` 把每个 `read …SKILL.md`
 * 变成一张卡，页面 `add()` 逐条收进本轮组里 —— 与实时推送走同一段代码。
 *
 * 不碰正式 7864（`PI_WEB_PORT=7864` 会被拒绝），也不起活的 pi（不花模型调用）。
 * 跑之前要先 `npm run build`：探针跑的是 bridge/dist/index.js，dist 比 src 旧就直接退。
 *
 * 跑：node probes/skill-group.mjs           截图为 .scratch/skill-group/shot.png
 */
import path from "node:path";
import fs from "node:fs";
import { execSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const PORT = Number(process.env.PI_WEB_PORT ?? 7891);
if (PORT === 7864) {
  console.error("refusing to run on 7864 (the live bridge): set PI_WEB_PORT to a free port");
  process.exit(2);
}
const ROOT = path.join(REPO, ".scratch/skill-group");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "skill-group-probe";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

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

// ── 一份手写的会话：第 1 轮读 3 个技能，第 2 轮读 1 个 ─────────────────────────────
fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, path.join(SESSIONS, "--skill-group-probe--"), WORK]) fs.mkdirSync(d, { recursive: true });

const SKILLS = {
  "grill-me": "A relentless interview to sharpen a plan or design.",
  grilling: "拷问一个计划、决定或想法，直到它站得住。",
  anatomy: "Build crafted, highly detailed, interactive isometric SVG figures.",
  jira: "Read Jira issues through the REST API.",
};
const skillPath = (name) => path.join(AGENT, "skills", name, "SKILL.md");
for (const [name, desc] of Object.entries(SKILLS)) {
  fs.mkdirSync(path.join(AGENT, "skills", name), { recursive: true });
  fs.writeFileSync(skillPath(name), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`, "utf8");
}

const at = new Date().toISOString();
const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: at, message });
const read = (id, parentId, callId, skill) =>
  entry(id, parentId, {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: skillPath(skill) } }],
    model: "probe",
  });
const result = (id, parentId, callId) =>
  entry(id, parentId, { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text: "# skill" }] });

const lines = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "session_info", id: "n0", parentId: null, timestamp: at, name: "skill-group" },
  entry("u1", "n0", { role: "user", content: [{ type: "text", text: "jira 接入，先按规矩来" }] }),
  entry("a1", "u1", { role: "assistant", content: [{ type: "text", text: "先读一下拷问的规矩。" }], model: "probe" }),
  read("a2", "a1", "t1", "grill-me"),
  result("r1", "a2", "t1"),
  entry("a3", "r1", { role: "assistant", content: [{ type: "text", text: "再看第二个。" }], model: "probe" }),
  read("a4", "a3", "t2", "grilling"),
  result("r2", "a4", "t2"),
  read("a5", "r2", "t3", "anatomy"),
  result("r3", "a5", "t3"),
  entry("u2", "r3", { role: "user", content: [{ type: "text", text: "第二件事" }] }),
  read("a7", "u2", "t4", "jira"),
  result("r4", "a7", "t4"),
];
fs.writeFileSync(path.join(SESSIONS, "--skill-group-probe--", `${SID}.jsonl`), lines.map((r) => JSON.stringify(r)).join("\n") + "\n");

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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 15000, "session card");
  await page.locator(".session-card").first().click();
  await page.locator(".msg.user").first().waitFor({ timeout: 15000 });
  await sleep(600);

  const groups = await page.locator(".skillgroup").evaluateAll((nodes) =>
    nodes.map((n) => ({
      open: n.hasAttribute("open"),
      text: (n.querySelector("summary")?.innerText ?? "").replace(/\s+/g, " ").trim(),
      title: n.querySelector(".skillgroup-names")?.getAttribute("title") ?? "",
      cards: [...n.querySelectorAll(".skillcard")].map((c) => ({
        name: c.querySelector(".n")?.textContent ?? "",
        desc: c.querySelector(".desc")?.textContent ?? "",
        src: c.querySelector(".src")?.textContent ?? "",
        why: c.querySelector(".why")?.textContent ?? "",
      })),
    })),
  );
  console.log("GROUPS:", JSON.stringify(groups, null, 1));

  check("两轮各一组，不是每个技能一张卡", groups.length === 2, `${groups.length} group(s)`);
  check("第一组默认折叠", groups[0]?.open === false, String(groups[0]?.open));
  check("摘要行点名本轮 3 个技能", /3 个技能/.test(groups[0]?.text ?? ""), groups[0]?.text ?? "");
  check(
    "摘要行按到达顺序列出全部名字",
    (groups[0]?.text ?? "").includes("grill-me") &&
      (groups[0]?.text ?? "").includes("grilling") &&
      (groups[0]?.text ?? "").includes("anatomy"),
    groups[0]?.text ?? "",
  );
  check("摘要行带「自动加载」徽标", (groups[0]?.text ?? "").includes("自动加载"), groups[0]?.text ?? "");
  check("tooltip 里是全文", (groups[0]?.title ?? "").includes("anatomy"), groups[0]?.title ?? "");
  check("第一组里装着 3 张完整技能卡", groups[0]?.cards.length === 3, `${groups[0]?.cards.length} cards`);
  check("卡里有描述", (groups[0]?.cards[0]?.desc ?? "").includes("relentless"), groups[0]?.cards[0]?.desc ?? "");
  check("卡里有 SKILL.md 出口", groups[0]?.cards[0]?.src === "SKILL.md", groups[0]?.cards[0]?.src ?? "");
  check("卡里有触发线索", (groups[0]?.cards[0]?.why ?? "").includes("先读一下拷问的规矩"), groups[0]?.cards[0]?.why ?? "");
  // 模型说过话就用它最近那一句（D199）；一句话没说才退回本轮用户消息 —— 第二轮的 jira 就是这种。
  check("模型说过话就用它最近那句", (groups[0]?.cards[2]?.why ?? "").includes("再看第二个"), groups[0]?.cards[2]?.why ?? "");
  check("没说话时退回本轮用户消息", (groups[1]?.cards[0]?.why ?? "").includes("第二件事"), groups[1]?.cards[0]?.why ?? "");

  check("第二轮的技能另起一组", (groups[1]?.text ?? "").includes("1 个技能"), groups[1]?.text ?? "");
  check("第二组只有 jira", (groups[1]?.text ?? "").includes("jira") && groups[1]?.cards.length === 1, groups[1]?.text ?? "");

  // 折叠时是一行：摘要行的实际高度只有一行字那么高（换行就会翻倍）。
  const summaryBox = await page.locator(".skillgroup > summary").first().boundingBox();
  check("折叠时摘要只有一行高", summaryBox !== null && summaryBox.height < 40, `${summaryBox?.height}px`);

  // 点开：详情全展开，chevron 转过去。
  await page.locator(".skillgroup > summary").first().click();
  await sleep(300);
  const opened = await page.locator(".skillgroup").first().evaluate((n) => ({
    open: n.hasAttribute("open"),
    cards: n.querySelectorAll(".skillcard").length,
    chev: getComputedStyle(n.querySelector(".chev")).transform,
  }));
  check("点一下组就展开", opened.open === true, String(opened.open));
  check("展开后 3 张卡都在", opened.cards === 3, String(opened.cards));
  check("chevron 转了 90 度", opened.chev.startsWith("matrix(0, 1, -1, 0"), opened.chev);

  // 折叠回去：又只剩一行。
  await page.locator(".skillgroup > summary").first().click();
  await sleep(300);
  const closed = await page.locator(".skillgroup").first().evaluate((n) => ({
    open: n.hasAttribute("open"),
    bodyH: n.querySelector(".skillgroup-body")?.getBoundingClientRect().height ?? -1,
  }));
  check("再点一下收回去", closed.open === false, String(closed.open));
  check("收起后详情不占高度", closed.bodyH === 0, `${closed.bodyH}px`);

  await page.locator(".skillgroup").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(ROOT, "shot.png") });
  console.log(`SHOT: ${path.join(ROOT, "shot.png")}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  bridge.kill();
  await sleep(400);
  killPort(PORT);
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
