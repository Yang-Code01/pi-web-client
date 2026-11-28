/**
 * Probe: 终端的两件小事（#756）——
 *
 *   1. `＋` 的 shell 选择菜单不许「穿模」：它以前一律贴着锚点**往上**弹，dock 拉高一点就顶出视口，
 *      压着顶栏的标签行、上沿还被屏幕切掉。现在：下方放得下就往下开，放不下才翻上去，两头都只剩一条缝
 *      就封顶自己滚，左右上下都夹在视口里。
 *   2. 「－」（收起）与「关闭」在顶栏那颗按钮上分得清：收起之后 shell 还在跑，字后面挂**三根音柱**
 *      （「正在播放」那个记号，1.05s 起伏）；关掉之后音柱消失、按钮回灰色。
 *
 * Stands in for the bridge: answers `term.list` / `term.open`, ignores input.
 *
 * Run: npm run build:web && node probes/term-shell-menu.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7914);
const OUT = path.join(REPO, ".scratch/term-shell-menu/shots");
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = 8;
// PROBE_THEME=dark 顺手看一眼暗色下这两样东西的样子（截图用，不影响断言）。
const THEME = process.env.PROBE_THEME ?? "";
const SHELLS = [
  { id: "pwsh", label: "pwsh" },
  { id: "powershell", label: "powershell" },
  { id: "git-bash", label: "Git Bash" },
  { id: "cmd", label: "cmd" },
];

fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
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
const A = { id: "probe-term", name: "终端探针", cwd: REPO, file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "shell 菜单" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };

let sock = null;
let shells = 0;
const send = (msg) => sock?.readyState === 1 && sock.send(JSON.stringify(msg));

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") return json(200, ME);
  if (url.pathname === "/api/git") return json(200, { repo: null });
  if (url.pathname === "/api/dirs") return json(200, { path: url.searchParams.get("path") ?? "", parent: "F:", dirs: [], files: [], error: "" });
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const file = path.join(DIST, rel);
  // 越界就 404：不能只比前缀 —— `dist-evil/x.js` 也是以 `dist` 开头的。
  const inside = path.relative(path.resolve(DIST), path.resolve(file));
  if (inside.startsWith("..") || path.isAbsolute(inside) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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
      ws.send(JSON.stringify({ type: "session", sessionId: A.id, state: A, items: [], approvals: [], asks: [], budget: null }));
      return;
    }
    if (msg.type === "term.list") {
      ws.send(JSON.stringify({ type: "term.list", items: [], shells: SHELLS }));
      return;
    }
    if (msg.type === "term.open") {
      shells += 1;
      const sh = SHELLS.find((s) => s.id === msg.shell) ?? SHELLS[0];
      ws.send(JSON.stringify({ type: "term.opened", id: `probe-term-${shells}`, shell: sh.label, cwd: msg.cwd ?? A.cwd }));
      return;
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [A], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

const rectOf = (loc) =>
  loc.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  // 主题要在 boot 之前落进偏好（paintTheme 只跑一次，事后改 dataset 不会重算强调色）。
  if (THEME) {
    await page.addInitScript((t) => {
      try {
        const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
        p.theme = t;
        localStorage.setItem("pi.prefs", JSON.stringify(p));
      } catch {
        /* 读不到就按默认主题跑 */
      }
    }, THEME);
  }
  await page.goto(BASE, { waitUntil: "networkidle" });
  if (THEME) await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, THEME);
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  const termBtn = page.locator('[data-act="terminal"]');
  await until(async () => await termBtn.isVisible(), 8000, "terminal button");
  const tintOf = () =>
    termBtn.evaluate((node) => {
      const s = getComputedStyle(node);
      return { color: s.color, bg: s.backgroundColor, live: node.classList.contains("term-live") };
    });
  const idle = await tintOf();

  // ---- 1) open the dock and drag its top edge to the top of the window -------------------------
  await termBtn.click();
  const dock = page.locator(".term-dock");
  await until(async () => await dock.isVisible(), 8000, "terminal dock");
  await until(async () => (await page.locator(".term-tab").count()) === 1, 4000, "first tab");

  const grip = page.locator(".term-grip").first();
  const gb = await grip.boundingBox();
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2, 0, { steps: 12 });
  await page.mouse.up();
  await sleep(250);
  const dockBox = await rectOf(dock);
  log(`dock: top=${Math.round(dockBox.top)} height=${Math.round(dockBox.height)}`);
  ok(dockBox.top <= 24, `the dock really is pushed to the top of the window (top ${Math.round(dockBox.top)}px)`);

  // ---- 2) the shell menu must stay inside the viewport and open downwards ----------------------
  const more = page.locator(".term-new");
  const anchor = await rectOf(more);
  await more.click();
  await until(async () => (await page.locator(".term-menu").count()) === 1, 3000, "shell menu");
  const menu = page.locator(".term-menu");
  const mb = await rectOf(menu);
  const view = page.viewportSize();
  log(`menu: top=${Math.round(mb.top)} bottom=${Math.round(mb.bottom)} left=${Math.round(mb.left)} right=${Math.round(mb.right)} (viewport ${view.width}x${view.height})`);
  log(`anchor(＋): top=${Math.round(anchor.top)} bottom=${Math.round(anchor.bottom)}`);

  ok(mb.top >= EDGE - 1, `menu top stays inside the window (${Math.round(mb.top)} >= ${EDGE})`);
  ok(mb.left >= EDGE - 1, `menu left stays inside the window (${Math.round(mb.left)} >= ${EDGE})`);
  ok(mb.right <= view.width - EDGE + 1, `menu right stays inside the window (${Math.round(mb.right)} <= ${view.width - EDGE})`);
  ok(mb.bottom <= view.height - EDGE + 1, `menu bottom stays inside the window (${Math.round(mb.bottom)} <= ${view.height - EDGE})`);
  // 下方有几屏的空间：菜单该往下开，别翻上去压住顶栏。
  ok(mb.top >= anchor.bottom - 1, `with room below the menu opens downwards (top ${Math.round(mb.top)} ≥ ＋ bottom ${Math.round(anchor.bottom)})`);
  ok(mb.top <= anchor.bottom + 12, `and it hugs the ＋ button (gap ${Math.round(mb.top - anchor.bottom)}px)`);

  // 每一项都在菜单的框里（绿色 hover 底不许越过菜单边缘）。
  const spill = await menu.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll(".term-menu-item")].map((item) => {
      const r = item.getBoundingClientRect();
      return { label: item.textContent, d: Math.max(box.left - r.left, box.top - r.top, r.right - box.right, r.bottom - box.bottom) };
    });
  });
  ok(spill.every((s) => s.d <= 1), `every shell item stays inside the menu (${spill.map((s) => `${s.label}:${s.d.toFixed(1)}`).join(", ")})`);

  // 菜单是这一点的最上层：终端窗口 / 顶栏不许画在它上面。
  const topmost = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return hit ? (hit.closest(".term-menu") ? "menu" : `${hit.tagName}.${hit.className}`) : "none";
  }, { x: Math.round((mb.left + mb.right) / 2), y: Math.round((mb.top + mb.bottom) / 2) });
  ok(topmost === "menu", `nothing paints over the menu at its centre (hit ${topmost})`);

  await page.screenshot({ path: path.join(OUT, "1-menu-down.png") });

  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".term-menu").count()) === 0, 2000, "menu closed by Esc");

  // ---- 3) dock back at the bottom: the menu hugs the ＋ and never overlaps it ------------------
  // Pull the dock back down to the bottom (double-click the grip resets the geometry).
  await grip.dblclick();
  await sleep(250);
  const dockLow = await rectOf(dock);
  await more.click();
  await until(async () => (await page.locator(".term-menu").count()) === 1, 3000, "shell menu (low dock)");
  const lowMenu = await rectOf(menu);
  const lowAnchor = await rectOf(more);
  log(`low dock: top=${Math.round(dockLow.top)} | menu top=${Math.round(lowMenu.top)} bottom=${Math.round(lowMenu.bottom)}`);
  const clears = lowMenu.top >= lowAnchor.bottom - 1 || lowMenu.bottom <= lowAnchor.top + 1;
  ok(clears, `the menu never covers the ＋ it hangs off (menu ${Math.round(lowMenu.top)}..${Math.round(lowMenu.bottom)}, ＋ ${Math.round(lowAnchor.top)}..${Math.round(lowAnchor.bottom)})`);
  ok(lowMenu.top >= EDGE - 1 && lowMenu.bottom <= view.height - EDGE + 1, `and stays inside the window (${Math.round(lowMenu.top)}..${Math.round(lowMenu.bottom)})`);
  await page.screenshot({ path: path.join(OUT, "2-menu-low-dock.png") });
  await page.keyboard.press("Escape");
  await sleep(120);

  // ---- 3b) a squat window: same rules, the menu must not run off the screen --------------------
  await page.setViewportSize({ width: 900, height: 360 });
  await sleep(200);
  if (!(await dock.isVisible())) await termBtn.click();
  await until(async () => await dock.isVisible(), 3000, "dock visible after resizing");
  await more.click();
  await until(async () => (await page.locator(".term-menu").count()) === 1, 3000, "shell menu (squat window)");
  const small = await rectOf(menu);
  const smallAnchor = await rectOf(more);
  log(`squat window 900x360: menu ${Math.round(small.top)}..${Math.round(small.bottom)} (anchor ${Math.round(smallAnchor.top)}..${Math.round(smallAnchor.bottom)})`);
  ok(small.top >= EDGE - 1 && small.bottom <= 360 - EDGE + 1, `squat window: menu stays inside (${Math.round(small.top)}..${Math.round(small.bottom)})`);
  ok(small.top >= smallAnchor.bottom - 1 || small.bottom <= smallAnchor.top + 1, "squat window: menu still clears the ＋");
  // 封了顶就要能滚到最后一个 shell，不能被自己的框切掉。
  const scrollable = await menu.evaluate((node) => {
    const hit = node.scrollHeight > node.clientHeight + 1;
    if (hit) node.scrollTop = node.scrollHeight;
    const last = node.querySelector(".term-menu-item:last-child");
    const box = node.getBoundingClientRect();
    const r = last.getBoundingClientRect();
    return { hit, visible: r.bottom <= box.bottom + 1 && r.top >= box.top - 1 };
  });
  ok(!scrollable.hit || scrollable.visible, `a capped menu can scroll to its last shell (capped=${scrollable.hit})`);
  await page.screenshot({ path: path.join(OUT, "3-menu-squat.png") });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(250);

  // ---- 4) 「－」 keeps the shell alive and shows the running bars --------------------------------
  await page.locator(".term-btn.min-btn").click();
  await until(async () => !(await dock.isVisible()), 2000, "dock minimized");
  ok((await page.locator(".term-tab").count()) === 1, "minimizing does not kill the shell (tab still alive)");
  const state = await termBtn.getAttribute("data-term-state");
  ok(state === "min", `the topbar button says it was minimized (data-term-state=${state})`);
  const bars = termBtn.locator(".term-bars");
  ok((await bars.count()) === 1 && (await bars.isVisible()), "the minimized terminal shows the running bars");
  const marks = await bars.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const btn = node.closest("button").getBoundingClientRect();
    return [...node.querySelectorAll("i")].map((bar) => {
      const s = getComputedStyle(bar);
      const r = bar.getBoundingClientRect();
      return {
        name: s.animationName,
        dur: s.animationDuration,
        count: s.animationIterationCount,
        delay: s.animationDelay,
        color: s.backgroundColor,
        // 柱子得在按钮里面，别戳出右边框。
        inside: r.right <= btn.right + 0.5 && r.top >= btn.top - 0.5 && r.bottom <= btn.bottom + 0.5,
      };
    });
  });
  log("bars:", JSON.stringify(marks));
  ok(marks.length === 3, `three running bars (got ${marks.length})`);
  ok(marks.every((m) => m.name && m.name !== "none"), `every bar is animated (${marks.map((m) => m.name).join(", ")})`);
  ok(marks.every((m) => m.count === "infinite"), "the bars keep going (iteration-count infinite)");
  ok(marks.every((m) => /^[0-9.]+s$/.test(m.dur) && Number.parseFloat(m.dur) >= 1), `a calm period, not a blink (${marks[0].dur})`);
  ok(new Set(marks.map((m) => m.delay)).size === 3, `the bars are staggered (${marks.map((m) => m.delay).join(" / ")})`);
  ok(marks.every((m) => m.inside), "the bars stay inside the button");
  // 真在动：隔一段采样，柱子的高度（scaleY）得变。
  const sample = async () => bars.evaluate((node) => getComputedStyle(node.querySelector("i")).transform);
  const a1 = await sample();
  await sleep(260);
  const a2 = await sample();
  ok(a1 !== a2, `the bars really move (${a1} → ${a2})`);
  // 按钮本身得是点亮的（accent 字 + accent 底），否则「收起来了」和「没有终端」只看得到音柱。
  const tint = await tintOf();
  log("button tint:", JSON.stringify(tint), "idle:", JSON.stringify(idle));
  // 按钮本身得真的点亮（accent 字 + accent 底），不然「收起来了」就只剩三根小柱子撑着 ——
  // mac 表皮的 `html[data-ui="mac"] .topbar .icon-btn` 比 `.icon-btn.term-live` 更具体，以前把它整个盖掉。
  ok(tint.live && idle.live === false, "the minimized button carries term-live, the idle one does not");
  ok(tint.color !== idle.color, `the button text really takes the accent (${idle.color} → ${tint.color})`);
  ok(tint.bg !== idle.bg && tint.bg !== "rgba(0, 0, 0, 0)", `the button gets a tinted fill (${idle.bg} → ${tint.bg})`);
  // 悬停要「更深一点」而且仍然不透明 —— 换成半透明强调色会在玻璃顶栏上发淡发透，正好反着。
  await termBtn.hover();
  await sleep(220);
  const hov = await tintOf();
  ok(hov.bg !== tint.bg, `hover deepens the lit button (${tint.bg} → ${hov.bg})`);
  ok(!hov.bg.includes("/") && hov.bg !== "rgba(0, 0, 0, 0)", `hover fill stays opaque (${hov.bg})`);
  await page.mouse.move(4, 300);
  await sleep(120);
  const labels = await termBtn.evaluate((n) => ({ label: n.getAttribute("aria-label"), title: n.getAttribute("title") }));
  ok(labels.label === labels.title, `aria-label and title say the same thing (${labels.label})`);
  await page.screenshot({ path: path.join(OUT, "3-minimized.png") });
  await termBtn.screenshot({ path: path.join(OUT, "3c-button-min.png") });
  await page.locator(".topbar").screenshot({ path: path.join(OUT, "3d-topbar-min.png") });

  // 再点顶栏：回到同一个 shell，音柱收掉。
  await termBtn.click();
  await until(async () => await dock.isVisible(), 4000, "dock back");
  ok((await page.locator(".term-tab").count()) === 1, "reopening returns to the same shell");
  ok((await termBtn.getAttribute("data-term-state")) === "open", "the button says the dock is open again");
  ok((await termBtn.locator(".term-bars").count()) === 0, "the bars go away while the dock is on screen");

  // ---- 5) 关闭 ends it: no bars, no accent ---------------------------------------------------
  await page.locator(".term-btn", { hasText: "关闭" }).click();
  await until(async () => (await page.locator(".term-dock").count()) === 0, 4000, "dock closed");
  const afterClose = await termBtn.getAttribute("data-term-state");
  ok(afterClose === "off", `closing leaves no live state (data-term-state=${afterClose})`);
  ok((await termBtn.locator(".term-bars").count()) === 0, "no running bars after closing");
  ok(!(await termBtn.evaluate((n) => n.classList.contains("term-live"))), "the button is no longer lit after closing");
  // 关掉最后一个终端之后，悬停说明得退回 build() 里那句能力说明（含公网隧道的限制），
  // 不能被 off 态冲成一句光秃秃的「终端」。
  const closedTitle = (await termBtn.getAttribute("title")) ?? "";
  ok(closedTitle.includes("shell") && closedTitle.includes("公网隧道"), `the idle tooltip keeps the capability hint (${closedTitle})`);
  ok((await termBtn.getAttribute("aria-label")) === closedTitle, "the idle aria-label matches its tooltip");
  await termBtn.screenshot({ path: path.join(OUT, "4c-button-off.png") });
  await page.screenshot({ path: path.join(OUT, "4-closed.png") });
  await page.locator(".topbar").screenshot({ path: path.join(OUT, "4d-topbar-off.png") });

  log(bad ? `${bad} FAILED` : "ALL OK");
  process.exitCode = bad ? 1 : 0;
} finally {
  await browser?.close();
  // 页面走了之后 socket 可能还挂着一会儿：先掐掉，server.close() 就不用等 keep-alive 超时。
  wss.clients.forEach((client) => client.terminate());
  server.closeAllConnections?.();
  server.close();
  wss.close();
}
