/**
 * Probe: 从 ★ 行里删掉一颗胶囊之后，行 2 的其余置顶不许一起消失（尤其是被删的那颗正是当前会话时）。
 *
 * 用户的说法：「从横排置顶的会话中，删除会话，当前的横排置顶不显示了，必须要重新点击上方的
 * 工作区之后，才会显示。」
 *
 * 桩桥发真的工作区快照（`hello.workspace`）—— 没有它页面会退回 D210 决定 3 的「旧桥铺全量置顶」
 * 那条腿，`starredRow()` 就不再看有没有当前会话，症状根本不会出现。
 *
 * 五段（落点规则见 D371，与「归档当前会话」的 D176 同一套）：
 *   0. 删一颗**非当前**的 ★：行里只剩另外几颗，当前那颗不动（本来就该这样，防回归）；
 *   1. 删**当前**那颗：行里剩下的 ★ 仍在，落点是 ★ 行的右邻，中栏 / hash 跟着它；
 *   2. 删行尾那颗：右边没有邻居 → 落到左邻；
 *   3. 删到最后一颗：左右都没有 → 现成的「还没有打开会话」空态 + `#/`；
 *   4. 管理面板批量带走当前 + 它的右邻：同批一起消失的那颗不能当邻居，落到再右边那颗。
 *
 * Run: npm run build:web && node probes/pin-delete-current.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7941);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(REPO, ".scratch/pin-delete-current");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
};

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

const CWD = path.join(REPO, ".scratch/probe-work/alpha");
const state = (id, name) => ({
  id, name, cwd: CWD, file: null, owned: true, origin: "web", running: false, done: false,
  updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "", ws: CWD.toLowerCase(),
});
const SESSIONS = [state("pd-a", "考试模块"), state("pd-b", "pi-web-client"), state("pd-c", "文档站"), state("pd-d", "周报")];
const byId = (id) => SESSIONS.find((s) => s.id === id);
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: ["pd-a", "pd-b", "pd-c", "pd-d"], order: [], archived: [] };
/** 把桩桥的会话 / 置顶恢复到出厂（批量那段重开一张页面前用）。 */
const resetFixtures = () => {
  SESSIONS.splice(0, SESSIONS.length, state("pd-a", "考试模块"), state("pd-b", "pi-web-client"), state("pd-c", "文档站"), state("pd-d", "周报"));
  manage.pin = ["pd-a", "pd-b", "pd-c", "pd-d"];
  manage.archived = [];
};
/** 一份真的工作区快照：四颗会话都在同一个工程根下。 */
const workspace = () => ({
  groups: [{ id: CWD.toLowerCase(), key: CWD, name: "alpha", color: "blue", manual: false }],
  overrides: {},
  keys: { [CWD.toLowerCase()]: CWD },
  order: [CWD.toLowerCase()],
  max: 6,
});
const stripOf = ({ items: _drop, ...rest }) => rest;

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
  if (url.pathname === "/api/dirs") return json(200, { path: url.searchParams.get("path") ?? "", parent: "/", dirs: [], files: [], error: "" });
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
const cast = (msg) => {
  for (const client of wss.clients) if (client.readyState === 1) client.send(JSON.stringify(msg));
};
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "subscribe") {
        const s = byId(msg.sessionId);
        if (!s) return;
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: stripOf(s), items: [], approvals: [], asks: [], budget: null }));
        return;
      }
      if (msg.type === "manage" && msg.action === "delete") {
        frames.push(msg);
        const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
        manage.pin = manage.pin.filter((id) => !ids.includes(id));
        for (let i = SESSIONS.length - 1; i >= 0; i -= 1) if (ids.includes(SESSIONS[i].id)) SESSIONS.splice(i, 1);
        cast({ type: "session.gone", ids });
        cast({ type: "manage", manage, workspace: workspace() });
        cast({ type: "trash", items: ids.map((id) => ({ id, name: id, cwd: CWD, file: `x/${id}.jsonl`, deletedAt: Date.now(), size: 1024 })) });
        ws.send(JSON.stringify({ type: "delete.result", removed: ids, binned: ids, released: [], skipped: [] }));
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS.map(stripOf), manage, workspace: workspace(), trash: [], tunnel: TUNNEL }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("stub bridge on", BASE);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" })).newPage();
page.on("pageerror", (e) => log("PAGEERROR", e.message));

/** ★ 行的现场：条在不在、画了哪几颗、当前那颗是谁；外加中栏是谁。 */
const row = () =>
  page.evaluate(() => {
    const host = document.querySelector(".pin-strip");
    return {
      stripHidden: host ? host.hidden : null,
      rowHidden: document.querySelector(".ws-session-row")?.hidden ?? null,
      chips: [...document.querySelectorAll(".pin-strip .pin-chip:not(.pin-new):not(.pin-more)")].map((c) => ({
        name: c.querySelector(".pin-name")?.textContent ?? "",
        cur: c.classList.contains("cur"),
        hidden: c.hidden,
      })),
      hash: location.hash,
      emptyChat: !!document.querySelector(".chat-empty"),
    };
  });

const names = (r) => r.chips.map((c) => c.name).join(" / ");

/** 悬停那颗胶囊 → 气泡 → 删除，等删除帧送达。 */
const deleteChip = async (name) => {
  const chip = page.locator(".pin-strip .pin-chip", { hasText: name }).first();
  await chip.hover();
  await until(async () => (await page.locator(".pin-menu").count()) === 1, 2500, `pin menu for ${name}`);
  await page.click('.pm-item[data-act="delete"]');
  const n = frames.length;
  await until(async () => frames.slice(n).some((f) => f.type === "manage" && f.action === "delete"), 6000, `delete frame for ${name}`);
  await sleep(600);
  // 删除动效会把左栏拉出来（露出那颗🗑）；收起它，回到用户看这条 ★ 行的状态
  const leftOpen = await page.evaluate(() => !document.querySelector(".main")?.classList.contains("no-left"));
  if (leftOpen) {
    await page.locator('.side-toggle[data-side="left"]').click();
    await sleep(500);
  }
};

try {
  // 深链打开 pd-a：它就是「当前会话」，也是第一颗 ★
  await page.goto(`${BASE}/#/s/pd-a`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("pi.collapse.sessions", "1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await row()).chips.length === 4, 8000, "four chips in the row");
  const before = await row();
  log("before:", JSON.stringify(before));
  ok(before.chips[0]?.cur === true && before.chips[0].name === "考试模块", "前置：当前会话是第一颗 ★");
  await page.screenshot({ path: `${OUT}/1-before.png`, clip: { x: 0, y: 0, width: 1280, height: 120 } });

  /* ---------------------------------------------- 0. 删一颗非当前的 ★：其余照旧 */
  log("0) delete a non-current chip");
  await deleteChip("pi-web-client");
  const s0 = await row();
  log("after non-current delete:", JSON.stringify(s0));
  ok(s0.stripHidden === false && s0.rowHidden === false, "删非当前的 ★ 之后，★ 行仍然显示");
  ok(names(s0) === "考试模块 / 文档站 / 周报", `行里剩另外三颗（实际：${names(s0)}）`);
  ok(s0.chips[0]?.cur === true, "当前会话没被动（还是考试模块）");

  /* ---------------------------------------------- 1. 删当前那颗：剩下的 ★ 不许一起消失 */
  log("1) delete the current chip");
  await deleteChip("考试模块");
  const s1 = await row();
  log("after current delete:", JSON.stringify(s1));
  await page.screenshot({ path: `${OUT}/2-after-current-delete.png`, clip: { x: 0, y: 0, width: 1280, height: 120 } });
  ok(s1.stripHidden === false && s1.rowHidden === false, "删当前会话之后，★ 行本身仍然显示（不是 hidden）");
  ok(names(s1) === "文档站 / 周报", `本区剩下的两颗 ★ 仍在行里（实际：${names(s1) || "空"}）`);
  ok(s1.chips.some((c) => c.cur), "落点是剩下的某一颗（有 .cur），不是空态");
  ok(s1.chips.find((c) => c.cur)?.name === "文档站", "右邻优先：落到原来的右邻「文档站」");
  ok(s1.hash === "#/s/pd-c", `地址栏跟着落到它（实际 ${s1.hash}）`);
  ok(!s1.emptyChat, "中栏不是「还没有打开会话」的空态");

  /* ---------------------------------------------- 2. 删行尾那颗：右邻没有就取左邻 */
  log("2) delete the last chip (no right neighbour → left)");
  await deleteChip("周报");
  const s2 = await row();
  log("after deleting the last chip:", JSON.stringify(s2));
  ok(names(s2) === "文档站", `只剩左边那颗（实际：${names(s2) || "空"}）`);
  ok(s2.chips[0]?.cur === true && s2.hash === "#/s/pd-c", "落点是左邻「文档站」，中栏跟着它");

  /* ---------------------------------------------- 3. 左右都没有：空态 */
  log("3) delete the only chip → empty state");
  await deleteChip("文档站");
  const s3 = await row();
  log("after deleting the only chip:", JSON.stringify(s3));
  await page.screenshot({ path: `${OUT}/3-empty.png` });
  ok(s3.stripHidden === false, "一颗 ★ 都没有时 ★ 行本身仍显示（只剩 ＋，与 D210 一致）");
  ok(s3.chips.length === 0, `行里没有胶囊了（实际 ${s3.chips.length}）`);
  ok(s3.hash === "#/", `地址栏回到无会话形态（实际 ${s3.hash}）`);
  ok(s3.emptyChat, "中栏是现成的「还没有打开会话」空态");

  /* ---------------------------------------------- 4. 批量删（管理面板）：同批的邻居要跳过 */
  log("4) bulk delete current + its right neighbour from the manager sheet");
  resetFixtures();
  frames.length = 0;
  await page.goto(`${BASE}/#/s/pd-a`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await row()).chips.length === 4, 8000, "four chips after reset");
  await page.locator('.side-toggle[data-side="left"]').click();
  await sleep(400);
  await page.evaluate(() => document.querySelector('.manage-bar .tool-btn[data-act="manage"]')?.click());
  await page.waitForSelector(".mgr-sheet .mgr-row", { timeout: 5000 });
  await sleep(250);
  // 一次 click 而不是 check()：勾选会触发管理面板整表重画，Playwright 的 check() 会二次点击把它取消。
  // 挑行按 `.mgr-name` 判（行的副标题里有 cwd，它本身就带 "pi-web-client" 这个片段，不能用整行的 hasText）。
  const mgrRow = (name) => page.locator(".mgr-sheet .mgr-row").filter({ has: page.locator(".mgr-name", { hasText: name }) }).first();
  for (const name of ["考试模块", "pi-web-client"]) {
    await mgrRow(name).locator('input[type="checkbox"]').click();
    await sleep(150);
  }
  ok(await page.evaluate(() => document.querySelectorAll(".mgr-sheet .mgr-row input[type=checkbox]:checked").length === 2), "管理面板里勾上了两颗");
  const bulkDel = page.locator(".mgr-sheet .mgr-foot .btn.danger");
  await bulkDel.click();
  await sleep(200);
  await bulkDel.click();
  await until(async () => frames.some((f) => f.type === "manage" && f.action === "delete" && f.ids.length === 2), 6000, "bulk delete frame");
  await sleep(700);
  // 关掉管理面板，左栏收回，回到用户看 ★ 行的状态
  await page.evaluate(() => {
    const head = document.querySelector(".mgr-sheet .sheet-head");
    [...(head?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === "关闭")?.click();
  });
  await sleep(300);
  const leftOpen4 = await page.evaluate(() => !document.querySelector(".main")?.classList.contains("no-left"));
  if (leftOpen4) {
    await page.locator('.side-toggle[data-side="left"]').click();
    await sleep(500);
  }
  const s4 = await row();
  log("after bulk delete:", JSON.stringify(s4));
  ok(names(s4) === "文档站 / 周报", `批量带走当前与右邻之后，剩下的两颗仍在（实际：${names(s4) || "空"}）`);
  ok(s4.chips.find((c) => c.cur)?.name === "文档站", "落点跳过同批被删的右邻，到再右边那颗「文档站」");
  ok(s4.hash === "#/s/pd-c", `地址栏跟着它（实际 ${s4.hash}）`);

  console.log(bad ? `\n${bad} FAIL` : "\nALL OK");
  process.exitCode = bad ? 1 : 0;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
