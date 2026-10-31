/**
 * Probe: Q-017 — the hover card over the activity line must carry what the run already gave us:
 * the tool, its args, the output streaming in, and the thinking tail. No protocol change, only
 * local state (chat.liveInfo()).
 *
 * Stands in for the bridge so it can drive a tool call event-by-event at a chosen moment.
 *
 * Run: node probes/round11-liveinfo.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7908;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round11-liveinfo/shots";
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
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const SESSION = { id: "probe-live", name: "悬停探针", cwd: "F:/pi-web-client", file: null, owned: false, origin: "disk", running: true, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "跑测试" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const ITEMS = [
  { kind: "user", id: "u1", ts: Date.now() - 30_000, text: "跑一下测试，看看改完还绿不绿。" },
  { kind: "assistant", id: "a1", ts: Date.now() - 20_000, model: "pi", text: "" },
];

let sock = null;
const send = (msg) => sock?.readyState === 1 && sock.send(JSON.stringify(msg));

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ME));
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
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: SESSION.id, state: SESSION, items: ITEMS, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SESSION], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 4).join(" | ")));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".hint-status.busy").count()) >= 1, 8000, "busy hint");

  // The run in progress: thinking first, then a tool that keeps printing.
  send({ type: "delta", sessionId: SESSION.id, id: "a1", field: "thinking", text: "先把测试脚本读一遍，确认没有环境依赖，再跑 npm test。" });
  send({ type: "tool", sessionId: SESSION.id, phase: "start", toolCallId: "t1", name: "bash", args: { command: "npm test -- --reporter=dot", cwd: "F:/pi-web-client" }, summary: "cd F:/pi-web-client && npm test" });
  const lines = [
    "> pi-web-client@0.1.0 test",
    "> node bridge/tests/e2e.mjs",
    "· bridge up on 7867",
    "· session created",
    "· message round-trip",
    "· artifacts listed",
    "· reload keeps state",
    "PASS 6 checks",
  ];
  for (const [i, line] of lines.entries()) {
    send({ type: "tool", sessionId: SESSION.id, phase: "update", toolCallId: "t1", partial: `${lines.slice(0, i + 1).join("\n")}\n` });
    await sleep(40);
  }
  await sleep(300);

  const hint = page.locator(".hint-status.busy").first();
  const pop = page.locator(".act-pop").first();
  // Q-029: the hover target is the label itself, not the whole status row.
  const label = hint.locator(".act-text");
  await label.hover();
  await until(async () => pop.isVisible(), 4000, "hover card");
  const text = await pop.innerText();
  log("hover card:", text.replace(/\s+/g, " ").slice(0, 200));

  assert(text.includes("工具"), "shows the tool row");
  assert(text.includes("bash"), "names the tool");
  assert(text.includes("参数"), "shows the args row");
  assert(text.includes("npm test"), "the command is there");
  assert(text.includes("输出"), "shows the output row");
  assert(text.includes("PASS 6 checks"), "the latest output line is there");
  assert(text.includes("思考"), "shows the thinking row");
  assert(text.includes("确认没有环境依赖"), "the thinking tail is there");
  assert(/\d+秒/.test(text), "keeps the running clock");
  await page.screenshot({ path: path.join(OUT, "1-hover.png") });

  // Q-024: the line itself only names the tool. The command (and its cwd) live in the hover card,
  // which this probe just proved carries them — so pasting them into the line is pure noise.
  const line = (await hint.locator(".act-text").innerText()).trim();
  assert(line === "正在执行 bash", `the busy line names the tool only (got ${JSON.stringify(line)})`);
  assert(!line.includes("npm test") && !line.includes("F:/pi-web-client"), `no command in the line (got ${JSON.stringify(line)})`);
  log("busy line:", line);

  // Q-024 moved the step counter into the tool branch: two starts of the same tool must still count
  // as two steps, even though their line text is now identical.
  send({ type: "tool", sessionId: SESSION.id, phase: "start", toolCallId: "t2", name: "bash", args: { command: "git status" }, summary: "git status --short" });
  await until(async () => (await pop.innerText()).includes("第 2 次工具调用"), 5000, "step counter counts same-tool calls");
  log("step counter: 第 2 次 ✓");

  // The card is a hover card, not a new panel: the composer line itself stays one line tall.
  const lineH = await hint.boundingBox();
  assert(lineH.height < 40, `the activity line stays compact (${Math.round(lineH.height)}px)`);

  // Q-029: it opens the moment the pointer arrives; leaving inside three seconds closes it again;
  // staying past three seconds makes it sticky, and from then on only a click outside (or Escape)
  // takes it down.
  await page.keyboard.press("Escape");
  await sleep(250);
  assert(!(await pop.isVisible()), "Escape closes the card");

  await page.mouse.move(5, 400);
  await sleep(150);
  await label.hover();
  await sleep(60);
  assert(await pop.isVisible(), "the card opens the moment the pointer arrives");
  log("opens at once ✓");
  await sleep(500);
  await page.mouse.move(80, 320);
  await sleep(500);
  assert(!(await pop.isVisible()), "leaving inside the 3 seconds closes it again");
  log("an early leave closes it ✓");

  // …and the rest of the row is not a trigger: it spans the composer's width, so binding it made
  // the card pop up whenever the pointer crossed the bottom of the chat area.
  const rowBox = await hint.boundingBox();
  await page.mouse.move(rowBox.x + rowBox.width - 8, rowBox.y + rowBox.height / 2);
  await sleep(400);
  assert(!(await pop.isVisible()), "hovering the empty end of the row does not open it");
  log("empty row space stays quiet ✓");

  await label.hover();
  await sleep(60);
  assert(await pop.isVisible(), "the card opens again on the next hover");
  await sleep(3400);
  await page.mouse.move(80, 320);
  await sleep(500);
  assert(await pop.isVisible(), "after 3 seconds it stays when the pointer leaves");
  await page.screenshot({ path: path.join(OUT, "2-sticky-card.png") });
  log("sticky after the 3s rest ✓");

  // The card is clickable now (pointer-events: auto), so a click inside must not count as "outside".
  const popBox = await pop.boundingBox();
  await page.mouse.click(popBox.x + popBox.width / 2, popBox.y + 24);
  await sleep(250);
  assert(await pop.isVisible(), "a click inside the card keeps it open");
  log("click inside keeps it ✓");

  const chatBox = await page.locator(".chat-scroll").boundingBox();
  await page.mouse.click(chatBox.x + chatBox.width / 2, chatBox.y + 60);
  await sleep(350);
  assert(!(await pop.isVisible()), "a click outside closes it");
  log("click outside closes it ✓");

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
