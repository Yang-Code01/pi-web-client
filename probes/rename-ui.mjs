/**
 * Probe: sidebar rename in a real browser (D43).
 * login → hover a card → ✎ → type → Enter; then Escape cancels, blur commits, reload persists.
 *
 * Run: node probes/rename-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const PORT = 7873;
const ROOT = path.join("F:/pi-web-client/.scratch", "rename-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exit(1);
};

// Two read-only disk sessions (the bridge never needs pi for those).
const old = new Date(Date.now() - 3600_000);
const ids = ["0199bbbb-0000-4000-8000-000000000001", "0199bbbb-0000-4000-8000-000000000002"];
const names = ["磁盘里的老会话", null];
ids.forEach((id, i) => {
  const file = path.join(SESSIONS, `--zz-ui-probe--`, `2025-03-0${i + 1}T00-00-00-000Z_${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = { type: "session", version: 3, id, timestamp: "2025-03-01T00:00:00.000Z", cwd: "F:/pi-web-client" };
  const lines = [JSON.stringify(header)];
  if (names[i]) lines.push(JSON.stringify({ type: "session_info", id: "s1", parentId: null, timestamp: "2025-03-01T00:00:00.500Z", name: names[i] }));
  lines.push(
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2025-03-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "第一句话当作名字" }] } }),
  );
  fs.writeFileSync(file, lines.join("\n") + "\n");
  fs.utimesSync(file, old, old);
});

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: "F:/pi-web-client",
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_AGENT_DIR: AGENT, PI_WEB_TUNNEL: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(150);
  }
  fail(`timeout waiting for ${label}\n${bridgeOut.join("").slice(-1500)}`);
};

let browser;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 10000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 15000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 }, deviceScaleFactor: 2 });
  page.on("console", (m) => {
    if (m.type() === "error") log("console error:", m.text());
  });
  page.on("pageerror", (e) => log("pageerror:", e.message));

  await page.goto(BASE);
  await page.fill(".login input", pass);
  await page.click(".login .btn");
  const cards = await until(async () => (await page.locator(".session-card").count()) === 2 && page.locator(".session-card"), 20000, "cards");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "1-list.png") });
  log("cards:", await cards.count());

  // nth card that has the disk name
  let target = page.locator('.session-card:has-text("磁盘里的老会话")').first();
  if ((await target.count()) === 0) target = page.locator(".session-card").first();
  await target.hover();
  await target.locator(".rename-btn").click();
  const input = page.locator(".session-card .rename-input");
  await input.waitFor();
  await page.screenshot({ path: path.join(OUT, "2-editing.png") });
  const focus = await page.evaluate(() => ({
    cls: document.activeElement?.className,
    value: document.activeElement?.value,
    sel: [document.activeElement?.selectionStart, document.activeElement?.selectionEnd],
  }));
  log("focused on open:", JSON.stringify(focus));
  if (!String(focus.cls).includes("rename-input")) fail("rename input is not focused on open");

  await input.fill("浏览器改的名字");
  await input.press("Enter");
  await until(async () => (await page.locator('.session-card:has-text("浏览器改的名字")').count()) === 1, 8000, "renamed card");
  log("Enter renamed the card");
  await page.screenshot({ path: path.join(OUT, "3-renamed.png") });

  // reload: the bridge persisted it in names.json
  await page.reload();
  await until(async () => (await page.locator('.session-card:has-text("浏览器改的名字")').count()) === 1, 20000, "name after reload");
  log("name survived a reload");

  // Escape cancels
  target = page.locator('.session-card:has-text("浏览器改的名字")').first();
  await target.hover();
  await target.locator(".rename-btn").click();
  await page.locator(".session-card .rename-input").fill("不该保存");
  await page.locator(".session-card .rename-input").press("Escape");
  await page.waitForTimeout(300);
  if ((await page.locator('.session-card:has-text("不该保存")').count()) !== 0) fail("Escape still saved the name");
  if ((await page.locator('.session-card:has-text("浏览器改的名字")').count()) !== 1) fail("Escape lost the old name");
  log("Escape cancelled");

  // blur commits
  await target.hover();
  await target.locator(".rename-btn").click();
  await page.locator(".session-card .rename-input").fill("失焦也保存");
  await page.locator(".topbar .title").click();
  await until(async () => (await page.locator('.session-card:has-text("失焦也保存")').count()) === 1, 8000, "blur commit");
  log("blur committed");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "4-final.png") });

  // the card is still clickable (opens the chat) after being a div
  const card4 = page.locator('.session-card:has-text("失焦也保存")').first();
  await card4.hover();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "5-hover.png") });
  await card4.screenshot({ path: path.join(OUT, "6-card.png") });
  await card4.click();
  await until(async () => (await page.locator(".composer textarea").count()) === 1, 8000, "chat open");
  log("card still opens the chat");

  log("ALL OK — shots in", OUT);
} finally {
  await browser?.close();
  bridge.kill();
  await sleep(400);
  fs.rmSync(path.join(SESSIONS, "--zz-ui-probe--"), { recursive: true, force: true });
}
