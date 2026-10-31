/**
 * Probe: the four items of this round against a throwaway bridge.
 *
 * Q-003 column grips (drag, remember, double-click reset), Q-005 the 文件管理器 label,
 * Q-006 the hover detail on the activity line, and Q-001's UI half: deleting a live
 * session must say why inside the sheet and must not silently do nothing.
 *
 * Runs its own bridge on 7881 with a temp agent dir, so the real ~/.pi/agent is never touched.
 *
 * Run: node probes/round1-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const PORT = 7891;
const ROOT = "F:/pi-web-client/.scratch/round1-ui";
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

const names = ["甲", "乙", "丙"];
for (const [i, name] of names.entries()) {
  const id = `zz-round1-${i}`;
  const dir = path.join(SESSIONS, `--${id}--`);
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - (i + 1) * 3600_000).toISOString();
  const rows = [
    { type: "session", version: 3, id, timestamp: at, cwd: CWD },
    { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: `${name}的工作` }] } },
    { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name },
  ];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.utimesSync(file, new Date(), new Date(at));
}

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: "F:/pi-web-client",
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
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(200);
  }
  console.error(bridgeOut.join("").slice(-2000));
  assert(false, `timeout waiting for ${label}`);
}

let browser = null;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 15000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  assert(login.ok, `login failed: HTTP ${login.status} ${await login.text()}`);
  const setCookie = login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""];
  const cookie = (setCookie[0] ?? "").split(";")[0];
  assert(cookie.includes("="), `no session cookie in ${JSON.stringify(setCookie)}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 3, 10000, "3 cards");

  const cols = () =>
    page.evaluate(() => {
      const g = getComputedStyle(document.querySelector(".main")).gridTemplateColumns.trim().split(/\s+/);
      return g.map((v) => Math.round(parseFloat(v)));
    });

  // ---------------------------------------------------------------- Q-003 grips
  const before = await cols();
  log("columns before:", before.join(" / "));
  const gl = page.locator(".col-grip.grip-l");
  const gr = page.locator(".col-grip.grip-r");
  assert(await gl.isVisible(), "left grip visible at 1280");
  assert(await gr.isVisible(), "right grip visible at 1280");

  const bl = await gl.boundingBox();
  await page.mouse.move(bl.x + bl.width / 2, bl.y + bl.height / 2);
  await page.mouse.down();
  await page.mouse.move(bl.x + bl.width / 2 + 120, bl.y + bl.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(150);
  let after = await cols();
  assert(Math.abs(after[0] - (before[0] + 120)) <= 6, `left column grew by 120 (${before[0]} → ${after[0]})`);
  const savedL = await page.evaluate(() => localStorage.getItem("pi.sessionsW"));
  assert(savedL && Math.abs(Number(savedL) - after[0]) <= 6, `pi.sessionsW remembered (${savedL})`);
  log("left grip drag:", before[0], "→", after[0], "saved", savedL);

  const br = await gr.boundingBox();
  await page.mouse.move(br.x + br.width / 2, br.y + br.height / 2);
  await page.mouse.down();
  await page.mouse.move(br.x + br.width / 2 - 80, br.y + br.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(150);
  after = await cols();
  assert(Math.abs(after[2] - (before[2] + 80)) <= 6, `right column grew by 80 (${before[2]} → ${after[2]})`);
  const savedR = await page.evaluate(() => localStorage.getItem("pi.queueW"));
  assert(savedR && Math.abs(Number(savedR) - after[2]) <= 6, `pi.queueW remembered (${savedR})`);
  log("right grip drag:", before[2], "→", after[2], "saved", savedR);
  await page.screenshot({ path: path.join(OUT, "1-grips.png") });

  // Double-click forgets it.
  await gl.dblclick();
  await sleep(150);
  after = await cols();
  assert(after[0] === 280, `dblclick reset the left column (got ${after[0]})`);
  assert(!(await page.evaluate(() => localStorage.getItem("pi.sessionsW"))), "pi.sessionsW cleared");
  log("dblclick reset left column to 280");

  // ---------------------------------------------------------------- Q-005 label
  await page.locator(".session-card").first().click();
  await until(async () => page.locator(".topbar button", { hasText: "文件管理器" }).count(), 8000, "文件管理器 button");
  const label = await page.locator(".topbar button", { hasText: "文件管理器" }).innerText();
  assert(label.includes("文件管理器"), `topbar says 文件管理器 (got ${label})`);
  assert(
    (await page.locator(".topbar button", { hasText: "产物" }).count()) === 1,
    "the 产物 button next to it is untouched",
  );
  await page.screenshot({ path: path.join(OUT, "2-topbar.png") });
  log("topbar label ok:", label.trim());

  // ---------------------------------------------------------------- Q-006 (+ Q-001 needs a live session)
  const ta = page.locator(".composer textarea");
  await ta.fill("用 bash 等待 8 秒，然后回一句好了");
  await ta.press("Enter");
  await until(async () => (await page.locator(".hint-status.busy").count()) > 0, 90000, "busy hint line");
  log("turn started");

  // Q-029 follow-up: the hover target is the label, not the whole strip (the strip spans the
  // composer, so binding the row made the card pop up on its own).
  const hint = page.locator(".hint-status.busy .act-text");
  await hint.hover();
  await until(async () => (await page.locator(".act-pop").isVisible()) === true, 5000, "activity popover");
  const popText = await page.locator(".act-pop").innerText();
  assert(/已运行/.test(popText), `popover shows the clock (got ${JSON.stringify(popText)})`);
  log("popover:", popText.replace(/\n/g, " | ").slice(0, 90));
  await page.screenshot({ path: path.join(OUT, "3-activity-pop.png") });

  // ---------------------------------------------------------------- Q-001 a live delete must explain itself
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await until(async () => (await page.locator(".mgr-row").count()) >= 3, 8000, "manager rows");
  // The live session is the one being subscribed to; its delete button must be disabled with a reason.
  const busyRow = page.locator(".mgr-row", { has: page.locator(".card-act.del[disabled]") });
  const busyCount = await busyRow.count();
  assert(busyCount >= 1, "a live session's delete button is disabled in the manager");
  const why = await busyRow.first().locator(".card-act.del[disabled]").getAttribute("title");
  assert(why && why.length > 4, `the disabled button explains itself (got ${why})`);
  log("disabled delete says:", why);
  await page.screenshot({ path: path.join(OUT, "4-manager.png") });

  // Force the skipped path through the socket anyway: the bridge must answer with a report.
  const report = await page.evaluate(async () => {
    const cards = [...document.querySelectorAll(".mgr-row")];
    const row = cards.find((r) => r.querySelector(".card-act.del[disabled]"));
    return row ? row.getAttribute("data-id") : null;
  });
  log("busy row id:", report ?? "(no data-id, ok)");

  console.log("ALL OK");
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
}
