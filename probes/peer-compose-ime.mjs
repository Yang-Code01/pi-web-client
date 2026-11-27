/**
 * 内网通输入框：中文输入法组字（composition）期间对方来消息，组字不许被打断。
 *
 * 用假 API + 真构建产物（web/dist）跑，快且确定：把一条「来信」塞进假的 /messages，
 * 等页面自己轮询到并整块重画聊天区（renderMain），看组字会话还在不在。
 *
 * 第一段是**对照**：不来消息、连着两次 imeSetComposition，组字必须是同一次会话 ——
 * 用来证明第二段的红是重画造成的，不是 CDP 模拟的错觉。
 *
 *   node probes/peer-compose-ime.mjs     （先 npm run build:web）
 * 全过退出 0；任何一项红退出 1。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const DIST = path.join(REPO, "web", "dist");
if (!fs.existsSync(path.join(DIST, "peer.html"))) {
  console.error(`没找到 ${path.join(DIST, "peer.html")}：先 npm run build:web`);
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
const BASE = `http://127.0.0.1:${server.address().port}`;

let bad = 0;
const check = (name, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `  — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ME = "99999999-8888-4777-8666-555555555555";
const ZHANG = "aaaaaaaa-1111-4111-8111-111111111111";
const at = Date.now() - 30_000;
const msg = (id, text, from) => ({
  id,
  at,
  from: { nodeId: from, nickname: from === ME ? "我" : "小张", hostname: "probe", port: 7865 },
  to: { kind: "node", id: from === ME ? ZHANG : ME },
  kind: "text",
  text,
  ack: { id, status: "delivered" },
});
const status = {
  ok: true,
  proto: 1,
  version: "0.1.0",
  nodeId: ME,
  nickname: "我",
  hostname: "probe",
  port: 17965,
  online: [{ nodeId: ZHANG, nickname: "小张", hostname: "小张-pc", addr: "127.0.0.1", port: 7865, lastSeen: at, ips: ["127.0.0.1"] }],
  config: { hidden: false, pauseFiles: false, dnd: false, inbox: "C:/inbox", manual: [] },
};
const thread = {
  nodeId: ZHANG,
  nickname: "小张",
  hostname: "小张-pc",
  port: 7865,
  last: null,
  count: 1,
  online: true,
  unread: 0,
};
const contact = {
  nodeId: ZHANG,
  nickname: "小张",
  hostname: "小张-pc",
  port: 7865,
  friend: true,
  favorite: false,
  incoming: false,
  outgoing: false,
  online: true,
  addr: "127.0.0.1",
  livePort: 7865,
  at,
};

/** 假的收件箱：探针往里塞一条，页面下一轮 /messages 就能看见「对方发来的消息」。 */
const inbox = [msg("aaaaaaaa-0000-4000-8000-000000000001", "在吗", ZHANG)];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1240, height: 820 } });
  const page = await ctx.newPage();
  // 轮询计数与「没假造的接口」：第 1 段红不红靠前者证明，后者防页面新增接口后探针静默变假。
  const polls = { messages: 0 };
  const unknown = new Set();
  const routeErrors = [];
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/peer/messages") polls.messages++;
    let body = {};
    if (p === "/api/peer") body = { enabled: true, running: true, reason: "", status };
    else if (p === "/api/peer/threads") body = { threads: [{ ...thread, last: inbox[inbox.length - 1] }] };
    else if (p === "/api/peer/contacts") body = { contacts: [contact] };
    else if (p === "/api/peer/messages") body = { entries: [...inbox] };
    else if (p === "/api/peer/transfers") body = { transfers: [], free: 1e12 };
    else if (p === "/api/peer/ignored") body = { ignored: [] };
    else if (p === "/api/peer/thread") body = { ok: true };
    else if (p === "/api/peer/read") body = { ok: true };
    else if (p === "/api/peer/typing") body = { ok: true };
    else if (p === "/api/peer/presence") body = { ok: true };
    else if (p === "/api/peer/send") body = { ok: true, id: "sent-by-probe" };
    else unknown.add(p);
    // 页面已经关掉时 fulfill 会抛「Target page, context or browser has been closed」，那是收尾不是失败；
    // 其余错误必须说出来，否则探针只能靠 waitForSelector 超时才发现不对。
    await route
      .fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
      .catch((err) => {
        if (!/closed|Target page/i.test(String(err))) routeErrors.push(`${p}: ${err}`);
      });
  });

  await page.goto(`${BASE}/peer.html`);
  await page.waitForSelector("#list .row, #list [data-id]", { timeout: 15000 });
  const row = (await page.$(`#list [data-id="${ZHANG}"]`)) ?? (await page.$("#list .row"));
  await row.click();
  await page.waitForSelector(".stream .msg", { timeout: 10000 });
  await page.waitForSelector(".peer-rich[contenteditable=true]", { timeout: 10000 });

  const body = page.locator(".peer-rich");
  const cdp = await ctx.newCDPSession(page);
  /** 输入框里文字的文本 / 组字事件计数。 */
  const text = () => body.evaluate((el) => el.textContent);
  const ime = () => page.evaluate(() => window.__ime);
  const watchIme = (sel = ".peer-rich") =>
    page.evaluate((sel) => {
      const w = window;
      w.__ime = { starts: 0, ends: 0 };
      const attach = () => {
        const el = document.querySelector(sel);
        if (!el || el.dataset.imeWatched) return;
        el.dataset.imeWatched = "1";
        el.addEventListener("compositionstart", () => w.__ime.starts++);
        el.addEventListener("compositionend", () => w.__ime.ends++);
      };
      attach();
      new MutationObserver(attach).observe(document.getElementById("main"), { childList: true, subtree: true });
    }, sel);

  // ---- 0. 对照：不来消息时连着两次组字，必须是同一次组字会话 ----
  await watchIme();
  await body.click();
  await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
  await sleep(100);
  await cdp.send("Input.imeSetComposition", { text: "nihao", selectionStart: 5, selectionEnd: 5 });
  await sleep(100);
  const ctl = await ime();
  const ctlText = await text();
  check("对照：连着两次组字仍是同一次会话", ctl.starts === 1, `starts=${ctl.starts}`);
  check("对照：组字文字连着写", ctlText === "nihao", JSON.stringify(ctlText));
  await cdp.send("Input.insertText", { text: "你好" });
  await sleep(150);
  const ctlCommitted = await text();
  check("对照：上屏后只剩「你好」", ctlCommitted === "你好", JSON.stringify(ctlCommitted));

  // 清空输入框，重新记一次组字事件。
  await body.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await sleep(100);
  await watchIme();

  // ---- 1. 组字中对方来消息：轮询发现新消息 → 整块重画聊天区 ----
  await body.click();
  await cdp.send("Input.imeSetComposition", { text: "nihao", selectionStart: 5, selectionEnd: 5 });
  await sleep(150);
  const composingText = await text();
  check("组字中：拼音在输入框里", composingText === "nihao", JSON.stringify(composingText));

  const before = await page.$$eval(".stream .msg", (els) => els.length);
  const pollsBefore = polls.messages;
  inbox.push(msg("aaaaaaaa-0000-4000-8000-000000000002", "来一条消息打断你", ZHANG));
  // 轮询周期 2.5s，多等两轮：组字期间**故意不重画**，消息要等上屏后才出现。
  await sleep(5600);
  const midCount = await page.$$eval(".stream .msg", (els) => els.length);
  const midPolls = polls.messages - pollsBefore;
  const mid = await ime();
  const midText = await text();
  // 先证「消息确实被轮询到了」：否则下面那条「没重画」也可能只是页面根本没取数，绿得没意义。
  check("组字期间页面确实在轮询（>=2 次 /messages）", midPolls >= 2, `polls=${midPolls}`);
  check("组字期间不重画（新消息先没出来）", midCount === before, `msg=${midCount} before=${before}`);
  check("重画没有结束组字会话", mid.ends === 0, `ends=${mid.ends}`);
  check("重画后组字还是原来那一次", mid.starts === 1, `starts=${mid.starts}`);
  check("重画后拼音还在输入框里", midText === "nihao", JSON.stringify(midText));

  // 接着组：如果上一次组字被掐断，这一下会开一次新的 compositionstart，拼音也会上屏成死字。
  await cdp.send("Input.imeSetComposition", { text: "nihao7", selectionStart: 6, selectionEnd: 6 });
  await sleep(120);
  const cont = await ime();
  const contText = await text();
  check("组字中接着打字还是同一次会话", cont.starts === 1, `starts=${cont.starts}`);
  check("接着组的拼音替换掉旧的、不是拼在后面", contText === "nihao7", JSON.stringify(contText));

  // 上屏：把组字提交成汉字，字不能丢、也不能和半截拼音叠在一起。
  await cdp.send("Input.insertText", { text: "你好" });
  await sleep(150);
  const finalText = await text();
  const done = await ime();
  check("上屏后文字是「你好」", finalText === "你好", JSON.stringify(finalText));
  check("组字会话正常结束一次", done.ends === 1, `ends=${done.ends}`);

  // 攒下来的那次重画要在上屏后补上：来消息不能因为「刚才在组字」就永远不画。
  let flushed = false;
  for (let k = 0; k < 40 && !flushed; k++) {
    flushed = (await page.$$eval(".stream .msg", (els) => els.length)) > before;
    if (!flushed) await sleep(100);
  }
  const streamText = await page.$$eval(".stream .msg", (els) => els.map((e) => e.textContent ?? "").join("|"));
  check("上屏后补画，新消息出现了", flushed && streamText.includes("来一条消息打断你"), streamText.slice(-60));
  check("上屏后输入框文字没被重画弄丢", (await text()) === "你好", JSON.stringify(await text()));

  // ---- 2. 组字中按 Ctrl+F：搜索条不能把组字掐掉，而补画之后它还得真的拿到焦点 ----
  // 以前 openSearch() 是 renderMain() 后立刻 searchInput.focus()；重画被推迟时 searchInput 还是 null，
  // 焦点就静默丢了。现在这两步排队到补画之后（afterMain）。
  await body.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await sleep(100);
  await watchIme();
  await body.click();
  await cdp.send("Input.imeSetComposition", { text: "nihao", selectionStart: 5, selectionEnd: 5 });
  await sleep(150);
  await page.keyboard.press("Control+F");
  await sleep(300);
  const barMid = await page.$$eval(".searchbar", (els) => els.length);
  const imeMid = await ime();
  check("组字中按 Ctrl+F 不掐断组字", imeMid.starts === 1 && imeMid.ends === 0, `starts=${imeMid.starts} ends=${imeMid.ends}`);
  check("组字中按 Ctrl+F：搜索条先不出现（等上屏）", barMid === 0, `bar=${barMid}`);
  await cdp.send("Input.insertText", { text: "你好" });
  await sleep(500);
  const barAfter = await page.$$eval(".searchbar", (els) => els.length);
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return el && el.tagName === "INPUT" && el.closest(".searchbar") ? el.value : `active=<${el ? el.tagName + "." + el.className : "null"}>`;
  });
  check("上屏后搜索条出现且拿到焦点（不是旧 DOM 上的空 focus）", barAfter === 1 && focused === "", `bar=${barAfter} focus=${focused}`);
  await page.keyboard.press("Escape");
  await sleep(200);

  // ---- 3. 组字中按着鼠标、却来的是 pointercancel：待做的重画不能就这么丢了 ----
  // imeEnd 以前只等 pointerup，拖拽被中断 / 触摸被取消时那一下永远不会来，攒着的重画就悬在那里了。
  await body.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await sleep(100);
  await body.click();
  await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
  const beforeCancel = await page.$$eval(".stream .msg", (els) => els.length);
  const pollsBase3 = polls.messages;
  inbox.push(msg("aaaaaaaa-0000-4000-8000-000000000003", "第三条待补画", ZHANG));
  await sleep(2900);
  const pollsDuring = polls.messages - pollsBase3;
  // 假装鼠标按着（合成事件，不碰真鼠标，否则 mousedown 会把组字提交掉）。
  await page.evaluate(() => document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await cdp.send("Input.insertText", { text: "你" });
  await sleep(300);
  const afterCommit = await page.$$eval(".stream .msg", (els) => els.length);
  check("鼠标没收时补画先不跑", afterCommit === beforeCancel, `msg=${afterCommit} before=${beforeCancel}`);
  check("pointerdown 到 cancel 之间页面确实在轮询", pollsDuring >= 1, `polls=${pollsDuring}`);
  await page.evaluate(() => document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true })));
  // 「不靠 1.5s 兜底」得掐着表量：以前这里给 2s 的宽限，比 whenPointerFree 的 1.5s 兜底还长，
  // 把 pointercancel 的监听整条删掉也照样绿。现在只给 800ms —— 兜底到点之前必须已经画完。
  const cancelAt = Date.now();
  let afterCancel = afterCommit;
  let cancelMs = -1;
  for (let k = 0; k < 32; k++) {
    afterCancel = await page.$$eval(".stream .msg", (els) => els.length);
    if (afterCancel > beforeCancel) {
      cancelMs = Date.now() - cancelAt;
      break;
    }
    await sleep(25);
  }
  const cancelText = await page.$$eval(".stream .msg", (els) => (els.map((e) => e.textContent ?? "")).join("|"));
  check(
    "pointercancel 之后补画立刻来（<800ms，不是等到 1.5s 兜底）",
    afterCancel > beforeCancel && cancelMs >= 0 && cancelMs < 800 && cancelText.includes("第三条待补画"),
    `msg=${afterCancel} before=${beforeCancel} ${cancelMs >= 0 ? `${cancelMs}ms` : "没来"}`,
  );

  // ---- 4. 聊天记录搜索框：主区里第二个会组字的输入框，同样不许被重画掐断 ----
  // 两路重画都在这里：搜索防抖自己（打字 160ms 后 renderMain）与对方来信（轮询发现签名变了）。
  await page.keyboard.press("Control+F");
  await page.waitForSelector(".searchbar input", { timeout: 5000 });
  await watchIme(".searchbar input");
  await page.locator(".searchbar input").click();
  await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
  await sleep(120);
  await cdp.send("Input.imeSetComposition", { text: "nihao", selectionStart: 5, selectionEnd: 5 });
  // 越过 160ms 的搜索防抖：以前这一次重画就把组字掐掉了，连对方来信都不用。
  await sleep(500);
  const sMid = await ime();
  const sVal = await page.locator(".searchbar input").inputValue();
  const sFocused = await page.evaluate(() => !!document.activeElement?.closest(".searchbar"));
  check("搜索框组字：防抖重画不掐断组字", sMid.starts === 1 && sMid.ends === 0, `starts=${sMid.starts} ends=${sMid.ends}`);
  check("搜索框组字：焦点还在框里", sFocused, `focused=${sFocused}`);
  check("搜索框组字：拼音还在框里", sVal === "nihao", JSON.stringify(sVal));

  const sMsgBefore = await page.$$eval(".stream .msg", (els) => els.length);
  const sPolls = polls.messages;
  inbox.push(msg("aaaaaaaa-0000-4000-8000-000000000004", "搜索框里来一条", ZHANG));
  await sleep(5600);
  const sAfter = await ime();
  const sValAfter = await page.locator(".searchbar input").inputValue();
  const sBarStill = await page.$$eval(".searchbar input", (els) => els.length);
  check("搜索框组字期间确实在轮询（>=2 次 /messages）", polls.messages - sPolls >= 2, `polls=${polls.messages - sPolls}`);
  check(
    "搜索框组字：来信不掐断组字",
    sAfter.starts === 1 && sAfter.ends === 0 && sBarStill === 1,
    `starts=${sAfter.starts} ends=${sAfter.ends} input=${sBarStill}`,
  );
  check("搜索框组字：来信后拼音还在框里", sValAfter === "nihao", JSON.stringify(sValAfter));
  // 上屏：半截拼音不能变成死字留在搜索框里。上屏的「在」在消息流里正好出现一次（「小在吗」），
  // 顺带证明「上屏后的值」真的被拿去搜了 —— 组字期间跳过的那种半截拼音查询不会命中它。
  await cdp.send("Input.insertText", { text: "在" });
  await sleep(400);
  const sDone = await ime();
  const sCommitted = await page.locator(".searchbar input").inputValue();
  check("搜索框组字：上屏恰好一次、文字是「在」", sDone.ends === 1 && sCommitted === "在", `ends=${sDone.ends} val=${JSON.stringify(sCommitted)}`);
  const sCnt = (await page.locator(".searchbar .cnt").textContent()) ?? "";
  check("搜索框组字：上屏后用上屏的字搜了一次（1 / 1）", sCnt.trim() === "1 / 1", JSON.stringify(sCnt));
  check("搜索框组字：上屏后搜索条还在、焦点还在", (await page.$$eval(".searchbar input", (els) => els.length)) === 1 && (await page.evaluate(() => !!document.activeElement?.closest(".searchbar"))), "");
  // 攒下的那次来信重画要补上：消息条数超过组字开始前的数。
  let sFlushed = false;
  for (let k = 0; k < 40 && !sFlushed; k++) {
    sFlushed = (await page.$$eval(".stream .msg", (els) => els.length)) > sMsgBefore;
    if (!sFlushed) await sleep(100);
  }
  check("搜索框上屏后补画，来信出现在消息流里", sFlushed, `msg=${await page.$$eval(".stream .msg", (els) => els.length)} before=${sMsgBefore}`);
  await page.keyboard.press("Escape");
  await sleep(200);

  // ---- 5. 组字悄悄没了，连 compositionend / blur 都不来：看门狗兜底，主区不许被永久冻住 ----
  // 真实来源是「输入法 / 浏览器把组字悄悄结束了，事件一个都没派」。这里合成一次 compositionstart
  // 之后什么都不发，组字标记就永远为真。看门狗 IME_STALL_MS = 20s，所以这一段真的等它 ——
  // 探针因此比别处长 20 秒；把 main.ts 里那个 setTimeout 删掉，这段就红（消息再也上不了屏）。
  await body.click();
  await page.evaluate(() => {
    document.querySelector(".peer-rich").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await sleep(120);
  const stuckBefore = await page.$$eval(".stream .msg", (els) => els.length);
  const pollsStuck = polls.messages;
  inbox.push(msg("aaaaaaaa-0000-4000-8000-000000000005", "第五条：卡住的组字", ZHANG));
  await sleep(3000);
  check(
    "卡住的组字确实把重画拦住了",
    (await page.$$eval(".stream .msg", (els) => els.length)) === stuckBefore && polls.messages - pollsStuck >= 1,
    `msg=${await page.$$eval(".stream .msg", (els) => els.length)} before=${stuckBefore} polls=${polls.messages - pollsStuck}`,
  );
  const recoverAt = Date.now();
  let recovered = false;
  for (let k = 0; k < 130 && !recovered; k++) {
    await sleep(200);
    recovered = (await page.$$eval(".stream .msg", (els) => els.length)) > stuckBefore;
  }
  const recoveredText = await page.$$eval(".stream .msg", (els) => (els.map((e) => e.textContent ?? "")).join("|"));
  check(
    "看门狗到点自己放行（20s 内不会永久冻住）",
    recovered && Date.now() - recoverAt < 26_000 && recoveredText.includes("第五条：卡住的组字"),
    `${Date.now() - recoverAt}ms ${recovered ? "" : "没恢复"}`,
  );

  // 假 API 要盖住页面用到的每一个接口：新增接口没假造时，上面那些「没看错」的断言会静默变假。
  check("假 API 盖住了页面用到的所有接口", unknown.size === 0, [...unknown].join(", "));
  check("route.fulfill 没有意外报错", routeErrors.length === 0, routeErrors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  server.close();
}
console.log(bad ? `\n${bad} 项失败` : "\n全过");
process.exit(bad ? 1 : 0);
