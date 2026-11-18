/**
 * 内网通页面的前端回归（跑真构建产物 web/dist，API 用 page.route 假造）：
 *
 *   1. 没有历史的人（刚加的好友）点「发消息」必须有输入框，且能真的 POST /api/peer/send；
 *      以前 renderChat() 只认 /threads 里有的会话，而 /threads 只列有历史文件的人 → 死路。
 *   2. 快速切会话不能串台：A 的 /messages 慢、B 的快，切到 B 之后不能再画 A 的消息。
 *   3. #381：通讯录只给 1 人、状态在线表多给一个陌生 nodeId 时，「附近的人」要出现；
 *      点「发消息」要直接聚焦输入框，发出的第一条消息命中这个陌生 nodeId。
 *   4. #382：quick 单独成组（在好友之后、附近的人之前），两颗添加按钮并存，
 *      传文件只给好友、离线禁用，以及中 / 英 / 日三种语境的新文案。
 *   5. #383：忽略名单挡住在线表兜底合并，设置页清空后附近的人重新出现。
 *
 * 用假 API 是刻意的：这些都测「拿到 JSON 之后怎么画」，跟 peer 活着与否无关。
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
const STRANGER = "dddddddd-4444-4444-8444-444444444444";
const QUICK = "eeeeeeee-5555-4555-8555-555555555555";
const OFFLINE = "ffffffff-6666-4666-8666-666666666666";
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

const strangerStatus = {
  ...status,
  online: [
    { nodeId: WANG, nickname: "小王", hostname: "小王-pc", addr: "127.0.0.1", port: 7865, lastSeen: at, ips: ["127.0.0.1"] },
    { nodeId: STRANGER, nickname: "小赵", hostname: "小赵-pc", addr: "127.0.0.1", port: 7865, lastSeen: at, ips: ["127.0.0.1"] },
  ],
};

// #382 的通讯录行：显式带上 online / quick，避免默认桩把好友全画到「好友 · 离线」。
const row = (nodeId, nickname, patch = {}) => ({
  nodeId,
  nickname,
  hostname: `${nickname}-pc`,
  port: 7865,
  friend: false,
  favorite: false,
  incoming: false,
  outgoing: false,
  online: true,
  addr: "127.0.0.1",
  livePort: 7865,
  at,
  ...patch,
});
const quickStatus = {
  ...status,
  online: [
    { nodeId: WANG, nickname: "小王", hostname: "小王-pc", addr: "127.0.0.1", port: 7865, lastSeen: at, ips: ["127.0.0.1"] },
    { nodeId: QUICK, nickname: "小陈", hostname: "小陈-pc", addr: "127.0.0.1", port: 7865, lastSeen: at, ips: ["127.0.0.1"] },
    { nodeId: STRANGER, nickname: "小赵", hostname: "小赵-pc", addr: "127.0.0.1", port: 7865, lastSeen: at, ips: ["127.0.0.1"] },
  ],
};
// 小赵只出现在在线表里、不出现在通讯录里 → 由页面合并进「附近的人」。
const quickContacts = [
  row(WANG, "小王", { friend: true, online: true }),
  row(ZHANG, "小张", { friend: true, online: false }),
  row(QUICK, "小陈", { quick: true }),
  row(OFFLINE, "小钱", { online: false }),
];
let friendCalls = [];
let clearedIgnored = 0;

let sent = null;
let acceptedNote = null;
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
    // D299：小张 3 条未读、小李静音 + 5 条未读（静音只画不带数字的小圆点）。
    else if (p === "/api/peer/threads")
      body = {
        threads: [
          { ...thread(ZHANG, "小张", msg("00000000-0000-4000-8000-00000000000a", "小张的最后一句", me, ZHANG)), unread: 3 },
          { ...thread(LI, "小李", msg("00000000-0000-4000-8000-00000000000b", "小李的最后一句", me, LI)), unread: 5, muted: true },
        ],
      };
    else if (p === "/api/peer/contacts") body = { contacts: [contact(WANG, "小王"), contact(ZHANG, "小张"), contact(LI, "小李")] };
    else if (p === "/api/peer/transfers") body = { transfers: [], free: 1e12 };
    else if (p === "/api/peer/messages") {
      const who = url.searchParams.get("peer");
      if (who === ZHANG) {
        delay = 1000; // 小张的响应慢：切到小李之后才回来
        body = { entries: [msg("aaaaaaaa-0000-4000-8000-000000000001", "我是 A 的消息", { ...me, nodeId: ZHANG, nickname: "小张" }, ME)] };
      } else if (who === LI) {
        // #516：富文本 / 旧纯文本 Markdown / 超长折叠三种气泡各来一条。
        body = {
          entries: [
            msg("bbbbbbbb-0000-4000-8000-000000000001", "我是 B 的消息", { ...me, nodeId: LI, nickname: "小李" }, ME),
            msg(
              "bbbbbbbb-0000-4000-8000-000000000002",
              '<p>富 <strong>粗</strong> <span style="color:#ff0000;font-size:20px">红</span></p><p><a href="https://example.com/x">链接</a></p>',
              { ...me, nodeId: LI, nickname: "小李" },
              ME,
            ),
            msg(
              "bbbbbbbb-0000-4000-8000-000000000003",
              "1. 第一\n2. 第二\n\n# 小标题\n\n| a | b |\n|---|---|\n| 1 | 2 |",
              { ...me, nodeId: LI, nickname: "小李" },
              ME,
            ),
            msg("bbbbbbbb-0000-4000-8000-000000000004", "长".repeat(1700), { ...me, nodeId: LI, nickname: "小李" }, ME),
            {
              id: "bbbbbbbb-0000-4000-8000-000000000005",
              at,
              from: { ...me, nodeId: LI, nickname: "小李" },
              to: { kind: "node", id: ME },
              kind: "note",
              note: {
                title: "复现步骤",
                body: "<p>点一下 <strong>提交</strong> 按钮</p>",
                kind: "bug",
                status: "pending",
                shots: [{ name: "a.png", size: 68, sha256: "a".repeat(64), entryId: "file-a" }],
                accepted: null,
              },
            },
            {
              id: "bbbbbbbb-0000-4000-8000-000000000006",
              at,
              from: { ...me, nodeId: LI, nickname: "小李" },
              to: { kind: "node", id: ME },
              kind: "note",
              note: {
                title: "缺图的记录",
                body: "<p>图还没到</p>",
                kind: "change",
                status: "done",
                shots: [{ name: "b.png", size: 1, sha256: "b".repeat(64), entryId: null }],
                accepted: null,
              },
            },
          ],
        };
      } else {
        body = { entries: [] }; // 小王：没有历史
      }
    } else if (p === "/api/peer/note/accept") {
      acceptedNote = JSON.parse(req.postData() ?? "{}");
      body = { ok: true, noteId: "n_imported" };
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
  const boxes = await page.locator(".peer-rich[contenteditable=true]").count();
  const head = (await page.locator("#main .head").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  check("无历史会话有输入框", boxes === 1, `contenteditable=${boxes}，头部「${head}」`);
  if (boxes === 1) {
    await page.fill(".peer-rich", "你好小王");
    await page.click('#main button:has-text("发送")');
    for (let i = 0; i < 40 && !sent; i++) await page.waitForTimeout(50);
    check("第一条消息真的发出去了", sent?.peer === WANG && sent?.text === "你好小王", JSON.stringify(sent));

    // #515：带格式的正文按 HTML 发，接收端才有东西可渲染。
    sent = null;
    await page.click(".peer-rich");
    await page.keyboard.type("**粗**");
    await page.click('#main button:has-text("发送")');
    for (let i = 0; i < 40 && !sent; i++) await page.waitForTimeout(50);
    check("富文本按 HTML 发出去", sent?.peer === WANG && /<strong>粗<\/strong>/.test(sent?.text ?? ""), JSON.stringify(sent));
  }

  // ---- 2. 切会话串台 ----
  await page.click('#rail button[title="消息"]');

  // D299 / P1：未读徽标在头像右上角；静音会话不带数字。
  const badges = await page.locator(".listbox .row .avwrap .unread").allTextContents();
  check("未读徽标画在头像上", badges.length === 2 && badges[0] === "3" && badges[1] === "", JSON.stringify(badges));
  const quiet = await page.locator(".listbox .row .avwrap .unread.quiet").count();
  check("静音会话的未读是不带数字的小圆点", quiet === 1, `quiet=${quiet}`);
  await page.click('.listbox .row:has-text("小张")');
  await page.click('.listbox .row:has-text("小李")');
  await page.waitForTimeout(1600);
  const text = (await page.locator("#main").innerText()).replace(/\s+/g, " ").trim();
  check(
    "慢响应不会画到别的会话里",
    text.includes("我是 B 的消息") && !text.includes("我是 A 的消息"),
    text.slice(0, 90),
  );
  // #516：三种气泡都画对，链接 / 表格 / 折叠互不打架。
  await page.waitForSelector(".bub-body.rich");
  const richStrong = (await page.locator(".bub-body.rich strong").first().innerText()).trim();
  const richSpan = await page.locator(".bub-body.rich span[style]").count();
  const richLink = await page.locator('.bub-body.rich a[href="https://example.com/x"]').evaluate((a) => ({
    target: a.getAttribute("target"),
    rel: a.getAttribute("rel"),
  }));
  check("富文本气泡保留结构、剥掉颜色字号", richStrong === "粗" && richSpan === 0, `strong=${richStrong}，带样式 span=${richSpan}`);
  check("富文本里的链接新窗口打开", richLink.target === "_blank" && (richLink.rel ?? "").includes("noopener"), JSON.stringify(richLink));
  const mdList = await page.locator(".bub-body.md ol li").count();
  const mdHead = await page.locator(".bub-body.md h3").first().innerText().catch(() => "");
  const mdTable = await page.locator(".bub-body.md table").count();
  check("旧纯文本按 Markdown 渲染列表与标题", mdList === 2 && mdHead.trim() === "小标题", `li=${mdList}，h3=${mdHead}`);
  check("气泡里不渲染表格", mdTable === 0, `table=${mdTable}`);
  const more = page.locator(".bub-more").first();
  const clipBefore = await page.locator(".bub-body.clip").count();
  const moreText = await more.innerText();
  await more.click();
  const clipAfter = await page.locator(".bub-body.clip").count();
  const moreAfter = await more.innerText();
  check("长消息折叠、点开不重渲染", clipBefore === 1 && clipAfter === 0 && moreText === "显示全文" && moreAfter === "收起", `clip=${clipBefore}→${clipAfter}，按钮=${moreText}→${moreAfter}`);
  // #508：记录卡片、缺图禁用、只读预览、接受一次。
  const cards = page.locator(".ncard");
  const cardCount = await cards.count();
  const cardTitle = (await page.locator(".ncard .ntitle").first().innerText()).trim();
  const chips = await page.locator(".ncard").first().locator(".nchip").allInnerTexts();
  check("记录卡片带标题与分类状态", cardCount === 2 && cardTitle === "复现步骤" && chips.join(",") === "bug,待处理", `cards=${cardCount}，title=${cardTitle}，chips=${chips.join(",")}`);
  const missText = await page.locator(".ncard").nth(1).locator(".nmiss").innerText();
  const missDisabled = await page.locator(".ncard").nth(1).locator("button", { hasText: "接受" }).isDisabled();
  check("缺图的卡片禁用接受", missText.includes("还差 1 张图") && missDisabled, `${missText} disabled=${missDisabled}`);
  await page.locator(".ncard").first().locator("button", { hasText: "预览" }).click();
  await page.waitForSelector(".modal.notepeek");
  const peekStrong = (await page.locator(".notepeek .note-rich strong").innerText()).trim();
  const peekEditable = await page.locator(".notepeek [contenteditable]").count();
  check("预览是只读正文", peekStrong === "提交" && peekEditable === 0, `strong=${peekStrong} editable=${peekEditable}`);
  await page.keyboard.press("Escape");
  await page.locator(".ncard").first().locator("button", { hasText: "接受" }).click();
  await page.waitForSelector(".ncard.accepted");
  const acceptedBody = acceptedNote;
  const openBtn = await page.locator(".ncard.accepted button", { hasText: "打开记录" }).count();
  check("接受后变「已接受」并可打开记录", acceptedBody?.peer === LI && acceptedBody?.id === "bbbbbbbb-0000-4000-8000-000000000005" && openBtn === 1, JSON.stringify(acceptedBody));
  await page.screenshot({ path: path.join(REPO, ".scratch", "shots", "peer-ui.png") });

  // ---- #381：通讯录桩只给 1 人，状态在线名单多给一个陌生 nodeId ----
  sent = null; // 上一段已经写过一次 sent，这段要重新看
  const ctx2 = await browser.newContext({ locale: "zh-CN", viewport: { width: 1240, height: 820 } });
  const page2 = await ctx2.newPage();
  await page2.route("**/api/**", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    let body = {};
    if (p === "/api/peer") body = { enabled: true, running: true, reason: "", status: strangerStatus };
    else if (p === "/api/peer/threads") body = { threads: [] };
    else if (p === "/api/peer/contacts") body = { contacts: [contact(WANG, "小王")] };
    else if (p === "/api/peer/transfers") body = { transfers: [], free: 1e12 };
    else if (p === "/api/peer/messages") body = { entries: [] };
    else if (p === "/api/peer/send") {
      sent = JSON.parse(req.postData() ?? "{}");
      body = { ok: true, id: "sent-by-ui" };
    }
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
  });
  await page2.goto(`${BASE}/peer.html`);
  await page2.waitForSelector('#rail button[title="联系人"]');
  await page2.click('#rail button[title="联系人"]');
  await page2.waitForSelector(".listbox .row");
  const nearbyGroup = await page2.locator('.group-title:has-text("附近的人")').count();
  const strangerRow = await page2.locator('.listbox .row:has-text("小赵")').count();
  check("通讯录只给 1 人时在线陌生人出现在附近的人", nearbyGroup === 1 && strangerRow === 1, `组=${nearbyGroup}，行=${strangerRow}`);
  await page2.click('.listbox .row:has-text("小赵")');
  await page2.click('#main button:has-text("发消息")');
  const focused = await page2.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement && el.classList.contains("peer-rich") ? "peer-rich" : (el?.tagName ?? "");
  });
  const boxes2 = await page2.locator(".peer-rich[contenteditable=true]").count();
  check("点发消息后输入框拿到焦点", focused === "peer-rich" && boxes2 === 1, `active=${focused}，contenteditable=${boxes2}`);
  if (boxes2 === 1) {
    await page2.fill(".peer-rich", "你好小赵");
    await page2.click('#main button:has-text("发送")');
    for (let i = 0; i < 40 && !sent; i++) await page2.waitForTimeout(50);
    check("附近的人发第一条消息命中正确 nodeId", sent?.peer === STRANGER && sent?.text === "你好小赵", JSON.stringify(sent));
  }

  // ---- #382：quick 分组 / 两颗按钮 / 文件权限 / 离线禁用 / 三语文案 ----
  const quickFixture = async (locale) => {
    const c = await browser.newContext({ locale, viewport: { width: 1240, height: 820 } });
    const p = await c.newPage();
    const missing = [];
    p.on("console", (m) => { if (m.text().includes("[i18n] missing")) missing.push(m.text()); });
    await p.route("**/api/**", async (route) => {
      const req = route.request();
      const path2 = new URL(req.url()).pathname;
      let body = {};
      if (path2 === "/api/peer") body = { enabled: true, running: true, reason: "", status: quickStatus };
      else if (path2 === "/api/peer/threads") body = { threads: [] };
      else if (path2 === "/api/peer/contacts") body = { contacts: quickContacts };
      else if (path2 === "/api/peer/transfers") body = { transfers: [], free: 1e12 };
      else if (path2 === "/api/peer/messages") body = { entries: [] };
      else if (path2 === "/api/peer/send") body = { ok: true, id: "sent-by-ui" };
      else if (path2 === "/api/peer/friend") {
        friendCalls.push(JSON.parse(req.postData() ?? "{}"));
        body = { ok: true };
      }
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
    });
    await p.goto(`${BASE}/peer.html`);
    await p.waitForSelector("#rail button:nth-child(2)");
    await p.click("#rail button:nth-child(2)");
    await p.waitForSelector(".listbox .row");
    return { c, p, missing };
  };
  const titlesOf = (p) => p.locator(".group-title").evaluateAll((els) => els.map((el) => el.firstChild?.textContent?.trim() ?? ""));
  const relationOf = (p) => p.locator("#main .kv .v").nth(4).innerText();
  // D300：传文件不再要好友，所以「加为好友」这颗按钮之外，任何（在线的）人都该有「传文件」。
  const exactFile = (p) => p.locator("#main button").filter({ hasText: /^传文件$/ }).count();

  friendCalls = [];
  const zh = await quickFixture("zh-CN");
  const zhTitles = await titlesOf(zh.p);
  check(
    "quick 单独成组且在好友之后、附近的人之前",
    JSON.stringify(zhTitles) === JSON.stringify(["好友 · 在线", "好友 · 离线", "快捷联系人", "附近的人"]),
    JSON.stringify(zhTitles),
  );
  const quickRow = await zh.p.locator('.listbox .row:has-text("小陈")').count();
  check("快捷联系人行出现在列表里", quickRow === 1, `行=${quickRow}`);

  await zh.p.click('.listbox .row:has-text("小陈")');
  const zhRel = (await relationOf(zh.p)).trim();
  const quickDone = await zh.p.locator('#main button:has-text("已是快捷联系人")').count();
  const quickDoneDisabled = await zh.p.locator('#main button:has-text("已是快捷联系人")').isDisabled();
  const addFriendBtn = await zh.p.locator('#main button:has-text("加为好友")').count();
  const quickFileBtn = await exactFile(zh.p);
  const quickPending = await zh.p.locator('#main .note:has-text("已发申请")').count();
  check(
    "已 quick 的人：禁用快捷按钮、仍可加好友、传文件照给（D300）",
    zhRel === "快捷联系人" && quickDone === 1 && quickDoneDisabled && addFriendBtn === 1 && quickFileBtn === 1 && quickPending === 0,
    `关系=${zhRel}，已快捷=${quickDone}/禁用=${quickDoneDisabled}，加好友=${addFriendBtn}，传文件=${quickFileBtn}，待处理=${quickPending}`,
  );

  // 已 quick 又点了「加为好友」后，资料卡必须显示「已发申请」而不是被 quick 遮住。
  const pendingFixture = await browser.newContext({ locale: "zh-CN", viewport: { width: 1240, height: 820 } });
  const pp = await pendingFixture.newPage();
  await pp.route("**/api/**", async (route) => {
    const path2 = new URL(route.request().url()).pathname;
    let body = {};
    if (path2 === "/api/peer") body = { enabled: true, running: true, reason: "", status: quickStatus };
    else if (path2 === "/api/peer/contacts") body = { contacts: [{ ...row(QUICK, "小陈"), quick: true, outgoing: true }] };
    else body = { threads: [], contacts: [], entries: [], transfers: [], nodeIds: [], ok: true, free: 1e12 };
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
  });
  await pp.goto(`${BASE}/peer.html`);
  await pp.click("#rail button:nth-child(2)");
  await pp.click('.listbox .row:has-text("小陈")');
  const pendingRel = (await relationOf(pp)).trim();
  check("quick + 已发申请：资料卡优先显示待处理", pendingRel === "已发申请", `关系=${pendingRel}`);
  await pendingFixture.close();

  await zh.p.click('.listbox .row:has-text("小赵")');
  const twoButtons = await zh.p.locator('#main button:has-text("快捷添加（可聊天）")').count();
  const twoButtons2 = await zh.p.locator('#main button:has-text("加为好友")').count();
  const strangerFile = await exactFile(zh.p);
  check("在线陌生人详情两颗添加按钮并存且照样能传文件", twoButtons === 1 && twoButtons2 === 1 && strangerFile === 1, `快捷=${twoButtons}，加好友=${twoButtons2}，传文件=${strangerFile}`);
  await zh.p.click('#main button:has-text("快捷添加（可聊天）")');
  for (let i = 0; i < 40 && !friendCalls.length; i++) await zh.p.waitForTimeout(50);
  check(
    "点快捷添加真的发出 action=quick 且 peer 正确",
    friendCalls.at(-1)?.action === "quick" && friendCalls.at(-1)?.peer === STRANGER,
    JSON.stringify(friendCalls),
  );

  await zh.p.click('.listbox .row:has-text("小钱")');
  const offQuick = zh.p.locator('#main button:has-text("快捷添加（可聊天）")');
  const offAdd = zh.p.locator('#main button:has-text("加为好友")');
  const offQuickDisabled = await offQuick.isDisabled();
  const offQuickTitle = await offQuick.getAttribute("title");
  const offAddDisabled = await offAdd.isDisabled();
  const offFile = zh.p.locator("#main button").filter({ hasText: /^传文件$/ });
  const offFileDisabled = await offFile.isDisabled();
  const offVisibleNote = await zh.p.locator('#main .note:has-text("对方已离线，等他上线再试")').count();
  check(
    "离线的人三颗按钮都禁用且提示等上线",
    offQuickDisabled && offAddDisabled && offFileDisabled && offQuickTitle === "对方已离线，等他上线再试" && offVisibleNote === 1,
    `快捷禁用=${offQuickDisabled}/title=${offQuickTitle}，加好友禁用=${offAddDisabled}，传文件禁用=${offFileDisabled}，可见提示=${offVisibleNote}`,
  );

  await zh.p.click('.listbox .row:has-text("小王")');
  const friendFile = await exactFile(zh.p);
  const friendQuick = await zh.p.locator('#main button:has-text("快捷添加（可聊天）")').count();
  check("好友有传文件、没有快捷添加按钮", friendFile === 1 && friendQuick === 0, `传文件=${friendFile}，快捷=${friendQuick}`);
  const detailAfterSwitch = (await zh.p.locator("#main .detail .hero").innerText().catch(() => "")).replace(/\s+/g, " ");
  check("连续切人不串台（详情跟着最后点的人走）", detailAfterSwitch.includes("小王") && !detailAfterSwitch.includes("小钱"), detailAfterSwitch.slice(0, 80));
  check("中文语境没有缺译文告警", zh.missing.length === 0, zh.missing.join(" | "));
  await zh.c.close();

  for (const [locale, group, quickLabel, addLabel] of [
    ["en", "Quick contacts", "Quick add (chat only)", "Add as friend"],
    ["ja", "クイック連絡先", "クイック追加（チャットのみ）", "友だちに追加"],
  ]) {
    const fx = await quickFixture(locale);
    const ts = await titlesOf(fx.p);
    check(`${locale} 语境 quick 分组名已翻译`, ts.includes(group), JSON.stringify(ts));
    check(`${locale} 语境没有缺译文告警`, fx.missing.length === 0, fx.missing.join(" | "));
    await fx.p.click(`.listbox .row:has-text("小赵")`);
    const ql = await fx.p.locator(`#main button:has-text("${quickLabel}")`).count();
    const al = await fx.p.locator(`#main button:has-text("${addLabel}")`).count();
    check(`${locale} 语境两颗按钮文案到位`, ql === 1 && al === 1, `快捷=${ql}，加好友=${al}`);
    await fx.c.close();
  }

  // ---- #383：忽略名单挡住在线表兜底，设置页清空后恢复 ----
  const ignoredFixture = async () => {
    const c = await browser.newContext({ locale: "zh-CN", viewport: { width: 1240, height: 820 } });
    const p = await c.newPage();
    const missing = [];
    p.on("console", (m) => { if (m.text().includes("[i18n] missing")) missing.push(m.text()); });
    let cleared = false;
    friendCalls = [];
    await p.route("**/api/**", async (route) => {
      const req = route.request();
      const path2 = new URL(req.url()).pathname;
      let body = {};
      if (path2 === "/api/peer") body = { enabled: true, running: true, reason: "", status: strangerStatus };
      else if (path2 === "/api/peer/threads") body = { threads: [] };
      else if (path2 === "/api/peer/contacts") body = { contacts: [contact(WANG, "小王")] };
      else if (path2 === "/api/peer/transfers") body = { transfers: [], free: 1e12 };
      else if (path2 === "/api/peer/messages") body = { entries: [] };
      else if (path2 === "/api/peer/ignored") body = { ok: true, nodeIds: cleared ? [] : [STRANGER] };
      else if (path2 === "/api/peer/ignored/clear") { cleared = true; clearedIgnored += 1; body = { ok: true, cleared: 1 }; }
      else if (path2 === "/api/peer/friend") { friendCalls.push(JSON.parse(req.postData() ?? "{}")); body = { ok: true }; }
      else if (path2 === "/api/peer/send") body = { ok: true, id: "sent-by-ui" };
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
    });
    await p.goto(`${BASE}/peer.html`);
    await p.waitForSelector('#rail button[title="联系人"]');
    await p.click('#rail button[title="联系人"]');
    await p.waitForSelector(".listbox .row");
    return { c, p, missing, cleared: () => cleared };
  };

  const ig = await ignoredFixture();
  const ignoredRow = await ig.p.locator('.listbox .row:has-text("小赵")').count();
  check("忽略名单里的人不再出现在附近的人", ignoredRow === 0, `行=${ignoredRow}`);

  // 设置页：忽略名单卡显示数量，点「清空忽略名单」后仍在线的人重新出现。
  await ig.p.click('#rail button[title="我"]');
  await ig.p.waitForSelector('#main button:has-text("清空忽略名单")');
  const countNote = await ig.p.locator('#main .note:has-text("已忽略 1 人")').count();
  const clearDisabled = await ig.p.locator('#main button:has-text("清空忽略名单")').isDisabled();
  check("设置页显示忽略人数且清空按钮可用", countNote === 1 && !clearDisabled, `note=${countNote}，禁用=${clearDisabled}`);
  await ig.p.click('#main button:has-text("清空忽略名单")');
  for (let i = 0; i < 40 && clearedIgnored === 0; i++) await ig.p.waitForTimeout(50);
  check("点清空真的 POST /api/peer/ignored/clear", clearedIgnored === 1 && ig.cleared(), `次数=${clearedIgnored}`);

  await ig.p.click('#rail button[title="联系人"]');
  await ig.p.waitForSelector(".listbox .row");
  const backRow = await ig.p.locator('.listbox .row:has-text("小赵")').count();
  const nearbyBack = await ig.p.locator('.group-title:has-text("附近的人")').count();
  check("清空忽略名单后附近的人恢复", backRow === 1 && nearbyBack === 1, `行=${backRow}，组=${nearbyBack}`);
  await ig.p.click('.listbox .row:has-text("小赵")');
  const removeBtn = await ig.p.locator('#main button:has-text("从附近移除")').count();
  check("附近的人详情有「从附近移除」入口", removeBtn === 1, `按钮=${removeBtn}`);
  await ig.p.click('#main button:has-text("从附近移除")');
  for (let i = 0; i < 40 && !friendCalls.length; i++) await ig.p.waitForTimeout(50);
  check(
    "点从附近移除真的发出 action=remove 且 peer 正确",
    friendCalls.at(-1)?.action === "remove" && friendCalls.at(-1)?.peer === STRANGER,
    JSON.stringify(friendCalls),
  );
  check("#383 中文语境没有缺译文告警", ig.missing.length === 0, ig.missing.join(" | "));
  await ig.c.close();
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
