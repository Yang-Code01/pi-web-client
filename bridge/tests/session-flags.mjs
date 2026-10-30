/**
 * Probe: sidebar order is fixed by creation time, and the card corner flags 完成 / 待确认 (D44).
 *
 * Needs the real pi CLI + configured model (it sends one tiny prompt).
 * Run: node bridge/tests/session-flags.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const PORT = 7875;
const ROOT = path.join("F:/pi-web-client/.scratch", "session-flags");
const STATE = path.join(ROOT, "state");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = "F:/pi-web-client";

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: "F:/pi-web-client",
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0" },
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
    await sleep(300);
  }
  console.error(bridgeOut.join("").slice(-2000));
  assert(false, `timeout waiting for ${label}`);
}

const files = [];
let browser;
let ws;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 15000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();

  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const list = async () => (await (await fetch(`${BASE}/api/sessions`, { headers: { cookie } })).json()).sessions;

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const states = [];
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.type === "session.state") states.push(msg.session);
    if (msg.type === "notice" && msg.level !== "info") log("notice:", msg.text);
  });
  await new Promise((r) => ws.on("open", r));

  const create = (name) =>
    new Promise((resolve, reject) => {
      const onMsg = (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.type === "session" && msg.state?.name === name) {
          ws.off("message", onMsg);
          files.push(msg.state.file);
          resolve(msg.sessionId);
        }
        if (msg.type === "error") {
          ws.off("message", onMsg);
          reject(new Error(msg.message));
        }
      };
      ws.on("message", onMsg);
      ws.send(JSON.stringify({ type: "create", cwd: CWD, name }));
      setTimeout(() => reject(new Error(`create ${name} timeout`)), 60000);
    });

  // The older session first, then the newer one: creation order is what the sidebar must keep.
  const a = await create("顺序 A");
  await sleep(1100);
  const b = await create("顺序 B");
  log("created A/B", a.slice(0, 8), b.slice(0, 8));

  let rows = await list();
  let ia = rows.findIndex((s) => s.id === a);
  let ib = rows.findIndex((s) => s.id === b);
  assert(ib >= 0 && ia >= 0, "both sessions are listed");
  assert(ib < ia, `newer session first (got B@${ib} A@${ia})`);
  assert(rows[ia].startedAt && rows[ib].startedAt, "both carry a creation time");
  assert(rows[ia].done === false && rows[ib].done === false, "nothing flagged as finished yet");
  log("order by creation time:", rows[ib].name, "→", rows[ia].name);

  // One real turn on A, the older card: it must finish *below* B and get the 完成 flag.
  const doneA = new Promise((resolve) => {
    const t = setInterval(() => {
      const s = states.find((x) => x.id === a && x.done === true);
      if (s) {
        clearInterval(t);
        resolve(s);
      }
    }, 250);
    setTimeout(() => {
      clearInterval(t);
      resolve(null);
    }, 180000);
  });
  ws.send(JSON.stringify({ type: "prompt", sessionId: a, text: "只回复两个字：收到" }));
  const finished = await doneA;
  assert(finished, "turn on A finished and set done=true");
  log("A finished, done=true");

  rows = await list();
  ia = rows.findIndex((s) => s.id === a);
  ib = rows.findIndex((s) => s.id === b);
  assert(ib < ia, `order stayed fixed after A answered (got B@${ib} A@${ia})`);
  assert(rows[ia].updatedAt > rows[ib].updatedAt, "A is the more recently updated session, yet stays below");
  log("order unchanged; A.updatedAt is newer, position is not");

  // The browser card: bottom-right 完成, cleared when the card is opened.
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 }, deviceScaleFactor: 2 });
  await page.goto(BASE);
  await page.fill(".login input", pass);
  await page.click(".login .btn");
  const cardA = page.locator(`.session-card:has-text("顺序 A")`).first();
  await cardA.waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  const flag = await cardA.locator(".meta .badge").innerText();
  assert(flag === "完成", `card corner shows 完成 (got ${JSON.stringify(flag)})`);
  const before = await cardA.locator(".meta").innerText();
  await page.screenshot({ path: path.join(OUT, "1-done.png") });
  await cardA.screenshot({ path: path.join(OUT, "2-card-done.png") });
  log("card corner:", before.replace(/\n/g, " | "));

  await cardA.click();
  await page.waitForTimeout(1200);
  const left = await page.locator(`.session-card:has-text("顺序 A")`).first().locator(".meta").innerText();
  assert(!left.includes("完成"), `opening the card cleared 完成 (got ${JSON.stringify(left)})`);
  log("opened the card, 完成 cleared");

  const fresh = await list();
  for (const id of [a, b]) files.push(fresh.find((s) => s.id === id)?.file);
  assert(fresh.find((s) => s.id === a).done === false, "bridge cleared done for everyone, not just this page");
  log("ALL OK — shots in", OUT);
} finally {
  await browser?.close();
  try {
    ws?.close();
  } catch {}
  bridge.kill();
  await sleep(500);
  for (const f of files) {
    if (f) fs.rmSync(f, { force: true });
  }
  fs.rmSync(path.join(ROOT, "state"), { recursive: true, force: true });
}
