/**
 * Probe: D92 — 终端是顶栏「产物」旁边那颗按钮弹出的 dialog。
 *
 * 要验四件事：
 *   1. 位置：顶栏 `[data-act]` 的顺序是 产物 → 终端 → 文件管理器，右栏（需要你）里那颗「打开终端」已经没了；
 *   2. 弹出 / 最小化：「－」只是把 dialog 收起来，标签还在，顶栏按钮亮着并写着数量；
 *   3. 进程一直在跑：收起期间从另一个 WS 往同一个 shell 打一条命令，再打开还能在同一个标签里看到它；
 *   4. 刷新页面后不自动弹窗，按钮上有数量，点一下回到同一个进程（桥把缓冲 replay 回来）。
 *
 * Run: npm run build:web && node probes/term-dialog.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "web/dist");
const ROOT = path.join(REPO, ".scratch/term-dialog");
const STATE = path.join(ROOT, "state");
const WORK = path.join(ROOT, "work");
const SHOTS = path.join(ROOT, "shots");
const PORT = 7898;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(150);
  }
  log("timeout waiting for", what);
  return false;
};

// --- a real bridge (node-pty lives there) with its own state, so nothing of yours is touched ------
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
const child = spawn(process.execPath, [path.join(REPO, "bridge/dist/index.js")], {
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_ROOT: DIST, PI_WEB_NO_EXT: "1" },
});
const bridgeLog = [];
child.stdout.on("data", (b) => bridgeLog.push(String(b)));
child.stderr.on("data", (b) => bridgeLog.push(String(b)));
const stop = () => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
};
process.on("exit", stop);
for (let i = 0; i < 100; i += 1) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(200);
}
const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
ok(Boolean(cookie), "logged in");

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  // 页面先建 WS / 拉 /api/me 再被 401 挡在登录页，这条 401 是登录流程自己的，不算这次变更的错。
  if (m.type() === "error" && !m.text().includes("401 (Unauthorized)")) errors.push(m.text().slice(0, 200));
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', pass);
  await page.click('button:has-text("进入")');
}
await page.waitForSelector(".session-card, .new-session", { timeout: 15000 });

// A session whose cwd is the fixture dir, so the shell starts somewhere harmless (and 产物 shows up).
await page.evaluate(async (cwd) => {
  const ws = new WebSocket(`${location.origin.replace("http", "ws")}/ws`);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.send(JSON.stringify({ type: "create", cwd, name: "终端 dialog" }));
  await new Promise((r) => {
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "session" || m.type === "session.state") r();
      } catch {
        /* not ours */
      }
    });
    setTimeout(r, 15000);
  });
  ws.close();
}, WORK);
await sleep(1200);
await page.locator(".session-card").first().click();
await sleep(600);

// --- 1. placement --------------------------------------------------------------------------------
const acts = await page.locator(".topbar [data-act]").evaluateAll((ns) => ns.map((n) => n.dataset.act));
const iArt = acts.indexOf("artifacts");
const iTerm = acts.indexOf("terminal");
ok(iArt >= 0 && iTerm === iArt + 1, `顶栏 产物 右边就是 终端（${acts.join(" → ")}）`);
ok((await page.locator('.queue [data-act="terminal"]').count()) === 0, "右栏（需要你）里那颗「打开终端」已经搬走");
const termBtn = page.locator('.topbar [data-act="terminal"]');
ok((await termBtn.innerText()).includes("终端"), `按钮写着「${(await termBtn.innerText()).trim()}」`);
ok(!(await termBtn.getAttribute("class")).includes("term-live"), "还没有 shell 时按钮不亮");

// --- 2. open → minimize --------------------------------------------------------------------------
await termBtn.click();
ok(await until(async () => page.locator(".term-dock").isVisible(), 15000, "dialog visible"), "点按钮弹出 dialog");
ok(await until(async () => (await page.locator(".term-tab").count()) === 1, 15000, "one tab"), "dialog 里一个标签");
const shellId = await page.locator(".term-tab").getAttribute("data-id");
const rows = page.locator(".term-dock .xterm-rows");
await until(async () => (await rows.innerText()).trim().length > 0, 20000, "shell banner");

// --- 2b. dialog 顶边还是那条拖高度的抓取带（Q-026 的行为没被 dialog 改掉）-------------------
await sleep(300); // 弹出动画结束再量
const grip = page.locator(".term-grip");
const dock = page.locator(".term-dock");
const geom = () =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("pi.termGeom") ?? "null");
    } catch {
      return null; // 存坏了就当没存
    }
  });
const h0 = (await dock.boundingBox()).height;
const gb = await grip.boundingBox();
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await page.mouse.down();
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2 - 120, { steps: 8 });
await page.mouse.up();
await sleep(250);
const h1 = (await dock.boundingBox()).height;
const savedGrip = await geom();
ok(h1 > h0 + 60, `拖顶边把 dialog 拉高了（${Math.round(h0)} → ${Math.round(h1)}）`);
ok(savedGrip && Math.abs(savedGrip.h - h1) <= 2, `高度进了存储（pi.termGeom.h=${savedGrip?.h}）`);
await grip.dblclick();
await sleep(250);
ok((await geom()) === null, "双击抓取带忘掉几何");
ok((await dock.boundingBox()).height < h1 - 40, "双击回到默认高度");

// --- 2c. D93：标题栏能拖动整个 dialog，右下角能拖大拖小 ------------------------------------
const b0 = await dock.boundingBox();
const hb = await page.locator(".term-head").boundingBox();
// 标题栏中间是 spacer（两边分别是标签 / ＋ 和 管理员 / － / 关闭），那里才是「拖走」
await page.mouse.move(hb.x + hb.width * 0.55, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + hb.width * 0.55 - 60, hb.y + hb.height / 2 - 80, { steps: 10 });
await page.mouse.up();
await sleep(250);
const b1 = await dock.boundingBox();
ok(Math.abs(b1.x - (b0.x - 60)) <= 2 && Math.abs(b1.y - (b0.y - 80)) <= 2, `拖标题栏把 dialog 拖走了（${Math.round(b0.x)},${Math.round(b0.y)} → ${Math.round(b1.x)},${Math.round(b1.y)}）`);
ok(Math.abs(b1.width - b0.width) <= 2 && Math.abs(b1.height - b0.height) <= 2, "拖动时大小不变");
const moved = await geom();
ok(moved && moved.l === Math.round(b1.x) && moved.t === Math.round(b1.y), `位置进了存储（l=${moved?.l} t=${moved?.t}）`);

const corner = page.locator(".term-resize");
const cb = await corner.boundingBox();
await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.mouse.down();
await page.mouse.move(cb.x + cb.width / 2 - 300, cb.y + cb.height / 2 - 100, { steps: 10 });
await page.mouse.up();
await sleep(250);
const b2 = await dock.boundingBox();
log("resized:", Math.round(b1.width), "x", Math.round(b1.height), "→", Math.round(b2.width), "x", Math.round(b2.height));
ok(Math.abs(b2.width - (b1.width - 300)) <= 2 && Math.abs(b2.height - (b1.height - 100)) <= 2, "右下拉小：宽和高都跟着指针变");
ok(Math.abs(b2.x - b1.x) <= 2 && Math.abs(b2.y - b1.y) <= 2, "拉大小的时候左上角不动");
const resized = await geom();
ok(resized && Math.abs(resized.w - b2.width) <= 2 && Math.abs(resized.h - b2.height) <= 2, "大小进了存储");
await page.screenshot({ path: path.join(SHOTS, "2-dragged.png") });

await page.locator(".term-body").click();
await page.keyboard.type("echo MK_ALIVE_1");
await page.keyboard.press("Enter");
ok(await until(async () => (await rows.innerText()).includes("MK_ALIVE_1"), 20000, "first marker"), "shell 跑到命令并回显");
await page.screenshot({ path: path.join(SHOTS, "1-open.png") });

await page.locator(".term-btn.min-btn").click();
ok(await until(async () => !(await page.locator(".term-dock").isVisible()), 5000, "minimized"), "「－」把 dialog 收了起来");
ok((await page.locator(".term-tab").count()) === 1, "收起只是藏视图，标签还在");
ok((await termBtn.getAttribute("class")).includes("term-live"), "收起后顶栏按钮亮着");
ok((await termBtn.innerText()).includes("终端"), `按钮还是那颗「${(await termBtn.innerText()).trim()}」`);

// --- 3. the shell kept running while minimized ----------------------------------------------------
const { WebSocket } = await import(pathToFileURL(path.join(REPO, "bridge/node_modules/ws/wrapper.mjs")).href);
const sock = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie } });
const frames = [];
sock.on("message", (raw) => {
  try {
    frames.push(JSON.parse(String(raw)));
  } catch {
    /* not json */
  }
});
await new Promise((r) => sock.on("open", r));
await sleep(400);
sock.send(JSON.stringify({ type: "term.input", id: shellId, data: "echo MK_ALIVE_2\n" }));
const echoed = await until(
  async () => frames.some((f) => f.type === "term.data" && f.id === shellId && String(f.data ?? "").includes("MK_ALIVE_2")),
  15000,
  "echo while minimized",
);
ok(echoed, "收起期间那个 shell 还在收输入、还回显（同一台 pty）");

await termBtn.click();
ok(await until(async () => page.locator(".term-dock").isVisible(), 8000, "reopened"), "再点顶栏按钮回到 dialog");
ok((await page.locator(".term-tab").getAttribute("data-id")) === shellId, "回来的还是同一个标签（没有重新开 shell）");
ok(
  await until(async () => (await page.locator(".term-dock .xterm-rows").innerText()).includes("MK_ALIVE_2"), 15000, "buffered marker"),
  "收起期间打的命令也在里面（缓冲没丢）",
);
await page.screenshot({ path: path.join(SHOTS, "2-reopened.png") });

// --- 4. reload: adopt the shell, but do not pop the dialog open -----------------------------------
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".session-card", { timeout: 15000 });
const adopted = await until(async () => (await page.locator('.topbar [data-act="terminal"]').innerText()).includes("终端"), 8000, "button back");
ok(adopted, "刷新后顶栏按钮回来了");
await sleep(1500);
ok(!(await page.locator(".term-dock").isVisible().catch(() => false)), "刷新后不自动弹窗（收起态起步）");
await page.locator('.topbar [data-act="terminal"]').click();
ok(await until(async () => page.locator(".term-dock").isVisible(), 8000, "dialog after reload"), "点按钮把 dialog 拿回来");
ok((await page.locator(".term-tab").getAttribute("data-id")) === shellId, "刷新后接管的还是那个 shell id");
ok(
  await until(async () => (await page.locator(".term-dock .xterm-rows").innerText()).includes("MK_ALIVE_2"), 15000, "replayed buffer"),
  "桥把缓冲 replay 回来（进程一直在跑）",
);
await sleep(400);
// D93：拖走 / 拖出的位置和大小也是存在 localStorage 的，刷新回来要一模一样。
const b3 = await page.locator(".term-dock").boundingBox();
ok(
  Math.abs(b3.x - resized.l) <= 2 && Math.abs(b3.y - resized.t) <= 2 && Math.abs(b3.width - resized.w) <= 2 && Math.abs(b3.height - resized.h) <= 2,
  `拖走 / 拖出的几何跨刷新还在（${Math.round(b3.x)},${Math.round(b3.y)} ${Math.round(b3.width)}×${Math.round(b3.height)}）`,
);

// --- 4b. 窄屏：dialog 贴两侧，底边让开底部三标签 --------------------------------------------
await page.setViewportSize({ width: 390, height: 820 });
await sleep(600);
ok(await page.locator(".term-dock").isVisible(), "窄屏下 dialog 还在");
const box = await page.locator(".term-dock").boundingBox();
const tabsBox = await page.locator(".tabs").boundingBox();
log("mobile dock box:", JSON.stringify(box), "| tabs:", JSON.stringify(tabsBox));
ok(box.x >= -1 && box.x + box.width <= 391, `dialog 没超出屏幕（${Math.round(box.width)}px 宽）`);
ok(tabsBox && box.y + box.height <= tabsBox.y + 2, "dialog 底边在底部三标签上方，不压住它");
await page.screenshot({ path: path.join(SHOTS, "3-mobile.png") });

// --- 5. × kills it for real ----------------------------------------------------------------------
await page.locator(".term-tab .term-tab-x").click();
ok(await until(async () => (await page.locator(".term-dock").count()) === 0, 6000, "dialog gone"), "× 结束了那个 shell，dialog 也收走");
ok((await termBtn.innerText()).trim() === ">_ 终端", `按钮回到没有数字的「${(await termBtn.innerText()).trim()}」`);
ok(!(await termBtn.getAttribute("class")).includes("term-live"), "没有 shell 了，按钮不亮");

await page.screenshot({ path: path.join(SHOTS, "4-closed.png") });
sock.close();
await browser.close();
if (errors.length) log("page errors:", errors.slice(0, 4));
ok(errors.length === 0, "没有 pageerror / console error");
stop();
if (bad) console.log("\nbridge log tail:\n" + bridgeLog.join("").split("\n").slice(-12).join("\n"));
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
