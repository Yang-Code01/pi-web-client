/**
 * Probe: #315 — the composer grows with its content, capped by half the chat pane.
 *
 * Stands in for the bridge (serves `web/dist`, speaks enough ws to open one session) and drives a
 * real Chromium: the height of a textarea can only be checked in a browser, and the cap depends on
 * the measured height of `section.pane.chat-pane` (never on `.chat-scroll`, which the growing
 * composer itself shrinks).
 *
 * Checks: one line when empty, every line visible up to twenty (no step at some row count), the cap
 * is `min(520, chatPane.clientHeight / 2)`, deleting lines shrinks at once, sending clears back to
 * one line, and a shorter window recomputes the cap without a reload.
 *
 * #316 adds the narrow and zoomed viewports: at 390×720 (effective width < 900) the cap is 40% of the
 * pane, so messages stay visible; going wide again restores the half-pane cap without a reload; at a
 * 1.25 UI scale the cap is still measured in layout px, i.e. the rendered box is the cap zoomed once.
 *
 * #317 adds the top fade: an overflowing box fades its top 24px only while the draft sits part way
 * down its own scroll range — no fade at either end, where “the bottom” includes the resting spot a
 * maxed draft is typed at (caret on the last line, the box's bottom inset still below the fold) —
 * never below the cap, and a wheel inside the box scrolls the box without moving the transcript.
 *
 * #318 adds the paste fold: a 30-line paste arrives folded, expanding it splits the composer's cap
 * in half (the fold takes the other half), the fold scrolls inside itself past its half, a real
 * corner drag stops at that half, collapsing gives the composer the whole cap back, and the narrow
 * layout still leaves the composer a line.
 *
 * #319 adds the transcript's side of the growth: a box that grows under a following transcript keeps
 * the last message wholly inside the band, a box that grows while the user reads history leaves the
 * message at the top of the band where it was, shrinking back to one line keeps the hold on the
 * bottom without moving a mid-transcript reading position, and a stream in flight keeps following
 * across the growth.
 *
 * Run: node probes/composer-grow.mjs   (needs `npm run build:web` first)
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7931);
const OUT = path.join(REPO, ".scratch/composer-grow/shots");
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
// #318: owned, so the composer carries no disk-preview takeover bar (55px) — that bar is a
// property of this probe's fixture, and the transcript-band check below must measure the product,
// not the fixture.
const SESSION = { id: "probe-grow", name: "输入框探针", cwd: REPO, file: null, owned: true, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "量输入框高度" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const HISTORY = [
  { kind: "user", id: "u1", ts: Date.now() - 120_000, text: "先随便聊两句，让对话区有内容。" },
  { kind: "assistant", id: "a1", ts: Date.now() - 60_000, model: "pi", text: "好。" },
  // #317: the wheel check needs a transcript long enough to overflow `.chat-scroll` by itself — a
  // conversation that cannot scroll could never prove that the box does not scroll it.
  ...Array.from({ length: 8 }, (_, i) => [
    { kind: "user", id: `u${i + 2}`, ts: Date.now() - 50_000 + i * 2, text: `第 ${i + 2} 轮：把对话区填到能滚动为止。` },
    {
      kind: "assistant",
      id: `a${i + 2}`,
      ts: Date.now() - 49_000 + i * 2,
      model: "pi",
      text: "收到。这一行够长，能占住对话区的一席之地，让框内滚动与对话区滚动彼此分得开。",
    },
  ]).flat(),
];

let sock = null;
/** What the page sent as a prompt — the send key must not leave the draft behind. */
const prompts = [];
const send = (msg) => (sock?.readyState === 1 ? sock.send(JSON.stringify(msg)) : false);
/** #319: a reply that keeps arriving while the box grows — the only way to judge "following". */
let streaming = false;
const startStream = (everyMs) => {
  streaming = true;
  const tick = () => {
    if (!streaming) return;
    send({ type: "delta", sessionId: SESSION.id, id: "a1", field: "text", text: `正在写第 ${Math.random().toString(36).slice(2, 8)} 个字。\n` });
    setTimeout(tick, everyMs);
  };
  tick();
};
const stopStream = () => {
  streaming = false;
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(ME));
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
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: SESSION.id, state: SESSION, items: [...HISTORY], approvals: [], asks: [], budget: null }));
    }
    if (msg.type === "prompt") {
      prompts.push(msg);
      // A real bridge answers with `ack`: without it the page still clears the draft, but the
      // send path leaves a pending row behind; ack keeps the pane in its normal resting state.
      ws.send(JSON.stringify({ type: "ack", sessionId: SESSION.id, clientId: msg.clientId }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SESSION], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const lines = (n) => Array.from({ length: n }, (_, i) => `第 ${i + 1} 行文字`).join("\n");

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1200, height: 1100 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") log("console error:", m.text().slice(0, 160));
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();

  const field = page.locator(".composer textarea");
  await until(async () => (await field.count()) === 1, 8000, "composer textarea");

  /** Everything the assertions need, measured from the live page. */
  const metrics = () =>
    page.evaluate(() => {
      const t = document.querySelector(".composer textarea");
      const pane = document.querySelector(".chat-pane");
      const cs = getComputedStyle(t);
      return {
        height: t.getBoundingClientRect().height,
        clientHeight: t.clientHeight,
        scrollHeight: t.scrollHeight,
        paneHeight: pane.clientHeight,
        padding: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
        border: parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth),
        maxHeight: cs.maxHeight,
        value: t.value,
      };
    });

  /**
   * One text line's box height, measured off a detached div with the textarea's own font. This is
   * the expected-value source: the probe must not recompute what `fitComposer()` does.
   */
  const lineBox = () =>
    page.evaluate(() => {
      const t = document.querySelector(".composer textarea");
      const cs = getComputedStyle(t);
      const probe = document.createElement("div");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.whiteSpace = "pre";
      probe.style.fontFamily = cs.fontFamily;
      probe.style.fontSize = cs.fontSize;
      probe.style.fontWeight = cs.fontWeight;
      probe.style.letterSpacing = cs.letterSpacing;
      probe.style.lineHeight = cs.lineHeight;
      probe.textContent = "x";
      document.body.append(probe);
      const h = probe.getBoundingClientRect().height;
      probe.remove();
      return h;
    });

  const lh = await lineBox();
  const chrome = await metrics();
  log("line box", lh.toFixed(2), "padding", chrome.padding, "border", chrome.border, "pane", chrome.paneHeight);

  /** Height a composer holding `n` lines should have (border-box), capped by the pane formula. */
  const expectedHeight = (n, paneHeight, share = 0.5) => {
    const natural = Math.max(44, n * lh + chrome.padding + chrome.border);
    const cap = Math.min(520, paneHeight * share);
    return { natural, cap, want: Math.min(natural, cap) };
  };

  /**
   * Layout-px sizes plus what the conversation shows. `#app` carries `zoom: var(--ui-scale)` (#316):
   * `offsetHeight` / `clientHeight` are layout px, `getBoundingClientRect()` is visual px, so both
   * sides of the cap can be checked against each other.
   */
  const layoutMetrics = () =>
    page.evaluate(() => {
      const t = document.querySelector(".composer textarea");
      const pane = document.querySelector(".chat-pane");
      const scroll = document.querySelector(".chat-scroll");
      const sr = scroll.getBoundingClientRect();
      const msgs = [...scroll.querySelectorAll(".msg")].map((m) => m.getBoundingClientRect());
      return {
        box: t.offsetHeight,
        visual: t.getBoundingClientRect().height,
        paneHeight: pane.clientHeight,
        scrollBox: scroll.clientHeight,
        visibleMessages: msgs.filter((r) => r.height > 0 && r.bottom > sr.top + 1 && r.top < sr.bottom - 1).length,
        scale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1,
        compact: document.documentElement.dataset.compact === "true",
      };
    });

  // 1. Empty: one line, nothing scrolling inside the box, and no second cap left in the stylesheet.
  //    “One line” is the textarea's own line box plus its padding and border — 44px is only the CSS
  //    min-height, which the real line box here (15px font) exceeds.
  const oneLine = Math.max(44, lh + chrome.padding + chrome.border);
  const empty = await metrics();
  assert(empty.value === "", "the composer starts empty");
  assert(Math.abs(empty.height - oneLine) <= 2, `empty composer is one line tall (${empty.height.toFixed(1)}px, want ${oneLine.toFixed(1)})`);
  assert(empty.height < oneLine + lh - 2, `and not the browser's two-row default (${empty.height.toFixed(1)}px)`);
  assert(empty.scrollHeight - empty.clientHeight <= 1, `empty composer does not scroll (${empty.scrollHeight} vs ${empty.clientHeight})`);
  assert(empty.maxHeight === "none", `the stylesheet no longer caps the composer (computed max-height ${empty.maxHeight})`);
  await page.screenshot({ path: path.join(OUT, "1-empty.png") });
  log("empty", empty.height.toFixed(1), "px");

  // 2. One to twenty lines: the box is exactly as tall as the text, with no flat stop part way.
  const sizes = [1, 3, 8, 20];
  const heights = {};
  for (const n of sizes) {
    await field.fill(lines(n));
    await sleep(60);
    const m = await metrics();
    const want = expectedHeight(n, m.paneHeight);
    heights[n] = m.height;
    assert(
      Math.abs(m.height - want.want) <= 2,
      `${n} line(s): height ${m.height.toFixed(1)}px, want ${want.want.toFixed(1)} (natural ${want.natural.toFixed(1)}, cap ${want.cap.toFixed(1)})`,
    );
    if (want.natural <= want.cap) {
      assert(m.scrollHeight - m.clientHeight <= 1, `${n} line(s) all visible, no inner scrollbar (${m.scrollHeight} vs ${m.clientHeight})`);
    }
    log(`${n} line(s)`, m.height.toFixed(1), "px (cap", want.cap.toFixed(1), ")");
  }
  assert(heights[1] < heights[3] && heights[3] < heights[8], `height follows the content (${sizes.map((n) => heights[n].toFixed(1)).join(" < ")})`);
  await page.screenshot({ path: path.join(OUT, "2-twenty-lines.png") });

  // 3. Deleting lines shrinks right away (no animation to wait out).
  await field.fill(lines(10));
  await sleep(60);
  const ten = await metrics();
  await field.fill(lines(3));
  await sleep(60);
  const three = await metrics();
  const want3 = expectedHeight(3, three.paneHeight);
  assert(three.height < ten.height - 20, `deleting lines shrinks the box (${ten.height.toFixed(1)} → ${three.height.toFixed(1)})`);
  assert(Math.abs(three.height - want3.want) <= 2, `shrunk to 3 lines (${three.height.toFixed(1)}px, want ${want3.want.toFixed(1)})`);
  await page.screenshot({ path: path.join(OUT, "3-shrunk.png") });

  // 4. Sending clears back to a single line.
  await field.fill("这一行会被发出去");
  await sleep(60);
  await field.press("Enter");
  await until(async () => prompts.length >= 1, 4000, "prompt on the wire");
  assert(prompts[0].text === "这一行会被发出去", `the prompt went out intact (${JSON.stringify(prompts[0].text)})`);
  await until(async () => (await page.evaluate(() => document.querySelector(".composer textarea")?.value ?? "?")) === "", 4000, "cleared draft");
  const cleared = await metrics();
  assert(Math.abs(cleared.height - oneLine) <= 2, `clearing after send returns to one line (${cleared.height.toFixed(1)}px, want ${oneLine.toFixed(1)})`);
  log("cleared", cleared.height.toFixed(1), "px");

  // 5. Cap: a tall window, then a short one. The cap has to follow the pane, not a constant.
  await field.fill(lines(40));
  await sleep(80);
  const tall = await metrics();
  const tallWant = expectedHeight(40, tall.paneHeight);
  assert(tallWant.natural > tallWant.cap, `the probe needs a cap that really bites (natural ${tallWant.natural.toFixed(1)} > cap ${tallWant.cap.toFixed(1)})`);
  assert(Math.abs(tall.height - tallWant.cap) <= 2, `past the cap the box stops at ${tallWant.cap.toFixed(1)}px (got ${tall.height.toFixed(1)})`);
  assert(tall.scrollHeight - tall.clientHeight > 20, `and the overflow scrolls inside the box (${tall.scrollHeight} vs ${tall.clientHeight})`);
  await page.screenshot({ path: path.join(OUT, "4-at-cap.png") });

  await page.setViewportSize({ width: 1200, height: 620 });
  await sleep(400);
  const short = await metrics();
  const shortWant = expectedHeight(40, short.paneHeight);
  assert(short.paneHeight < tall.paneHeight - 100, `the window really got shorter (pane ${tall.paneHeight} → ${short.paneHeight})`);
  assert(
    Math.abs(short.height - shortWant.cap) <= 2,
    `the cap follows the shorter pane (${short.height.toFixed(1)}px, want ${shortWant.cap.toFixed(1)} from pane ${short.paneHeight})`,
  );
  assert(short.height < tall.height - 20, `the box got shorter with the window (${tall.height.toFixed(1)} → ${short.height.toFixed(1)})`);
  await page.screenshot({ path: path.join(OUT, "5-short-window.png") });

  await page.setViewportSize({ width: 1200, height: 1100 });
  await sleep(400);
  const back = await metrics();
  assert(Math.abs(back.height - tall.height) <= 2, `growing the window back restores the cap (${back.height.toFixed(1)} vs ${tall.height.toFixed(1)})`);
  log("cap follows the pane:", tallWant.cap.toFixed(1), "→", shortWant.cap.toFixed(1), "→", back.height.toFixed(1));

  // 6. #316 narrow: effective width < 900 → the cap is 40% of the pane, so the conversation above
  //    still shows. Effective width is `innerWidth / uiScale` (D158), which jsdom cannot judge.
  await page.setViewportSize({ width: 390, height: 720 });
  await sleep(400);
  const narrow = await layoutMetrics();
  assert(narrow.compact, `390×720 is the narrow layout (data-compact ${narrow.compact})`);
  const narrowWant = expectedHeight(40, narrow.paneHeight, 0.4);
  assert(
    narrowWant.natural > narrowWant.cap,
    `narrow: the cap really bites (natural ${narrowWant.natural.toFixed(1)} > cap ${narrowWant.cap.toFixed(1)})`,
  );
  assert(
    Math.abs(narrow.box - narrowWant.cap) <= 2,
    `narrow caps at 40% of the pane (${narrow.box}px, want ${narrowWant.cap.toFixed(1)} from pane ${narrow.paneHeight})`,
  );
  assert(narrow.box < narrow.paneHeight * 0.5, `and that is tighter than the wide half-pane cap (${narrow.box} vs ${(narrow.paneHeight * 0.5).toFixed(1)})`);
  assert(narrow.scrollBox >= 150, `the conversation keeps a visible band under the cap (${narrow.scrollBox} of ${narrow.paneHeight})`);
  assert(narrow.visibleMessages >= 2, `messages stay visible above the composer (${narrow.visibleMessages})`);
  await page.screenshot({ path: path.join(OUT, "6-narrow.png") });
  log("narrow", `${narrow.box}px cap`, "scroll", narrow.scrollBox, "visible msgs", narrow.visibleMessages);

  // 7. Wide again with the same 40-line draft: the formula switches on the spot, no stale 40% value.
  await page.setViewportSize({ width: 1200, height: 1100 });
  await sleep(400);
  const wideBack = await layoutMetrics();
  assert(!wideBack.compact, `back to wide (data-compact ${wideBack.compact})`);
  const wideBackWant = expectedHeight(40, wideBack.paneHeight);
  assert(wideBackWant.natural > wideBackWant.cap, `wide again: the cap really bites (natural ${wideBackWant.natural.toFixed(1)})`);
  assert(
    Math.abs(wideBack.box - wideBackWant.cap) <= 2,
    `crossing back to wide swaps in the half-pane cap at once (${wideBack.box}px, want ${wideBackWant.cap.toFixed(1)} from pane ${wideBack.paneHeight})`,
  );
  assert(wideBack.box > narrow.box + 20, `and the box grew back (${narrow.box} → ${wideBack.box})`);
  await page.screenshot({ path: path.join(OUT, "7-wide-again.png") });
  log("wide again", `${wideBack.box}px cap`);

  // 8. #316 zoom: the settings slider persists `scale` in `pi.prefs`, so write it there and reload —
  //    the real entry point, not a hand-set CSS variable. The cap must stay in layout px: the
  //    rendered box is `cap × 1.25`, not `cap × 1.25²`.
  await page.evaluate(() => {
    let prefs = {};
    try {
      prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    } catch {
      prefs = {};
    }
    localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, scale: 1.25 }));
  });
  await page.reload({ waitUntil: "networkidle" });
  if ((await field.count()) === 0) {
    await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card after reload");
    await page.locator(".session-card").first().click();
  }
  await until(async () => (await field.count()) === 1, 8000, "composer after reload");
  await field.fill(lines(40));
  await sleep(120);
  const zoomed = await layoutMetrics();
  assert(Math.abs(zoomed.scale - 1.25) < 0.001, `the UI scale really is 1.25 (${zoomed.scale})`);
  assert(!zoomed.compact, `1200px at 1.25 is still wide (effective ${(1200 / zoomed.scale).toFixed(0)})`);
  const zoomCap = Math.min(520, zoomed.paneHeight * 0.5);
  assert(
    Math.abs(zoomed.box - zoomCap) <= 2,
    `at 1.25 the cap is still layout px (${zoomed.box}px, want ${zoomCap.toFixed(1)} from pane ${zoomed.paneHeight})`,
  );
  assert(
    Math.abs(zoomed.visual - zoomCap * 1.25) <= 3,
    `rendered height is that cap zoomed once (${zoomed.visual.toFixed(1)}px, want ${(zoomCap * 1.25).toFixed(1)})`,
  );
  assert(
    zoomed.visual < zoomCap * 1.25 * 1.25 - 10,
    `not zoomed twice (${zoomed.visual.toFixed(1)}px, a double zoom would be ${(zoomCap * 1.25 * 1.25).toFixed(1)})`,
  );
  await page.screenshot({ path: path.join(OUT, "8-zoom-125.png") });
  log("zoom 1.25", `${zoomed.box}px layout cap`, `${zoomed.visual.toFixed(1)}px rendered`);

  // 9. #317 top fade. Runs at scale 1 again so the fade is judged unzoomed.
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, scale: 1 }));
  });
  await page.reload({ waitUntil: "networkidle" });
  if ((await field.count()) === 0) {
    await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card after reload");
    await page.locator(".session-card").first().click();
  }
  await until(async () => (await field.count()) === 1, 8000, "composer after the second reload");
  assert(Math.abs((await layoutMetrics()).scale - 1) < 0.001, `the fade is checked at scale 1 (${(await layoutMetrics()).scale})`);

  /**
   * What the fade looks like from outside: the box's own scroll position, the mask the browser
   * computes for it, who owns a click in the top band, and where the transcript sits. The mask is
   * the only observable of “the text fades here” — there is no painted layer to measure.
   */
  const fadeState = () =>
    page.evaluate(() => {
      const t = document.querySelector(".composer textarea");
      const cs = getComputedStyle(t);
      const mask = cs.maskImage && cs.maskImage !== "none" ? cs.maskImage : cs.webkitMaskImage;
      const r = t.getBoundingClientRect();
      // 5px in from the top: inside the 24px fade band, clear of the 1px border.
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 5);
      const chat = document.querySelector(".chat-scroll");
      return {
        scrollTop: t.scrollTop,
        overflow: t.scrollHeight - t.clientHeight,
        // What "the bottom" means in CSS px here: the part of the box a caret line needs below it.
        inset: parseFloat(cs.paddingBottom) + (t.offsetHeight - t.clientHeight),
        mask: mask || "none",
        transition: cs.transitionDuration,
        pointerEvents: cs.pointerEvents,
        hitIsTextarea: hit === t,
        hit: hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : "none",
        chatTop: chat.scrollTop,
        chatOverflow: chat.scrollHeight - chat.clientHeight,
        box: { left: r.left, top: r.top, width: r.width, height: r.height },
      };
    });
  const scrollBoxTo = async (where) => {
    await page.evaluate((where) => {
      const t = document.querySelector(".composer textarea");
      t.scrollTop = where === "bottom" ? t.scrollHeight : where;
    }, where);
    await sleep(200);
  };

  await field.fill(lines(40));
  await sleep(150);
  const capped = await fadeState();
  assert(capped.overflow > 20, `#317 needs a box that really overflows (${capped.overflow}px hidden)`);
  // Where a maxed draft rests while it is being written: the caret is on the last line, so the box
  // has scrolled — but only far enough to show that line, which leaves its own bottom padding below
  // the fold. That is the reading position, and it must not fade: nothing is hidden above the text
  // that matters there.
  assert(capped.scrollTop > 40, `the draft is scrolled down, lines hidden above (scrollTop ${capped.scrollTop} of ${capped.overflow})`);
  assert(capped.inset > 8, `the box has a bottom inset to measure (${capped.inset}px of padding + border)`);
  const restGap = capped.overflow - capped.scrollTop;
  assert(
    restGap <= capped.inset + 1,
    `typing leaves the box resting at its bottom: ${restGap}px left to scroll vs a ${capped.inset}px inset`,
  );
  assert(capped.mask === "none", `at the resting position nothing fades (mask ${capped.mask})`);
  await page.screenshot({ path: path.join(OUT, "10-no-fade.png") });
  log("caret on the last line (resting at the bottom): no fade", `scrollTop ${capped.scrollTop}/${capped.overflow}, ${restGap}px left vs ${capped.inset}px inset`);

  // 1. Scrolling up from the reading position: 24px at the top fade out, and nothing is painted to
  // fade them. A wheel inside the box belongs to the box: the transcript must not scroll along.
  assert(capped.chatOverflow > 60, `the transcript can scroll on its own (${capped.chatOverflow}px)`);
  const beforeWheel = capped;
  await page.mouse.move(beforeWheel.box.left + beforeWheel.box.width / 2, beforeWheel.box.top + beforeWheel.box.height / 2);
  await page.mouse.wheel(0, -90);
  await sleep(250);
  const faded = await fadeState();
  assert(faded.scrollTop < beforeWheel.scrollTop - 20, `the wheel scrolls the box itself (${beforeWheel.scrollTop} → ${faded.scrollTop})`);
  assert(
    Math.abs(faded.chatTop - beforeWheel.chatTop) <= 1,
    `and the transcript stayed put (chat scrollTop ${beforeWheel.chatTop} → ${faded.chatTop})`,
  );
  assert(
    faded.scrollTop > 0 && faded.overflow - faded.scrollTop > faded.inset + 1,
    `the box is now above its bottom (scrollTop ${faded.scrollTop} of ${faded.overflow}, inset ${faded.inset})`,
  );
  assert(/gradient/.test(faded.mask), `scrolled up into the draft: the top fades (mask ${faded.mask})`);
  assert(/24px/.test(faded.mask), `the fade is 24px tall (mask ${faded.mask})`);
  const maskColours = [...faded.mask.matchAll(/rgba?\([^)]*\)/g)].map((m) => m[0]);
  assert(
    maskColours.length > 0 && maskColours.every((c) => /^rgba?\(0, 0, 0(, 0)?\)$/.test(c)),
    `the fade is pure alpha — no colour of its own to clash with the theme (${maskColours.join(" ")})`,
  );
  assert(!/[1-9]/.test(faded.transition), `no transition on the fade, so nothing to suppress under reduced motion (${faded.transition})`);
  assert(faded.pointerEvents === "auto", `the box still takes pointer events (${faded.pointerEvents})`);
  assert(faded.hitIsTextarea, `a click in the fade band lands on the textarea itself, not on a layer (${faded.hit})`);
  await page.screenshot({ path: path.join(OUT, "9-fade-top.png") });
  log("wheel up in the box: faded top confirmed", faded.mask, `chat ${beforeWheel.chatTop} → ${faded.chatTop}`);

  // 2. Back at the first line nothing is hidden above the fold, so the fade goes away there too.
  await scrollBoxTo(0);
  const atTop = await fadeState();
  assert(atTop.scrollTop === 0, `the box is back at its first line (scrollTop ${atTop.scrollTop})`);
  assert(atTop.mask === "none", `nothing is above the fold: no fade (mask ${atTop.mask})`);
  log("first line: no fade");

  // 3. And at the true end of the scroll range, still nothing: both ends read clean.
  await scrollBoxTo("bottom");
  const atBottom = await fadeState();
  assert(atBottom.scrollTop >= atBottom.overflow - 1, `the box is at the end of its range (scrollTop ${atBottom.scrollTop} of ${atBottom.overflow})`);
  assert(atBottom.mask === "none", `at the end of the range: still no fade (mask ${atBottom.mask})`);
  log("scrolled to the very bottom: no fade");

  // Below the cap nothing is above the fold, so the fade never shows — even pinned to the end.
  await field.fill(lines(20));
  await sleep(150);
  await scrollBoxTo("bottom");
  const underCap = await fadeState();
  assert(underCap.overflow <= 1, `20 lines stay under the cap (overflow ${underCap.overflow}px)`);
  assert(underCap.mask === "none", `under the cap there is no fade (mask ${underCap.mask})`);
  log("20 lines, under the cap: no fade");

  // 10. #318. A long paste folds into its own block; while that block is open the composer and the
  //     fold split the same cap in half, so the transcript keeps its share of the pane. The fold
  //     scrolls inside itself past its half, and a real drag of its corner stops at that half.
  /** Layout px of the composer, the fold and the transcript, plus the fold's own scroll state. */
  const budget = () =>
    page.evaluate(() => {
      const pane = document.querySelector(".chat-pane");
      const input = document.querySelector(".composer-input > textarea");
      const scroll = document.querySelector(".chat-scroll");
      const body = document.querySelector(".paste-body");
      const cs = body ? getComputedStyle(body) : null;
      const r = body ? body.getBoundingClientRect() : null;
      return {
        paneHeight: pane.clientHeight,
        inputBox: input.offsetHeight,
        scrollBox: scroll.clientHeight,
        visibleMsgs: (() => {
          const view = scroll.getBoundingClientRect();
          return [...scroll.querySelectorAll(".msg")].filter((m) => {
            const r = m.getBoundingClientRect();
            return r.height > 0 && r.top >= view.top - 1 && r.bottom <= view.bottom + 1;
          }).length;
        })(),
        compact: document.documentElement.dataset.compact === "true",
        folds: document.querySelectorAll(".paste-block").length,
        openFolds: document.querySelectorAll(".paste-block.open").length,
        body: body
          ? {
              box: body.offsetHeight,
              scrollHeight: body.scrollHeight,
              clientHeight: body.clientHeight,
              maxHeight: cs.maxHeight === "none" ? null : parseFloat(cs.maxHeight),
              overflowY: cs.overflowY,
              resize: cs.resize,
              rect: { left: r.left, top: r.top, width: r.width, height: r.height },
            }
          : null,
      };
    });

  await field.fill("");
  await sleep(80);
  assert((await budget()).folds === 0, "no paste fold before the paste");

  const pasteText = Array.from({ length: 30 }, (_, i) => `粘贴的第 ${i + 1} 行，这一行够长，让块里装不下全部内容`).join("\n");
  await page.evaluate((text) => {
    const t = document.querySelector(".composer-input > textarea");
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, pasteText);
  await until(async () => (await page.locator(".paste-block").count()) === 1, 4000, "paste fold");
  const folded = await budget();
  assert(folded.openFolds === 0, `a 30-line paste starts folded (${folded.openFolds} open)`);
  assert(folded.body === null, "a folded paste has no editor");

  // A folded paste must cost the composer nothing: the whole cap is still its own.
  const mainField = page.locator(".composer-input > textarea");
  await mainField.fill(lines(40));
  await sleep(100);
  const withFold = await budget();
  assert(!withFold.compact, `the wide half-cap checks run wide (compact ${withFold.compact})`);
  const fullCap = Math.min(520, withFold.paneHeight * 0.5);
  assert(
    Math.abs(withFold.inputBox - fullCap) <= 2,
    `a folded paste leaves the composer its whole cap (${withFold.inputBox}px, want ${fullCap.toFixed(1)})`,
  );
  log("folded paste, composer at the whole cap", withFold.inputBox, "px");

  await page.locator(".paste-toggle").first().click();
  await until(async () => (await page.locator(".paste-body").count()) === 1, 4000, "paste editor");
  await sleep(150);
  const opened = await budget();
  const halfCap = fullCap / 2;
  assert(
    Math.abs(opened.inputBox - halfCap) <= 2,
    `with the fold open the composer keeps half the cap (${opened.inputBox}px, want ${halfCap.toFixed(1)})`,
  );
  assert(
    opened.body.maxHeight !== null && Math.abs(opened.body.maxHeight - halfCap) <= 1,
    `the fold's cap is the other half (max-height ${opened.body.maxHeight}, want ${halfCap.toFixed(1)})`,
  );
  assert(opened.body.resize === "vertical", `the fold can still be dragged by hand (resize ${opened.body.resize})`);
  assert(opened.body.box <= halfCap + 1, `the fold is no taller than its half (${opened.body.box}px <= ${halfCap.toFixed(1)})`);
  assert(
    opened.body.scrollHeight > opened.body.clientHeight + 20,
    `30 lines overflow the fold and scroll inside it (${opened.body.scrollHeight} vs ${opened.body.clientHeight})`,
  );
  assert(opened.body.overflowY === "auto", `and the overflow is its own scrollbar (overflow-y ${opened.body.overflowY})`);
  log("fold open", `composer ${opened.inputBox}px, fold ${opened.body.box}px of ${opened.body.scrollHeight}px`);

  // A real drag of the native corner: it must stop at the half, not at the pointer's 260px below.
  const grip = {
    x: opened.body.rect.left + opened.body.rect.width - 7,
    y: opened.body.rect.top + opened.body.rect.height - 7,
  };
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x, grip.y + 260, { steps: 12 });
  await sleep(120);
  await page.mouse.up();
  await sleep(250);
  const dragged = await budget();
  assert(
    dragged.body.box >= halfCap - 2,
    `the drag really moved the fold — it reached its half (${dragged.body.box}px vs ${halfCap.toFixed(1)})`,
  );
  assert(dragged.body.box <= halfCap + 1, `a drag past the half stops at it (${dragged.body.box}px <= ${halfCap.toFixed(1)})`);
  assert(
    Math.abs(dragged.body.maxHeight - halfCap) <= 1,
    `the browser clamps against the inline cap (max-height ${dragged.body.maxHeight})`,
  );
  assert(dragged.body.scrollHeight > dragged.body.clientHeight + 20, "the taller fold still scrolls inside itself");

  // Both boxes at their halves: the transcript still owns the rest of the pane. The composer's own
  // fixed chrome (hint 53 + padding 24 + grid gap 16) sits outside the split, so the transcript is
  // `pane − two halves − chrome`, not a fixed share of the pane: what matters is that it keeps a
  // real band of conversation, so assert the band and whole messages, not a pixel ratio.
  const both = await budget();
  log(
    "both at half",
    `composer ${both.inputBox}px, fold ${both.body.box}px, chat ${both.scrollBox}px of ${both.paneHeight}`,
    `(${((both.scrollBox / both.paneHeight) * 100).toFixed(1)}%), ${both.visibleMsgs} whole messages`,
  );
  assert(both.scrollBox >= 300, `both open still leaves the transcript a 300px band (${both.scrollBox}px)`);
  assert(both.visibleMsgs >= 2, `and whole messages stay readable (${both.visibleMsgs})`);
  await page.screenshot({ path: path.join(OUT, "11-paste-expanded.png") });

  // Collapsing gives the composer the whole cap back — the split only exists while a fold is open.
  await page.locator(".paste-toggle").first().click();
  await sleep(200);
  const collapsed = await budget();
  assert(collapsed.body === null, "collapsing removes the fold editor");
  assert(
    Math.abs(collapsed.inputBox - fullCap) <= 2,
    `closing the fold gives the composer the whole cap back (${collapsed.inputBox}px, want ${fullCap.toFixed(1)})`,
  );
  log("fold closed", "composer back at", collapsed.inputBox, "px");

  // Narrow: the same split, and it must not squeeze the composer below one line.
  await page.setViewportSize({ width: 390, height: 720 });
  await sleep(400);
  await page.locator(".paste-toggle").first().click();
  await until(async () => (await page.locator(".paste-body").count()) === 1, 4000, "paste editor on narrow");
  await sleep(200);
  const narrowFold = await budget();
  assert(narrowFold.compact, `390×720 is the narrow layout (${narrowFold.compact})`);
  const narrowHalf = Math.min(520, narrowFold.paneHeight * 0.4) / 2;
  assert(
    Math.abs(narrowFold.inputBox - narrowHalf) <= 2,
    `narrow: the composer takes half of the 40% cap (${narrowFold.inputBox}px, want ${narrowHalf.toFixed(1)} from pane ${narrowFold.paneHeight})`,
  );
  assert(
    narrowFold.inputBox >= oneLine - 1,
    `narrow: the composer still fits a line (${narrowFold.inputBox}px vs one line ${oneLine.toFixed(1)})`,
  );
  assert(narrowFold.body.box <= narrowHalf + 1, `narrow: the fold stays within its half (${narrowFold.body.box}px)`);
  assert(narrowFold.scrollBox >= 120, `narrow: the transcript keeps a visible band (${narrowFold.scrollBox} of ${narrowFold.paneHeight})`);
  await page.screenshot({ path: path.join(OUT, "12-paste-narrow.png") });
  log("narrow fold", `composer ${narrowFold.inputBox}px, fold ${narrowFold.body.box}px, chat ${narrowFold.scrollBox}px`);

  // #319 starts wide, with no fold and a one-line box: the #318 fold is part of the previous
  // section's fixture, not of this one, so put the page back to a known geometry first.
  await page.setViewportSize({ width: 1200, height: 1100 });
  await sleep(400);
  while ((await page.locator(".paste-body").count()) > 0) {
    await page.locator(".paste-toggle").first().click();
    await sleep(150);
  }
  while ((await page.locator(".paste-x").count()) > 0) {
    await page.locator(".paste-x").first().click();
    await sleep(120);
  }
  await page.locator(".composer-input > textarea").fill("");
  await sleep(200);

  /**
   * What the transcript looks like from outside: where every message sits relative to the visible
   * band, and how much is left below. The reader's position is a message's box, never `scrollTop` —
   * the band itself changes height, so `scrollTop` alone cannot tell “still showing the last line”
   * from “the last line slid under the composer”.
   */
  const transcript = () =>
    page.evaluate(() => {
      const scroll = document.querySelector(".chat-scroll");
      const view = scroll.getBoundingClientRect();
      const boxes = [...scroll.querySelectorAll(".msg")].map((m) => {
        const r = m.getBoundingClientRect();
        return { text: (m.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24), top: r.top, bottom: r.bottom };
      });
      return {
        scrollTop: scroll.scrollTop,
        max: scroll.scrollHeight - scroll.clientHeight,
        gap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        view: { top: view.top, bottom: view.bottom, height: view.height },
        boxes,
        last: boxes.length ? boxes[boxes.length - 1] : null,
      };
    });
  const jumpUp = async () => {
    const j = page.locator(".chat-jump");
    return (await j.count()) > 0 && (await j.first().isVisible());
  };
  /** Reach the bottom the way a user does: the button (follow()) when it is up, else scroll by hand. */
  const gotoBottom = async () => {
    if (await jumpUp()) {
      await page.locator(".chat-jump").first().click();
      await sleep(350);
    } else {
      await page.evaluate(() => {
        const el = document.querySelector(".chat-scroll");
        el.scrollTop = el.scrollHeight;
      });
      await sleep(250);
    }
  };
  /** A wheel gesture over the middle of the visible transcript — never over the composer. */
  const wheelTranscript = async (dy) => {
    const band = await page.locator(".chat-scroll").boundingBox();
    await page.mouse.move(band.x + band.width / 2, band.y + band.height / 2);
    await page.mouse.wheel(0, dy);
    await sleep(450);
  };
  /** Pinned: nothing left below, and the last message wholly inside the visible band. */
  const assertPinned = async (where, slack = 1) => {
    const t = await transcript();
    assert(t.gap <= slack, `${where}: at the bottom (gap ${t.gap.toFixed(1)}px)`);
    assert(t.last !== null, `${where}: the transcript still has messages`);
    assert(
      t.last.bottom <= t.view.bottom + 1 && t.last.top >= t.view.top - 1,
      `${where}: the last message is wholly inside the band (${t.last.top.toFixed(1)}–${t.last.bottom.toFixed(1)} vs band ${t.view.top.toFixed(1)}–${t.view.bottom.toFixed(1)})`,
    );
    return t;
  };

  // 13. #319 — the box grows under a following transcript: the last message must stay where a reader
  //     looks for it. The band shrinks by exactly the amount the box grew, so this is measured on the
  //     message box: `scrollTop === scrollHeight - clientHeight` can hold while the last line sits
  //     under the composer.
  await gotoBottom();
  const rest = await assertPinned("13 before growing");
  assert(!(await jumpUp()), "13 starts out following (no jump button)");
  const oneLineBox = await metrics();
  await field.fill(lines(40));
  await sleep(350);
  const grownBox = await metrics();
  const atCap = await assertPinned("13 with the box at its cap");
  assert(
    grownBox.height > oneLineBox.height + 200,
    `13 the box really grew (${oneLineBox.height.toFixed(1)} → ${grownBox.height.toFixed(1)}px)`,
  );
  assert(
    atCap.view.height < rest.view.height - 200,
    `13 the band really shrank (${rest.view.height.toFixed(1)} → ${atCap.view.height.toFixed(1)}px)`,
  );
  assert(!(await jumpUp()), "13 the growth did not read as “the user left the bottom” (no jump button)");
  await page.screenshot({ path: path.join(OUT, "13-grow-follows.png") });
  log(
    "13 grow while following",
    `box ${oneLineBox.height.toFixed(0)} → ${grownBox.height.toFixed(0)}px`,
    `band ${rest.view.height.toFixed(0)} → ${atCap.view.height.toFixed(0)}px`,
    `gap ${atCap.gap.toFixed(1)}`,
  );

  // 13c. The pin has to land in the keystroke's own task, not a frame later. The input handler writes
  //      the textarea's height synchronously; a pin that waits for the scroller's own size observer
  //      paints one frame with the last line pushed under the box. Read the geometry in that same
  //      task — no frame can run while the page is still inside `dispatchEvent`.
  await field.fill("");
  await sleep(200);
  await gotoBottom();
  const sameTask = await page.evaluate((text) => {
    const t = document.querySelector(".composer-input > textarea");
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setValue.call(t, text);
    t.dispatchEvent(new Event("input", { bubbles: true }));
    const scroll = document.querySelector(".chat-scroll");
    const view = scroll.getBoundingClientRect();
    const msgs = [...scroll.querySelectorAll(".msg")];
    const last = msgs[msgs.length - 1].getBoundingClientRect();
    return {
      box: t.getBoundingClientRect().height,
      band: view.height,
      gap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      lastBottom: last.bottom,
      viewBottom: view.bottom,
    };
  }, lines(40));
  assert(sameTask.box > 400, `13c the box grew inside the input task (${sameTask.box.toFixed(0)}px)`);
  assert(sameTask.band < 500, `13c the band shrank inside the same task (${sameTask.band.toFixed(0)}px)`);
  assert(
    sameTask.gap <= 1 && sameTask.lastBottom <= sameTask.viewBottom + 1,
    `13c pinned before the next frame (gap ${sameTask.gap.toFixed(1)}px, last line ${sameTask.lastBottom.toFixed(0)} vs band bottom ${sameTask.viewBottom.toFixed(0)})`,
  );
  await page.screenshot({ path: path.join(OUT, "13c-same-task-pin.png") });
  log("13c pin in the keystroke's task", `box ${sameTask.box.toFixed(0)}px, band ${sameTask.band.toFixed(0)}px, gap ${sameTask.gap.toFixed(1)}`);

  // 13b. The same growth through a paste fold: opening it pushes the band up by the fold's height
  //      while the composer is still one line — a grow the composer's own box does not show.
  await field.fill("");
  await sleep(200);
  await gotoBottom();
  await page.evaluate((text) => {
    const t = document.querySelector(".composer-input > textarea");
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, pasteText);
  await until(async () => (await page.locator(".paste-block").count()) === 1, 4000, "paste fold for #319");
  await gotoBottom();
  const foldShut = await assertPinned("13b fold shut");
  await page.locator(".paste-toggle").first().click();
  await until(async () => (await page.locator(".paste-body").count()) === 1, 4000, "paste editor for #319");
  await sleep(350);
  const foldOpen = await assertPinned("13b fold opened");
  assert(
    foldOpen.view.height < foldShut.view.height - 150,
    `13b opening the fold pushed the band up (${foldShut.view.height.toFixed(1)} → ${foldOpen.view.height.toFixed(1)}px)`,
  );
  assert(!(await jumpUp()), "13b opening the fold did not break the follow");
  await page.screenshot({ path: path.join(OUT, "13b-fold-grow.png") });
  log("13b fold opened while following", `band ${foldShut.view.height.toFixed(0)} → ${foldOpen.view.height.toFixed(0)}px, gap ${foldOpen.gap.toFixed(1)}`);
  await page.locator(".paste-x").first().click();
  await sleep(200);

  // 14. #319 — already reading history: growing the box must leave the reading position alone. The
  //     wheel below is a real gesture, so the app itself decides the follow is off (a programmatic
  //     `scrollTop` would leave `following` on and the next frame would drag the view back).
  await field.fill("");
  await sleep(200);
  await gotoBottom();
  await wheelTranscript(-220);
  const beforeRead = await transcript();
  assert(beforeRead.gap > 100, `14 the wheel really left the bottom (gap ${beforeRead.gap.toFixed(0)}px)`);
  assert(await jumpUp(), "14 not following any more: the jump button is up");
  const readIndex = beforeRead.boxes.findIndex((b) => b.top >= beforeRead.view.top - 1);
  assert(readIndex >= 0, "14 there is a message at the top of the band to read");
  const anchorMsg = beforeRead.boxes[readIndex];
  await field.fill(lines(40));
  await sleep(350);
  const afterRead = await transcript();
  const moved = afterRead.boxes[readIndex].top - anchorMsg.top;
  assert(Math.abs(moved) <= 2, `14 the message being read did not move (${moved.toFixed(1)}px, “${anchorMsg.text}”)`);
  assert(
    Math.abs(afterRead.scrollTop - beforeRead.scrollTop) <= 2,
    `14 the view was not dragged to the bottom (scrollTop ${beforeRead.scrollTop.toFixed(0)} → ${afterRead.scrollTop.toFixed(0)})`,
  );
  assert(
    afterRead.view.height < beforeRead.view.height - 200,
    `14 the box grew and the band shrank (${beforeRead.view.height.toFixed(0)} → ${afterRead.view.height.toFixed(0)}px)`,
  );
  assert(await jumpUp(), "14 still not following: the jump button stays up");
  await page.screenshot({ path: path.join(OUT, "14-grow-while-reading.png") });
  log(
    "14 grow while reading",
    `message “${anchorMsg.text}” moved ${moved.toFixed(1)}px`,
    `band ${beforeRead.view.height.toFixed(0)} → ${afterRead.view.height.toFixed(0)}px`,
  );

  // 15. #319 — shrinking back to one line. From the bottom: the band grows downwards and the hold on
  //     the bottom must survive it, with the last message still wholly visible.
  await gotoBottom();
  const capHold = await assertPinned("15 before shrinking from the bottom");
  await field.fill("");
  await sleep(350);
  const shrunkBottom = await assertPinned("15 shrunk at the bottom");
  assert(
    shrunkBottom.view.height > capHold.view.height + 200,
    `15 the band grew back (${capHold.view.height.toFixed(0)} → ${shrunkBottom.view.height.toFixed(0)}px)`,
  );
  assert(!(await jumpUp()), "15 the user at the bottom was not bounced off it");
  log("15 shrink at the bottom", `band ${capHold.view.height.toFixed(0)} → ${shrunkBottom.view.height.toFixed(0)}px, gap ${shrunkBottom.gap.toFixed(1)}`);
  await page.screenshot({ path: path.join(OUT, "15-shrink-at-bottom.png") });

  // 15b. From the middle: the band grows downwards, so what is being read must not shift. The
  //      reading position has to be further from the bottom than the box is tall, otherwise the
  //      browser's own clamp (and not the app) decides where the view ends up.
  await field.fill(lines(40));
  await sleep(300);
  const capGeo = await transcript();
  assert(
    Math.round(capGeo.max / 2) > 470,
    `15b the transcript is long enough to read mid-way (max ${capGeo.max.toFixed(0)}px of scroll)`,
  );
  await wheelTranscript(-Math.round(capGeo.max / 2));
  const midBefore = await transcript();
  assert(midBefore.gap > 470, `15b the reading position sits above the clamp zone (gap ${midBefore.gap.toFixed(0)}px)`);
  const midIndex = midBefore.boxes.findIndex((b) => b.top >= midBefore.view.top - 1);
  assert(midIndex >= 0, "15b there is a message at the top of the band to read");
  const midMsg = midBefore.boxes[midIndex];
  await field.fill("");
  await sleep(350);
  const midAfter = await transcript();
  const midMoved = midAfter.boxes[midIndex].top - midMsg.top;
  assert(Math.abs(midMoved) <= 2, `15b the message being read did not move (${midMoved.toFixed(1)}px, “${midMsg.text}”)`);
  assert(
    Math.abs(midAfter.scrollTop - midBefore.scrollTop) <= 2,
    `15b the shrinking box did not scroll the view (scrollTop ${midBefore.scrollTop.toFixed(0)} → ${midAfter.scrollTop.toFixed(0)})`,
  );
  assert(await jumpUp(), "15b still reading history: the jump button stays up");
  log(
    "15b shrink while reading",
    `message “${midMsg.text}” moved ${midMoved.toFixed(1)}px`,
    `band ${midBefore.view.height.toFixed(0)} → ${midAfter.view.height.toFixed(0)}px`,
  );
  await page.screenshot({ path: path.join(OUT, "15b-shrink-while-reading.png") });

  // 16. #319 — a reply arrives while the box grows. Following has to survive the growth, so the tail
  //     of the streaming message stays visible and nothing claims there is new content below.
  await field.fill("");
  await sleep(200);
  await gotoBottom();
  startStream(60);
  await sleep(400);
  const streamStart = await transcript();
  assert(streamStart.gap <= 80, `16 the running stream is followed (gap ${streamStart.gap.toFixed(0)}px)`);
  await field.fill(lines(40));
  await sleep(450);
  const streamGrown = await transcript();
  assert(
    streamGrown.view.height < streamStart.view.height - 200,
    `16 the box grew mid-stream (band ${streamStart.view.height.toFixed(0)} → ${streamGrown.view.height.toFixed(0)}px)`,
  );
  assert(streamGrown.gap <= 80, `16 the follow survived the growth (gap ${streamGrown.gap.toFixed(0)}px)`);
  assert(
    streamGrown.last.bottom <= streamGrown.view.bottom + 80,
    `16 the tail of the streaming message is still visible (${streamGrown.last.bottom.toFixed(0)} vs band bottom ${streamGrown.view.bottom.toFixed(0)})`,
  );
  assert(!(await jumpUp()), "16 still following: no jump button and no “new” badge");
  stopStream();
  await sleep(400);
  await assertPinned("16 once the stream stops");
  await page.screenshot({ path: path.join(OUT, "16-stream-grow.png") });
  log(
    "16 grow mid-stream",
    `band ${streamStart.view.height.toFixed(0)} → ${streamGrown.view.height.toFixed(0)}px, gap ${streamGrown.gap.toFixed(0)}, tail visible`,
  );

  log("ALL OK");
} finally {
  stopStream();
  await browser?.close();
  server.close();
  wss.close();
}
