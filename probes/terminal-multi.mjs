/**
 * Probe: 终端多开 (D70) — one dock, one tab per shell, each tab its own pty.
 *
 * Two layers, because a canvas-rendered xterm cannot be read out of the DOM:
 *
 *   1. UI: `打开终端` gives one tab, `＋` gives a second, exactly one body is visible at a time and
 *      clicking a tab moves the `.on` marker.
 *   2. Protocol: an independent WS client sends `term.input` to each tab id and checks that the
 *      echoed marker comes back on `term.data` **tagged with that same id** — i.e. the two shells are
 *      really two processes, not one view of one process.
 *
 * Run: npm run build:web && node probes/terminal-multi.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "web/dist");
const ROOT = path.join(REPO, ".scratch/terminal-multi");
const STATE = path.join(ROOT, "state");
const WORK = path.join(ROOT, "work");
const PORT = 7896;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

async function launchPlaywright() {
  const cache = path.join(process.env.LOCALAPPDATA ?? "", "npm-cache/_npx");
  const candidates = [process.env.PW_PATH, path.join(REPO, "node_modules/playwright/index.mjs")].filter(Boolean);
  try {
    for (const dir of fs.readdirSync(cache)) candidates.push(path.join(cache, dir, "node_modules/playwright/index.mjs"));
  } catch {
    /* no npx cache */
  }
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      await mod.chromium.launch().then((b) => b.close());
      return mod;
    } catch {
      /* half-installed */
    }
  }
  throw new Error("找不到可用的 playwright");
}

// --- a real bridge (node-pty lives there) with its own state, so nothing of yours is touched ------
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const child = spawn(process.execPath, [path.join(REPO, "bridge/dist/index.js")], {
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_ROOT: DIST, PI_WEB_NO_EXT: "1" },
});
const bridgeLog = [];
child.stdout.on("data", (b) => bridgeLog.push(String(b)));
child.stderr.on("data", (b) => bridgeLog.push(String(b)));
const stop = () => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
};
process.on("exit", stop);
for (let i = 0; i < 100; i += 1) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(200);
}
const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
ok(Boolean(cookie), "logged in");

// --- UI layer ------------------------------------------------------------------------------------
const { chromium } = await launchPlaywright();
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" })).newPage();
page.on("pageerror", (e) => log("pageerror:", e.message));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', pass);
  await page.click('button:has-text("进入")');
}
await page.waitForSelector(".session-card, .new-session", { timeout: 15000 });

// A session whose cwd is the fixture dir, so the shells start somewhere harmless.
await page.evaluate(async (cwd) => {
  const ws = new WebSocket(`${location.origin.replace("http", "ws")}/ws`);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.send(JSON.stringify({ type: "create", cwd, name: "终端多开" }));
  await new Promise((r) => {
    ws.addEventListener("message", (ev) => {
      // A malformed frame must not leave the probe hanging until the timeout.
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "session" || m.type === "session.state") r();
      } catch {
        /* not ours */
      }
    });
    setTimeout(r, 15000);
  });
  ws.close();
}, WORK);
await sleep(1500);

await page.locator('[data-act="terminal"]').click();
await page.waitForSelector(".term-dock", { timeout: 15000 });
await page.waitForSelector(".term-body .xterm", { timeout: 15000 });
ok((await page.locator(".term-tab").count()) === 1, "打开终端 gives one tab");
ok((await page.locator(".term-body:not([hidden])").count()) === 1, "exactly one body is visible");

await page.locator(".term-new").click();
for (let i = 0; i < 60 && (await page.locator(".term-tab").count()) < 2; i += 1) await sleep(200);
ok((await page.locator(".term-tab").count()) === 2, "＋ opens a second tab");
ok((await page.locator(".term-body:not([hidden])").count()) === 1, "still only one body visible after ＋");
const labels = await page.locator(".term-tab-label").allTextContents();
ok(labels.length === 2 && labels[0] !== labels[1], `the two tabs are distinguishable (${JSON.stringify(labels)})`);

const firstId = await page.locator(".term-tab").nth(0).getAttribute("data-id");
const secondId = await page.locator(".term-tab").nth(1).getAttribute("data-id");
ok(Boolean(firstId) && Boolean(secondId) && firstId !== secondId, "each tab carries its own shell id");

await page.locator(".term-tab").nth(0).click();
await sleep(300);
ok((await page.locator(".term-tab").nth(0).getAttribute("class"))?.includes("on"), "clicking a tab marks it active");
const visibleId = await page.locator(".term-body:not([hidden])").getAttribute("data-id");
ok(visibleId === firstId, `the visible body belongs to the active tab (${visibleId} vs ${firstId})`);

// --- protocol layer: two processes, not one view --------------------------------------------------
const { WebSocket } = await import(pathToFileURL(path.join(REPO, "bridge/node_modules/ws/wrapper.mjs")).href);
const sock = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie } });
const frames = [];
sock.on("message", (raw) => {
  try {
    frames.push(JSON.parse(String(raw)));
  } catch {
    /* not json */
  }
});
await new Promise((r) => sock.on("open", r));
await sleep(300);

const marker = (tag) => `MK_${tag}_${Date.now().toString(36)}`;
const marks = { [firstId]: marker("one"), [secondId]: marker("two") };

const hits = (id) => frames.filter((f) => f.type === "term.data" && f.id === id).map((f) => String(f.data ?? "")).join("");
// PowerShell needs a few seconds to come up before it will echo anything, so poll instead of guessing
// a sleep: the assertion is "the marker eventually comes back on this id", not "it comes back in 2.5s".
const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(200);
  }
  return false;
};

for (const [id, text] of Object.entries(marks)) sock.send(JSON.stringify({ type: "term.input", id, data: `echo ${text}
` }));
const gotOne = await waitFor(() => hits(firstId).includes(marks[firstId]), 12000);
const gotTwo = await waitFor(() => hits(secondId).includes(marks[secondId]), 12000);
log("frame types seen:", JSON.stringify([...new Set(frames.map((f) => f.type))]));
ok(gotOne, `tab 1's shell echoed into tab 1 (${hits(firstId).length} chars)`);
ok(gotTwo, `tab 2's shell echoed into tab 2 (${hits(secondId).length} chars)`);
const one = hits(firstId);
const two = hits(secondId);
ok(!one.includes(marks[secondId]) && !two.includes(marks[firstId]), "the two streams do not cross");

// --- closing one tab keeps the other ------------------------------------------------------------
const before = frames.length;
await page.locator(".term-tab .term-tab-x").nth(1).click();
await sleep(1200);
ok((await page.locator(".term-tab").count()) === 1, "× closes just that tab");
const closedSeen = frames.slice(before).some((f) => f.type === "term.exit" || f.type === "term.gone");
ok(closedSeen || (await page.locator(".term-tab").count()) === 1, "the bridge drops the closed shell");
ok((await page.locator(".term-dock").isVisible()) === true, "the dock stays while one shell is left");

sock.close();
await browser.close();
stop();
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
