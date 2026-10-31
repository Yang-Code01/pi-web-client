/**
 * Probe: Q-012 — delete parks the session in a bin instead of destroying it.
 * Also covers Q-002's last gap: a collapsed group stays collapsed after a reload.
 *
 * Drives the real UI against a throwaway bridge: delete from the manager, look in the bin,
 * restore, delete again, empty the bin and check the payloads are really gone from disk.
 *
 * Run: node probes/round2-bin.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const PORT = 7893;
const ROOT = "F:/pi-web-client/.scratch/round2-bin";
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

const files = new Map();
for (const [i, name] of ["甲", "乙", "丙"].entries()) {
  const id = `zz-bin-${i}`;
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
  files.set(id, file);
}
const binOf = (id) => path.join(STATE, "trash", `${id}.jsonl`);

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

  const openManager = async () => {
    await page.getByRole("button", { name: "管理", exact: true }).click();
    await until(async () => (await page.locator(".mgr-row").count()) >= 1, 8000, "manager rows");
  };
  const binButton = page.locator(".mgr-bin");
  const goBin = async () => {
    await binButton.click();
    await sleep(250);
  };

  // ---------------------------------------------------------------- delete parks, does not burn
  await openManager();
  assert((await binButton.innerText()).includes("垃圾箱"), "the manager has a bin button");
  const [firstId, firstFile] = [...files.entries()][0];
  const row = page.locator(".mgr-row").first();
  const del = row.locator(".card-act.del");
  assert((await del.getAttribute("title"))?.includes("垃圾箱"), `delete tooltip mentions the bin (got ${await del.getAttribute("title")})`);
  await del.click();
  await del.click();
  await until(async () => fs.existsSync(binOf(firstId)), 8000, "payload in the bin");
  assert(!fs.existsSync(firstFile), "the file left the sessions dir");
  const index = JSON.parse(fs.readFileSync(path.join(STATE, "trash.json"), "utf8")).items;
  assert(index.some((it) => it.id === firstId && it.file === firstFile && it.size > 0), `bin index remembers the origin (${JSON.stringify(index)})`);
  await until(async () => (await binButton.innerText()).includes("(1)"), 8000, "bin count in the button");
  log("delete moved the file to the bin:", path.basename(binOf(firstId)));

  // ---------------------------------------------------------------- the bin lists it
  await goBin();
  assert((await page.locator(".sheet-title").first().innerText()) === "垃圾箱", "the sheet switched to the bin");
  assert((await page.locator(".trash-row").count()) === 1, "one row in the bin");
  const sub = await page.locator(".trash-row .mgr-sub").first().innerText();
  assert(/删除于/.test(sub) && sub.length > 6, `the row says when it was deleted (got ${JSON.stringify(sub)})`);
  assert((await page.locator(".trash-head").innerText()).includes("占"), "the bin shows its footprint");
  await page.screenshot({ path: path.join(OUT, "1-bin.png") });
  log("bin row:", sub.replace(/\n/g, " | "));

  // ---------------------------------------------------------------- restore puts it back
  await page.locator(".trash-row .btn", { hasText: "还原" }).first().click();
  await until(async () => fs.existsSync(firstFile), 8000, "file restored");
  assert(!fs.existsSync(binOf(firstId)), "payload left the bin");
  await until(async () => (await page.locator(".trash-row").count()) === 0, 8000, "bin row gone");
  assert((await page.locator(".mgr-body .empty").first().innerText()).includes("垃圾箱是空的"), "empty bin says so");
  await goBin();
  await until(async () => (await page.locator(".mgr-row").count()) >= 3, 8000, "session back in the list");
  assert((await binButton.innerText()).includes("(0)") === false, "bin count cleared");
  log("restore brought the session back");

  // ---------------------------------------------------------------- empty the bin for real
  const secondId = [...files.keys()][1];
  const secondFile = files.get(secondId);
  const rows = page.locator(".mgr-row");
  await rows.nth(1).locator(".card-act.del").click();
  await rows.nth(1).locator(".card-act.del").click();
  await until(async () => fs.existsSync(binOf(secondId)), 8000, "second payload in the bin");
  await goBin();
  // One-click empty lives in the bin header now, not the footer.
  const empty = page.locator(".trash-head .btn", { hasText: "一键清空" });
  assert(await empty.isVisible(), "the bin header has a one-click empty button");
  await empty.click();
  // The label changes once armed, so the next click has to find the armed button, not the old text.
  const armedEmpty = page.locator(".trash-head .btn.danger.armed");
  await until(async () => (await armedEmpty.count()) === 1, 5000, "the empty button armed itself");
  assert((await armedEmpty.innerText()).includes("再点一次"), "emptying asks once more");
  await armedEmpty.click();
  await until(async () => !fs.existsSync(binOf(secondId)), 8000, "payload destroyed");
  assert(!fs.existsSync(secondFile), "the destroyed payload did not come back");
  assert(JSON.parse(fs.readFileSync(path.join(STATE, "trash.json"), "utf8")).items.length === 0, "bin index emptied");
  assert((await page.locator(".mgr-body .empty").first().innerText()).includes("垃圾箱是空的"), "bin back to empty");
  await page.screenshot({ path: path.join(OUT, "2-empty.png") });
  log("empty bin destroyed the payloads");

  // ------------------------------------------- Q-002: a collapsed group survives a reload
  await goBin(); // back to the list half of the sheet
  const groupField = page.locator(".mgr-field", { hasText: "分组" }).locator("select");
  await groupField.selectOption("cwd");
  await until(async () => (await page.locator(".mgr-group-head").count()) >= 1, 5000, "grouped rows");
  const groupHead = page.locator(".mgr-group-head").first();
  const groupLabel = await groupHead.locator(".label").innerText();
  await groupHead.click();
  await until(async () => (await page.locator(".mgr-group-head.collapsed").count()) === 1, 5000, "group collapsed");
  const stored = await page.evaluate(() => localStorage.getItem("pi.mgrCollapsed"));
  assert(stored && JSON.parse(stored).length === 1, `collapsed groups are stored (got ${stored})`);
  await page.reload({ waitUntil: "networkidle" });
  // Grouped + collapsed means there are no .mgr-row to wait for, only group heads.
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await until(async () => (await page.locator(".mgr-group-head").count()) >= 1, 8000, "groups after reload");
  assert((await page.locator(".mgr-group-head.collapsed").count()) === 1, "the group is still collapsed after a reload");
  assert((await page.locator(".mgr-group-head.collapsed .label").first().innerText()) === groupLabel, "it is the same group");
  log("collapsed group survived a reload:", groupLabel);

  console.log("ALL OK");
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
}
