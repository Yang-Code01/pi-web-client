/**
 * Probe: #49 — 设置 → 扩展与 MCP 顶部那行「pi 本体」：查版本、一键更新、失败强制重装、公网只读。
 *
 * 桩桥只做一件事：按脚本回答 `pi.update.check`，把 `picli` 的 `pkg.update` 当成一次安装去演。
 * 断言量的是页面上的文字和网络里真的发了什么（target / force），不是只看按钮存在。
 *   1. 打开设置 → 扩展与 MCP：显示 `pi 1.4.0`、`最新 1.5.0`、按钮「更新 pi」可点；
 *   2. 点更新 → 确认框写明会替换全局安装的 pi；确认后桥收到 {op:pkg.update, target:self}（不带 force）；
 *   3. 安装成功 → 桥广播新版本 → 行变 `pi 1.5.0` +「已是最新」+ 成功提示 +「重启当前会话」「看更新日志」；
 *   4. 看更新日志 → 切到更新日志页并读到内容；
 *   5. 失败 → 红字 +「强制重装（--force）」，点它确认后桥收到 force:true；
 *   6. 查不到最新版 → 显示错误但「更新 pi」仍可点（pi update 自己会再查）；
 *   7. 重新检查 → 请求带 force:true；
 *   8. 公网 → 按钮禁用 + 桥的只读提示在场。
 *
 * Run: npm run build:web && node probes/pi-update.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7923);
const OUT = path.join(REPO, ".scratch/pi-update/shots");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = REPO;
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
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "1.4.0", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const SES = { id: "probe-pi", name: "pi 更新", cwd: CWD, file: null, owned: true, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "pi" };
const ITEMS = [
  { kind: "user", id: "u1", ts: Date.now() - 60_000, text: "pi 更新" },
  { kind: "assistant", id: "a1", ts: Date.now() - 50_000, model: "pi", text: "在设置里更新 pi 本体。" },
];

/** What the fake registry / installer does next. */
const world = { latest: "1.5.0", reachable: true, installFails: false, checks: [], picli: [] };

/** app 版本比较（探针自己算，避免 import 桥的模块）。 */
const newer = (a, b) => {
  const pa = String(a).replace(/^v/, "").split(/[.+-]/).map((n) => Number(n) || 0);
  const pb = String(b).replace(/^v/, "").split(/[.+-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
};

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
  if (url.pathname === "/api/changelog") {
    return json(200, { version: ME.pi, text: `# ${ME.pi}\n\n- 这个版本是探针造出来的。\n` });
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
  const send = (msg) => ws.send(JSON.stringify(msg));
  const broadcastPi = (version, previous) => {
    for (const c of wss.clients) if (c.readyState === 1) c.send(JSON.stringify({ type: "pi.version", version, previous }));
  };
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      send({ type: "session", sessionId: SES.id, state: SES, items: ITEMS, approvals: [], asks: [], budget: null });
      return;
    }
    if (msg.type === "settings.get") {
      send({ type: "settings", scope: msg.scope ?? "global", cwd: msg.cwd, path: "probe", exists: false, values: {}, raw: "{}" });
      return;
    }
    if (msg.type === "lockext.get") {
      send({ type: "lockext", installed: false, path: "probe" });
      return;
    }
    if (msg.type === "ext.inventory") {
      // D113: a real bridge pushes this in stages; this probe only needs the final shape.
      send({ type: "ext.inventory", cwd: msg.cwd ?? CWD, packages: [], extensions: [], mcp: [], mcpError: null, updates: 0, checkedAt: Date.now(), mcpReady: true, versionsChecked: true });
      return;
    }
    if (msg.type === "pi.update.check") {
      world.checks.push({ force: msg.force === true });
      if (!world.reachable) {
        send({ type: "pi.update.status", current: ME.pi, latest: null, checkedAt: Date.now(), error: "registry 超时；pi.dev 请求超时" });
        return;
      }
      send({
        type: "pi.update.status",
        current: ME.pi,
        latest: world.latest,
        source: "npm registry.npmmirror.com",
        checkedAt: Date.now(),
        update: newer(world.latest, ME.pi),
      });
      return;
    }
    if (msg.type === "picli") {
      world.picli.push(msg);
      const runId = `cli_${world.picli.length}`;
      send({ type: "picli.start", runId, op: msg.op });
      send({ type: "picli.out", runId, text: "$ pi update\n" });
      setTimeout(() => {
        if (world.installFails) {
          send({ type: "picli.out", runId, text: "Error: command failed\n" });
          send({ type: "picli.done", runId, op: msg.op, code: 1 });
          return;
        }
        send({ type: "picli.out", runId, text: `Updated pi from ${ME.pi} to ${world.latest}\n` });
        send({ type: "picli.done", runId, op: msg.op, code: 0 });
        const from = ME.pi;
        ME.pi = world.latest;
        broadcastPi(ME.pi, from);
      }, 120);
    }
  });
  send({ type: "hello", me: ME, sessions: [SES], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL });
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const rowText = async (page) => (await page.locator(".ext-pi").innerText()).replace(/\s+/g, " ");
const openExt = async (page) => {
  await page.getByRole("button", { name: "pi 设置", exact: true }).click();
  await until(async () => (await page.locator(".settings-sheet").count()) === 1, 5000, "settings sheet");
  await page.getByRole("button", { name: "扩展与 MCP", exact: true }).click();
  await until(async () => (await page.locator(".ext-pi").count()) === 1, 5000, "pi row");
  await until(async () => !(await rowText(page)).includes("检查版本中"), 5000, "version check answer");
};

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "messages");

  // 1) 第一眼：当前版本、最新版、可点的更新按钮；懒检查只发了一次（不带 force）
  await openExt(page);
  let text = await rowText(page);
  log("row:", text);
  assert(text.includes("pi 1.4.0"), `行里是当前版本（拿到 ${text}）`);
  assert(text.includes("最新 1.5.0") && text.includes("registry.npmmirror.com"), `行里是最新版本与来源（拿到 ${text}）`);
  assert(world.checks.length === 1 && world.checks[0].force === false, `懒检查只发一次且不带 force（拿到 ${JSON.stringify(world.checks)}）`);
  assert(await page.getByRole("button", { name: "更新 pi", exact: true }).isEnabled(), "更新按钮可点");
  await page.screenshot({ path: path.join(OUT, "1-update-available.png") });

  // 2) 确认框 + 桥收到的请求
  await page.getByRole("button", { name: "更新 pi", exact: true }).click();
  const modal = page.locator(".modal");
  await until(async () => await modal.isVisible(), 4000, "confirm modal");
  const modalText = (await modal.innerText()).replace(/\s+/g, " ");
  log("modal:", modalText);
  assert(modalText.includes("更新 pi？"), `确认框标题（拿到 ${modalText}）`);
  assert(modalText.includes("全局安装的 pi") && modalText.includes("1.4.0 → 1.5.0"), `确认框写明替换什么（拿到 ${modalText}）`);
  // 它是在设置弹层里打开的：z-index 必须高过 .sheet-back（60），否则点不到
  const zs = await page.evaluate(() => ({
    modal: Number(getComputedStyle(document.querySelector(".modal")).zIndex),
    sheet: Number(getComputedStyle(document.querySelector(".sheet-back")).zIndex),
    hit: document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.closest(".modal") !== null,
  }));
  log("z:", zs);
  assert(zs.modal > zs.sheet, `确认框压在设置弹层之上（modal ${zs.modal} / sheet ${zs.sheet}）`);
  assert(zs.hit, "屏幕中心的点击落在确认框上，而不是被弹层截走");
  await page.screenshot({ path: path.join(OUT, "2-confirm.png") });
  await modal.getByRole("button", { name: "更新", exact: true }).click();
  await until(async () => world.picli.length === 1, 4000, "pkg.update request");
  assert(world.picli[0].target === "self" && world.picli[0].force === undefined, `桥收到 target=self 且不带 force（拿到 ${JSON.stringify(world.picli[0])}）`);

  // 3) 成功：版本号刷新、已是最新、重启与更新日志入口
  await until(async () => (await rowText(page)).includes("pi 1.5.0"), 6000, "version refresh");
  text = await rowText(page);
  log("row after update:", text);
  assert(text.includes("已是最新"), `成功后显示已是最新（拿到 ${text}）`);
  assert(text.includes("已更新到 1.5.0"), `成功提示带新版本（拿到 ${text}）`);
  assert(text.includes("已开着的会话仍是旧版本"), `提示旧会话仍是旧版本（拿到 ${text}）`);
  assert(await page.getByRole("button", { name: "重启当前会话", exact: true }).isVisible(), "重启当前会话在场");
  const out = await page.locator(".cli-out").innerText().catch(() => "");
  assert(out.includes("Updated pi from 1.4.0 to 1.5.0"), `控制台有 pi 的输出（拿到 ${out.slice(0, 80)}）`);
  await page.screenshot({ path: path.join(OUT, "3-updated.png") });

  // 4) 看更新日志：切页并读到 /api/changelog
  await page.getByRole("button", { name: "看更新日志", exact: true }).click();
  await until(async () => (await page.locator(".settings-changelog").innerText().catch(() => "")).includes("探针造出来"), 5000, "changelog body");
  assert((await page.locator(".chip.on").innerText()).includes("更新日志"), "看更新日志真的切到了更新日志页");
  await page.screenshot({ path: path.join(OUT, "4-changelog.png") });

  // 5) 升级失败 → 强制重装；桥必须收到 force:true
  world.installFails = true;
  world.latest = "1.6.0";
  ME.pi = "1.4.0";
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card after reload");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "messages after reload");
  await openExt(page);
  await until(async () => await page.getByRole("button", { name: "更新 pi", exact: true }).isVisible(), 5000, "update button");
  await page.getByRole("button", { name: "更新 pi", exact: true }).click();
  await page.locator(".modal").getByRole("button", { name: "更新", exact: true }).click();
  await until(async () => (await rowText(page)).includes("更新失败"), 6000, "failure notice");
  text = await rowText(page);
  log("row after failure:", text);
  assert(text.includes("强制重装（--force）"), `失败后给强制重装（拿到 ${text}）`);
  await page.screenshot({ path: path.join(OUT, "5-failed.png") });
  await page.getByRole("button", { name: "强制重装（--force）", exact: true }).click();
  const forceModal = (await page.locator(".modal").innerText()).replace(/\s+/g, " ");
  assert(forceModal.includes("强制重装 pi？"), `强制重装的确认框文案不同（拿到 ${forceModal}）`);
  await page.locator(".modal").getByRole("button", { name: "强制重装", exact: true }).click();
  await until(async () => world.picli.at(-1)?.force === true, 4000, "forced pkg.update");
  log("forced request:", JSON.stringify(world.picli.at(-1)));

  // 6) 查不到最新版：报错误，但更新按钮仍可点（pi update 自己会再查）
  world.installFails = false;
  world.reachable = false;
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card after reload 2");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "messages after reload 2");
  await openExt(page);
  text = await rowText(page);
  log("row without registry:", text);
  assert(text.includes("没查到最新版"), `显示查不到最新版（拿到 ${text}）`);
  assert(text.includes("pi.dev 请求超时"), `把两处失败原因都带上（拿到 ${text}）`);
  const stillThere = page.getByRole("button", { name: "更新 pi", exact: true });
  assert(await stillThere.isVisible() && await stillThere.isEnabled(), "查不到最新版时更新按钮仍在且可点");
  await page.screenshot({ path: path.join(OUT, "6-no-registry.png") });

  // 7) 重新检查绕过缓存
  const before = world.checks.length;
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await until(async () => world.checks.length === before + 1, 4000, "recheck request");
  assert(world.checks.at(-1).force === true, `重新检查带 force:true（拿到 ${JSON.stringify(world.checks.at(-1))}）`);

  // 8) 公网：只读，按钮禁用
  world.reachable = true;
  ME.public = true;
  ME.pi = "1.4.0";
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card after reload 3");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "messages after reload 3");
  await openExt(page);
  const pubBtn = page.getByRole("button", { name: "更新 pi", exact: true });
  assert(await pubBtn.isVisible(), "公网仍看得到这行");
  assert(!(await pubBtn.isEnabled()), "公网时更新按钮禁用");
  const bodyText = (await page.locator(".settings-body").innerText()).replace(/\s+/g, " ");
  assert(bodyText.includes("只能查看"), `公网只读提示在场（拿到 ${bodyText.slice(0, 120)}）`);
  await page.screenshot({ path: path.join(OUT, "7-public.png") });

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
