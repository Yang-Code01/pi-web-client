/**
 * Probe: 工作区管理（#100）—— 组头 ⋯ 的改名 / 删除，树底「新建工作区」。
 *
 * 桩桥照 `bridge/src/workspaces.ts` 的规矩回话（rename 存 trim+slice(0,80)、空名=回落目录名；
 * create 给一个新 id；drop 只肯删空的手动组；move 空 wsId = 删 override）。断言：
 *   1. 组头有 ⋯，菜单三行（重命名 / 移到最前 / 删除工作区）；#177 的「移到最前」在这里只占位，
 *      标签行本身的探针在 `probes/workspace-tabs.mjs`；
 *   2. 有会话的工作区可发起删除确认；会话列表完整展示，取消不发 ws.delete；
 *   3. 改名：输入框进组头，Enter 提交的是洗过的名字（折叠空白），组头立刻变；
 *   4. 清空名字：发的是空串，组头回落到目录名；
 *   5. Esc 取消：一个字都不发；
 *   6. 新建工作区：ws.create 发出去，空组立刻在树里（空态），并直接进改名态；
 *   7. 组里有会话时可以打开确认框；取消不删除；会话被挪回工程后，空组也可确认删除；
 *   9. 矮窗口 + 组头贴着窗口底：菜单整块留在窗口里（翻到组头上方，或自己滚），
 *      「删除工作区」不能被窗口裁掉半行。
 *
 * Run: npm run build:web && node probes/workspace-manage.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.WS_DIST ? path.resolve(process.env.WS_DIST) : path.join(REPO, "web/dist");
const SHOT = process.env.WS_SHOT ?? "workspace-manage";
const PORT = Number(process.env.PI_WEB_PORT ?? 7907);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

/* ---------------- 桩桥：只实现这张票会用到的几条消息 ---------------- */

const LIB = { id: "f:/demo/lib", name: "library", key: "F:/demo/lib", manual: false };
const WORKSPACE = { groups: [LIB], overrides: {}, keys: {} };
/** 桥收到过的 manage 动作（探针按它断言「发了没有、参数是什么」）。 */
const CALLS = [];

let n = 0;
const state = (id, name, cwd, ws) => ({
  id,
  name,
  cwd,
  ws,
  file: null,
  owned: false,
  origin: "disk",
  running: false,
  done: false,
  updatedAt: Date.now() - ++n * 1000,
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
});
const SESSIONS = [state("s-a", "改左栏", "F:/demo/lib", LIB.id), state("s-b", "写脚本", "F:/demo/lib", LIB.id)];
let MANUAL = null; // 新建出来的那个组

/** 桥的 groupFor：override 优先，查不到回落 cwd 的派生组。 */
const groupFor = (s) => WORKSPACE.overrides[s.id] ?? s.cwd ?? "";

const MANAGE = { pin: [], order: [], archived: [] };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/healthz") return json(200, { ok: true });
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
      const s = SESSIONS.find((x) => x.id === msg.sessionId);
      if (msg.type === "subscribe" && s) {
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items: [], approvals: [], asks: [], budget: null }));
      }
      if (msg.type !== "manage") return;
      // 页面会顺手发点别的（opened 之类），记下来但只处理 ws.*。
      if (msg.action === "opened") {
        MANAGE.pin = [String(msg.id), ...MANAGE.pin.filter((x) => x !== msg.id)];
        cast({ type: "manage", manage: MANAGE });
        return;
      }
      if (!String(msg.action ?? "").startsWith("ws.")) return;
      CALLS.push({ action: msg.action, id: msg.id, name: msg.name, wsId: msg.wsId, ids: msg.ids, sessionIds: msg.sessionIds });

      if (msg.action === "ws.rename") {
        const g = WORKSPACE.groups.find((x) => x.id === msg.id);
        if (g) g.name = String(msg.name ?? "").trim().slice(0, 80); // 空串 = 回落目录名
        cast({ type: "workspaces", workspace: WORKSPACE });
        return;
      }
      if (msg.action === "ws.create") {
        const id = `manual:p${WORKSPACE.groups.length}`;
        const group = { id, name: String(msg.name ?? "").trim().slice(0, 80), key: "", manual: true };
        WORKSPACE.groups.push(group);
        MANUAL = group;
        cast({ type: "workspaces", workspace: WORKSPACE });
        return;
      }
      if (msg.action === "ws.delete") {
        const id = String(msg.id ?? "");
        const members = SESSIONS.filter((session) => groupFor(session) === id).map((session) => session.id);
        const expected = Array.isArray(msg.sessionIds) ? msg.sessionIds.map(String).sort() : members.slice().sort();
        if (!WORKSPACE.groups.some((g) => g.id === id) || expected.join("\n") !== members.slice().sort().join("\n")) {
          ws.send(JSON.stringify({ type: "ws.delete.result", id, deleted: false, reason: "工作区里的会话已变化，请重新确认", skipped: [] }));
          return;
        }
        for (let i = SESSIONS.length - 1; i >= 0; i--) if (members.includes(SESSIONS[i].id)) SESSIONS.splice(i, 1);
        WORKSPACE.groups = WORKSPACE.groups.filter((g) => g.id !== id);
        WORKSPACE.order = (WORKSPACE.order ?? []).filter((x) => x !== id);
        for (const [sid, wid] of Object.entries(WORKSPACE.overrides)) if (wid === id) delete WORKSPACE.overrides[sid];
        cast({ type: "workspaces", workspace: WORKSPACE });
        ws.send(JSON.stringify({ type: "ws.delete.result", id, deleted: true, removed: members, binned: members, skipped: [], released: [] }));
        return;
      }
      if (msg.action === "ws.drop") {
        const g = WORKSPACE.groups.find((x) => x.id === msg.id);
        const n = Object.values(WORKSPACE.overrides).filter((x) => x === msg.id).length;
        let reason = null;
        if (!g) reason = "这个工作区不在了";
        else if (!g.manual) reason = "这个工作区跟着目录走，不能删";
        else if (n > 0) reason = `这个工作区里还有 ${n} 个会话，先把它们拖回工程或删掉`;
        if (reason) {
          cast({ type: "notice", text: reason, level: "warn" });
          return;
        }
        WORKSPACE.groups = WORKSPACE.groups.filter((x) => x.id !== msg.id);
        cast({ type: "workspaces", workspace: WORKSPACE });
        return;
      }
      if (msg.action === "ws.move") {
        // 探针用不到拖拽（#99），但「会话被挪出去」这一步要能从桩里做：wsId 空 = 删 override。
        for (const sid of msg.ids ?? []) {
          if (msg.wsId) WORKSPACE.overrides[sid] = msg.wsId;
          else delete WORKSPACE.overrides[sid];
        }
        for (const x of SESSIONS) x.ws = groupFor(x);
        cast({ type: "workspaces", workspace: WORKSPACE });
        cast({ type: "sessions.list", sessions: SESSIONS, workspace: WORKSPACE });
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, workspace: WORKSPACE, trash: [], tunnel: TUNNEL }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1180, height: 900 }, locale: "zh-CN" });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

const passGate = async () => {
  await page.waitForSelector(".session-card, .ws-head", { timeout: 15000 });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', "probe");
    await page.click('button:has-text("进入")');
    await page.waitForSelector(".session-card, .ws-head", { timeout: 15000 });
  }
};

/** 左栏现在的树：组名 / 数量 / 组内卡片 / 空态。 */
const tree = () =>
  page.evaluate(() => ({
    groups: [...document.querySelectorAll(".ws-sec")].map((sec) => ({
      id: sec.dataset.ws ?? "",
      name: sec.querySelector(".ws-head .label")?.textContent ?? "",
      editing: Boolean(sec.querySelector(".ws-rename-input")),
      draft: sec.querySelector(".ws-rename-input")?.value ?? null,
      focused: sec.contains(document.activeElement) && document.activeElement?.classList.contains("ws-rename-input") === true,
      count: sec.querySelector(".ws-head .n")?.textContent ?? "",
      cards: [...sec.querySelectorAll(".session-card")].map((c) => c.dataset.id),
      empty: sec.querySelector(".ws-empty")?.textContent?.trim() ?? null,
    })),
    menu: (() => {
      const m = document.querySelector(".ws-menu");
      if (!m) return null;
      return {
        head: m.querySelector(".pm-name")?.textContent ?? "",
        items: [...m.querySelectorAll(".pm-item")].map((b) => ({
          act: b.dataset.act,
          text: b.querySelector(".pm-text")?.textContent?.trim() ?? b.textContent?.trim() ?? "",
          disabled: b.disabled,
        })),
        whys: [...m.querySelectorAll(".pm-why")].map((n) => n.textContent?.trim() ?? ""),
        dropWhy: m.querySelector(".pm-why[data-for='drop']")?.textContent?.trim() ?? null,
      };
    })(),
    newRow: document.querySelector(".ws-new-btn")?.textContent?.trim() ?? null,
  }));

const more = (id) => page.locator(`.ws-sec[data-ws="${id}"] .ws-head .ws-more`);
/** ⋯ 跟会话卡片的按钮一样只在指着组头时出现：先 hover 组头，再点。 */
const openMore = async (id) => {
  await page.locator(`.ws-sec[data-ws="${id}"] .ws-head`).hover();
  await more(id).click();
};
const callOf = (action) => CALLS.filter((c) => c.action === action).at(-1) ?? null;

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await passGate();
await sleep(400);

// 0) 左侧工作区行要有足够大的纵向点击区域。
const wsHeadHeight = await page.locator(`.ws-sec[data-ws="${LIB.id}"] .ws-head`).evaluate((node) => node.getBoundingClientRect().height);
ok(wsHeadHeight >= 36, `工作区行高度至少 36px（当前 ${wsHeadHeight.toFixed(1)}px）`);

// 1) 组头有 ⋯，树底有「新建工作区」
let t = await tree();
ok(t.groups.length === 1 && t.groups[0].name === "library", `开局一个派生组：${t.groups.map((g) => g.name).join(" / ")}`);
ok((await more(LIB.id).count()) === 1, "组头有 ⋯ 按钮");
ok(/新建工作区/.test(t.newRow ?? ""), `树底有「${t.newRow}」`);

// 2) 有会话的派生组：删除项可点，显示会话清单，取消不发 ws.delete
await openMore(LIB.id);
await sleep(200);
t = await tree();
ok(Boolean(t.menu), "点 ⋯ 弹出菜单");
ok(t.menu?.items.map((i) => i.text).join(" / ") === "重命名 / 移到最前 / 删除工作区", `菜单三行：${t.menu?.items.map((i) => i.text).join(" / ")}`);
const del = t.menu?.items.find((i) => i.act === "drop");
ok(del?.disabled === false, "有会话的目录工作区仍可发起删除确认");
if (del?.disabled === false) {
  await page.locator(".ws-menu .pm-item[data-act='drop']").click();
  await sleep(200);
  const dialog = await page.evaluate(() => ({
    title: document.querySelector(".ws-delete-sheet .sheet-title")?.textContent?.trim() ?? "",
    names: [...document.querySelectorAll(".ws-delete-session .ws-delete-name")].map((n) => n.textContent?.trim() ?? ""),
  }));
  ok(Boolean(dialog.title), "删除前打开工作区会话确认对话框");
  ok(dialog.names.includes("改左栏") && dialog.names.includes("写脚本"), `确认框列出工作区会话（${dialog.names.join(" / ")}）`);
  await page.locator(".ws-delete-sheet [data-act='cancel']").click();
  await sleep(150);
  ok((await page.locator(".ws-delete-sheet").count()) === 0, "取消后关闭确认框，不删除工作区");
  await openMore(LIB.id);
  await sleep(150);
}
await page.keyboard.press("Escape");
await sleep(150);
ok((await page.locator(".ws-menu").count()) === 0, "Esc 关掉菜单");
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-menu.png`), clip: { x: 0, y: 0, width: 380, height: 820 } });

// 3) 改名：输入框进组头，提交的是洗过的名字
await openMore(LIB.id);
await sleep(150);
await page.locator(".ws-menu .pm-item[data-act='rename']").click();
await sleep(250);
t = await tree();
ok(t.groups[0]?.editing === true && t.groups[0]?.draft === "library", "重命名：组头换成输入框，里面是当前名字");
ok(t.groups[0]?.focused === true, "输入框自动获得焦点（并且全选）");
await page.fill(".ws-sec .ws-rename-input", "  我的  图书馆  ");
await page.keyboard.press("Enter");
await sleep(300);
t = await tree();
ok(callOf("ws.rename")?.name === "我的 图书馆", `发出去的 name 洗过（"${callOf("ws.rename")?.name}"）`);
ok(t.groups[0]?.name === "我的 图书馆" && t.groups[0]?.editing === false, `组头立刻变成「${t.groups[0]?.name}」`);

// 4) Esc 取消：一个字都不发
const sentBefore = CALLS.length;
await openMore(LIB.id);
await sleep(150);
await page.locator(".ws-menu .pm-item[data-act='rename']").click();
await sleep(200);
await page.fill(".ws-sec .ws-rename-input", "不想改");
await page.keyboard.press("Escape");
await sleep(250);
t = await tree();
ok(CALLS.length === sentBefore, "Esc 取消后没有新的 ws.* 请求");
ok(t.groups[0]?.name === "我的 图书馆", "组名没变");

// 5) 清空名字 = 恢复成目录名
await openMore(LIB.id);
await sleep(150);
await page.locator(".ws-menu .pm-item[data-act='rename']").click();
await sleep(200);
await page.fill(".ws-sec .ws-rename-input", "");
await page.keyboard.press("Enter");
await sleep(300);
ok(callOf("ws.rename")?.name === "", "清空后发的是空串");
t = await tree();
ok(t.groups[0]?.name === "lib", `组头回落成目录名（library → ${t.groups[0]?.name}）`);

// 6) 新建工作区：先建空组、立刻进改名态
await page.locator(".ws-new-btn").click();
await sleep(350);
ok(callOf("ws.create") !== null, "点了就发 ws.create");
t = await tree();
const born = t.groups.find((g) => g.id === MANUAL?.id);
ok(Boolean(born), `新组出现在树里（${t.groups.map((g) => g.name).join(" / ")}）`);
ok(born?.empty === "这个工作区里还没有会话。", "新组是空的，显示空态");
ok(born?.editing === true && born?.focused === true, "新组直接进改名态、输入框有焦点");
await page.fill(".ws-sec .ws-rename-input", "临时组");
await page.keyboard.press("Enter");
await sleep(300);
t = await tree();
ok(t.groups.find((g) => g.id === MANUAL?.id)?.name === "临时组", "给它起了名字，组头就是新名字");

// 7) 会话被拖进这个空组（#99 的动作，这里从桩里做）→ 组有会话时仍可打开确认框
await page.evaluate(() => {}); // 留一拍：让上面的广播落定
CALLS.push({ action: "ws.move", ids: ["s-a"], wsId: "manual:p1" });
WORKSPACE.overrides["s-a"] = MANUAL.id;
for (const x of SESSIONS) x.ws = groupFor(x);
cast({ type: "workspaces", workspace: WORKSPACE });
cast({ type: "sessions.list", sessions: SESSIONS, workspace: WORKSPACE });
await sleep(350);
t = await tree();
ok(t.groups.find((g) => g.id === MANUAL?.id)?.cards.join() === "s-a", "挪进组的会话显示在这个组里（落点是 .session-cards）");
await openMore(MANUAL.id);
await sleep(200);
t = await tree();
ok(t.menu?.items.find((i) => i.act === "drop")?.disabled === false, "有会话的手动组：删除项可以打开确认");
await page.locator(".ws-menu .pm-item[data-act='drop']").click();
await sleep(200);
const manualDeleteNames = await page.locator(".ws-delete-session .ws-delete-name").allTextContents();
ok(manualDeleteNames.includes("改左栏"), `手动组确认框列出会话（${manualDeleteNames.join(" / ")}）`);
await page.locator(".ws-delete-sheet [data-act='cancel']").click();
await sleep(150);

// 8) 会话被挪回工程（ws.move 空 wsId）→ 组空了 → 能删；会话落在 cwd 推出来的组里
WORKSPACE.overrides = {};
for (const x of SESSIONS) x.ws = groupFor(x);
cast({ type: "workspaces", workspace: WORKSPACE });
cast({ type: "sessions.list", sessions: SESSIONS, workspace: WORKSPACE });
await sleep(350);
t = await tree();
ok(t.groups.find((g) => g.id === MANUAL?.id)?.cards.length === 0, "会话挪回去后手动组又空了");
ok(t.groups.find((g) => g.id === LIB.id)?.cards.join() === "s-a,s-b", "两个会话都在按 cwd 推出来的 library 组里");
await openMore(MANUAL.id);
await sleep(200);
t = await tree();
ok(t.menu?.items.find((i) => i.act === "drop")?.disabled === false, "空的手动组可以删");
ok(t.menu?.dropWhy === null, "能删的时候删除项不显示原因行");
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-drop.png`), clip: { x: 0, y: 0, width: 380, height: 820 } });
await page.locator(".ws-menu .pm-item[data-act='drop']").click();
await sleep(350);
await page.locator(".ws-delete-sheet [data-act='confirm']").click();
await sleep(350);
ok(callOf("ws.delete")?.id === MANUAL.id, `确认后发出去的是 ws.delete ${callOf("ws.delete")?.id}`);
t = await tree();
ok(!t.groups.some((g) => g.id === MANUAL?.id), `组从树里消失（现在只有 ${t.groups.map((g) => g.name).join(" / ")}）`);

// 9) 矮窗口：组头贴着窗口底时菜单不能戳出窗口（bug：「删除工作区」只剩半行）。
//    左栏能滚十几组，所以「组头就在窗口最底下」是日常状态，不是边角。
//    每一档都按实测几何算「该翻还是该贴下方」，不做条件跳过：翻不翻都得有断言。
for (const vh of [900, 480, 420, 380, 300, 200]) {
  await page.setViewportSize({ width: 1180, height: vh });
  await sleep(300);
  await openMore(LIB.id);
  await sleep(250);
  const box = await page.evaluate((sel) => {
    const node = document.querySelector(".ws-menu");
    if (!node) return null;
    const r = node.getBoundingClientRect();
    const h = document.querySelector(sel + " .ws-more").getBoundingClientRect();
    const rows = [...node.querySelectorAll(".pm-item, .pm-why")].map((e) => {
      const q = e.getBoundingClientRect();
      return { text: (e.textContent ?? "").trim().slice(0, 8), top: q.top, bottom: q.bottom };
    });
    return {
      top: r.top,
      bottom: r.bottom,
      headTop: h.top,
      headBottom: h.bottom,
      headRow: document.querySelector(sel).getBoundingClientRect().top,
      ih: innerHeight,
      clientH: node.clientHeight,
      scrollH: node.scrollHeight,
      rows,
      scrolls: node.scrollHeight > node.clientHeight + 1,
    };
  }, `.ws-sec[data-ws="${LIB.id}"] .ws-head`);
  ok(Boolean(box), `${vh}px 窗口：⋯ 菜单打得开`);
  if (!box) continue;
  // 菜单整块在窗口里：位置夹进 8px 边距，高度封到窗口装得下的程度。
  ok(box.top >= -0.5 && box.bottom <= box.ih + 0.5, `${vh}px 窗口：菜单整块在窗口里（${Math.round(box.top)}..${Math.round(box.bottom)} / ${box.ih}）`);
  // 期望的落位方向由实测几何决定（和 placeMenu 同一条规矩），所以每一档都得对上，不存在「跳过」。
  const natural = box.scrollH + 2; // scrollHeight 不含 1px 上下边框
  const roomBelow = box.ih - box.headBottom - 4 - 8;
  const roomAbove = box.headTop - 4 - 8;
  const wantFlip = natural > roomBelow && roomAbove > roomBelow;
  ok(box.top < box.headTop - 1 === wantFlip, `${vh}px 窗口：${wantFlip ? `下方只剩 ${Math.round(roomBelow)}px，翻到组头上方` : `下方放得下 ${Math.round(roomBelow)}px，贴在组头下方`}（顶 ${Math.round(box.top)} / 组头 ${Math.round(box.headBottom)}）`);
  if (!wantFlip) ok(Math.abs(box.top - (box.headBottom + 4)) <= 1, `${vh}px 窗口：贴着组头下方 4px`);
  if (wantFlip) await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-menu-flip-${vh}.png`) });
  if (box.scrolls) {
    // 封顶生效：菜单自己滚，「删除工作区」滚得出来、点得到。
    const reach = await page.evaluate(() => {
      const n = document.querySelector(".ws-menu");
      const row = n.querySelector(".pm-item[data-act='drop']");
      row.scrollIntoView({ block: "nearest" });
      const a = row.getBoundingClientRect();
      const b = n.getBoundingClientRect();
      return { inside: a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5, h: n.clientHeight };
    });
    ok(reach.inside, `${vh}px 窗口：菜单封顶到 ${reach.h}px 自己滚，「删除工作区」滚得出来`);
  }
  await page.keyboard.press("Escape");
  await sleep(150);
}
await page.setViewportSize({ width: 1180, height: 900 });

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
