/**
 * Probe: D62 — the directory picker shows what "够不够用" means: a drive row carries its fill bar,
 * percentage and 剩余; a file row carries 大小 and 修改时间 in right-aligned columns. The sizes are a
 * second request, so the names must already be on screen while they are still in flight.
 *
 * Stands in for the bridge: 此电脑 has three drives (D: at 92% so the 吃紧 colour is exercised), the
 * session's cwd has four files with sizes chosen to hit every unit, and the stats answer is delayed
 * by 450ms so "names first, sizes later" can actually be observed.
 *
 * Run: npm run build:web && node probes/round22-dirsize.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7916;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round22-dirsize/shots";
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
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const CWD = "F:\\probe-work\\exam";
const SRC = "F:\\probe-work\\exam\\src";
const LONG = "一个很长很长很长的中文文件名示例用来测试截断行为.ts";
const FILES = ["index.ts", "sessions.ts", "installer.exe", LONG];
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const KB = 1024;
const NOW = Date.now();
const day = 24 * 3600 * 1000;
/** The same rule the picker uses, spelled out here so the expectation is not read off the code under test. */
const expectTime = (ms) => {
  const d = new Date(ms);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** 34500 B → "33.7 KB"; the long name is the 1.4 MB one so the truncation case also has a size. */
const STATS = {
  "index.ts": { size: Math.round(33.7 * KB), mtime: NOW }, // today → HH:MM
  "sessions.ts": { size: Math.round(60.9 * KB), mtime: NOW - 40 * day }, // this year → MM-DD
  "installer.exe": { size: Math.round(4.2 * GB), mtime: new Date(2024, 5, 1, 9, 5).getTime() }, // older → YYYY-MM-DD
  [LONG]: { size: Math.round(1.4 * MB), mtime: NOW - 3 * day },
};
const VOLUMES = [
  { root: "C:\\", total: Math.round(265.3 * GB), free: Math.round(55.7 * GB) },
  { root: "D:\\", total: Math.round(931.5 * GB), free: Math.round(74.0 * GB) },
  { root: "E:\\", total: Math.round(475.8 * GB), free: Math.round(173.6 * GB) },
];
const norm = (p) => p.replace(/\//g, "\\").replace(/\\+$/, (m) => (m.length ? "\\" : ""));

const ANSWER = "收到。先摸现状。\n\n- 读入口\n- 只改一处";
const items = [
  { id: "u0", kind: "user", text: "看一眼目录里的文件大小。", images: [], ts: new Date().toISOString() },
  { id: "a0", kind: "assistant", text: ANSWER, thinking: "", model: "probe", ts: new Date().toISOString() },
];
const A = {
  id: "probe-a", name: "会话 A", cwd: "F:/probe-work/exam", file: null, owned: true, origin: "web", running: false, done: false,
  updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "", items,
};
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: [], order: [], archived: [] };
const strip = ({ items: _drop, ...rest }) => rest;

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const server = http.createServer(async (req, res) => {
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
  if (url.pathname === "/api/dirs") {
    const raw = url.searchParams.get("path") ?? "";
    const dir = norm(raw);
    if (url.searchParams.get("stats") === "1") {
      // Deliberately slow: the rows must already be on screen without sizes.
      await sleep(450);
      if (dir === CWD) return json(200, { files: FILES.map((name) => ({ name, ...STATS[name] })) });
      if (dir === SRC) return json(200, { files: [{ name: "app.ts", size: 4096, mtime: NOW }] });
      return json(200, { files: [] });
    }
    if (!dir) return json(200, { path: "", parent: null, dirs: VOLUMES.map((v) => v.root), files: [], volumes: VOLUMES });
    if (dir === CWD) return json(200, { path: CWD, parent: "F:\\probe-work", dirs: ["src"], files: FILES });
    if (dir === SRC) return json(200, { path: SRC, parent: CWD, dirs: [], files: ["app.ts"] });
    if (dir === "D:\\") return json(200, { path: "D:\\", parent: "", dirs: [], files: [] });
    return json(200, { path: dir, parent: "", dirs: [], files: [], error: "" });
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
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: A.id, state: strip(A), items: A.items, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [strip(A)], manage, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

/** Drive rows: label, percentage, 剩余, the colour class, and whether the bar is filled to that pct. */
const driveRows = (page) =>
  page.evaluate(() => {
    const wide = document.querySelector(".dirpicker")?.getBoundingClientRect().width ?? 0;
    return [...document.querySelectorAll(".dirpicker .vol-row")].map((row) => {
      const bar = row.querySelector(".vol-bar");
      const fill = bar?.firstElementChild;
      const pct = row.querySelector(".vol-pct");
      const free = row.querySelector(".vol-free");
      return {
        label: row.querySelector(".vol-letter")?.textContent ?? "",
        pct: pct?.textContent ?? "",
        pctShown: pct ? getComputedStyle(pct).display !== "none" : false,
        free: free?.textContent ?? "",
        tight: row.classList.contains("tight"),
        full: row.classList.contains("full"),
        fillWidth: fill ? Math.round(fill.getBoundingClientRect().width) : -1,
        barWidth: bar ? Math.round(bar.getBoundingClientRect().width) : -1,
        title: row.getAttribute("title") ?? "",
        pickerWidth: Math.round(wide),
      };
    });
  });

/** File rows: name, the two columns, their right edges (they must line up), height, truncation. */
const fileRows = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll(".dirpicker .file-row")];
    return rows.map((row) => {
      const size = row.querySelector(".size");
      const time = row.querySelector(".mtime");
      const nm = row.querySelector(".nm");
      const box = (n) => (n ? Math.round(n.getBoundingClientRect().right) : null);
      return {
        name: nm?.textContent ?? "",
        size: size?.textContent ?? "",
        time: time?.textContent ?? "",
        sizeAlign: size ? getComputedStyle(size).textAlign : "",
        sizeRight: box(size),
        timeRight: box(time),
        height: Math.round(row.getBoundingClientRect().height),
        truncated: nm ? nm.scrollWidth - nm.clientWidth > 0 : false,
        sizeShown: size ? size.getBoundingClientRect().width > 0 : false,
      };
    });
  });

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") log("console:", m.text()); });
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) === 1, 8000, "the session card");
  await page.locator('.session-card[data-id="probe-a"]').click();
  await until(async () => (await page.locator(".chat-scroll .msg.user").count()) === 1, 8000, "the transcript");
  await sleep(300);

  // 1) 附件选择器（桌面宽度下就是那个"宽"的面板）里，名字先出来、大小后到
  await page.locator('.hint-tools [data-act="attach"]').click();
  await until(async () => (await page.locator(".sheet.file-picker .dirpicker").count()) === 1, 5000, "the attach sheet");
  await until(async () => (await page.locator(".sheet.file-picker .file-row").count()) === 4, 5000, "four file rows");
  const early = await fileRows(page);
  log("rows before stats:", early.map((r) => ({ name: r.name, size: r.size })));
  assert(early.length === 4, `the four files are listed (got ${early.length})`);
  assert(early.every((r) => r.size === ""), `sizes are still empty while the stats request is in flight (got ${JSON.stringify(early.map((r) => r.size))})`);

  await until(async () => (await fileRows(page)).every((r) => r.size !== ""), 5000, "the sizes to land");
  const done = await fileRows(page);
  log("rows after stats:", done);
  const byName = Object.fromEntries(done.map((r) => [r.name, r]));
  assert(byName["index.ts"].size === "33.7 KB", `33.7 KB (got ${byName["index.ts"].size})`);
  assert(byName["sessions.ts"].size === "60.9 KB", `60.9 KB (got ${byName["sessions.ts"].size})`);
  assert(byName["installer.exe"].size === "4.2 GB", `4.2 GB (got ${byName["installer.exe"].size})`);
  assert(byName[LONG].size === "1.4 MB", `1.4 MB (got ${byName[LONG].size})`);
  assert(/^\d{2}:\d{2}$/.test(byName["index.ts"].time), `today's file shows a clock time (got ${byName["index.ts"].time})`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(byName["installer.exe"].time), `an old file spells the year (got ${byName["installer.exe"].time})`);
  for (const [name, st] of Object.entries(STATS)) {
    assert(byName[name].time === expectTime(st.mtime), `${name} shows ${expectTime(st.mtime)} (got ${byName[name].time})`);
  }
  assert(done.every((r) => r.sizeAlign === "right"), "sizes are right aligned");
  const sizeRights = new Set(done.map((r) => r.sizeRight));
  const timeRights = new Set(done.map((r) => r.timeRight));
  assert(sizeRights.size === 1, `all sizes share one right edge (got ${[...sizeRights].join(", ")})`);
  assert(timeRights.size === 1, `all mtimes share one right edge (got ${[...timeRights].join(", ")})`);
  assert(done.every((r) => r.height <= 44), `rows stay compact (max ${Math.max(...done.map((r) => r.height))}px)`);
  assert(byName[LONG].truncated, "the absurd file name is truncated, not wrapped");
  await page.screenshot({ path: `${OUT}/1-sheet-files.png` });

  // 2) 此电脑：每个盘一行，带百分比、剩余和吃紧的颜色；D: 92% 该变成琥珀
  await page.locator('.dirpicker .crumb[title="此电脑"]').click();
  await until(async () => (await page.locator(".dirpicker .vol-row").count()) === 3, 5000, "three drive rows");
  const drives = await driveRows(page);
  log("drives:", drives);
  assert(drives.map((d) => d.label).join(",") === "C:,D:,E:", `drive letters (got ${drives.map((d) => d.label).join(",")})`);
  assert(drives[0].pct === "79%", `C: is 79% used (got ${drives[0].pct})`);
  assert(drives[1].pct === "92%", `D: is 92% used (got ${drives[1].pct})`);
  assert(drives[1].tight && !drives[1].full, "D: at 92% is flagged 吃紧, not 塞满");
  assert(!drives[0].tight && !drives[2].tight, "C: and E: stay neutral");
  assert(drives[1].fillWidth / drives[1].barWidth > 0.85, `D: bar is filled to its percentage (${drives[1].fillWidth}/${drives[1].barWidth})`);
  assert(drives[0].free === "55.7 GB 可用", `C: shows what is left (got ${drives[0].free})`);
  assert(drives[0].title.includes("265.3 GB") && drives[0].title.includes("209.6 GB"), `the tooltip spells out 共/已用 (got ${drives[0].title})`);
  assert(drives.every((d) => d.pctShown), "at this width the percentage is shown");
  await page.screenshot({ path: `${OUT}/2-this-pc.png` });

  // 3) 点盘符进得去（不是死行）
  await page.locator(".dirpicker .vol-row").nth(1).click();
  await until(async () => (await page.evaluate(() => document.querySelector(".dirpicker .dir-path")?.textContent ?? "")).includes("D:"), 4000, "entering D:");

  // 4) 回到目录：筛选重画后大小还在（否则一输入就把这一排清空）
  await page.locator('.dirpicker .crumb[title="此电脑"]').click();
  await until(async () => (await page.locator(".dirpicker .vol-row").count()) === 3, 4000, "back at 此电脑");
  await page.locator('.sheet.file-picker [data-act="dir-home"]').click();
  await until(async () => (await page.locator(".dirpicker .file-row").count()) === 4, 4000, "back in the cwd");
  await until(async () => (await fileRows(page)).every((r) => r.size !== ""), 4000, "sizes again");
  await page.locator(".dirpicker .dir-filter").fill("in");
  await sleep(200);
  const filtered = await fileRows(page);
  log("filtered:", filtered.map((r) => `${r.name}=${r.size}`));
  assert(filtered.length === 2, `筛选 keeps only the matching files (got ${filtered.length})`);
  assert(filtered.every((r) => r.size !== ""), `筛选 does not drop the sizes (got ${JSON.stringify(filtered.map((r) => r.size))})`);
  await page.locator(".dirpicker .dir-filter").fill("");

  // 5) 进子目录再回来：换目录会把旧的大小丢掉，回来时重新取
  await page.locator('.dirpicker .dir-row', { hasText: "src" }).first().click();
  await until(async () => (await fileRows(page)).some((r) => r.name === "app.ts"), 4000, "the child folder");
  await until(async () => (await fileRows(page)).every((r) => r.size !== ""), 4000, "the child folder's sizes");
  const child = await fileRows(page);
  assert(child[0].size === "4 KB", `the child folder's file gets its own size (got ${child[0].size})`);
  await page.locator('.sheet.file-picker [data-act="dir-home"]').click();
  await until(async () => (await fileRows(page)).every((r) => r.size !== ""), 4000, "the parent folder's sizes to come back");
  assert((await fileRows(page)).every((r) => r.name !== "app.ts"), "no rows leak from the child folder");

  // 6) 窄容器（手机宽度下的同一个弹层）：百分比让位，路径与剩余还在
  await page.locator('.dirpicker .crumb[title="此电脑"]').click();
  await until(async () => (await page.locator(".dirpicker .vol-row").count()) === 3, 4000, "此电脑 again");
  await page.setViewportSize({ width: 420, height: 860 });
  await sleep(600);
  const narrow = await driveRows(page);
  log("narrow:", narrow);
  assert(narrow[0].pickerWidth < 460, `sanity: the picker is actually narrow (${narrow[0].pickerWidth}px)`);
  assert(narrow.every((d) => !d.pctShown), "the percentage is dropped when there is no room");
  assert(narrow.every((d) => d.free.includes("可用")), "剩余容量 survives the narrow layout");
  assert(narrow.every((d) => d.barWidth > 40), `the bar keeps a usable width (${narrow.map((d) => d.barWidth).join(", ")})`);
  await page.screenshot({ path: `${OUT}/3-narrow.png` });

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
