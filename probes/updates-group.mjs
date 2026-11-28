/**
 * D441 守卫：局域网固定只读更新组的界面（跑真构建产物 web/dist，API 用 page.route 假造）。
 *
 * 要守的是「成员到底能不能发」「公告卡片读不读得下去」：
 *  1. 成员：更新组里没有输入区（`.peer-rich`）、没有发文件按钮，底部是只读提示条。
 *  2. 成员的「更多」菜单里没有建群 / 改群名以外的写操作（退出仍在）。
 *  3. 公告卡片：仓库 + 短提交 + 批次标题 + 批次正文的条目都画出来。
 *  4. 公告卡片上的「打开更新日志」开的是 `/?settings=whatsnew`（主界面 D441 深链）。
 *  5. 消息右键只剩「复制文字」；悬停不出现回应笑脸、气泡上没有回应行。
 *  6. 发布者同一份数据：有输入区、没有只读条、卡片照画。
 *  7. 设置页「更新公告」卡：发布者看到「本机是发布者」+ 立即检查可点；成员看到「没加入」+ 重新加入。
 *  8. 字号 150%：卡片不横向溢出（`scrollWidth <= clientWidth + 1`）。
 *
 * 用法：npm run build:web && node probes/updates-group.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const DIST = path.join(REPO, "web", "dist");
const OUT = path.join(REPO, ".scratch", "updates-group", "shots");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!fs.existsSync(path.join(DIST, "peer.html"))) {
  console.error(`没找到 ${path.join(DIST, "peer.html")}：先跑 npm run build:web`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

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
  const file = path.resolve(DIST, rel);
  if (!file.startsWith(DIST + path.sep)) return res.writeHead(404).end("not found");
  // 一次 statSync 就把「存在 / 是目录」都判了，别在 existsSync 和 statSync 之间留 TOCTOU（评审 #21）。
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return res.writeHead(404).end("not found");
  }
  if (stat.isDirectory()) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const ME = "11111111-1111-4111-8111-111111111111";
const PUB = "22222222-2222-4222-8222-222222222222";
const GROUP = "grp-updates-yang-code01-pi-web-client";
const REPO_SLUG = "yang-code01/pi-web-client";
const at = Date.now() - 60_000;

const me = (nodeId, nickname) => ({ nodeId, nickname, hostname: "probe", port: 7865, online: [] });
const viewFor = (nodeId, nickname, publisher) => ({
  enabled: true,
  running: true,
  reason: "",
  status: {
    ...me(nodeId, nickname),
    config: { hidden: false, pauseFiles: false, dnd: false, inbox: "/tmp", manual: [], updates: { repo: REPO_SLUG, publisher } },
  },
});
const announce = {
  id: "m-announce",
  at,
  from: { nodeId: PUB, nickname: "发布者" },
  to: { kind: "group", id: GROUP },
  kind: "text",
  reactions: [{ emoji: "👍", who: [PUB] }],
  text: `${REPO_SLUG} 更新到 abc1234（2026-11-28）\n\n· 2026-11-28 · 局域网更新组（#730）\n\n怎么更新：设置 → 工具 → 热部署`,
  announce: {
    repo: REPO_SLUG,
    commit: "abc1234",
    batches: [{ title: "2026-11-28 · 局域网更新组（#730）", body: "### 新增\n\n- 固定只读更新组\n- 成员不能发消息\n" }],
    howTo: "auto",
  },
};
const threadFor = (nodeId) => ({
  nodeId: GROUP,
  nickname: `${REPO_SLUG} 更新`,
  hostname: "",
  port: 0,
  last: announce,
  count: 1,
  online: true,
  status: "",
  lastSeen: at,
  unread: 1,
  pinned: false,
  muted: false,
  draft: "",
  lastMine: false,
  sending: false,
  typing: false,
  group: {
    members: [
      { nodeId: PUB, nickname: "发布者" },
      { nodeId, nickname: "我" },
    ],
    owner: PUB,
    left: false,
    announceOnly: true,
    publisher: PUB,
  },
});
const updatesFor = (publisher) => ({
  ok: true,
  available: true,
  repo: REPO_SLUG,
  groupId: GROUP,
  groupName: `${REPO_SLUG} 更新`,
  publisher,
  joined: publisher ? true : false,
  memberCount: 2,
  onlineCount: 1,
  lastCommit: "abc1234",
  lastBatchTitle: "2026-11-28 · 局域网更新组（#730）",
  lastAnnouncedAt: at,
  lastCheckAt: at,
  lastError: "",
  hotdeploy: true,
  peerRunning: true,
});

let failed = 0;
const ok = (t) => log("✔", t);
const bad = (t, d) => {
  failed++;
  console.error("✘", t, d === undefined ? "" : JSON.stringify(d).slice(0, 400));
};
const check = (cond, label, detail) => (cond ? ok(label) : bad(label, detail));

async function mock(page, nodeId, nickname, publisher) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const body = (() => {
      if (p === "/api/peer") return viewFor(nodeId, nickname, publisher);
      if (p === "/api/updates") return updatesFor(publisher);
      if (p === "/api/peer/threads") return { threads: [threadFor(nodeId)] };
      if (p === "/api/peer/contacts") return { contacts: [] };
      if (p === "/api/peer/ignored") return { nodeIds: [] };
      if (p === "/api/peer/transfers") return { transfers: [], free: 0 };
      if (p === "/api/peer/stickers") return { stickers: [] };
      if (p === "/api/peer/messages") return { entries: [announce] };
      return { ok: true };
    })();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

const browser = await chromium.launch({ headless: true });
try {

// ---------------------------------------------------------------- 成员视角
const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1180, height: 820 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__opened = [];
  // 卡片用 `window.open(url, "_blank", "noopener")`：handle 拿不到，这里记下 URL 再放行。
  const orig = window.open;
  window.open = (url, ...rest) => {
    window.__opened.push(String(url));
    return orig.apply(window, [url, ...rest]);
  };
});
await mock(page, ME, "我", false);
await page.goto(`${BASE}/peer.html`);
await page.waitForSelector(".an-card", { timeout: 15_000 });

check((await page.locator(".compose .peer-rich").count()) === 0, "成员没有输入区");
check((await page.locator(".compose.readonlybar").count()) === 1, "成员底部是只读提示条");
check((await page.locator('.tools .icon-btn[title="发文件"]').count()) === 0, "成员没有「发文件」");

const card = page.locator(".an-card").first();
const cardText = await card.innerText();
check(cardText.includes(REPO_SLUG) && cardText.includes("abc1234"), "卡片有仓库与短提交", cardText);
check(cardText.includes("2026-11-28 · 局域网更新组（#730）"), "卡片有批次标题");
check(cardText.includes("固定只读更新组") && cardText.includes("成员不能发消息"), "卡片有批次正文条目");
check(cardText.includes("热部署"), "有热部署时「怎么更新」指向热部署", cardText);

await page.locator(".an-acts .btn").first().click();
const opened = await page.evaluate(() => window.__opened ?? []);
check(opened.some((u) => u === "/?settings=whatsnew"), "打开更新日志指向 /?settings=whatsnew", opened);
await page.locator(".an-acts .btn").nth(1).click();
const opened2 = await page.evaluate(() => window.__opened ?? []);
check(opened2.some((u) => u === "/?settings=tools"), "热部署可用时有「打开热部署」→ /?settings=tools", opened2);

// 右键：只读群里只剩「复制文字」。
await page.locator(".msg .bub, .msg .an-card").first().click({ button: "right" });
const menuItems = await page.locator("#layer .menu > button").allInnerTexts().catch(() => []);
check(menuItems.length === 1 && menuItems[0].includes("复制文字"), "成员右键菜单只剩复制文字", menuItems);
await page.keyboard.press("Escape");

check((await page.locator(".msg-quick").count()) === 0, "成员看不到回应笑脸");
check((await page.locator(".reacts").count()) === 0, "成员消息上没有回应行（发布者的回应也不画操作）");
await page.screenshot({ path: path.join(OUT, "member.png"), fullPage: false });

// 设置页：成员 → 没加入 + 重新加入。
await page.getByRole("button", { name: "我" }).click();
await page.waitForSelector(".card", { timeout: 5000 });
const meText = await page.locator("#main").innerText();
check(meText.includes("更新公告") && meText.includes("没加入"), "成员设置页显示没加入", meText.slice(0, 300));
check(meText.includes("重新加入更新组"), "成员设置页给「重新加入更新组」");
await page.locator("h3", { hasText: "更新公告" }).scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(OUT, "member-settings.png") });

// 字号 150%：卡片不横向溢出。
await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "1.5"));
const overflow = await page.evaluate(() => {
  const el = document.querySelector(".an-card");
  return el ? el.scrollWidth - el.clientWidth : 0;
});
check(overflow <= 1, "字号 150% 卡片不横向溢出", overflow);

// ---------------------------------------------------------------- 发布者视角
const ctx2 = await browser.newContext({ locale: "zh-CN", viewport: { width: 1180, height: 820 } });
const page2 = await ctx2.newPage();
// 发布者这边也记 window.open：以后加「打开更新日志」的断言时别读到 undefined（评审 #17）。
await page2.addInitScript(() => {
  window.__opened = [];
  const orig = window.open;
  window.open = (url, ...rest) => {
    window.__opened.push(String(url));
    return orig.apply(window, [url, ...rest]);
  };
});
await mock(page2, PUB, "发布者", true);
await page2.goto(`${BASE}/peer.html`);
await page2.waitForSelector(".an-card", { timeout: 15_000 });
check((await page2.locator(".compose .peer-rich").count()) === 1, "发布者有输入区");
check((await page2.locator(".compose.readonlybar").count()) === 0, "发布者没有只读条");
check((await page2.locator(".an-card").count()) === 1, "发布者那边公告卡片照画");
check((await page2.locator(".reacts").count()) === 1, "发布者那边照常画回应行");
await page2.getByRole("button", { name: "我" }).click();
await page2.waitForSelector(".card", { timeout: 5000 });
const pubText = await page2.locator("#main").innerText();
check(pubText.includes("本机是发布者"), "发布者设置页显示「本机是发布者」", pubText.slice(0, 300));
check((await page2.locator(".acts .btn", { hasText: "立即检查" }).isEnabled().catch(() => false)) === true, "发布者「立即检查」可点");
await page2.locator("h3", { hasText: "更新公告" }).scrollIntoViewIfNeeded();
await page2.screenshot({ path: path.join(OUT, "publisher-settings.png") });

} finally {
  // 探针中途抛错也要收掉 Chromium，否则 headless 进程会留在后台（评审 #20）。
  await browser.close().catch(() => {});
  server.close();
}
log(failed ? `失败 ${failed} 项` : "全部通过");
process.exit(failed ? 1 : 0);
