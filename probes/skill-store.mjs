/**
 * 技能商店（D126）：输入框「技能」面板底部的「商店」按钮，打开一个 dialog——skills.sh 搜索、
 * 装到全局 / 当前项目、按地址安装、已安装列表与 4 秒二次确认卸载。
 *
 * 桩桥 + 真 Chromium（`web/dist` 的静态文件）：不联网、不碰本机技能目录，只验证页面把该发的
 * 消息发出去、该说的话说出来。真实安装 / 卸载的磁盘行为在 `bridge/tests/skill-store.mjs`。
 *
 * 跑：npm --prefix web run build && node probes/skill-store.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7925);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(REPO, ".scratch", "skill-store", "shots");
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(80);
  }
  throw new Error(`超时：${what}`);
};

const SESSION = {
  id: "probe-store",
  name: "技能商店探针",
  cwd: REPO,
  file: null,
  owned: true,
  origin: "web",
  running: false,
  done: false,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  locked: false,
  preview: "技能商店",
  permission: "ask",
};

const SKILLS = [
  { name: "code-review", description: "审查分支改动", source: "user", uses: 2, lastUsed: 2_000 },
  { name: "grilling", description: "拷问计划", source: "user", uses: 1, lastUsed: 1_000 },
];

const STORE = [
  {
    id: "anthropics/skills/pdf",
    name: "pdf",
    source: "anthropics/skills",
    installs: 223195,
    description: "Use this skill whenever the user wants to do anything with PDF files.",
    dir: "skills/pdf",
  },
  {
    id: "vercel-labs/json-render/react-pdf",
    name: "react-pdf",
    source: "vercel-labs/json-render",
    installs: 2340,
    description: "Render PDFs from JSON.",
    dir: "skills/react-pdf",
  },
  {
    id: "acme/moved/skill-x",
    name: "skill-x",
    source: "acme/moved",
    installs: 5,
    description: "",
    dir: null,
    note: "404 not found",
  },
];

const INSTALLED = [
  { name: "code-review", description: "审查分支改动", source: "user", uses: 2, lastUsed: 2_000, path: path.join(REPO, ".scratch", "skill-store", "home", ".pi", "agent", "skills", "code-review"), root: path.join(REPO, ".scratch", "skill-store", "home", ".pi", "agent", "skills"), link: false, removable: true, from: "anthropics/skills", installedAt: Date.now() },
  { name: "grilling", description: "拷问计划", source: "user", uses: 1, lastUsed: 1_000, path: path.join(REPO, ".scratch", "skill-store", "home", ".agents", "skills", "grilling"), root: path.join(REPO, ".scratch", "skill-store", "home", ".agents", "skills"), link: true, removable: true, from: null, installedAt: null },
  { name: "pi-web-client-test-dev", description: "起测试环境", source: "project", uses: 0, lastUsed: 0, path: path.join(REPO, ".pi", "skills", "pi-web-client-test-dev"), root: path.join(REPO, ".pi", "skills"), link: false, removable: false, from: null, installedAt: null },
];

const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const seen = { store: [], install: [], remove: [], installed: [], source: [] };
let sock = null;
const reply = (msg) => sock?.readyState === 1 && sock.send(JSON.stringify(msg));

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" }));
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

let installedItems = INSTALLED.map((s) => ({ ...s }));

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
      ws.send(
        JSON.stringify({
          type: "session",
          sessionId: SESSION.id,
          state: { ...SESSION },
          items: [{ kind: "user", id: "u1", text: "这里是一条历史消息。" }],
          approvals: [],
          asks: [],
          budget: null,
        }),
      );
    } else if (msg.type === "skills") {
      reply({ type: "skills", sessionId: SESSION.id, commands: SKILLS.map((s) => ({ ...s })) });
    } else if (msg.type === "skill.installed") {
      seen.installed.push(msg.cwd ?? null);
      reply({ type: "skill.installed", cwd: msg.cwd ?? null, items: installedItems.map((s) => ({ ...s })) });
    } else if (msg.type === "skill.store") {
      seen.store.push({ query: msg.query, limit: msg.limit });
      if (String(msg.query).trim().length < 2) reply({ type: "skill.store", query: msg.query, items: [], error: "技能搜索至少输入 2 个字符", errCode: "skill_store_failed" });
      else {
        // Two stages, as the bridge does it (D126): rank first, then dirs and descriptions.
        const at = Date.now();
        reply({ type: "skill.store", query: msg.query, items: STORE.map((s) => ({ ...s, description: "", dir: null, note: undefined })), at });
        setTimeout(() => reply({ type: "skill.store.meta", query: msg.query, at, items: STORE.map((s) => ({ ...s, resolved: true })) }), 80);
      }
    } else if (msg.type === "skill.source") {
      seen.source.push(String(msg.source ?? ""));
      reply({
        type: "skill.source",
        kind: "repo",
        source: "acme/skills",
        query: msg.source,
        items: [
          { path: "skills/alpha", name: "alpha", description: "仓库里的 alpha", local: false },
          { path: "skills/beta", name: "beta", description: "", local: false },
        ],
      });
    } else if (msg.type === "skill.install") {
      seen.install.push({ ...msg });
      const name = msg.local ? path.basename(String(msg.local)) : path.basename(String(msg.dir ?? "")) || String(msg.skillId ?? "skill");
      installedItems = [
        { name, description: "刚装上的", source: msg.scope === "project" ? "project" : "user", uses: 0, lastUsed: 0, path: path.join(REPO, ".scratch", "skill-store", "home", ".pi", "agent", "skills", name), root: path.join(REPO, ".scratch", "skill-store", "home", ".pi", "agent", "skills"), link: false, removable: msg.scope !== "project", from: String(msg.source ?? msg.local ?? ""), installedAt: Date.now() },
        ...installedItems,
      ];
      setTimeout(() => reply({ type: "skill.install.done", reqId: msg.reqId, ok: true, name, dir: path.join("x", name), root: "x", files: 3, from: String(msg.source ?? "") }), 120);
    } else if (msg.type === "skill.remove") {
      seen.remove.push({ ...msg });
      installedItems = installedItems.filter((s) => s.path !== msg.path);
      setTimeout(() => reply({ type: "skill.remove.done", reqId: msg.reqId, ok: true, name: "code-review", dir: msg.path, link: false, root: "x" }), 120);
    }
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      me: { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" },
      sessions: [SESSION],
      manage: { pin: [], order: [], archived: [] },
      trash: [],
      tunnel: TUNNEL,
    }),
  );
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`fake bridge on ${BASE}`);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 }, locale: "zh-CN" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/#/s/${SESSION.id}`, { waitUntil: "networkidle" });

  const composer = page.locator(".composer");
  const skillsBtn = composer.locator('[data-act="skills"]');
  await until(async () => (await skillsBtn.count()) === 1, 8000, "技能 button");
  const storeBtn = page.locator(".skill-store-open");
  const sheet = page.locator(".skill-sheet");

  // ---- 1. 面板底部有「商店」，点开是那个 dialog
  await skillsBtn.click();
  await until(async () => (await storeBtn.count()) === 1, 3000, "商店 button in the palette footer");
  check("技能面板底部有「商店」按钮", (await storeBtn.innerText()).trim() === "商店", await storeBtn.innerText());
  check("面板本身还在（不是一开就换页）", (await page.locator(".skill-pop").count()) === 1);
  await storeBtn.click();
  await until(async () => (await sheet.count()) === 1, 4000, "store sheet");
  check("点「商店」后技能面板收起、dialog 打开", (await page.locator(".skill-pop").count()) === 0 && (await sheet.count()) === 1);
  check("标题是「技能商店」", (await sheet.locator(".sheet-title").innerText()).trim() === "技能商店", await sheet.locator(".sheet-title").innerText());
  const tabs = await sheet.locator(".ext-tabs .chip").allInnerTexts();
  check("两个标签：商店 / 已安装", tabs.length === 2 && tabs[0] === "商店" && tabs[1].startsWith("已安装"), JSON.stringify(tabs));
  await page.screenshot({ path: path.join(OUT, "1-store.png") });

  // ---- 2. 已安装：用户技能能卸载，项目技能只读
  await until(async () => seen.installed.length >= 1, 3000, "installed requested on open");
  check("打开 dialog 就要一次已安装清单", seen.installed.length >= 1);
  await sheet.locator(".ext-tabs .chip").nth(1).click();
  await until(async () => (await page.locator(".skill-host .login-row").count()) === 3, 3000, "three installed rows");
  const groups = await page.locator(".skill-host .settings-label").allInnerTexts();
  check("分成用户技能 / 项目技能两组", groups.some((g) => g.startsWith("用户技能")) && groups.some((g) => g.startsWith("项目技能")), JSON.stringify(groups));
  const projectRow = page.locator(".skill-host .login-row", { hasText: "pi-web-client-test-dev" });
  check("项目技能的组名写明只读", groups.some((g) => g.includes("只读")), JSON.stringify(groups));
  check("项目技能没有卸载按钮", (await projectRow.locator("button").count()) === 0);
  check("项目技能告诉你怎么删", (await projectRow.innerText()).includes("直接删这个目录"), await projectRow.innerText());
  const linkRow = page.locator(".skill-host .login-row", { hasText: "grilling" });
  check("链接装的技能标了「链接」", (await linkRow.innerText()).includes("链接"), await linkRow.innerText());
  const userRow = page.locator(".skill-host .login-row", { hasText: "code-review" });
  check("用户技能有来源", (await userRow.innerText()).includes("来自 anthropics/skills"), await userRow.innerText());
  await page.screenshot({ path: path.join(OUT, "2-installed.png") });

  // ---- 3. 卸载要点两次（4 秒内）
  const delBtn = userRow.locator("button");
  await delBtn.click();
  await until(async () => (await userRow.locator("button").innerText()).includes("确认卸载"), 2000, "armed");
  check("第一次点只是「确认卸载？」", seen.remove.length === 0);
  await userRow.locator("button").click();
  await until(async () => seen.remove.length === 1, 3000, "remove sent");
  check("第二次点才真的发 skill.remove", String(seen.remove[0].path).endsWith("code-review"), JSON.stringify(seen.remove[0]));
  await until(async () => !(await page.locator(".skill-host .login-row", { hasText: "code-review" }).count()), 3000, "row gone after done");
  check("卸载完成后清单里没有了", (await page.locator(".skill-host .login-row", { hasText: "code-review" }).count()) === 0);
  check("卸载后有回执", (await page.locator(".skill-host .login-result").innerText()).includes("已卸载"), await page.locator(".skill-host .login-result").innerText());

  // 加载后出现「重新加载当前会话」的提醒（新装的技能要重启 pi 才认）
  check("改动后有重新加载的提醒", (await page.locator(".skill-host .ext-reload").count()) === 1);

  // ---- 4. 商店：至少 2 个字才搜；结果带安装量、来源、说明
  await sheet.locator(".ext-tabs .chip").first().click();
  await until(async () => (await sheet.locator(".skill-search, .settings-body input").count()) >= 1, 3000, "store tab");
  const search = page.locator(".skill-host input").first();
  await search.click();
  await page.keyboard.type("p");
  await sleep(500);
  check("一个字不搜", seen.store.length === 0, JSON.stringify(seen.store));
  check("提示输入至少 2 个字", (await page.locator(".skill-host .empty").innerText()).includes("至少 2 个字"), await page.locator(".skill-host .empty").innerText());
  await page.keyboard.type("df");
  await until(async () => seen.store.length >= 1, 3000, "store queried");
  check("两个字开始搜（防抖后）", seen.store.at(-1).query === "pdf", JSON.stringify(seen.store));
  await until(async () => (await page.locator(".skill-host .login-list .login-row").count()) === 3, 3000, "three store rows");
  await until(async () => (await page.locator(".skill-host .login-list").innerText()).includes("PDF files"), 3000, "descriptions merged in");
  const storeText = await page.locator(".skill-host .login-list").innerText();
  check("结果带来源与安装量", storeText.includes("anthropics/skills") && storeText.includes("次安装"), storeText.slice(0, 200));
  check("结果带说明", storeText.includes("PDF files"), storeText.slice(0, 300));
  const missing = page.locator(".skill-host .login-list .login-row", { hasText: "skill-x" });
  check("仓库里没找到的技能不给安装", (await missing.innerText()).includes("没找到这个技能的目录") && (await missing.locator("button").count()) === 0, await missing.innerText());
  await page.screenshot({ path: path.join(OUT, "3-search.png") });

  // ---- 5. 安装：发的是 source + dir + 全局
  const pdfRow = page.locator(".skill-host .login-list .login-row", { hasText: "anthropics/skills" });
  await pdfRow.locator("button").click();
  await until(async () => seen.install.length === 1, 3000, "install sent");
  check("安装发的是 source + dir", seen.install[0].source === "anthropics/skills" && seen.install[0].dir === "skills/pdf", JSON.stringify(seen.install[0]));
  check("默认装到全局", seen.install[0].scope === "user", String(seen.install[0].scope));
  check("带上会话 cwd（项目范围要用）", seen.install[0].cwd === REPO, String(seen.install[0].cwd));
  check("按钮在装的时候变成「安装中…」", (await pdfRow.innerText()).includes("安装中"), await pdfRow.innerText());
  await until(async () => (await page.locator(".skill-host .login-result").innerText()).includes("已装好"), 3000, "install receipt");
  await until(async () => (await page.locator(".skill-host .login-result").innerText()).includes("pdf"), 3000, "receipt names the skill");
  check("装完的提示带技能名", (await page.locator(".skill-host .login-result").innerText()).includes("已装好 pdf"), await page.locator(".skill-host .login-result").innerText());
  check("装完去重拉已安装清单", seen.installed.length >= 2, String(seen.installed.length));
  await until(async () => (await pdfRow.innerText()).includes("已安装"), 3000, "row marked installed");
  check("已装过的行标「已安装」", (await pdfRow.innerText()).includes("已安装"));

  // ---- 6. 装到当前项目
  await sheet.locator(".skill-scope select").selectOption("project");
  const reactRow = page.locator(".skill-host .login-list .login-row", { hasText: "vercel-labs" });
  await reactRow.locator("button").click();
  await until(async () => seen.install.length === 2, 3000, "second install");
  check("切换后发 scope=project", seen.install[1].scope === "project", JSON.stringify(seen.install[1]));
  await page.screenshot({ path: path.join(OUT, "4-install.png") });

  // ---- 7. 按地址安装：列出来，再装其中一个
  await page.locator(".skill-host details summary").click();
  const addr = page.locator(".skill-host details input").first();
  await addr.click();
  await page.keyboard.type("acme/skills");
  await page.locator(".skill-host details .info-compact button").click();
  await until(async () => seen.source.length === 1, 3000, "source listed");
  check("按地址安装把输入的地址发过去", seen.source[0] === "acme/skills", seen.source[0]);
  await until(async () => (await page.locator(".skill-host details .login-list .login-row").count()) === 2, 3000, "two repo skills");
  const alphaRow = page.locator(".skill-host details .login-list .login-row", { hasText: "alpha" });
  await alphaRow.locator("button").click();
  await until(async () => seen.install.length === 3, 3000, "install from address");
  check("从仓库列表装的带 dir", seen.install[2].source === "acme/skills" && seen.install[2].dir === "skills/alpha", JSON.stringify(seen.install[2]));
  await page.screenshot({ path: path.join(OUT, "5-address.png") });

  // ---- 8. 关闭
  await sheet.locator(".sheet-head button").click();
  await until(async () => (await sheet.count()) === 0, 2000, "closed");
  check("「关闭」收走 dialog", (await sheet.count()) === 0);
  check("页面没有 JS 异常", errors.length === 0, errors.join(" | "));
} catch (err) {
  failures++;
  console.error("FAIL", err?.message ?? err);
} finally {
  await browser?.close().catch(() => {});
  server.close();
  wss.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
process.exit(failures ? 1 : 0);
