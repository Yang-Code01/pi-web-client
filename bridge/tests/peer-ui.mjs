/**
 * 内网通页面的两个前端回归（跑真构建产物 web/dist，API 用 page.route 假造）：
 *
 *   1. 没有历史的人（刚加的好友）点「发消息」必须有输入框，且能真的 POST /api/peer/send；
 *      以前 renderChat() 只认 /threads 里有的会话，而 /threads 只列有历史文件的人 → 死路。
 *   2. 快速切会话不能串台：A 的 /messages 慢、B 的快，切到 B 之后不能再画 A 的消息。
 *
 * 用假 API 是刻意的：这两个 bug 都在「拿到 JSON 之后怎么画」，跟 peer 活着与否无关。
 *
 * 用法：node bridge/tests/peer-ui.mjs   （先 npm run build:web）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const DIST = path.join(REPO, "web", "dist");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (!fs.existsSync(path.join(DIST, "peer.html"))) {
  console.error(`没找到 ${path.join(DIST, "peer.html")}：先跑 npm run build:web`);
  process.exit(1);
}

const { chromium } = await loadPlaywright();
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const rel = url.pathname === "/" || url.pathname === "/peer" ? "peer.html" : url.pathname.slice(1);
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
fs.mkdirSync(path.join(REPO, ".scratch", "shots"), { recursive: true });
const BASE = `http://127.0.0.1:${server.address().port}`;

const ME = "99999999-8888-4777-8666-555555555555";
const ZHANG = "aaaaaaaa-1111-4111-8111-111111111111";
const LI = "bbbbbbbb-2222-4222-8222-222222222222";
const WANG = "cccccccc-3333-4333-8333-333333333333";
const at = Date.now() - 30_000;

const msg = (id, text, from, to) => ({ id, at, from, to: { kind: "node", id: to }, kind: "text", text, ack: { id, status: "delivered" } });
const me = { nodeId: ME, nickname: "我", hostname: "probe", port: 17965 };
const thread = (nodeId, nickname, last) => ({
  nodeId,
  nickname,
  hostname: `${nickname}-pc`,
  port: 7865,
  last,
  count: 1,
  online: true,
});
const contact = (nodeId, nickname) => ({
  nodeId,
  nickname,
  hostname: `${nickname}-pc`,
  port: 7865,
  friend: true,
  favorite: false,
  incoming: false,
  outgoing: false,
  at,
});

const status = {
  ok: true,
  proto: 1,
  version: "0.1.0",
  nodeId: ME,
  nickname: "我",
  hostname: "probe",
  port: 17965,
  online: [
    { nodeId: ZHANG, nickname: "小张", hostname: "小张-pc", addr: "127.0.0.1", port: 7865, lastSeen: at, ips: ["127.0.0.1"] },
    { nodeId: LI, nickname: "小李", hostname: "小李-pc", addr: "127.0.0.1", port: 7865, lastSeen: at, ips: ["127.0.0.1"] },
    { nodeId: WANG, nickname: "小王", hostname: "小王-pc", addr: "127.0.0.1", port: 7865, lastSeen: at, ips: ["127.0.0.1"] },
  ],
  config: { hidden: false, pauseFiles: false, dnd: false, inbox: "C:/inbox", manual: [] },
};

let sent = null;
const browser = await chromium.launch();
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1240, height: 820 } });
  const page = await ctx.newPage();
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    let body = {};
    let delay = 0;
    if (p === "/api/peer") body = { enabled: true, running: true, reason: "", status };
    else if (p === "/api/peer/threads") body = { threads: [thread(ZHANG, "小张", msg("00000000-0000-4000-8000-00000000000a", "小张的最后一句", me, ZHANG)), thread(LI, "小李", msg("00000000-0000-4000-8000-00000000000b", "小李的最后一句", me, LI))] };
    else if (p === "/api/peer/contacts") body = { contacts: [contact(WANG, "小王"), contact(ZHANG, "小张"), contact(LI, "小李")] };
    else if (p === "/api/peer/transfers") body = { transfers: [], free: 1e12 };
    else if (p === "/api/peer/messages") {
      const who = url.searchParams.get("peer");
      if (who === ZHANG) {
        delay = 1000; // 小张的响应慢：切到小李之后才回来
        body = { entries: [msg("aaaaaaaa-0000-4000-8000-000000000001", "我是 A 的消息", { ...me, nodeId: ZHANG, nickname: "小张" }, ME)] };
      } else if (who === LI) {
        body = { entries: [msg("bbbbbbbb-0000-4000-8000-000000000001", "我是 B 的消息", { ...me, nodeId: LI, nickname: "小李" }, ME)] };
      } else {
        body = { entries: [] }; // 小王：没有历史
      }
    } else if (p === "/api/peer/send") {
      sent = JSON.parse(req.postData() ?? "{}");
      body = { ok: true, id: "sent-by-ui" };
    }
    if (delay) await new Promise((r) => setTimeout(r, delay));
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
  });

  await page.goto(`${BASE}/peer.html`);
  await page.waitForSelector(".listbox .row");

  // ---- 1. 没有历史的人也要能发第一条消息 ----
  await page.click('#rail button[title="联系人"]');
  await page.click('.listbox .row:has-text("小王")');
  await page.click('#main button:has-text("发消息")');
  const boxes = await page.locator("textarea").count();
  const head = (await page.locator("#main .head").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  check("无历史会话有输入框", boxes === 1, `textarea=${boxes}，头部「${head}」`);
  if (boxes === 1) {
    await page.fill("textarea", "你好小王");
    await page.click('#main button:has-text("发送")');
    for (let i = 0; i < 40 && !sent; i++) await page.waitForTimeout(50);
    check("第一条消息真的发出去了", sent?.peer === WANG && sent?.text === "你好小王", JSON.stringify(sent));
  }

  // ---- 2. 切会话串台 ----
  await page.click('#rail button[title="消息"]');
  await page.click('.listbox .row:has-text("小张")');
  await page.click('.listbox .row:has-text("小李")');
  await page.waitForTimeout(1600);
  const text = (await page.locator("#main").innerText()).replace(/\s+/g, " ").trim();
  check(
    "慢响应不会画到别的会话里",
    text.includes("我是 B 的消息") && !text.includes("我是 A 的消息"),
    text.slice(0, 90),
  );
  await page.screenshot({ path: path.join(REPO, ".scratch", "shots", "peer-ui.png") });
} catch (err) {
  check("脚本跑完", false, err?.message ?? String(err));
} finally {
  await browser.close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
if (bad.length) {
  console.error(`\npeer-ui：${bad.length} 项失败`);
  process.exit(1);
}
log("peer-ui 全过");
process.exit(0);
