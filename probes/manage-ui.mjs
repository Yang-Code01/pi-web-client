/**
 * Probe: the session-management UI (D46) — pin, drag, multi-select archive/delete, filter.
 *
 * Runs a throwaway bridge on its own port with a temp agent dir, so it never touches
 * the real ~/.pi/agent sessions.
 *
 * Run: node probes/manage-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const PORT = 7877;
const ROOT = "F:/pi-web-client/.scratch/manage-ui";
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = "F:/pi-web-client";

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Four sessions; 甲 is the newest. Files and names must both show up in the sidebar. */
const names = ["甲", "乙", "丙", "丁", "戊"];
const files = {};
for (const [i, name] of names.entries()) {
  const id = `zz-manage-ui-${i}`;
  const dir = path.join(SESSIONS, `--${id}--`);
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - (i + 1) * 3600_000).toISOString();
  const rows = [
    { type: "session", version: 3, id, timestamp: at, cwd: CWD },
    { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: `${name}的工作` }] } },
    { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name },
  ];
  files[name] = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(files[name], rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.utimesSync(files[name], new Date(), new Date(at));
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

const manage = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE, "manage.json"), "utf8"));
  } catch {
    return { pin: [], order: [], archived: [] };
  }
};

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
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });

  const card = (name) => page.locator(".session-card", { has: page.locator(`.name:text-is("${name}")`) });
  const sectionNames = async (sec) => page.$$eval(`.session-sec[data-sec="${sec}"] .session-card .name`, (els) => els.map((e) => e.textContent));
  const waitCards = (min = 4) => until(async () => (await page.locator(".session-card").count()) >= min, 10000, `${min} cards`);

  await waitCards(5);
  let order = await sectionNames("rest");
  assert(order.join() === names.join(), `newest first (got ${order.join()})`);
  log("initial order:", order.join(" → "));

  // 1. ☆ turns into 置顶.
  await card("丙").hover();
  await card("丙").locator(".pin-btn").click();
  await until(async () => (await sectionNames("pin")).includes("丙"), 5000, "丙 pinned");
  assert(manage().pin[0] === "zz-manage-ui-2", "pin persisted");
  assert((await sectionNames("rest")).join() === "甲,乙,丁,戊", `rest without 丙 (got ${(await sectionNames("rest")).join()})`);
  await page.screenshot({ path: path.join(OUT, "1-pinned.png") });
  log("pinned 丙");

  // 2. Drag 戊 onto the lower half of 乙.
  await page.dragAndDrop(`.session-card[data-id="zz-manage-ui-4"]`, `.session-card[data-id="zz-manage-ui-1"]`, {
    targetPosition: { x: 40, y: 60 },
  });
  await until(async () => (await sectionNames("rest")).join() === "甲,乙,戊,丁", 5000, "drag reorder");
  assert(manage().order.join() === "zz-manage-ui-0,zz-manage-ui-1,zz-manage-ui-4,zz-manage-ui-3", "order persisted");
  await page.screenshot({ path: path.join(OUT, "2-dragged.png") });
  log("dragged 戊 after 乙");

  // 3. Manage mode: pick two, archive them, expand, restore one.
  await page.locator(".manage-bar .tool-btn").click();
  assert((await page.locator(".manage-bar .tool-btn").textContent()) === "完成", "button reads 完成 in manage mode");
  await card("甲").click();
  await card("丁").click();
  await page.locator(".manage-actions .what").textContent().then((t) => assert(t.includes("选 2 个"), `picked count says ${t}`));
  await page.screenshot({ path: path.join(OUT, "3-managing.png") });
  await page.locator(".manage-actions .btn", { hasText: /^归档$/ }).click();
  await until(async () => (await sectionNames("rest")).join() === "乙,戊", 5000, "archived two");
  assert(manage().archived.length === 2, "archive persisted");
  assert((await page.locator('.session-sec[data-sec="archived"] .sess-head .n').textContent()) === "2", "archived count shows 2");
  await page.locator('.session-sec[data-sec="archived"] .sess-head .label').click();
  await until(async () => (await sectionNames("archived")).length === 2, 5000, "archived expanded");
  await page.screenshot({ path: path.join(OUT, "4-archived.png") });
  await card("甲").click();
  await page.locator(".manage-actions .btn", { hasText: /^恢复$/ }).click();
  await until(async () => (await sectionNames("rest")).includes("甲"), 5000, "甲 restored");
  log("archive / restore ok");

  // 4. Delete is two-step and really removes the file.
  await card("戊").click();
  const del = page.locator(".manage-actions .btn.danger");
  await del.click();
  assert((await del.textContent()) === "再点一次删除", "first click only arms the delete");
  assert(fs.existsSync(files["戊"]), "file still there after the first click");
  await del.click();
  await until(async () => !(await sectionNames("rest")).includes("戊"), 5000, "戊 deleted");
  assert(!fs.existsSync(files["戊"]), "session file deleted");
  assert(!manage().order.includes("zz-manage-ui-4"), "manage entry cleaned up");
  await page.screenshot({ path: path.join(OUT, "5-deleted.png") });
  log("two-step delete ok");

  // 5. Filter narrows the list, and cards are not draggable while filtering.
  await page.locator(".manage-bar .tool-btn").click(); // leave manage mode
  await page.locator(".session-filter").fill("乙");
  await until(async () => (await sectionNames("rest")).join() === "乙", 5000, "filter");
  assert((await page.locator(".session-card[draggable='true']").count()) === 0, "no drag while filtered");
  await page.locator(".session-filter").fill("");
  await waitCards(4);
  await page.screenshot({ path: path.join(OUT, "6-final.png") });
  log("filter ok");

  console.log("ALL OK");
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
}
