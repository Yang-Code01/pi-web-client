/**
 * Probe D452: 两个 provider 卖同一个 model id 时，模型弹层与代码评审到底认哪一个。
 *
 * 为什么要有它：本机 `wb2api`（远端网关 192.168.31.36:7863）与 `wb2_mac`（127.0.0.1:7863）
 * 各有一份 `cn:glm-5.4` / `cn:deepseek-v4.1-flash`。原来是只按 id `find()`，稳定命中目录里的
 * 第一个（wb2api），于是：
 *   - 评审面板默认就把评审派去远端网关；
 *   - 在弹层里点「wb2_mac 那一行」并确认，记下来的还是 `wb2api/...`（远端掉线就整轮全红）；
 *   - 两行同时标「使用中」，人根本看不出选的是哪一个。
 *
 * 桩桥 + 真 Chromium（先 `npm --prefix web run build`），要盯的四条：
 *   1. 评审面板没单独挑过模型时，chip 的 title 是会话自己的 `provider/id`（wb2_mac）；
 *   2. 弹层打开时只有**一行**标「使用中」，且是 wb2_mac 那一行；
 *   3. 挑 wb2_mac 那一行 + 确认后，chip 记的仍是 wb2_mac（不是目录里排在前面的 wb2api）；
 *   4. 点「开始评审」，发给桥的 `review.run` 里 provider / model 就是 wb2_mac + 挑的那个。
 *
 * 跑：npm --prefix web run build && node probes/review-model-provider.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DIST, REPO, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const PORT = Number(process.env.PI_WEB_PORT ?? 0);
let BASE = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- 桩桥 ------------------------------------------------------------------
const SID = "zz-review-model-provider";
const CWD = REPO;
const SESSION = {
  id: SID,
  name: "重名 provider",
  cwd: CWD,
  ws: "",
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
  // 会话真实用的是本机网关那份；目录里 wb2api 排在前面，只按 id 找就会认成它。
  model: "cn:deepseek-v4.1-flash",
  modelName: "DeepSeek-V4.1-Flash（x0.11）",
  provider: "wb2_mac",
  thinkingLevel: "high",
};
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };
const OCR = { installed: true, version: "1.14.2", tooOld: false };
/** 与真机 models.json 同序：wb2api（远端）在前，wb2_mac（本机）在后，同名 id 两边都有。 */
const MODELS = [
  { id: "cn:deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash（x0.11）", provider: "wb2api", contextWindow: 1_000_000, levels: ["off", "low", "high", "max"] },
  { id: "cn:glm-5.4", name: "GLM-5.4（x0.69）", provider: "wb2api", contextWindow: 1_000_000, levels: ["off", "low", "high", "max"] },
  { id: "cn:deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash（x0.11）", provider: "wb2_mac", contextWindow: 1_000_000, levels: ["off", "low", "high", "max"] },
  { id: "cn:glm-5.4", name: "GLM-5.4（x0.69）", provider: "wb2_mac", contextWindow: 1_000_000, levels: ["off", "low", "high", "max"] },
];

/** 面板的「评什么」：不选 PR，就是工作区改动 —— 否则「开始评审」是灰的，跑不到 review.run 那一步。 */
const WORKSPACE_PICK = { mode: "workspace", pr: 0, base: "", target: "", commit: "" };

const seen = { setModel: [], reviewRun: [] };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  // 登录 / 身份这几条必须自己答：落到静态兜底会给页面一份 HTML，启动就停在登录页。
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(ME));
  }
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (url.pathname === "/" || !path.extname(file)) file = path.join(DIST, "index.html");
  const inside = path.relative(DIST, file);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const { WebSocketServer } = await import(pathToFileURL(wsWrapper()).href);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "models") send({ type: "catalog", models: MODELS, error: "" });
      if (msg.type === "setModel") seen.setModel.push({ provider: msg.provider, modelId: msg.modelId });
      if (msg.type === "review.run") seen.reviewRun.push({ provider: msg.provider, model: msg.model, mode: msg.mode });
      if (msg.type === "subscribe") {
        send({ type: "session", sessionId: SID, state: SESSION, items: [], approvals: [], asks: [], budget: null });
      }
      if (msg.type === "review.get") {
        send({ type: "catalog", models: MODELS, fast: [], error: "" });
        send({ type: "review.ocr", ocr: OCR });
        send({ type: "review.pinned", pinned: "" });
        send({ type: "review.prs", dir: CWD, sessionId: SID, asked: CWD, prs: [], open: 0, error: "" });
        send({ type: "review.state", dir: CWD, sessionId: SID, state: { repo: CWD, runs: [], marks: {}, pick: WORKSPACE_PICK }, progresses: [], cap: 2, pinned: "" });
      }
    });
    send({
      type: "hello",
      me: ME,
      sessions: [SESSION],
      manage: { pin: [], order: [], archived: [] },
      trash: [],
      tunnel: TUNNEL,
      workspace: { groups: [], overrides: {}, keys: {} },
      ui: { chrome: { skills: true, ext: true, attach: true, model: true } },
    });
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
});
const addr = server.address();
BASE = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : PORT}`;

// ---- 页面 ------------------------------------------------------------------
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, locale: "zh-CN" });
  await page.addInitScript(() => localStorage.setItem("pi.queueTab", "review"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.locator(".session-card").first().click();
  const chip = page.locator(".rv-model");
  await chip.waitFor({ timeout: 20000 });
  await sleep(400);

  const title = () => chip.getAttribute("title");
  const t0 = await title();
  check("评审默认路径认会话自己的 provider", t0 === "wb2_mac/cn:deepseek-v4.1-flash", `chip title = ${t0}`);

  // 面板会自愈重画，元素会被换掉：直接派发 click，别等 Playwright 的 stability。
  await page.evaluate(() => document.querySelector(".rv-model").click());
  await page.locator(".model-sheet").waitFor({ timeout: 10000 });
  const marks = await page.locator(".model-sheet .pm-row.on").evaluateAll((els) => els.map((e) => e.dataset?.provider ?? ""));
  check("打开弹层时只有一行标「使用中」，而且是 wb2_mac", marks.length === 1 && marks[0] === "wb2_mac", `标中的行：${JSON.stringify(marks)}`);

  // 分组只是视觉块（行不是 .pm-group 的后代）：同名 id 的第 2 次出现就是 wb2_mac 那一行。
  const row = page.locator('.model-sheet .pm-row[data-id="cn:glm-5.4"]').nth(1);
  await row.waitFor({ timeout: 10000 });
  check("那一行确实属于 wb2_mac", (await row.getAttribute("data-provider")) === "wb2_mac");
  await row.evaluate((el) => el.click());
  await sleep(150);
  await page.locator(".pm-foot-actions .btn.primary").first().evaluate((el) => el.click());
  await sleep(500);
  const t1 = await title();
  check("挑 wb2_mac 的 GLM-5.4 并确认后，面板记的仍是 wb2_mac", t1 === "wb2_mac/cn:glm-5.4", `chip title = ${t1}`);

  // 真的点一次「开始评审」：发给桥的那一帧必须带对 provider（桥按它起子进程）。
  const runBtn = page.locator(".rv-run");
  if (await runBtn.isEnabled()) {
    await runBtn.evaluate((el) => el.click());
    await sleep(600);
    const sent = seen.reviewRun.at(-1);
    check(
      "review.run 带上 wb2_mac + 挑中的模型",
      !!sent && sent.provider === "wb2_mac" && sent.model === "cn:glm-5.4",
      `实际 ${JSON.stringify(sent)}`,
    );
  } else {
    console.log("skip  开始评审按不了（桩里范围没配对），跳过 review.run 那一条");
  }

  // 同一个 commit() 也管对话切模型：点在 wb2_mac 那一组里的另一行，setModel 必须是 wb2_mac。
  await page.evaluate(() => document.querySelector(".model-chip")?.click());
  await page.locator(".model-sheet").waitFor({ timeout: 10000 });
  // 对话那颗 chip 开场落在「当前使用」页（只有在用的一行）；要到「全部模型」页才有别的行可挑。
  await page.locator(".st-nav__item", { hasText: "全部模型" }).first().click();
  await sleep(200);
  const chatRow = page.locator('.model-sheet .pm-row[data-provider="wb2_mac"][data-id="cn:glm-5.4"]');
  await chatRow.first().waitFor({ timeout: 10000 });
  await chatRow.first().evaluate((el) => el.click());
  await sleep(150);
  await page.locator(".pm-foot-actions .btn.primary").first().evaluate((el) => el.click());
  await sleep(500);
  const sent1 = seen.setModel.at(-1);
  check("对话切模型也按 provider/id 走（wb2_mac）", !!sent1 && sent1.provider === "wb2_mac", `setModel = ${JSON.stringify(sent1)}`);

  check("没有页面异常", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} 条失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
