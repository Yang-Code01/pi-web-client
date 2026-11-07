/**
 * Probe: Q-011 — pinned sessions stay reachable when the left column is collapsed.
 *
 * Seeds three sessions, pins two of them (in a deliberate order), then checks row 2: order matches
 * the list's 置顶 order, clicking a chip opens that session, the topbar toggle brings the column
 * back, and row 2 never grows a second 「展开左栏」 of its own (the topbar toggle is the only one).
 *
 * Run: node probes/round4-pin.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const PORT = Number(process.env.PI_WEB_PORT ?? 7895);
const ROOT = path.join(REPO, ".scratch/round4-pin");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = REPO;

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

const NAMES = ["登录改造", "接口联调", "文档校对"];
const IDS = ["zz-pin-0", "zz-pin-1", "zz-pin-2"];
IDS.forEach((id, i) => {
  const dir = path.join(SESSIONS, `--${id}--`);
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - (i + 1) * 60_000).toISOString();
  const rows = [
    { type: "session", version: 3, id, timestamp: at, cwd: CWD },
    { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: `${NAMES[i]}：先聊聊这一步。` }] } },
    { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name: NAMES[i] },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
});
// Pin 接口联调 above 登录改造 — the strip must follow this order, not the list's time order.
fs.writeFileSync(path.join(STATE, "manage.json"), JSON.stringify({ pin: ["zz-pin-1", "zz-pin-0"], order: [], archived: [] }));

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: CWD,
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) === 3, 10000, "3 cards");

  // 行 2 是常驻的（#97 壳 A 两行制）—— 左栏开着的时候它也在。
  const strip = page.locator(".pin-strip");
  assert(await strip.isVisible(), "row 2 is on screen while the column is open");
  const chips = strip.locator(".pin-chip:not(.pin-new)");
  await until(async () => (await chips.count()) === 2, 4000, "2 pinned chips");
  const labels = await chips.allInnerTexts();
  assert(labels[0].includes("接口联调"), `pin order is respected (got ${JSON.stringify(labels)})`);
  assert(labels[1].includes("登录改造"), `second pin follows (got ${JSON.stringify(labels)})`);
  assert(!labels.join().includes("文档校对"), "an unpinned session is not on the strip");
  log("strip:", labels.map((l) => l.replace(/\s+/g, " ").trim()));
  await page.screenshot({ path: path.join(OUT, "1-strip.png") });

  // 收起左栏：行 2 不再长出一颗「展开左栏」（顶栏左上角那颗就能展开）。
  await page.locator(".icon-btn.side-toggle[data-side=left]").click();
  await until(async () => !(await page.locator(".session-list").isVisible()), 4000, "column collapsed");
  assert((await strip.locator("button", { hasText: "展开左栏" }).count()) === 0, "row 2 has no second 「展开左栏」");
  await page.screenshot({ path: path.join(OUT, "1b-collapsed.png") });

  // A chip is a shortcut, not a decoration.
  await chips.first().click();
  await until(async () => (await page.locator(".topbar .title").innerText()).includes("接口联调"), 6000, "chip opens its session");
  log("chip opened the session");

  // And the topbar toggle puts the column back (the strip no longer carries its own copy).
  await page.locator(".icon-btn.side-toggle[data-side=left]").click();
  await until(async () => (await page.locator(".session-list").isVisible()) && (await strip.isVisible()), 4000, "column restored");
  assert(await page.locator(".session-card").first().isVisible(), "the session column is back");
  log("展开左栏 restores the column");

  // Unpinning everything leaves an honest empty hint instead of a bare strip.
  await page.locator(".icon-btn.side-toggle[data-side=left]").click();
  await until(async () => strip.isVisible(), 4000, "strip visible again");
  await page.evaluate(async () => {
    const el = document.querySelector(".session-card .card-acts .card-act[title*='取消置顶'], .session-card .card-acts .card-act[title*='置顶']");
    if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, "2-after-unpin.png") });

  // Q-013: the last thing in the strip starts a session — the only visible way while the pane is hidden.
  const add = page.locator(".pin-strip .pin-new");
  await until(async () => (await add.count()) > 0, 5000, "＋ button in the strip");
  await add.first().click();
  await until(async () => (await page.locator(".sheet").count()) > 0, 5000, "new session sheet opened");
  const sheetTitle = (await page.locator(".sheet-title").first().innerText()).trim();
  assert(/新会话|新建/.test(sheetTitle), `the ＋ opens the new-session sheet (got ${sheetTitle})`);
  console.log("＋ opened:", sheetTitle);
  await page.screenshot({ path: path.join(OUT, "3-pin-new.png") });

  console.log("ALL OK");
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
}
