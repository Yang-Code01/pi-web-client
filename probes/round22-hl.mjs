/**
 * Probe: Q-031 — 代码预览与 markdown 围栏上色。
 *
 * 该染的要染：`.ts` 预览出 `hljs-keyword`、```ts 围栏出同款 span、行号槽还在、文字一个字符不丢。
 * 不该染的保持原样：`.txt`、超过 200 KB 的 `.log`、不认识的围栏语言（```zzz）。
 * 颜色靠 `hljs-*` class + `web/src/styles.css` 里的变量，探针只认结构不认具体色号。
 *
 * Run: node probes/round22-hl.mjs   (needs `npm run build:web` first)
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7920);
const OUT = path.join(REPO, ".scratch/round22-hl/shots");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = REPO;
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const TS_SRC = `import { readFile } from "node:fs/promises";

/** 读一个文件。 */
export async function load(file: string, size = 4096): Promise<string> {
  const text = await readFile(file, "utf8"); // 2 KB 以内直接返回
  return text.length > size ? text.slice(0, size) : text;
}
`;
const TXT_SRC = "这是纯文本，没有语言。\n第二行 const x = 1;\n";
const BIG_SRC = "const x = 1;\n".repeat(16000); // 208 KB，越过 200 KB 阈值
const FENCE_TS = "```ts\nexport const answer: number = 42;\n```";
const FENCE_UNKNOWN = "```zzz\nplain words stay plain\n```";

const FILES = {
  "src/app.ts": { name: "app.ts", abs: `${CWD}/src/app.ts`, text: TS_SRC, kind: "text" },
  "tmp/a.txt": { name: "a.txt", abs: `${CWD}/tmp/a.txt`, text: TXT_SRC, kind: "text" },
  "tmp/big.ts": { name: "big.ts", abs: `${CWD}/tmp/big.ts`, text: BIG_SRC, kind: "text" },
};

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
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const SESSIONS = [
  { id: "probe-a", name: "会话甲", cwd: CWD, file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "高亮" },
];
const ITEMS = [
  { kind: "user", id: "u1", ts: Date.now() - 60_000, text: "给我一段 ts" },
  { kind: "assistant", id: "a1", ts: Date.now() - 50_000, text: `${FENCE_TS}\n\n再看这个：\n\n${FENCE_UNKNOWN}\n\n文件：src/app.ts 与 tmp/a.txt、tmp/big.ts` },
];

const tokens = new Map();
let seq = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ME));
  if (url.pathname === "/api/preview" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* ignore */
      }
      const want = String(body.path ?? "").replace(/\\/g, "/");
      const hit = FILES[want] ?? Object.values(FILES).find((f) => f.abs === `${CWD}/${want}` || f.abs.endsWith(`/${want}`));
      if (!hit) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: `文件不存在：${want}` }));
      }
      const token = `tok${++seq}`;
      tokens.set(token, hit);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token, rel: want, name: hit.name, abs: hit.abs, size: hit.text.length, mtime: Date.now(), kind: hit.kind }));
    });
    return;
  }
  if (url.pathname.startsWith("/raw/")) {
    // 前端拼的是 /raw/<token>/<rel>（web/src/app.ts:5338），token 是第一段。
    const hit = tokens.get(url.pathname.slice("/raw/".length).split("/")[0]);
    if (!hit) return res.writeHead(404, { "content-type": "text/plain" }).end("no token");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(hit.text);
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
      ws.send(JSON.stringify({ type: "session", sessionId: "probe-a", state: SESSIONS[0], items: ITEMS, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session cards");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "messages");

  // 1) ```ts 围栏：上色、文字不丢
  const tsPre = page.locator(".msg pre.hl").first();
  await until(async () => (await tsPre.count()) === 1, 8000, "highlighted ts fence");
  const kw = await tsPre.locator("code .hljs-keyword").count();
  const tex = (await tsPre.locator("code").innerText()).trim();
  log("fence keywords:", kw, "text:", JSON.stringify(tex));
  assert(kw >= 1, `fence with "ts" should produce hljs-keyword (got ${kw})`);
  assert(tex === "export const answer: number = 42;", `围栏文字一个字符都不能丢（拿到 ${JSON.stringify(tex)}）`);

  // 2) 不认识的围栏：不染色、仍是纯文本
  const unknownPre = page.locator(".msg pre", { hasText: "plain words stay plain" }).first();
  assert((await unknownPre.count()) === 1, "未知语言的围栏还在");
  assert(!(await unknownPre.getAttribute("class"))?.includes("hl"), "未知语言不该上色");
  const noSpan = await unknownPre.locator("span").count();
  assert(noSpan === 0, `未知语言不该产生 span（拿到 ${noSpan} 个）`);
  await page.screenshot({ path: path.join(OUT, "1-fence.png") });

  // 3) .ts 文件预览：行号槽 + hljs span + 文字完整
  await page.locator(".msg a", { hasText: "src/app.ts" }).first().click();
  await until(async () => (await page.locator(".viewer-src.hl").count()) === 1, 8000, "highlighted preview");
  const gutter = await page.locator(".viewer-src .ln-gutter").count();
  const previewKw = await page.locator(".viewer-src code .hljs-keyword").count();
  const previewText = await page.locator(".viewer-src code").innerText();
  log("preview keywords:", previewKw, "gutter:", gutter, "chars:", previewText.length);
  assert(gutter === 1, "行号槽还在（上色不能替掉它）");
  assert(previewKw >= 1, `ts 预览该出现 hljs-keyword（拿到 ${previewKw} 个）`);
  assert(previewText.trimEnd() === TS_SRC.trimEnd(), `预览文字与源文件一致（得到 ${previewText.length} 字符，期望 ${TS_SRC.length}）`);
  assert((await page.locator(".viewer-src").getAttribute("data-lang")) === "typescript", "data-lang 记下了识别结果");
  // 有 class 不等于看得见：token 的颜色必须真的与正文默认色不同（Q-034 就是栽在这里）。
  const previewColors = await page.evaluate(() => {
    const code = document.querySelector(".viewer-src code");
    const kw = code.querySelector(".hljs-keyword");
    return { base: getComputedStyle(code).color, kw: kw ? getComputedStyle(kw).color : "" };
  });
  log("preview colors:", JSON.stringify(previewColors));
  assert(previewColors.kw && previewColors.kw !== previewColors.base, `预览里关键字要有自己的颜色（base=${previewColors.base} kw=${previewColors.kw || "无"}）`);
  await page.screenshot({ path: path.join(OUT, "2-preview-ts.png") });
  await page.keyboard.press("Escape");
  await sleep(200);

  // 4) .txt：照旧纯文本
  await page.locator(".msg a", { hasText: "tmp/a.txt" }).first().click();
  await until(async () => (await page.locator(".viewer-src").count()) === 1, 8000, "txt preview");
  const txtHl = await page.locator(".viewer-src.hl").count();
  const txtSpans = await page.locator(".viewer-src code span").count();
  log("txt hl:", txtHl, "spans:", txtSpans);
  assert(txtHl === 0, ".txt 不该被染色");
  assert(txtSpans === 0, ".txt 不该产生 span");
  assert((await page.locator(".viewer-src code").innerText()).includes("纯文本"), ".txt 内容照旧");
  await page.keyboard.press("Escape");
  await sleep(200);

  // 5) 208 KB 的 .log：越过阈值就保持纯文本（哪怕语言认识）
  await page.locator(".msg a", { hasText: "tmp/big.ts" }).first().click();
  await until(async () => (await page.locator(".viewer-src").count()) === 1, 12000, "big preview");
  const bigHl = await page.locator(".viewer-src.hl").count();
  const bigSpans = await page.locator(".viewer-src code span").count();
  const bigLen = (await page.locator(".viewer-src code").innerText()).length;
  log("big hl:", bigHl, "spans:", bigSpans, "chars:", bigLen);
  assert(bigHl === 0, "超过 200 KB 不该染色");
  assert(bigSpans === 0, "超过 200 KB 不该产生 span");
  assert(bigLen >= BIG_SRC.length - 4, `大文件内容仍在（${bigLen} / ${BIG_SRC.length}）`);
  await page.screenshot({ path: path.join(OUT, "3-preview-big.png") });
  await page.keyboard.press("Escape");
  await sleep(200);

  // 6) Q-034：编辑态也上色（下层 <pre> 画字，textarea 自己的字透明，只留光标与选区）
  await page.locator(".msg a", { hasText: "src/app.ts" }).first().click();
  await until(async () => (await page.locator(".pane-seg").count()) === 1, 8000, "viewer toolbar");
  await page.locator(".pane-seg button", { hasText: "编辑" }).click();
  await until(async () => (await page.locator(".ed-code .ed-ta").count()) === 1, 8000, "editor");
  const edKw = await page.locator(".ed-hl code .hljs-keyword").count();
  const edColor = await page.locator(".ed-ta").evaluate((n) => getComputedStyle(n).color);
  const edText = await page.locator(".ed-hl code").innerText();
  const edColors = await page.evaluate(() => {
    const code = document.querySelector(".ed-hl code");
    const kw = code.querySelector(".hljs-keyword");
    return { base: getComputedStyle(code).color, kw: kw ? getComputedStyle(kw).color : "" };
  });
  log("edit colors:", JSON.stringify(edColors));
  assert(edColors.kw && edColors.kw !== edColors.base, `编辑态关键字要有自己的颜色（base=${edColors.base} kw=${edColors.kw || "无"}）`);
  log("edit keywords:", edKw, "ta color:", edColor, "chars:", edText.length);
  assert(edKw >= 1, `编辑态也该出现 hljs-keyword（拿到 ${edKw} 个）`);
  assert(/rgba?\(0, 0, 0, 0\)|transparent/.test(edColor), `编辑态的字由下层画，textarea 该透明（拿到 ${edColor}）`);
  // 结尾换行会补一个零宽字符（让 <pre> 也占住最后那行空行），比较前先去掉。
  assert(edText.replace(/​/g, "").trimEnd() === TS_SRC.trimEnd(), `编辑态文字与源文件一致（${edText.replace(/​/g, "").length} / ${TS_SRC.length}）`);

  // 打几个字：高亮要跟着走（不是只有打开时染一次）
  await page.locator(".ed-ta").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nconst added = 42;");
  await until(async () => (await page.locator(".ed-hl code").innerText()).includes("const added"), 4000, "highlight follows typing");
  const typedKw = await page.locator(".ed-hl code .hljs-keyword").count();
  log("keywords after typing:", typedKw);
  assert(typedKw > edKw, `新打的关键字也要上色（${edKw} → ${typedKw}）`);

  // 滚动同步：横向、纵向都要跟着
  await page.locator(".ed-ta").evaluate((n) => {
    n.scrollTop = 40;
    n.scrollLeft = 30;
    n.dispatchEvent(new Event("scroll"));
  });
  await sleep(150);
  const scrolls = await page.evaluate(() => {
    const ta = document.querySelector(".ed-ta");
    const pre = document.querySelector(".ed-hl");
    return { top: [ta.scrollTop, pre.scrollTop], left: [ta.scrollLeft, pre.scrollLeft] };
  });
  assert(scrolls.top[0] === scrolls.top[1] && scrolls.left[0] === scrolls.left[1], `高亮层要跟输入层一起滚（${JSON.stringify(scrolls)}）`);

  // 输入法组字期间必须切回「自己显字」，否则中文打不出可见的候选
  await page.locator(".ed-ta").evaluate((n) => n.dispatchEvent(new CompositionEvent("compositionstart")));
  await sleep(80);
  const composing = await page.evaluate(() => ({
    color: getComputedStyle(document.querySelector(".ed-ta")).color,
    hl: getComputedStyle(document.querySelector(".ed-hl")).visibility,
  }));
  log("composing:", JSON.stringify(composing));
  assert(!/rgba?\(0, 0, 0, 0\)/.test(composing.color), `组字期间 textarea 要自己显字（拿到 ${composing.color}）`);
  assert(composing.hl === "hidden", `组字期间高亮层要藏起来（拿到 ${composing.hl}）`);
  await page.locator(".ed-ta").evaluate((n) => n.dispatchEvent(new CompositionEvent("compositionend")));
  await sleep(250);
  const after = await page.locator(".ed-ta").evaluate((n) => getComputedStyle(n).color);
  assert(/rgba?\(0, 0, 0, 0\)/.test(after), `组字结束后回到透明（拿到 ${after}）`);
  await page.screenshot({ path: path.join(OUT, "4-edit-hl.png") });

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
