/**
 * 内网通三处回归（一份探针）：
 *  1. 看图器：比舞台大的图，「适应」之后要在舞台正中（以前 grid 溢出、缩放后偏到右下）。
 *  2. 暂存附件：输入框上方托盘里的截图，刷新页面（= 关掉内网通再打开）之后还在。
 *  3. 搜索会话：输入法拼字（composition）期间，搜索框不许被重画换掉，否则拼音被掐断、只剩字母。
 *
 * 要两份测试实例（pi-web-client-test-dev 技能起的，口令 test）：
 *   node probes/peer-viewer-draft-ime.mjs <A bridge> <B bridge> <B peer>
 * 全过退出 0；任何一项红退出 1。
 */
import zlib from "node:zlib";
import { loadPlaywright } from "../tools/playwright.mjs";

const [A_PORT, B_PORT, B_PEER] = process.argv.slice(2).map(Number);
if (!A_PORT || !B_PORT || !B_PEER) {
  console.log("用法：node probes/peer-viewer-draft-ime.mjs <A bridge> <B bridge> <B peer>");
  process.exit(2);
}
const A = `http://127.0.0.1:${A_PORT}`;
const B = `http://127.0.0.1:${B_PORT}`;

let bad = 0;
const check = (name, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `  — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(base) {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "test" }),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}
const api = (base, cookie) => ({
  get: async (p) => (await fetch(base + p, { headers: { cookie } })).json(),
  post: async (p, body) => {
    const res = await fetch(base + p, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  },
  raw: async (p, buf) => {
    const res = await fetch(base + p, { method: "POST", headers: { cookie, "content-type": "application/octet-stream" }, body: buf });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  },
});

/** 一张纯色 PNG（不依赖图像库）。 */
function png(w, h, rgb) {
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat([...Array(w)].map(() => Buffer.from(rgb)))]);
  const raw = Buffer.concat([...Array(h)].map(() => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const ca = await login(A);
const cb = await login(B);
const a = api(A, ca);
const b = api(B, cb);
const aId = (await a.get("/api/peer")).status?.nodeId;
const bId = (await b.get("/api/peer")).status?.nodeId;
check("拿到两边的 nodeId", Boolean(aId && bId));
await a.post("/api/peer/add", { addr: `127.0.0.1:${B_PEER}` });
let online = false;
for (let i = 0; i < 30 && !online; i++) {
  const list = (await a.get("/api/peer/contacts")).contacts ?? [];
  online = list.some((c) => c.nodeId === bId && c.online);
  if (!online) await sleep(500);
}
check("A 看见 B 在线", online);
await a.post("/api/peer/friend", { peer: bId, action: "quick", on: true });
await b.post("/api/peer/friend", { peer: aId, action: "quick", on: true });
await a.post("/api/peer/thread", { peer: bId, draft: "" });
// 一张远大于窗口的图：适应后缩小显示，最能看出偏没偏。
const up = await a.raw(`/api/peer/upload?peer=${bId}&name=${encodeURIComponent("超大图.png")}`, png(3000, 2000, [40, 160, 90]));
check("A 发一张 3000×2000 的图", up.ok, JSON.stringify(up.data));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
let code = 0;
try {
  const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: ca.split("=")[0], value: ca.split("=").slice(1).join("="), url: A }]);
  const page = await ctx.newPage();
  await page.goto(`${A}/peer`);
  await page.waitForSelector(`#list [data-id="${bId}"], #list .row`, { timeout: 15000 });
  const row = (await page.$(`#list [data-id="${bId}"]`)) ?? (await page.$("#list .row"));
  await row.click();
  await page.waitForSelector(".stream .pic:not(.sticker) img", { timeout: 15000 });

  // ---- 1. 看图器居中
  await page.locator(".stream .pic:not(.sticker) img").last().click();
  await page.waitForSelector(".iv .iv-img");
  await page.waitForFunction(() => {
    const i = document.querySelector(".iv .iv-img");
    return i && i.complete && i.naturalWidth > 0 && i.style.opacity === "1";
  });
  await sleep(250);
  const geo = await page.evaluate(() => {
    const s = document.querySelector(".iv-stage").getBoundingClientRect();
    const i = document.querySelector(".iv-img").getBoundingClientRect();
    return {
      dx: i.left + i.width / 2 - (s.left + s.width / 2),
      dy: i.top + i.height / 2 - (s.top + s.height / 2),
      w: i.width,
      sw: s.width,
    };
  });
  check("适应后图在舞台正中（偏差 ≤ 2px）", Math.abs(geo.dx) <= 2 && Math.abs(geo.dy) <= 2, JSON.stringify(geo));
  check("适应后图不超出舞台", geo.w <= geo.sw, JSON.stringify(geo));
  await page.keyboard.press("Escape");

  // ---- 2. 暂存附件刷新后还在
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 40;
    c.height = 30;
    c.getContext("2d").fillRect(0, 0, 40, 30);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "截图.png", { type: "image/png" }));
    const ed = document.querySelector(".peer-rich") ?? document.querySelector("[contenteditable]");
    ed.focus();
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector(".stage-item.pic", { timeout: 5000 }).catch(() => {});
  check("粘贴截图进托盘", (await page.$$(".stage-item.pic")).length === 1);
  await sleep(400);
  await page.reload();
  await page.waitForSelector(`#list .row`, { timeout: 15000 });
  const row2 = (await page.$(`#list [data-id="${bId}"]`)) ?? (await page.$("#list .row"));
  await row2.click();
  await page.waitForSelector(".stage-item.pic", { timeout: 5000 }).catch(() => {});
  check("刷新后截图还在托盘", (await page.$$(".stage-item.pic")).length === 1);
  const thumbOk = await page.evaluate(() => {
    const i = document.querySelector(".stage-item.pic img");
    return Boolean(i && i.complete && i.naturalWidth > 0);
  });
  check("刷新后缩略图能显示", thumbOk);
  // 收尾：移掉，别影响下次跑；移掉后再刷新也不该回来。
  for (const x of await page.$$(".stage-item .stage-x")) await x.click();
  await sleep(300);
  await page.reload();
  await page.waitForSelector(`#list .row`, { timeout: 15000 });
  await ((await page.$(`#list [data-id="${bId}"]`)) ?? (await page.$("#list .row"))).click();
  await sleep(800);
  check("移除后刷新不再出现", (await page.$$(".stage-item")).length === 0);

  // ---- 3. 搜索框拼字不被掐断（真走 CDP 的 IME 合成）
  const search = page.locator('#list input[data-keep="search"]');
  await search.click();
  await page.evaluate(() => {
    document.querySelector('#list input[data-keep="search"]').__probe = 1;
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "c", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "ce", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.imeSetComposition", { text: "ces", selectionStart: 3, selectionEnd: 3 });
  await sleep(200);
  const mid = await page.evaluate(() => {
    const i = document.querySelector('#list input[data-keep="search"]');
    return { same: i?.__probe === 1, focused: document.activeElement === i, value: i?.value };
  });
  check("拼字中搜索框还是同一个元素、焦点还在", mid.same && mid.focused, JSON.stringify(mid));
  await cdp.send("Input.insertText", { text: "测试" });
  await sleep(300);
  const end = await page.evaluate(() => {
    const i = document.querySelector('#list input[data-keep="search"]');
    return { value: i?.value, rows: document.querySelectorAll("#list .row").length, focused: document.activeElement === i };
  });
  check("上屏后值是中文、列表按中文过滤", end.value === "测试" && end.rows >= 1 && end.focused, JSON.stringify(end));
} catch (err) {
  console.log("FAIL 异常", err);
  code = 1;
} finally {
  await browser.close();
}
process.exit(bad || code ? 1 : 0);
