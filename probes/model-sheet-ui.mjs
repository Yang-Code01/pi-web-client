/**
 * Probe: D373 — 模型切换弹窗（设置控制台骨架）+ 新的模型 chip。
 *
 * 桩桥 + 真 Chromium（先 `npm --prefix web run build`）。要盯的是这几条，都是「改坏了一眼看不出来」的：
 *   1. chip 只显示 模型 · 档位 · 上下文，**空闲时不出现 `tok/s`**（这正是这次要消掉的噪声）；
 *   2. 弹窗是 `.st-console.model-sheet`，左栏三页（当前使用 / 全部模型 / 本会话）；
 *   3. 点一行只改草稿：头部换成新模型、出现「未保存」、底栏长出「取消 / 确认」，但**一个 setModel 都还没发**；
 *   4. 取消 / Esc 都丢弃草稿，chip 不变、仍然一个 setModel 都没发；
 *   5. 确认才发 `setModel`（带 provider / modelId / level）并关窗；
 *   6. 只动档位时发的是 `setThinking`，不发 `setModel`；
 *   7. 目标模型没有当前档位时落到它**最高档**（不是 off）；
 *   8. 搜索按名字 / id 过滤，数量对得上；
 *   9. 窄容器（<620px）里 chip 丢掉上下文数字、`释放会话` 不被挤到第二行。
 *
 * 跑：npm --prefix web run build && node probes/model-sheet-ui.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7936);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(REPO, ".scratch", "model-sheet-ui", "shots");
fs.rmSync(path.join(REPO, ".scratch", "model-sheet-ui"), { recursive: true, force: true });
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
    await sleep(60);
  }
  throw new Error(`超时：${what}`);
};

const SESSION = {
  id: "probe-model-sheet",
  name: "模型探针",
  cwd: REPO,
  file: null,
  owned: true,
  origin: "web",
  running: false,
  done: true,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  locked: false,
  preview: "模型",
  permission: "ask",
  model: "cn:kimi-k3-1",
  modelName: "Kimi-K3",
  thinkingLevel: "max",
};

const MODELS = [
  { id: "cn:kimi-k3-1", name: "Kimi-K3 · x1.62 · 1M", provider: "wb2api", contextWindow: 1_000_000, levels: ["off", "medium"] },
  { id: "cn:kimi-k3.1-pro", name: "Kimi-K3.1-Pro · x0.97 · 1M", provider: "wb2api", contextWindow: 1_000_000, levels: ["off", "low", "high", "max"] },
  { id: "cn:deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", provider: "wb2api", contextWindow: 1_000_000, levels: ["off", "low", "high", "max"] },
  { id: "cn:glm-5.3", name: "GLM-5.3 · x0.69 · 1M", provider: "wb2api", contextWindow: 1_000_000, levels: ["off", "low", "high", "max"] },
  { id: "cn:hy4flash", name: "hy4flash", provider: "wb2api", contextWindow: 960_000, levels: ["off", "high"] },
  { id: "or:claude-sonnet-4.6", name: "Claude Sonnet 4.6", provider: "openrouter", contextWindow: 200_000, levels: ["off", "low", "medium", "high", "xhigh", "max"] },
  { id: "or:gpt-5.2", name: "GPT-5.2", provider: "openrouter", contextWindow: 400_000, levels: ["off", "low", "high"] },
  { id: "lm:qwen3-coder-30b", name: "Qwen3 Coder 30B", provider: "lmstudio", contextWindow: 128_000, levels: [] },
];

const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
// usage / 压缩线：chip 的 12K/1M 与「已用 1%」都从这一帧来（订阅之后才发）。
const STATS = {
  type: "stats",
  sessionId: SESSION.id,
  policy: {
    policy: { compactPercent: 70, compactFrom: "default", compactOn: true, handoffOn: false, handoffFrom: "default", handoffPercent: null },
    window: 1_000_000,
    used: 12_000,
    compact: { line: 700_000, percent: 70, clamped: false },
  },
  tokens: null,
  cost: 0,
  context: { tokens: 12_000, contextWindow: 1_000_000 },
};
const seen = { setModel: [], setThinking: [], prompt: [] };
let sock = null;

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/__owned") {
    // 探针要试「没接管」的分支：下一次 hello 就带着翻转后的 owned。
    SESSION.owned = url.searchParams.get("v") !== "0";
    return res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  }
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" }));
  }
  let rel = url.pathname.replace(/^\//, "");
  if (url.pathname === "/") rel = "index.html";
  else if (url.pathname === "/peer") rel = "peer.html";
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
      // 真桥是连上后按帧推 stats 的；得等它认下 currentId 再发，不然这帧被丢掉、chip 的用量永远是空的。
      // 真桥是按帧推 stats 的；这里也周期推，免得只发一次时被 early-return 吞掉。
      const push = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify(STATS));
        else clearInterval(push);
      }, 300);
      ws.on("close", () => clearInterval(push));
    } else if (msg.type === "models") {
      ws.send(JSON.stringify({ type: "catalog", models: MODELS.map((m) => ({ ...m })), error: "" }));
    } else if (msg.type === "setModel") {
      seen.setModel.push({ provider: msg.provider, modelId: msg.modelId, level: msg.level ?? null });
    } else if (msg.type === "setThinking") {
      seen.setThinking.push({ level: msg.level });
    } else if (msg.type === "prompt") {
      seen.prompt.push({ text: msg.text });
    }
  });
  const hello = () => ({
    type: "hello",
    me: { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" },
    sessions: [SESSION],
    manage: { pin: [], order: [], archived: [] },
    trash: [],
    ui: { chrome: { skills: true, ext: true, attach: true, model: true } },
  });
  ws.send(JSON.stringify(hello()));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

let browser;
try {
  browser = await chromium.launch();
  // 1600 宽：输入框下那一行宽到能容下上下文数字；窄窗（下文的 1280）放不下就让位。
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // 记下服务端到底推了哪些帧：chip 不亮时先分清「帧没到」还是「到了没用上」。
  await page.addInitScript(() => {
    window.__frames = [];
    const Orig = window.WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (ev) => {
          try {
            window.__frames.push(JSON.parse(String(ev.data)).type);
          } catch {
            /* 非 JSON 帧不管 */
          }
        });
      }
    };
  });
  await page.goto(`${BASE}/#/s/${SESSION.id}`, { waitUntil: "networkidle" });

  const composer = page.locator(".composer");
  const sheet = page.locator(".st-console.model-sheet");
  const chipText = () => page.locator(".model-chip").innerText().then((t) => t.replace(/\s+/g, " ").trim());
  const footHidden = () => page.evaluate(() => document.querySelector(".model-sheet .pm-foot-actions")?.hidden ?? null);

  await until(async () => (await composer.count()) === 1, 8000, "composer");
  await until(async () => (await chipText()).includes("Kimi-K3"), 8000, "chip 报出模型");

  check("chip 有模型名与档位", /Kimi-K3/.test(await chipText()) && /max/.test(await chipText()), await chipText());
  check("chip 有上下文用量", /12K\/1M/.test(await chipText()), `${await chipText()} · 帧 ${JSON.stringify(await page.evaluate(() => (window.__frames || []).slice(0, 12)))}`);
  check("空闲时 chip 不显示 tok/s", !/tok\/s/.test(await chipText()), await chipText());
  await page.locator(".model-chip").screenshot({ path: path.join(OUT, "chip.png") });

  await page.locator(".model-chip").click();
  await until(async () => (await sheet.count()) === 1, 4000, "弹窗打开");
  const navs = await page.locator(".model-sheet .st-nav__item").allInnerTexts();
  check("左栏三页", navs.length === 3 && /当前使用/.test(navs[0]) && /全部模型/.test(navs[1]) && /本会话/.test(navs[2]), navs.join(" / ").replace(/\n/g, " "));
  check("没改东西时底栏没有按钮", (await footHidden()) === true);
  await page.screenshot({ path: path.join(OUT, "now.png") });

  await page.locator(".model-sheet .st-nav__item", { hasText: "全部模型" }).first().click();
  await sleep(200);
  const rowsBefore = await page.locator(".model-sheet .pm-row").evaluateAll((els) => els.map((e) => e.dataset?.id ?? ""));
  check("默认只展开当前来源（5 行）", rowsBefore.length === 5);

  // 多来源：每个来源一组，组头能折叠；当前模型所在组默认开，其余默认折（跟目录选择器共用 pi.modelGroups.open）。
  const groupHeads = await page.locator(".model-sheet .pm-group").evaluateAll((els) =>
    els.map((e) => `${e.getAttribute("aria-expanded") === "true" ? "open" : "folded"}:${e.innerText.replace(/\s+/g, " ")}`),
  );
  check(
    "按来源分组、当前来源展开、其余折叠",
    groupHeads.length === 3 && /^open:.*wb2api 5 个/.test(groupHeads[0]) && /^folded:.*openrouter 2 个/.test(groupHeads[1]) && /^folded:.*lmstudio 1 个/.test(groupHeads[2]),
    groupHeads.join(" | "),
  );
  await page.screenshot({ path: path.join(OUT, "groups.png") });
  // 当前来源默认展开，但用户得能把它折上：以前每次 paint 都又摊开，点一下等于没点。
  await page.locator(".model-sheet .pm-group", { hasText: "wb2api" }).click();
  await sleep(250);
  check("当前来源也能折回去", (await page.locator(".model-sheet .pm-row").count()) === 0);
  await page.locator(".model-sheet .pm-group", { hasText: "wb2api" }).click();
  await sleep(250);
  check("再展开又是 5 行", (await page.locator(".model-sheet .pm-row").count()) === 5);
  await page.locator(".model-sheet .pm-group", { hasText: "openrouter" }).click();
  await sleep(200);
  check("点组头展开该来源", (await page.locator(".model-sheet .pm-row").count()) === 7);
  await page.locator(".model-sheet .pm-group", { hasText: "openrouter" }).click();
  await sleep(200);
  check("再点一下折回去", (await page.locator(".model-sheet .pm-row").count()) === 5);
  await page.fill(".model-sheet .pm-search__input", "gpt");
  await sleep(250);
  const gptHeads = await page.locator(".model-sheet .pm-group").allInnerTexts();
  check(
    "搜索时折叠组自动展开、组头报命中数",
    (await page.locator(".model-sheet .pm-row").count()) === 1 && gptHeads.length === 1 && /1 \/ 2 个/.test(gptHeads[0].replace(/\s+/g, " ")),
    gptHeads.join(" | ").replace(/\n/g, " "),
  );
  await page.fill(".model-sheet .pm-search__input", "");
  await sleep(200);
  check("当前模型标着「使用中」", /使用中/.test(await page.locator(".model-sheet .pm-row.on .settings-name").first().innerText()));
  // 这一页就能选档位：草稿模型是 Kimi-K3，它的档位只有 off / medium
  const segsHere = await page.locator(".model-sheet .pm-lvbar .st-seg__btn").allInnerTexts();
  check("全部模型页也有思考档位（跟着草稿模型）", segsHere.join("/") === "off/medium", segsHere.join("/"));

  await page.fill(".model-sheet .pm-search__input", "kimi");
  await sleep(250);
  const hits = await page.locator(".model-sheet .pm-row .settings-name").allInnerTexts();
  check("搜索 kimi 过滤到 2 个", hits.length === 2, hits.join(" / "));
  await page.fill(".model-sheet .pm-search__input", "");
  await sleep(200);

  // BUG 修掉后：点一行只是选中，不能把它提到最上面（否则鼠标底下的列表整体换位）
  await page.locator(".model-sheet .pm-row", { hasText: "GLM-5.3" }).first().click();
  await sleep(250);
  const rowsAfter = await page.locator(".model-sheet .pm-row").evaluateAll((els) => els.map((e) => e.dataset?.id ?? ""));
  check("点一行不会把它提到最上面", rowsAfter.join() === rowsBefore.join(), `${rowsBefore.join()} → ${rowsAfter.join()}`);
  check("点一行后档位跟着换成那模型的", (await page.locator(".model-sheet .pm-lvbar .st-seg__btn").allInnerTexts()).join("/") === "off/low/high/max");

  // 模型多的时候列表要滚很久：档位条必须钉在滚动区外，滚到底也能直接改（用户报的第二个问题）。
  // 先把所有来源展开，否则 5 行不够高、根本滚动不了。
  while ((await page.locator(".model-sheet .pm-group.folded").count()) > 0) {
    await page.locator(".model-sheet .pm-group.folded").first().click();
    await sleep(150);
  }
  await sleep(300);
  await page.setViewportSize({ width: 1440, height: 620 });
  await sleep(300);
  await page.locator(".model-sheet .pm-body").evaluate((b) => {
    b.scrollTop = b.scrollHeight;
  });
  await sleep(200);
  const barAtBottom = await page.evaluate(() => {
    const body = document.querySelector(".model-sheet .pm-body");
    const bar = document.querySelector(".model-sheet .pm-lvbar");
    const pane = document.querySelector(".model-sheet .st-pane");
    const b = bar?.getBoundingClientRect();
    const p = pane?.getBoundingClientRect();
    return {
      scrolled: (body?.scrollTop ?? 0) > 0,
      visible: !!b && !!p && b.top >= p.top - 1 && b.bottom <= p.bottom + 1 && b.height > 24,
      segs: [...document.querySelectorAll(".model-sheet .pm-lvbar .st-seg__btn")].length,
    };
  });
  check("滚到底部时档位条仍在视口内", barAtBottom.scrolled && barAtBottom.visible && barAtBottom.segs === 4, JSON.stringify(barAtBottom));
  await page.screenshot({ path: path.join(OUT, "scrolled.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(300);
  await page.locator(".model-sheet .pm-lvbar .st-seg__btn", { hasText: "low" }).click();
  await sleep(250);
  check("同一页改档位也进草稿", /思考/.test(await page.locator(".model-sheet .st-foot__hint").innerText()), await page.locator(".model-sheet .st-foot__hint").innerText());

  // 目标模型没有当前档位（low 不在 off/medium 里）时落它的**最高档**，不是 off——落到 off 等于默默把思考关了。
  await page.locator(".model-sheet .pm-row", { hasText: "Kimi-K3" }).first().click();
  await sleep(250);
  const fell = await page.locator(".model-sheet .pm-lvbar .st-seg__btn.on").allInnerTexts();
  check("档位不支持时落最高档", fell.join() === "medium", fell.join("/"));

  // 选一个思考档位不含 max 的模型：应落到它的最高档 medium（不是 off）
  await page.locator(".model-sheet .pm-row", { hasText: "Kimi-K3.1-Pro" }).first().click();
  await sleep(250);
  const headDirty = await page.locator(".model-sheet .st-head").innerText();
  check("头部换成草稿模型并标未保存", /Kimi-K3\.1-Pro/.test(headDirty) && /未保存/.test(headDirty), headDirty.replace(/\n/g, " | "));
  check("改了才出现取消 / 确认", (await footHidden()) === false);
  check("还没发出去：setModel 0 条", seen.setModel.length === 0);
  const hint = await page.locator(".model-sheet .st-foot__hint").innerText();
  check("底栏说清改了什么", /未保存/.test(hint) && /Kimi-K3\.1-Pro/.test(hint), hint);
  await page.screenshot({ path: path.join(OUT, "dirty.png") });

  await page.locator(".model-sheet .pm-foot-actions .btn", { hasText: "取消" }).click();
  await sleep(400);
  check("取消后弹窗关掉", (await sheet.count()) === 0);
  check("取消后 chip 不变", /Kimi-K3/.test(await chipText()) && !/K3\.1/.test(await chipText()), await chipText());
  check("取消不发 setModel", seen.setModel.length === 0);

  // Esc：同样丢弃
  await page.locator(".model-chip").click();
  await until(async () => (await sheet.count()) === 1, 4000, "弹窗再次打开");
  await page.locator(".model-sheet .st-nav__item", { hasText: "全部模型" }).first().click();
  await sleep(200);
  await page.locator(".model-sheet .pm-row", { hasText: "GLM-5.3" }).first().click();
  await sleep(200);
  await page.keyboard.press("Escape");
  await sleep(400);
  check("Esc 关窗且不发 setModel", (await sheet.count()) === 0 && seen.setModel.length === 0);

  // 确认：真发 setModel
  await page.locator(".model-chip").click();
  await until(async () => (await sheet.count()) === 1, 4000, "弹窗第三次打开");
  await page.locator(".model-sheet .st-nav__item", { hasText: "全部模型" }).first().click();
  await sleep(200);
  await page.locator(".model-sheet .pm-row", { hasText: "Kimi-K3.1-Pro" }).first().click();
  await sleep(200);
  await page.locator(".model-sheet .pm-foot-actions .btn.primary").click();
  await until(async () => seen.setModel.length === 1, 4000, "setModel");
  check("确认发 setModel（带 provider / modelId / level）", seen.setModel[0].modelId === "cn:kimi-k3.1-pro" && seen.setModel[0].provider === "wb2api", JSON.stringify(seen.setModel[0]));
  await sleep(400); // 弹窗是带着退场动画关的，节点不是当场就没了
  check("确认后弹窗关掉", (await sheet.count()) === 0);
  check("这次没有 setThinking", seen.setThinking.length === 0);

  // 只动档位：只发 setThinking
  await page.locator(".model-chip").click();
  await until(async () => (await sheet.count()) === 1, 4000, "弹窗第四次打开");
  await page.locator(".model-sheet .st-nav__item", { hasText: "当前使用" }).first().click();
  await sleep(200);
  await page.locator(".model-sheet .st-seg__btn").first().click();
  await sleep(200);
  await page.locator(".model-sheet .pm-foot-actions .btn.primary").click();
  await until(async () => seen.setThinking.length === 1, 4000, "setThinking");
  check("只改档位 → setThinking 一条，setModel 仍是一条", seen.setThinking.length === 1 && seen.setModel.length === 1, JSON.stringify(seen.setThinking));

  // 1440 宽：输入框那一行只有 ~524px，上下文数字挤不下→让位；但整行仍得是一行（1280 时连一排按钮都放不下，
  // 那里本来就换行，不归本改动负责）。
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(400);
  const narrow = await page.evaluate(() => {
    const tools = document.querySelector(".hint-tools");
    const ctx = document.querySelector(".model-chip .chip-ctx");
    const chip = document.querySelector(".model-chip");
    const rect = chip?.getBoundingClientRect();
    return {
      ctxShown: ctx ? getComputedStyle(ctx).display !== "none" : false,
      toolsH: Math.round(tools.getBoundingClientRect().height),
      chipText: (chip?.innerText ?? "").replace(/\s+/g, " ").trim(),
      chipH: Math.round(rect?.height ?? 0),
      chipW: Math.round(rect?.width ?? 0),
    };
  });
  check("窄容器丢掉上下文数字", narrow.ctxShown === false, JSON.stringify(narrow));
  check("窄容器整行仍是一行", narrow.toolsH <= 40, `hint-tools 高 ${narrow.toolsH}px`);
  check("窄容器 chip 仍报模型与档位", /Kimi-K3\.1-Pro/.test(narrow.chipText) && /off/.test(narrow.chipText), JSON.stringify(narrow));
  await page.locator(".model-chip").screenshot({ path: path.join(OUT, "chip-narrow.png") });

  // 宽到一行放得下时，倍率（目录塞在名字里的 x0.97）才露出来：窄窗先让它让位，再让上下文数字。
  await page.setViewportSize({ width: 1920, height: 900 });
  await sleep(500);
  const wide = await page.evaluate(() => ({
    hintW: Math.round(document.querySelector(".composer .hint")?.clientWidth ?? 0),
    toolsH: Math.round(document.querySelector(".hint-tools")?.getBoundingClientRect().height ?? 0),
    text: (document.querySelector(".model-chip")?.innerText ?? "").replace(/s+/g, " ").trim(),
  }));
  check("宽窗才显示倍率", /x0.97/.test(wide.text), JSON.stringify(wide));
  check("宽窗仍是一行", wide.toolsH <= 40, JSON.stringify(wide));

  // 没接管（owned:false）：草稿随便点，但底栏不许给「确认」——桥会直接丢掉 setModel。
  await page.request.get(`${BASE}/__owned?v=0`);
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await composer.count()) === 1, 8000, "composer(只读)");
  await page.locator(".model-chip").click();
  await until(async () => (await sheet.count()) === 1, 4000, "弹窗(只读)");
  await page.locator(".model-sheet .st-nav__item", { hasText: "全部模型" }).first().click();
  await sleep(200);
  const sentBefore = seen.setModel.length;
  await page.locator(".model-sheet .pm-row", { hasText: "GLM-5.3" }).first().click();
  await sleep(250);
  const readOnly = {
    foot: await footHidden(),
    hint: await page.locator(".model-sheet .st-foot__hint").innerText(),
    notice: await page.locator(".model-sheet .takeover").count(),
    sent: seen.setModel.length - sentBefore,
  };
  check("没接管时不给确认", readOnly.foot === true && readOnly.sent === 0, JSON.stringify(readOnly));
  check("没接管时底栏说清原因", /没有写入权/.test(readOnly.hint), readOnly.hint);
  check("没接管时全部模型页也有接管入口", readOnly.notice >= 1, JSON.stringify(readOnly));

  check("页面没有 JS 异常", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
console.log(failures ? `\nFAILED (${failures})` : "\nALL OK");
process.exit(failures ? 1 : 0);
