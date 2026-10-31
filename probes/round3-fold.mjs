/**
 * Probe: Q-004 — a block only folds when it is actually tall.
 *
 * Seeds one session with a long message, a medium one and a short one, plus an ask card with a
 * long prompt, then checks: long gets a control, short never does, the control toggles, and the
 * medium one starts short but becomes foldable once the column is narrowed (height is measured,
 * so it must re-measure on resize).
 *
 * Run: node probes/round3-fold.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const PORT = 7894;
const ROOT = "F:/pi-web-client/.scratch/round3-fold";
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = "F:/pi-web-client";

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, OUT]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(120);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const id = "zz-fold-0";
const dir = path.join(SESSIONS, `--${id}--`);
fs.mkdirSync(dir, { recursive: true });
const at = new Date(Date.now() - 600_000).toISOString();
const longText = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：这是一段很长的提问，用来测试折叠是否真的只在内容过长时出现。`).join("\n");
const mediumText = Array.from({ length: 6 }, () => "中等长度的提问，在宽窗口里应该看不到折叠按钮，把聊天列拖窄之后才出现。").join("\n");
const shortText = "短问题：这个不该出现折叠按钮。";
const longAnswer = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行：助手的长回答，用来确认右上角那个折叠按钮也换成了统一的形状。`).join("\n");
const longPrompt = Array.from({ length: 12 }, (_, i) => `问题 ${i + 1}：这是一条很长的问卷题干，需要确认它在转录里会被折叠。`).join("\n");

const rows = [
  { type: "session", version: 3, id, timestamp: at, cwd: CWD },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: longText }] } },
  { type: "message", id: "m2", parentId: "m1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: longAnswer }] } },
  { type: "message", id: "m3", parentId: "m2", timestamp: at, message: { role: "user", content: [{ type: "text", text: mediumText }] } },
  { type: "message", id: "m4", parentId: "m3", timestamp: at, message: { role: "user", content: [{ type: "text", text: shortText }] } },
  {
    type: "message",
    id: "m5",
    parentId: "m4",
    timestamp: at,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "questionnaire", arguments: { questions: [{ id: "q1", label: "Q1", prompt: longPrompt, options: [] }] } }],
    },
  },
  { type: "session_info", id: "n1", parentId: "m5", timestamp: at, name: "折叠" },
];
const file = path.join(dir, `${id}.jsonl`);
fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: "F:/pi-web-client",
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", (b) => process.stdout.write(`[bridge] ${b}`));
bridge.stderr.on("data", (b) => process.stderr.write(`[bridge] ${b}`));

let browser;
try {
  await until(
    async () => {
      try {
        return (await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(800) })).ok;
      } catch {
        return false;
      }
    },
    20000,
    "bridge",
  );
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  assert(res.ok && cookie.includes("="), `login worked (got ${res.status})`);

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg.user").count()) === 3, 10000, "3 user messages");
  await sleep(400); // let the rAF measurement settle

  const msgs = page.locator(".msg.user");
  const longbox = msgs.nth(0).locator(".foldable");
  const mediumbox = msgs.nth(1).locator(".foldable");
  const shortbox = msgs.nth(2).locator(".foldable");

  assert((await longbox.getAttribute("class"))?.includes("has-fold"), "the 40-line message has a fold control");
  assert(!(await shortbox.getAttribute("class"))?.includes("has-fold"), "the one-line message has none");
  assert(!(await mediumbox.getAttribute("class"))?.includes("has-fold"), "the medium message fits at 1280px");
  const longBtn = longbox.locator(".fold-btn");
  assert(await longBtn.isVisible(), "the fold control is visible");
  assert((await longBtn.innerText()).includes("收起"), `it starts expanded (got ${await longBtn.innerText()})`);

  await longBtn.click();
  await until(async () => (await longbox.getAttribute("class"))?.includes("folded"), 3000, "folded");
  assert((await longBtn.innerText()).includes("展开"), "the control now offers to expand");
  await longbox.scrollIntoViewIfNeeded();
  const box = await longbox.locator(".fold-body").evaluate((el) => ({
    clip: Math.round(el.getBoundingClientRect().height),
    content: Math.round((el.firstElementChild?.scrollHeight ?? 0)),
  }));
  assert(box.clip > 200 && box.clip < 260, `the folded block is clipped to ~240px (got ${JSON.stringify(box)})`);
  assert(box.content > box.clip + 40, `there is more content behind the fold (got ${JSON.stringify(box)})`);
  await page.screenshot({ path: path.join(OUT, "1-folded.png") });
  await longBtn.click();
  await until(async () => !(await longbox.getAttribute("class"))?.includes("folded"), 3000, "expanded again");
  log("long message folds and unfolds:", JSON.stringify(box));

  // ---------------------------------------------------------------- the ask card uses it too
  log("cards:", await page.locator(".tool").count(), "qa:", await page.locator(".qa-card").count(), "qa-foldable:", await page.locator(".qa-card .foldable").count());
  const qa = page.locator(".qa-card .foldable").first();
  assert((await qa.getAttribute("class"))?.includes("has-fold"), "the long question card has a fold control");
  log("ask card folds");

  // ---------------------------------------------------------------- resize re-measures
  // Drag the left grip (Q-003) instead of the viewport: the column really does get narrower.
  const grip = page.locator(".grip-l");
  const gb = await grip.boundingBox();
  assert(gb && gb.height > 100, "the left grip is grabbable");
  await page.mouse.move(gb.x + gb.width / 2, gb.y + 300);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2 + 240, gb.y + 300, { steps: 12 });
  await page.mouse.up();
  const sessionsW = await page.evaluate(() => localStorage.getItem("pi.sessionsW"));
  assert(Number(sessionsW) > 460, `the left pane got wider (pi.sessionsW=${sessionsW})`);
  await until(async () => (await mediumbox.getAttribute("class"))?.includes("has-fold"), 5000, "medium becomes foldable when narrow");
  log("narrowing the column made the medium message foldable");
  await page.screenshot({ path: path.join(OUT, "2-narrow.png") });

  // Q-016: the two JS-driven folds now share one trigger shape and are always visible.
  const shapes = await page.evaluate(() => {
    const pick = (sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      const chev = node.querySelector(".chev");
      return {
        cls: String(node.className),
        expanded: node.getAttribute("aria-expanded"),
        chev: chev ? getComputedStyle(chev).fontSize : null,
        rot: chev ? getComputedStyle(chev).transform : null,
        opacity: Number(getComputedStyle(node).opacity),
        label: node.querySelector(".fold-label")?.textContent?.trim() ?? null,
      };
    };
    return { answer: pick(".msg.assistant .msg-fold"), user: pick(".msg.user .foldable .fold-head") };
  });
  assert(shapes.answer?.cls.includes("fold-head"), `assistant fold uses the shared trigger (got ${JSON.stringify(shapes.answer)})`);
  assert(shapes.answer?.opacity === 1, `assistant fold is visible without hovering (got ${shapes.answer?.opacity})`);
  assert(shapes.user?.cls.includes("fold-head"), `user message fold uses the shared trigger (got ${JSON.stringify(shapes.user)})`);
  assert(shapes.user?.chev === shapes.answer?.chev, `both chevrons are the same size (${shapes.user?.chev} vs ${shapes.answer?.chev})`);
  assert(shapes.user?.rot !== "none", `an expanded fold has its chevron turned (got ${shapes.user?.rot})`);
  log("fold shapes:", JSON.stringify(shapes));
  await page.screenshot({ path: path.join(OUT, "3-fold-shapes.png") });

  console.log("ALL OK");
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
}
