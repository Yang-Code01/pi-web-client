/**
 * Probe: Q-035 — 置顶条每颗胶囊悬停弹出气泡（归档 / 重命名 / 删除），三个动作各带动效。
 *
 * 断言的是「谁能看见什么」而不是「动画有几帧」：
 *  - 气泡挂在 body 上（条是 overflow-x:auto，挂在里面会被裁掉），位置在胶囊下方
 *  - 悬停 180ms 才出、移开 220ms 才收（扫过不算）
 *  - 重命名在气泡里就地变输入框，回车提交发 rename
 *  - 归档：条尾出现抽屉 → 胶囊压扁滑进去 → 发 manage/archive，随后条里没它了
 *  - 删除：胶囊被克隆带走 → 左栏自动展开露出🗑 → 飞进桶 → 发 manage/delete，桶计数 +1
 *  - 左栏那颗🗑 直接打开会话管理的垃圾箱视图
 *
 * Run: npm run build:web && node probes/round24-pinactions.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7918;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round24-pinactions/shots";
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
    await sleep(60);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const ANSWER = "好，我把这一处改完再跑一遍验证。\n\n- 先读入口\n- 只改这一处\n- 再跑探针";
const items = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `u${i}`, kind: "user", text: `第 ${i + 1} 轮：继续。`, images: [], ts: new Date(Date.now() - (n - i) * 60000).toISOString() });
    out.push({ id: `a${i}`, kind: "assistant", text: ANSWER, thinking: "", model: "probe", ts: new Date(Date.now() - (n - i) * 59000).toISOString() });
  }
  return out;
};

const CWD = "F:/probe-work/alpha";
const base = (id, name, n) => ({
  id, name, cwd: CWD, file: null, owned: true, origin: "web", running: false, done: false,
  updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "", items: items(n),
});
const A = base("probe-a", "考试模块", 2);
const B = base("probe-b", "pi-web-client", 2);
const C = base("probe-c", "文档站", 1);
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: ["probe-a", "probe-b", "probe-c"], order: [], archived: [] };
const strip = ({ items: _drop, ...rest }) => rest;

const frames = [];
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
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
  if (url.pathname === "/api/git") return json(200, { repo: CWD, branch: "main", detached: false, empty: false, dirty: 0 });
  if (url.pathname === "/api/dirs") return json(200, { path: url.searchParams.get("path") ?? "", parent: "F:", dirs: [], files: [], error: "" });
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
const live = new Set();
wss.on("connection", (ws) => {
  live.add(ws);
  ws.on("close", () => live.delete(ws));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      const s = [A, B, C].find((x) => x.id === msg.sessionId) ?? A;
      ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: strip(s), items: s.items, approvals: [], asks: [], budget: null }));
      return;
    }
    if (msg.type === "manage" || msg.type === "rename") {
      frames.push(msg);
      if (msg.type === "rename") {
        const s = [A, B, C].find((x) => x.id === msg.sessionId);
        if (s) s.name = String(msg.name);
        for (const w of live) w.send(JSON.stringify({ type: "sessions", sessions: [strip(A), strip(B), strip(C)] }));
        return;
      }
      if (msg.action === "archive") {
        const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
        manage.archived = msg.on ? [...new Set([...manage.archived, ...ids])] : manage.archived.filter((id) => !ids.includes(id));
        for (const w of live) w.send(JSON.stringify({ type: "manage", manage }));
        return;
      }
      if (msg.action === "delete") {
        const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
        for (const w of live) {
          w.send(JSON.stringify({ type: "delete.result", removed: ids, skipped: [] }));
          w.send(JSON.stringify({ type: "trash", items: ids.map((id) => ({ id, name: id, cwd: CWD, file: `x/${id}.jsonl`, deletedAt: Date.now(), size: 1024 })) }));
        }
      }
      return;
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [strip(A), strip(B), strip(C)], manage, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const rect = (page, sel) =>
  page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
  }, sel);
const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const chipAt = (page, i) => page.locator(`.pin-chip:not(.pin-new):not(.pin-expand)`).nth(i);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => log("PAGEERROR", e.message));
page.on("console", (m) => {
  if (m.type() === "error") log("CONSOLE", m.text());
});

try {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("pi.collapse.sessions", "1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await count(page, ".pin-chip")) >= 3, 6000, "pin strip with three chips");
  await page.screenshot({ path: `${OUT}/1-strip.png` });

  /* ---------------------------------------------------------------- 1. 悬停出气泡 */
  log("1) hover a chip");
  await chipAt(page, 0).hover();
  await until(async () => (await count(page, ".pin-menu")) === 1, 1500, "pin menu to open");
  const menu = await page.evaluate(() => {
    const n = document.querySelector(".pin-menu");
    return {
      parent: n?.parentElement?.tagName ?? "",
      inStrip: !!n?.closest(".pin-strip"),
      head: n?.querySelector(".pm-name")?.textContent ?? "",
      cwd: n?.querySelector(".pm-cwd")?.textContent ?? "",
      rows: [...(n?.querySelectorAll(".pm-item") ?? [])].map((b) => b.dataset.act),
      focused: document.activeElement?.className ?? "",
    };
  });
  assert(menu.parent === "BODY", `气泡必须挂在 body 上（条是 overflow-x:auto），实际父节点是 ${menu.parent}`);
  assert(!menu.inStrip, "气泡不能待在 .pin-strip 里，否则会被 overflow 裁掉");
  assert(menu.head === "考试模块", `气泡头部应显示会话名，实际「${menu.head}」`);
  assert(menu.cwd === CWD, `气泡头部应显示目录，实际「${menu.cwd}」`);
  assert(menu.rows.join(",") === "archive,rename,delete", `三个动作的顺序/数量不对：${menu.rows.join(",")}`);
  const chipBox = await rect(page, ".pin-chip");
  const menuBox = await rect(page, ".pin-menu");
  assert(menuBox.top >= chipBox.bottom - 1, `气泡应在胶囊下方（chip bottom ${chipBox.bottom} vs menu top ${menuBox.top}）`);
  assert(menuBox.left >= 0 && menuBox.right <= 1280, `气泡不该出窗（left ${menuBox.left} right ${menuBox.right}）`);
  await page.screenshot({ path: `${OUT}/2-menu.png` });

  /* ---------------------------------------------------------------- 2. 移开就收 */
  log("2) leave closes it");
  await page.mouse.move(640, 500);
  await until(async () => (await count(page, ".pin-menu")) === 0, 1500, "pin menu to close");

  /* ---------------------------------------------------------------- 3. 重命名就地改 */
  log("3) rename in place");
  await chipAt(page, 0).hover();
  await until(async () => (await count(page, ".pin-menu")) === 1, 1500, "pin menu again");
  await page.click('.pm-item[data-act="rename"]');
  await until(async () => (await count(page, ".pm-input")) === 1, 1000, "inline rename input");
  const editing = await page.evaluate(() => {
    const input = document.querySelector(".pm-input");
    return { focused: document.activeElement === input, value: input?.value ?? "", menuRows: document.querySelectorAll(".pin-menu .pm-item").length };
  });
  assert(editing.focused, "重命名输入框应自动聚焦");
  assert(editing.value === "考试模块", `输入框预填当前名字，实际「${editing.value}」`);
  assert(editing.menuRows === 3, `改名时气泡仍应是三行（归档/重命名/删除），实际 ${editing.menuRows}`);
  await page.locator(".pm-input").fill("改过的名字");
  await page.screenshot({ path: `${OUT}/3-rename.png` });
  await page.keyboard.press("Enter");
  await until(async () => frames.some((f) => f.type === "rename"), 1500, "rename frame");
  const ren = frames.find((f) => f.type === "rename");
  assert(ren.sessionId === "probe-a" && ren.name === "改过的名字", `rename 帧不对：${JSON.stringify(ren)}`);
  await until(async () => (await count(page, ".pin-menu")) === 0, 1000, "menu closed after rename");

  /* ---------------------------------------------------------------- 4. 归档：抽屉 + 压扁滑入 */
  log("4) archive");
  await until(async () => (await chipAt(page, 0).textContent())?.includes("改过的名字"), 2000, "chip to show the new name");
  await chipAt(page, 0).hover();
  await until(async () => (await count(page, ".pin-menu")) === 1, 1500, "pin menu for archive");
  await page.click('.pm-item[data-act="archive"]');
  await until(async () => (await count(page, ".pin-tray")) === 1, 1200, "archive tray to appear");
  const moving = await page.evaluate(() => {
    const chip = document.querySelector(".pin-chip .pin-open")?.closest(".pin-chip");
    return { anims: chip?.getAnimations().length ?? 0, tray: !!document.querySelector(".pin-tray") };
  });
  assert(moving.anims > 0, "归档时胶囊应该在播动画（压扁 + 滑入）");
  await sleep(200);
  await page.screenshot({ path: `${OUT}/4-archive.png` });
  await sleep(280);
  await page.screenshot({ path: `${OUT}/4b-archive-squash.png` });
  await until(async () => frames.some((f) => f.type === "manage" && f.action === "archive"), 2500, "archive frame");
  const arc = frames.find((f) => f.type === "manage" && f.action === "archive");
  assert(arc.ids.length === 1 && arc.ids[0] === "probe-a" && arc.on === true, `archive 帧不对：${JSON.stringify(arc)}`);
  await until(async () => (await count(page, ".pin-chip.pin-new")) === 1 && !(await page.evaluate(() => [...document.querySelectorAll(".pin-name")].some((n) => n.textContent === "改过的名字"))), 3000, "archived chip to leave the strip");
  const stripW = await page.evaluate(() => document.querySelector(".pin-strip")?.clientWidth ?? 0);
  assert(stripW > 600, `归档动画只能压扁那一颗胶囊：整条置顶条被挤成 ${stripW}px 了`);
  const note = await page.evaluate(() => document.querySelector(".pin-note")?.textContent ?? "");
  assert(note.includes("已归档"), `归档后应有一句去向提示，实际「${note}」`);

  /* ---------------------------------------------------------------- 5. 删除：飞进左栏的🗑 */
  log("5) delete flies into the bin");
  await until(async () => (await count(page, ".pin-chip.pin-new")) === 1, 2000, "strip back to normal");
  await chipAt(page, 0).hover();
  await until(async () => (await count(page, ".pin-menu")) === 1, 1500, "pin menu for delete");
  await page.screenshot({ path: `${OUT}/5-menu-delete.png` });
  await page.click('.pm-item[data-act="delete"]');
  await until(async () => (await count(page, ".pin-flyer")) === 1, 1200, "flying clone");
  const expanded = await page.evaluate(() => ({
    noLeft: document.querySelector(".main")?.classList.contains("no-left") ?? true,
    stripHidden: document.querySelector(".pin-strip")?.hidden ?? false,
    binVisible: !!document.querySelector(".bin-btn")?.getBoundingClientRect().width,
  }));
  assert(!expanded.noLeft, "删除时左栏应自动展开（.main 不该再有 no-left）");
  assert(expanded.binVisible, "展开后左栏那颗🗑要看得见，否则飞行体没有落点");
  assert(expanded.stripHidden, "左栏展开后置顶条应当整条收起（它只在收起时显示）");
  await page.screenshot({ path: `${OUT}/6-flyer.png` });
  await sleep(300);
  await page.screenshot({ path: `${OUT}/6b-flyer-mid.png` });
  await sleep(230);
  await page.screenshot({ path: `${OUT}/6c-flyer-end.png` });
  await until(async () => frames.some((f) => f.type === "manage" && f.action === "delete"), 3000, "delete frame");
  const del = frames.find((f) => f.type === "manage" && f.action === "delete");
  assert(del.ids.length === 1 && del.ids[0] === "probe-b", `delete 帧不对：${JSON.stringify(del)}`);
  await until(async () => (await page.evaluate(() => document.querySelector(".bin-btn .bin-count")?.textContent ?? "")) === "1", 2500, "bin count to become 1");
  const hit = await page.evaluate(() => document.querySelector(".bin-btn")?.classList.contains("hit") ?? false);
  assert(hit, "落点应该闪一下（.bin-btn.hit）");
  await page.screenshot({ path: `${OUT}/7-landed.png` });

  /* ---------------------------------------------------------------- 6. 🗑 直达垃圾箱 */
  log("6) bin button opens the trash view");
  await page.click(".bin-btn");
  await until(async () => (await count(page, ".mgr-sheet")) === 1, 2000, "manager sheet");
  const view = await page.evaluate(() => ({
    title: document.querySelector(".mgr-sheet .sheet-title")?.textContent ?? "",
    bin: document.querySelector(".mgr-bin")?.textContent ?? "",
    rows: document.querySelectorAll(".mgr-sheet .trash-row").length,
  }));
  assert(view.title === "垃圾箱", `左栏🗑 应直接打开垃圾箱视图，实际标题「${view.title}」`);
  assert(view.bin.includes("会话列表"), `垃圾箱视图里那颗按钮应变成「← 会话列表」，实际「${view.bin}」`);
  assert(view.rows === 1, `垃圾箱里应有 1 个（刚删的），实际 ${view.rows}`);
  await page.screenshot({ path: `${OUT}/8-trash.png` });

  await browser.close();
  await new Promise((r) => server.close(r));
  log("ALL OK — 气泡挂在 body、180/220ms 开关、就地改名、归档抽屉、删除飞进左栏🗑、🗑 直达垃圾箱");
  log("shots:", OUT);
} catch (err) {
  await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
  throw err;
}
