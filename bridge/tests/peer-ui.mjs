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
 *   6. #394：对话打开 / 切换 / 收到新消息停在最底部；翻到中间时收到新消息保位。
 *   7. #395：列表行的未读数；打开即清零；停在对话里时新消息直接已读；另一个浏览器标记后这边同样清零。
 *   8. #396：「消息」导航（宽屏 rail / 窄屏底部）有未读时画一颗圆点、不写数字，读完后消失。
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
  const focused = await page2.evaluate(() => document.activeElement?.tagName ?? "");
  const boxes2 = await page2.locator("textarea").count();
  check("点发消息后输入框拿到焦点", focused === "TEXTAREA" && boxes2 === 1, `active=${focused}，textarea=${boxes2}`);
  if (boxes2 === 1) {
    await page2.fill("textarea", "你好小赵");
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
  // 按钮「加为好友（可传文件）」也含「传文件」三个字，必须用精确文本找真正的传文件按钮。
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
  const addFriendBtn = await zh.p.locator('#main button:has-text("加为好友（可传文件）")').count();
  const quickFileBtn = await exactFile(zh.p);
  const quickPending = await zh.p.locator('#main .note:has-text("已发申请")').count();
  check(
    "已 quick 的人：禁用快捷按钮、仍可加好友、不给传文件",
    zhRel === "快捷联系人" && quickDone === 1 && quickDoneDisabled && addFriendBtn === 1 && quickFileBtn === 0 && quickPending === 0,
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
  const twoButtons2 = await zh.p.locator('#main button:has-text("加为好友（可传文件）")').count();
  const strangerFile = await exactFile(zh.p);
  check("在线陌生人详情两颗添加按钮并存且不给传文件", twoButtons === 1 && twoButtons2 === 1 && strangerFile === 0, `快捷=${twoButtons}，加好友=${twoButtons2}，传文件=${strangerFile}`);
  await zh.p.click('#main button:has-text("快捷添加（可聊天）")');
  for (let i = 0; i < 40 && !friendCalls.length; i++) await zh.p.waitForTimeout(50);
  check(
    "点快捷添加真的发出 action=quick 且 peer 正确",
    friendCalls.at(-1)?.action === "quick" && friendCalls.at(-1)?.peer === STRANGER,
    JSON.stringify(friendCalls),
  );

  await zh.p.click('.listbox .row:has-text("小钱")');
  const offQuick = zh.p.locator('#main button:has-text("快捷添加（可聊天）")');
  const offAdd = zh.p.locator('#main button:has-text("加为好友（可传文件）")');
  const offQuickDisabled = await offQuick.isDisabled();
  const offQuickTitle = await offQuick.getAttribute("title");
  const offAddDisabled = await offAdd.isDisabled();
  const offVisibleNote = await zh.p.locator('#main .note:has-text("对方已离线，等他上线再试")').count();
  check(
    "离线的人两颗按钮都禁用且提示等上线",
    offQuickDisabled && offAddDisabled && offQuickTitle === "对方已离线，等他上线再试" && offVisibleNote === 1,
    `快捷禁用=${offQuickDisabled}/title=${offQuickTitle}，加好友禁用=${offAddDisabled}，可见提示=${offVisibleNote}`,
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
    ["en", "Quick contacts", "Quick add (chat only)", "Add as friend (files allowed)"],
    ["ja", "クイック連絡先", "クイック追加（チャットのみ）", "友だちに追加（ファイル送信可）"],
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

  // #395：未读数。列表行右侧的药丸显示未读条数；打开对话即清零；停在对话里时来的新消息直接已读；两个浏览器共用已读。
  // 假接口带状态（两个页面共用同一份 unread）：读 /threads 的 unread，POST /read 清零，receive() 模拟对方来信。
  const unread = {
    counts: { [ZHANG]: 2, [LI]: 3 },
    entries: {
      [ZHANG]: [msg("zhang-1", "小张的旧消息", { nodeId: ZHANG, nickname: "小张" }, ME)],
      [LI]: [msg("li-1", "小李的旧消息", { nodeId: LI, nickname: "小李" }, ME)],
    },
    reads: [],
  };
  const receive = (nodeId, text) => {
    unread.entries[nodeId].push(msg(`recv-${unread.entries[nodeId].length}-${text}`, text, { nodeId, nickname: nodeId === ZHANG ? "小张" : "小李" }, ME));
    unread.counts[nodeId] += 1;
  };
  const unreadPage = async () => {
    const c = await browser.newContext({ locale: "zh-CN", viewport: { width: 1240, height: 820 } });
    const p = await c.newPage();
    await p.route("**/api/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      let body = {};
      if (url.pathname === "/api/peer") body = { enabled: true, running: true, reason: "", status };
      else if (url.pathname === "/api/peer/threads")
        body = {
          threads: [
            { ...thread(ZHANG, "小张", unread.entries[ZHANG].at(-1)), unread: unread.counts[ZHANG] },
            { ...thread(LI, "小李", unread.entries[LI].at(-1)), unread: unread.counts[LI] },
          ],
        };
      else if (url.pathname === "/api/peer/contacts") body = { contacts: [contact(ZHANG, "小张"), contact(LI, "小李")] };
      else if (url.pathname === "/api/peer/transfers") body = { transfers: [], free: 1e12 };
      else if (url.pathname === "/api/peer/messages") body = { entries: unread.entries[url.searchParams.get("peer")] ?? [] };
      else if (url.pathname === "/api/peer/read") {
        const { peer } = JSON.parse(req.postData() ?? "{}");
        unread.reads.push(peer);
        unread.counts[peer] = 0;
        body = { ok: true };
      }
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
    });
    await p.goto(`${BASE}/peer.html`);
    await p.waitForSelector(".listbox .row");
    return { c, p };
  };
  const pillOf = (p, name) => p.locator(`.listbox .row:has-text("${name}") .pill.unread`);

  const u = await unreadPage();
  await pillOf(u.p, "小李").waitFor({ timeout: 6000 });
  // 宽屏下主区那一条（列表第一条）打开即视为已读：小张的数字清零，小李保留。
  await u.p.waitForTimeout(600);
  const liShown = await pillOf(u.p, "小李").innerText();
  const zhangGone = await pillOf(u.p, "小张").count();
  check("列表行显示未读条数，主区打开的那条已清零", liShown === "3" && zhangGone === 0 && unread.reads.includes(ZHANG), `小李=${liShown}，小张药丸=${zhangGone}`);

  await u.p.click('.listbox .row:has-text("小李")');
  await u.p.waitForTimeout(300);
  const liCleared = await pillOf(u.p, "小李").count();
  check("点开对话后数字清零并 POST /api/peer/read", liCleared === 0 && unread.reads.includes(LI), `药丸=${liCleared}，reads=${unread.reads.join(",")}`);

  const readsBeforeLive = unread.reads.length;
  receive(LI, "正在看的时候来的");
  for (let i = 0; i < 120 && unread.reads.length === readsBeforeLive; i++) await u.p.waitForTimeout(50);
  await u.p.waitForTimeout(300);
  const liLive = await pillOf(u.p, "小李").count();
  check("停在对话里时新消息直接已读（不计未读）", unread.reads.length > readsBeforeLive && unread.counts[LI] === 0 && liLive === 0, `药丸=${liLive}，计数=${unread.counts[LI]}`);

  const readsBeforeAway = unread.reads.length;
  receive(ZHANG, "没在看的时候来的");
  await pillOf(u.p, "小张").waitFor({ timeout: 6000 });
  const zhangAway = await pillOf(u.p, "小张").innerText();
  check("没在看的对话来消息照常计未读", zhangAway === "1" && unread.reads.length === readsBeforeAway, `小张=${zhangAway}，reads 增量=${unread.reads.length - readsBeforeAway}`);

  // 另一个浏览器（同一份服务端状态）打开小张：这边列表下一轮轮询里数字也要消失。
  const v = await unreadPage();
  await pillOf(v.p, "小张").waitFor({ state: "detached", timeout: 6000 });
  await pillOf(u.p, "小张").waitFor({ state: "detached", timeout: 7000 });
  check("另一个浏览器标记已读，这边同样清零", unread.counts[ZHANG] === 0, `计数=${unread.counts[ZHANG]}`);
  await v.c.close();
  await u.c.close();
  // ---- #394：对话贴底。小张 120 条消息；轮询 2.5 秒一次，等 3 秒看新消息；平滑滚动要等 1.5 秒才落定。 ----
  const scrollHistory = {
    entries: Array.from({ length: 120 }, (_, i) => {
      const text = `第 ${i} 条：内网通贴底测试文字，会换行，`.repeat(2 + (i % 4));
      return i % 2 ? msg(`s-${i}`, text, me, ZHANG) : msg(`s-${i}`, text, { nodeId: ZHANG, nickname: "小张" }, ME);
    }),
  };
  const liMsg = msg("cccccccc-0000-4000-8000-000000000001", "小李的一句话", { ...me, nodeId: LI, nickname: "小李" }, ME);
  const sc = await browser.newContext({ locale: "zh-CN", viewport: { width: 1240, height: 820 } });
  const sp = await sc.newPage();
  await sp.route("**/api/**", async (route) => {
    const req = route.request();
    const p2 = new URL(req.url()).pathname;
    let body = {};
    if (p2 === "/api/peer") body = { enabled: true, running: true, reason: "", status };
    else if (p2 === "/api/peer/threads") body = { threads: [thread(ZHANG, "小张", scrollHistory.entries.at(-1)), thread(LI, "小李", liMsg)] };
    else if (p2 === "/api/peer/contacts") body = { contacts: [] };
    else if (p2 === "/api/peer/transfers") body = { transfers: [], free: 1e12 };
    else if (p2 === "/api/peer/messages") {
      const who = new URL(req.url()).searchParams.get("peer");
      body = { entries: who === ZHANG ? scrollHistory.entries : [liMsg] };
    }
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
  });
  await sp.goto(`${BASE}/peer.html`);
  await sp.waitForSelector(".listbox .row");
  await sp.click('#rail button[title="消息"]');
  const streamGap = () =>
    sp.evaluate(() => {
      const s = document.querySelector("#main .stream");
      return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : -1;
    });
  const streamTop = () => sp.evaluate(() => document.querySelector("#main .stream")?.scrollTop ?? -1);
  const pushNew = (id, text) => {
    scrollHistory.entries = [...scrollHistory.entries, msg(id, text, { ...me, nodeId: ZHANG, nickname: "小张" }, ME)];
  };

  await sp.click('.listbox .row:has-text("小张")');
  await sp.waitForTimeout(300);
  const openInstant = await streamGap();
  check("打开后 300ms 已贴底（没有平滑动画半路停住）", openInstant === 0, `离底 ${openInstant}px`);
  await sp.waitForTimeout(1500);
  const openGap = await streamGap();
  check("打开 120 条消息的对话停在底部", openGap === 0, `离底 ${openGap}px`);

  await sp.evaluate(() => { document.querySelector("#main .stream").scrollTop = 0; });
  await sp.waitForTimeout(1500);
  await sp.click('.listbox .row:has-text("小李")');
  await sp.waitForTimeout(1500);
  await sp.click('.listbox .row:has-text("小张")');
  await sp.waitForTimeout(1500);
  const switchGap = await streamGap();
  check("切走再切回停在底部，不继承翻到顶的位置", switchGap === 0, `离底 ${switchGap}px`);

  pushNew("s-new-bottom", "停在底部时收到的新消息");
  await sp.waitForTimeout(3000);
  const newAtBottom = await streamGap();
  check("停在底部时收到新消息仍贴底", newAtBottom === 0, `离底 ${newAtBottom}px`);

  await sp.evaluate(() => { document.querySelector("#main .stream").scrollTop = 300; });
  await sp.waitForTimeout(1500);
  const midBefore = await streamTop();
  pushNew("s-new-middle", "翻到中间时收到的新消息");
  await sp.waitForTimeout(3000);
  const midAfter = await streamTop();
  check("翻到中间时收到新消息位置不变", Math.abs(midBefore - midAfter) <= 2, `scrollTop ${midBefore} -> ${midAfter}`);
  await sc.close();

  // ---- #394 补：长对话 A 翻到中间后切到长对话 B，B 必须贴底，不继承 A 的滚动位置（两边都 120 条，所以两边都有可滚的 .stream）。 ----
  const longHistory = (tag, nodeId, nickname) =>
    Array.from({ length: 120 }, (_, i) => {
      const text = `${tag} 第 ${i} 条：内网通贴底测试文字，会换行，`.repeat(2 + (i % 4));
      return i % 2 ? msg(`${tag}-${i}`, text, me, nodeId) : msg(`${tag}-${i}`, text, { nodeId, nickname }, ME);
    });
  const longA = longHistory("甲", ZHANG, "小张");
  const longB = longHistory("乙", LI, "小李");
  const lc = await browser.newContext({ locale: "zh-CN", viewport: { width: 1240, height: 820 } });
  const lp = await lc.newPage();
  await lp.route("**/api/**", async (route) => {
    const req = route.request();
    const p2 = new URL(req.url()).pathname;
    let body = {};
    if (p2 === "/api/peer") body = { enabled: true, running: true, reason: "", status };
    else if (p2 === "/api/peer/threads") body = { threads: [thread(ZHANG, "小张", longA.at(-1)), thread(LI, "小李", longB.at(-1))] };
    else if (p2 === "/api/peer/contacts") body = { contacts: [] };
    else if (p2 === "/api/peer/transfers") body = { transfers: [], free: 1e12 };
    else if (p2 === "/api/peer/messages") body = { entries: new URL(req.url()).searchParams.get("peer") === ZHANG ? longA : longB };
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
  });
  await lp.goto(`${BASE}/peer.html`);
  await lp.waitForSelector(".listbox .row");
  await lp.click('#rail button[title="消息"]');
  await lp.click('.listbox .row:has-text("小张")');
  await lp.waitForTimeout(1500);
  await lp.evaluate(() => { document.querySelector("#main .stream").scrollTop = 300; });
  await lp.waitForTimeout(1500);
  await lp.click('.listbox .row:has-text("小李")');
  await lp.waitForTimeout(1500);
  const longSwitchGap = await lp.evaluate(() => {
    const s = document.querySelector("#main .stream");
    return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : -1;
  });
  check("长对话翻到中间后切到另一个长对话仍停在底部", longSwitchGap === 0, `离底 ${longSwitchGap}px`);
  await lc.close();

  // ---- #396：「消息」导航上的未读圆点。有未读就出现，只画点不写数字；全部读完后消失。宽屏 rail 与窄屏底部导航都要。 ----
  // 小张排第一、开机即主区打开即已读（宽屏）；小李 2 条未读，所以两种宽度下都有一颗要画的点。
  const navCounts = { [ZHANG]: 0, [LI]: 2 };
  const navFixture = async (viewport) => {
    const c = await browser.newContext({ locale: "zh-CN", viewport });
    const p = await c.newPage();
    const pageErrors = [];
    p.on("pageerror", (e) => pageErrors.push(e.message));
    await p.route("**/api/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      let body = {};
      if (url.pathname === "/api/peer") body = { enabled: true, running: true, reason: "", status };
      else if (url.pathname === "/api/peer/threads")
        body = {
          threads: [
            { ...thread(ZHANG, "小张", msg("nav-z", "小张的话", { nodeId: ZHANG, nickname: "小张" }, ME)), unread: navCounts[ZHANG] },
            { ...thread(LI, "小李", msg("nav-l", "小李的话", { nodeId: LI, nickname: "小李" }, ME)), unread: navCounts[LI] },
          ],
        };
      else if (url.pathname === "/api/peer/contacts") body = { contacts: [contact(ZHANG, "小张"), contact(LI, "小李")] };
      else if (url.pathname === "/api/peer/transfers") body = { transfers: [], free: 1e12 };
      else if (url.pathname === "/api/peer/messages") body = { entries: [] };
      else if (url.pathname === "/api/peer/read") navCounts[JSON.parse(req.postData() ?? "{}").peer] = 0;
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
    });
    await p.goto(`${BASE}/peer.html`);
    await p.waitForSelector(".listbox .row");
    return { c, p, pageErrors };
  };
  const railMsgDot = '#rail button[title="消息"] .dot';
  const mobMsgDot = '#mobnav button:has-text("消息") .dot';

  const desk = await navFixture({ width: 1240, height: 820 });
  await desk.p.locator(railMsgDot).waitFor({ state: "attached", timeout: 6000 }).catch(() => {});
  const railDots = await desk.p.locator(railMsgDot).count();
  const railText = railDots ? (await desk.p.locator(railMsgDot).first().textContent()).trim() : "";
  check("宽屏「消息」导航有未读时出现圆点，且不写数字", railDots === 1 && railText === "", `圆点=${railDots}，文字=「${railText}」`);

  const mob = await navFixture({ width: 390, height: 800 });
  await mob.p.locator(mobMsgDot).waitFor({ state: "attached", timeout: 6000 }).catch(() => {});
  const mobDots = await mob.p.locator(mobMsgDot).count();
  check("窄屏底部「消息」导航有未读时出现圆点", mobDots === 1, `圆点=${mobDots}`);

  navCounts[LI] = 0;
  await desk.p.locator(railMsgDot).waitFor({ state: "detached", timeout: 7000 }).catch(() => {});
  await mob.p.locator(mobMsgDot).waitFor({ state: "detached", timeout: 7000 }).catch(() => {});
  const railLeft = await desk.p.locator(railMsgDot).count();
  const mobLeft = await mob.p.locator(mobMsgDot).count();
  check("全部读完后两处圆点都消失", railLeft === 0 && mobLeft === 0, `宽屏=${railLeft}，窄屏=${mobLeft}`);
  check("圆点相关渲染没有页面错误", desk.pageErrors.length + mob.pageErrors.length === 0, [...desk.pageErrors, ...mob.pageErrors].join(" | "));
  await desk.c.close();
  await mob.c.close();
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
