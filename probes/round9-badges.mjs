/**
 * Probe: Q-015 — the pin strip must not call an approval-waiting session 运行中.
 *
 * A fake bridge serves `web/dist` and speaks just enough of the ws protocol to show one session;
 * nothing here needs pi to be running.
 *
 * Q-015: five pinned sessions in five different states, left pane collapsed — the strip has to say
 * 待回答 / 待确认 / 终端占用 / 运行中 / 完成, and the header has to count the two that block on the user.
 *
 * Run: node probes/round6-keys.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const wsMod = await import(pathToFileURL(wsWrapper()).href);
const { WebSocketServer } = wsMod;

const PORT = Number(process.env.PI_WEB_PORT ?? 7903);
const OUT = path.join(REPO, ".scratch/round9-badges/shots");
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
const base = { cwd: REPO, file: null, owned: false, origin: "disk", updatedAt: Date.now() - 60_000, preview: "" };
const SESSIONS = [
  { ...base, id: "s-ask", name: "等答题", running: true, done: false, approvals: 0, asks: 2, locked: false },
  { ...base, id: "s-approve", name: "等确认", running: true, done: false, approvals: 1, asks: 0, locked: false },
  { ...base, id: "s-lock", name: "终端占用", running: false, done: false, approvals: 0, asks: 0, locked: true },
  { ...base, id: "s-run", name: "真在跑", running: true, done: false, approvals: 0, asks: 0, locked: false },
  { ...base, id: "s-done", name: "已完成", running: false, done: true, approvals: 0, asks: 0, locked: false },
  { ...base, id: "s-idle", name: "空闲", running: false, done: false, approvals: 0, asks: 0, locked: false },
  // D450：评审在跑的三组组合 —— 它只压过「完成」与空位，压不过会话自己 / 后台子代理。
  { ...base, id: "s-review", name: "评审在跑", running: false, done: true, approvals: 0, asks: 0, locked: false, review: 1 },
  { ...base, id: "s-review2", name: "两条评审", running: false, done: true, approvals: 0, asks: 0, locked: false, review: 2 },
  { ...base, id: "s-run-review", name: "跑中带评审", running: true, done: false, approvals: 0, asks: 0, locked: false, review: 1 },
  { ...base, id: "s-bg-review", name: "后台带评审", running: false, done: false, approvals: 0, asks: 0, locked: false, bg: { n: 1, since: Date.now() - 60_000 }, review: 1 },
];
const SESSION = SESSIONS[0];
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
      // D450：按点开的那个会话回帧 —— 全都回 s-ask 的话，切到别的会话会「又到了一份问卷」，
      // 右栏被 ask-tab 的逻辑拽回「需要你」，就量不到「评审中」把右栏切到代码评审页签。
      const s = SESSIONS.find((x) => x.id === msg.sessionId) ?? SESSION;
      ws.send(
        JSON.stringify({
          type: "session",
          sessionId: s.id,
          state: s,
          items: [{ kind: "user", id: "u1", text: "帮我把问卷答了。" }],
          approvals: [],
          asks: s.id === SESSION.id ? [ASK] : [],
          budget: null,
        }),
      );
    }
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      me: { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" },
      sessions: SESSIONS,
      manage: { pin: SESSIONS.map((s) => s.id), order: [], archived: [] },
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
  const context = await browser.newContext({ viewport: { width: 1560, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 5).join(" | ")));
  page.on("console", (m) => log("console:", m.type(), m.text().slice(0, 160)));
  page.on("requestfailed", (r) => log("request failed:", r.url(), r.failure()?.errorText));
  page.on("response", (r) => {
    if (r.status() >= 400) log("http", r.status(), r.url());
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  // Collapse the left pane so the strip appears.
  await page.locator('[data-act="sessions"]').click();
  const strip = page.locator(".pin-strip");
  await until(async () => (await strip.isVisible()), 5000, "pin strip visible");

  // Q-015 的「条头要数出两个待处理」在 #97 之后没有那颗字了（`heading: () => ""`），
  // 改数量本身：两颗带 warn 色的胶囊 = 两个在等你。
  const blocked = await strip.locator(".pin-chip.wait").count();
  assert(blocked === 2, `two sessions block on the user (got ${blocked})`);
  log("pending chips:", blocked);

  const chips = strip.locator(".pin-chip:not(.pin-new)");
  await until(async () => (await chips.count()) === SESSIONS.length, 5000, "one chip per session");
  const rows = await chips.evaluateAll((nodes) =>
    nodes.map((n) => ({
      name: n.querySelector(".pin-name")?.textContent?.trim(),
      small: n.querySelector("small")?.textContent?.trim(),
      cls: n.className.replace("pin-chip", "").trim(),
    })),
  );
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert(byName["等答题"].small === "待回答 2", `ask chip (got ${JSON.stringify(byName["等答题"])})`);
  assert(byName["等答题"].cls.includes("wait"), `ask chip is warn-tinted (got ${byName["等答题"].cls})`);
  assert(byName["等确认"].small === "待确认", `approval chip (got ${JSON.stringify(byName["等确认"])})`);
  assert(byName["终端占用"].small === "终端占用", `locked chip (got ${JSON.stringify(byName["终端占用"])})`);
  assert(byName["终端占用"].cls.includes("lock"), `locked chip has its own class (got ${byName["终端占用"].cls})`);
  assert(byName["真在跑"].small === "运行中", `running chip (got ${JSON.stringify(byName["真在跑"])})`);
  assert(byName["已完成"].small === "完成", `done chip (got ${JSON.stringify(byName["已完成"])})`);
  assert(!/运行中|待回答|待确认|完成|终端占用|评审中/.test(byName["空闲"].small), `idle chip shows a time, not a state (got ${byName["空闲"].small})`);
  // D450：评审自己跑的时候不能还说「完成」。
  assert(byName["评审在跑"].small === "评审中", `review chip (got ${JSON.stringify(byName["评审在跑"])})`);
  assert(byName["评审在跑"].cls.includes("reviewing"), `review chip has its own colour (got ${byName["评审在跑"].cls})`);
  assert(byName["两条评审"].small === "评审中 2", `two runs say how many (got ${JSON.stringify(byName["两条评审"])})`);
  assert(byName["跑中带评审"].small === "运行中", `session running wins over review (got ${JSON.stringify(byName["跑中带评审"])})`);
  assert(byName["后台带评审"].small === "后台", `background subagent still leads (got ${JSON.stringify(byName["后台带评审"])})`);
  log("chips:", rows.map((r) => `${r.name}=${r.small}`).join(" | "));
  await page.screenshot({ path: path.join(OUT, "1-strip.png") });

  // D450：「评审中」可点 —— 切到那个会话 + 右栏切到「代码评审」页签，且只切一次。
  const reviewSub = strip.locator(".pin-chip", { hasText: "评审在跑" }).locator("small");
  assert(await reviewSub.getAttribute("role") === "button", "review badge is a click target");
  assert(await reviewSub.getAttribute("tabindex") === "0", "review badge is keyboard reachable");
  await reviewSub.click();
  await until(async () => page.url().includes("#/s/s-review"), 5000, "switched to the reviewing session");
  const reviewTab = page.locator('[data-exec-tab="review"]');
  await until(async () => (await reviewTab.getAttribute("class") ?? "").split(" ").includes("on"), 5000, "right pane on the code review tab");
  const curChip = strip.locator(".pin-chip.cur .pin-name");
  assert((await curChip.innerText()).trim() === "评审在跑", `exactly one session stayed selected (got ${await curChip.innerText()})`);
  await page.screenshot({ path: path.join(OUT, "2-review-jump.png") });
  log("review badge click →", page.url(), "tab:", await reviewTab.getAttribute("class"));

  // 键盘同一套：Enter 也要能去（与左栏卡片那枚同一个手势）。
  const otherSub = strip.locator(".pin-chip", { hasText: "两条评审" }).locator("small");
  await otherSub.focus();
  await otherSub.press("Enter");
  await until(async () => page.url().includes("#/s/s-review2"), 5000, "Enter on the review badge switches session");
  await until(async () => (await reviewTab.getAttribute("class") ?? "").split(" ").includes("on"), 5000, "Enter also lands on the code review tab");
  log("review badge Enter →", page.url());

  log("ALL OK");
} finally {
  await browser.close();
  server.close();
  wss.close();
}
