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
const SESSION = { id: "probe-grow", name: "输入框探针", cwd: REPO, file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "量输入框高度" };
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

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
