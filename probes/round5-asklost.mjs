/**
 * Probe: Q-010 — a questionnaire that dies mid-answer must not eat what was filled in.
 *
 * The real chain (pi aborts the tool call → the child's fetch dies → the bridge cancels the ask) is
 * hard to stage from outside, so this probe stands in for the bridge: it serves `web/dist`, speaks
 * just enough of the ws protocol to put a two-question questionnaire on screen, then cancels it the
 * same way `bridge/src/sessions.ts` does (`ask.remove` with status/reason).
 *
 * Checks: the panel closes with a visible reason (not silently), the filled answers survive, they
 * can be dropped into the composer, and they come back after a reload (localStorage).
 *
 * Run: node probes/round5-asklost.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7896;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round5-asklost/shots";
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
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
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const SESSION = { id: "probe-sess", name: "问卷探针", cwd: "F:/pi-web-client", file: null, owned: false, origin: "disk", running: true, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "问两个问题" };
const ASK = {
  id: "ask_probe1",
  sessionId: SESSION.id,
  sessionName: SESSION.name,
  createdAt: Date.now(),
  questions: [
    { id: "q1", label: "Q1", prompt: "先确认一下：这次改动要动 bridge 吗？", options: [{ value: "yes", label: "要动" }, { value: "no", label: "不动" }], allowOther: true },
    { id: "q2", label: "Q2", prompt: "第二题：截图要不要一起给你？", options: [{ value: "yes", label: "要" }, { value: "no", label: "不要" }], allowOther: true },
  ],
};

const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
let sock = null;
const send = (msg) => sock?.readyState === 1 && sock.send(JSON.stringify(msg));

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" }));
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const file = path.join(DIST, rel);
  if (!path.resolve(file).startsWith(path.resolve(DIST)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  sock = ws;
  ws.on("close", () => {
    if (sock === ws) sock = null;
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    log("client →", msg.type);
    if (msg.type === "subscribe") {
      ws.send(
        JSON.stringify({
          type: "session",
          sessionId: SESSION.id,
          state: { ...SESSION, asks: 1 },
          items: [{ kind: "user", id: "u1", text: "帮我把问卷答了。" }],
          approvals: [],
          asks: [ASK],
          budget: null,
        }),
      );
    }
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      me: { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" },
      sessions: [SESSION],
      manage: { pin: [], order: [], archived: [] },
      trash: [],
      tunnel: TUNNEL,
    }),
  );
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 5).join(" | ")));
  page.on("console", (m) => log("console:", m.type(), m.text().slice(0, 160)));
  page.on("requestfailed", (r) => log("request failed:", r.url(), r.failure()?.errorText));
  page.on("response", (r) => {
    if (r.status() >= 400) log("http", r.status(), r.url());
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  const slot = page.locator(".ask-slot:not(.ask-lost)");
  await until(async () => slot.isVisible(), 8000, "ask panel");
  log("ask panel up:", (await slot.innerText()).split("\n")[0]);

  // Answer the first question, then the second: both land in askDrafts.
  await slot.locator(".ask-opt").first().click();
  await until(async () => (await slot.innerText()).includes("第二题"), 4000, "second question tab");
  await slot.locator(".ask-opt").nth(1).click();
  await sleep(200);
  const before = await page.evaluate(() => localStorage.getItem("pi.askDrafts"));
  assert(before && before.includes("ask_probe1"), "answers are persisted as they are picked");
  await page.screenshot({ path: path.join(OUT, "1-answered.png") });

  // The tool call dies exactly like an aborted fetch: ask.remove, status cancelled.
  send({ type: "ask.remove", sessionId: SESSION.id, id: ASK.id, status: "cancelled", reason: "发起方断开了" });
  const lost = page.locator(".ask-lost");
  await until(async () => lost.isVisible(), 4000, "ask-lost banner");
  const text = await lost.innerText();
  assert(text.includes("发起方断开了"), `the reason is on screen (got ${JSON.stringify(text)})`);
  assert(text.includes("2 题"), `it says how much is kept (got ${JSON.stringify(text)})`);
  await page.screenshot({ path: path.join(OUT, "2-lost.png") });
  log("banner:", text.replace(/\s+/g, " ").slice(0, 90));

  // The answers must be retrievable, not just announced.
  await lost.getByRole("button", { name: /放进输入框/ }).click();
  const composer = await page.locator("textarea").first().inputValue();
  assert(composer.includes("这次改动要动 bridge 吗") && composer.includes("要动"), `answers land in the composer (got ${JSON.stringify(composer)})`);
  assert(composer.includes("第二题"), "both answers are there");
  await page.screenshot({ path: path.join(OUT, "3-composer.png") });
  log("composer got", composer.split("\n").length, "lines");

  // A reload keeps the drafts (they are in localStorage, the ask id is the key).
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "card after reload");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".ask-slot:not(.ask-lost)").count()) === 1, 8000, "ask panel again");
  const marks = await page.locator(".ask-slot:not(.ask-lost) .ask-tab.on, .ask-slot:not(.ask-lost) .ask-opt.on").count();
  const tabs = await page.locator(".ask-slot:not(.ask-lost)").innerText();
  assert(tabs.includes("2 题") || /✓/.test(tabs) || marks > 0, `the same questionnaire shows the filled answers again (got ${JSON.stringify(tabs.slice(0, 120))})`);
  log("after reload the panel remembers:", marks, "marked option(s)");

  console.log("ALL OK");
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  wss.close();
  server.close();
}
