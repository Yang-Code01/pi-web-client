/**
 * Probe: does swiping up during streaming survive the stream? (D68)
 *
 * Reproduces the reported "scroll competition": send a message, the reply streams in, swipe up to
 * read history — and the view keeps getting yanked back down. Runs a stub bridge (no pi, no model),
 * streams `delta` events into the last assistant message, drives a real touch swipe through CDP, then
 * samples scrollTop for a second afterwards.
 *
 * Pass = the viewport stays where the finger left it (and does not creep back to the bottom).
 *
 * Run: npm run build:web && node probes/scroll-race.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "web/dist");
const PORT = 7895;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a transcript long enough to scroll, with one assistant message left open for the stream ------
const N = 14;
const items = [];
for (let i = 0; i < N; i += 1) {
  items.push({
    id: `u${i}`,
    kind: "user",
    text: `第 ${i + 1} 轮：把 bridge 里的审批超时再核对一遍，顺便看一眼 D${14 + i} 那条决定还成不成立。`,
    images: [],
    ts: new Date(Date.now() - (N - i) * 60_000).toISOString(),
  });
  items.push({
    id: `a${i}`,
    kind: "assistant",
    text:
      `第 ${i + 1} 轮的结论：\n\n` +
      "审批超时是 `5 * 60 * 1000`，只出现在 `bridge/ext/approval-gate.ts`；前端读的是 bridge 下发的 `deadline`，" +
      "所以放宽它不需要改前端。顺带核对了一下：`sessions.ts` 里 ask 的超时是另一条线，超时后走 `cancelAsk`。\n\n" +
      "至于那条决定，结论是仍然成立，但理由要补一句：现在还有终端会话只读这条约束。",
    thinking: "",
    model: "stub",
    ts: new Date(Date.now() - (N - i) * 59_000).toISOString(),
  });
}
const streamId = `a${N - 1}`;
const strippedItems = items.map(({ id, kind, text, thinking, model, ts, images }) => ({ id, kind, text, thinking, model, ts, images }));

const state = {
  id: "stub-scroll",
  name: "滚动竞争复现",
  cwd: REPO,
  file: null,
  owned: true,
  origin: "web",
  running: true,
  done: false,
  model: "stub",
  modelName: "stub",
  thinkingLevel: "medium",
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
  items: strippedItems,
};
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: REPO };
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (url.pathname === "/api/login") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") return json(200, ME);
  if (url.pathname === "/api/git") return json(200, { repo: null });
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const file = path.join(DIST, rel);
  if (!path.resolve(file).startsWith(path.resolve(DIST)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const { WebSocketServer } = await import(pathToFileURL(path.join(REPO, "bridge/node_modules/ws/wrapper.mjs")).href);
const wss = new WebSocketServer({ noServer: true });
const sockets = new Set();
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "subscribe") {
        ws.send(JSON.stringify({ type: "session", sessionId: state.id, state, items: strippedItems, approvals: [], asks: [], budget: null }));
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [(({ items: _i, ...rest }) => rest)(state)], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
  });
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// --- drive it ------------------------------------------------------------------------------------
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, locale: "zh-CN" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', "probe");
  await page.click('button:has-text("进入")');
}
await page.waitForSelector(".session-card", { timeout: 15000 });
await page.locator(".session-card").first().click();
await sleep(1200);

const geom = () =>
  page.evaluate(() => {
    const root = document.querySelector(".chat-scroll");
    return {
      top: Math.round(root.scrollTop),
      height: Math.round(root.scrollHeight),
      client: Math.round(root.clientHeight),
      gap: Math.round(root.scrollHeight - root.scrollTop - root.clientHeight),
      jumpHidden: document.querySelector(".chat-jump")?.hidden ?? null,
      hasNew: document.querySelector(".chat-jump")?.classList.contains("has-new") ?? null,
    };
  });

console.log("start:", JSON.stringify(await geom()));

// Start streaming into the last assistant message.
const stream = setInterval(() => {
  const chunk = `流式输出的又一行：这条消息还在长，内容每 80ms 追加一次，用来触发 follow 的自动滚动。\n`;
  for (const ws of sockets) ws.send(JSON.stringify({ type: "delta", sessionId: state.id, id: streamId, field: "text", text: chunk }));
}, 80);

const cdp = await ctx.newCDPSession(page);

/**
 * Finger down at y0, dragged down in `moves` steps of `step` px (a phone scrolling up into history).
 * The interesting number is `stopAt`: with the follow state machine working, the very first few pixels
 * of drag already flip following off, so the gap starts growing immediately. While it is broken the
 * stream keeps pinning the view to the bottom and the gap stays near zero for most of the gesture.
 */
async function swipe(step, moves) {
  await page.evaluate(() => document.querySelector(".chat-jump")?.click()); // back to the bottom, following on
  await sleep(400);
  const before = await geom();
  const x = 195;
  let y = 420;
  const gaps = [];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 0; i < moves; i += 1) {
    y += step;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await sleep(16);
    gaps.push((await geom()).gap);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const after = await geom();
  const trail = [];
  for (let i = 0; i < 8; i += 1) {
    await sleep(120);
    trail.push(await geom());
  }
  const stopAt = gaps.findIndex((g) => g > 100);
  return { before, after, trail, stopAt, gaps: gaps.filter((_, i) => i % 8 === 0) };
}

const result = {};
for (const [label, step, moves] of [["fast", 18, 12], ["slow", 4, 40]]) {
  const r = await swipe(step, moves);
  const last = r.trail[r.trail.length - 1];
  const pinnedTail = r.trail.filter((g) => g.gap <= 2).length;
  const held = last.gap >= r.after.gap && pinnedTail === 0;
  // "Prompt" is measured in finger travel, not in samples: the point is that a drag costing a few
  // dozen pixels is enough to break the follow, not that it happens within N frames.
  const stopAfterPx = r.stopAt < 0 ? Infinity : r.stopAt * step;
  const prompt = stopAfterPx <= 80;
  result[label] = held && prompt;
  console.log(
    `${label.padEnd(4)} swipe (${step}px × ${moves}): gap trajectory ${JSON.stringify(r.gaps)}` +
      `  stop after ${stopAfterPx}px, ended gap=${last.gap} pinnedTail=${pinnedTail}/8 → ${held && prompt ? "PASS" : "FAIL"}`,
  );
}
// D94: desktop wheel. A touchpad / high-res mouse moves a few px per event and Chrome's smooth scroll
// animates a notch over several frames, so the first `scroll` events still read gap ≤ 24 — which used
// to reopen the follow and let the next delta snap the view back ("上下抖动"). Pass = once the view has
// left the bottom it never comes back to it during the gesture or the second after.
async function wheelSteps(label, run) {
  await page.evaluate(() => document.querySelector(".chat-jump")?.click());
  await sleep(400);
  const gaps = await run();
  for (let i = 0; i < 8; i += 1) {
    await sleep(120);
    gaps.push((await geom()).gap);
  }
  const left = gaps.findIndex((g) => g > 0);
  const snaps = left < 0 ? gaps.length : gaps.slice(left).filter((g) => g <= 2).length;
  const ok = left >= 0 && snaps === 0;
  result[label] = ok;
  console.log(`${label.padEnd(12)}: gaps ${JSON.stringify(gaps)} snap-backs=${snaps} → ${ok ? "PASS" : "FAIL"}`);
}
await wheelSteps("wheel-tiny", async () => {
  await page.mouse.move(195, 420);
  const gaps = [];
  for (let i = 0; i < 20; i += 1) {
    await page.mouse.wheel(0, -4);
    await sleep(16);
    gaps.push((await geom()).gap);
  }
  return gaps;
});
// Headless Chrome does not animate wheel scrolls, so play the animation the way Chrome does: one wheel
// event, then the viewport stepping up a few px per frame.
// Whether a delta lands inside those 4 frames is luck, so play it three times.
for (const n of [1, 2, 3]) await wheelSteps(`wheel-smooth${n}`, () =>
  page.evaluate(async () => {
    const root = document.querySelector(".chat-scroll");
    root.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }));
    const gaps = [];
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => requestAnimationFrame(r));
      root.scrollTop -= 5;
      gaps.push(Math.round(root.scrollHeight - root.scrollTop - root.clientHeight));
    }
    return gaps;
  }),
);
await sleep(400); // let the wheel's follow hold expire before the back-to-bottom check

// Getting back to the bottom must hand control back to the stream — the fix must not leave the
// transcript permanently unfollowed. Using scrollTop (what a wheel / keyboard / a settled drag all end
// up dispatching) instead of another synthetic drag: headless Chrome coalesces rapid touchMoves, so a
// scripted drag measures the coalescer rather than the app.
//
// Text keeps arriving between animation frames, so one gap reading can be tens of px even when
// following perfectly. Judge by "still pinned over a second" instead of a single sample.
{
  await page.evaluate(() => {
    const root = document.querySelector(".chat-scroll");
    root.scrollTop = root.scrollHeight;
  });
  const gaps = [];
  for (let i = 0; i < 6; i += 1) {
    await sleep(160);
    gaps.push((await geom()).gap);
  }
  const back = await geom();
  const worst = Math.max(...gaps);
  const ok = back.jumpHidden === true && worst < 200;
  result.back = ok;
  console.log(`back to bottom: jumpHidden=${back.jumpHidden} gaps=${JSON.stringify(gaps)} → ${ok ? "PASS" : "FAIL"}`);
}

clearInterval(stream);

await browser.close();
await new Promise((r) => server.close(r));
const passed = Object.values(result).every(Boolean);
console.log(passed ? "PASS: every swipe held" : "FAIL: 内容把视口拽回去了");
process.exitCode = passed ? 0 : 1;
