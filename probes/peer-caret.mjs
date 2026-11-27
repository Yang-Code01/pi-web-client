/**
 * 内网通输入框：打字过程中页面重画（对方来消息 / 输入中 / 轮询），光标不许跳回最前面。
 *
 * 要两份测试实例（pi-web-client-test-dev 技能起的，口令 test）：
 *   node probes/peer-caret.mjs <A 的 bridge 端口> <B 的 bridge 端口> <B 的 peer 端口>
 * 全过退出 0；任何一项红退出 1。
 */
import { loadPlaywright } from "../tools/playwright.mjs";

const [A_PORT, B_PORT, B_PEER] = process.argv.slice(2).map(Number);
if (!A_PORT || !B_PORT || !B_PEER) {
  console.log("用法：node probes/peer-caret.mjs <A bridge> <B bridge> <B peer>");
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
});

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
await a.post("/api/peer/send", { peer: bId, text: "探针：光标" });

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 860 } });
await ctx.addCookies([{ name: ca.split("=")[0], value: ca.split("=").slice(1).join("="), url: A }]);
const page = await ctx.newPage();
await page.goto(`${A}/peer`);
await page.waitForSelector(`#list [data-id="${bId}"], #list .row`, { timeout: 15000 });
const row = (await page.$(`#list [data-id="${bId}"]`)) ?? (await page.$("#list .row"));
await row.click();
await page.waitForSelector(".stream .msg", { timeout: 10000 });

/** 光标在输入框文字里的偏移（-1 = 选区不在输入框里）。 */
const caret = () =>
  page.evaluate(() => {
    const body = document.querySelector(".peer-rich");
    const sel = document.getSelection();
    if (!body || !sel?.rangeCount || !body.contains(sel.anchorNode)) return -1;
    const r = document.createRange();
    r.selectNodeContents(body);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r.toString().length;
  });
const msgCount = () => page.$$eval(".stream .msg", (els) => els.length);

await page.click(".peer-rich");
await page.keyboard.type("abc");
for (let i = 1; i <= 3; i++) {
  const before = await msgCount();
  // 对方来一条消息：A 的轮询拿到后整块重画聊天区。
  await b.post("/api/peer/send", { peer: aId, text: `来信 ${i}` });
  for (let k = 0; k < 40 && (await msgCount()) <= before; k++) await sleep(100);
  check(`第 ${i} 次重画确实发生`, (await msgCount()) > before);
  const text = await page.$eval(".peer-rich", (el) => el.textContent);
  const at = await caret();
  check(`第 ${i} 次重画后光标仍在末尾`, at === text.length, `caret=${at} len=${text.length}`);
  await page.keyboard.type(String(i));
}
const final = await page.$eval(".peer-rich", (el) => el.textContent);
check("接着打的字都接在后面", final === "abc123", JSON.stringify(final));

// 中间位置也要保住（不是「一律放到末尾」）。
await page.keyboard.press("ArrowLeft");
await page.keyboard.press("ArrowLeft");
const before = await msgCount();
await b.post("/api/peer/send", { peer: aId, text: "来信 mid" });
for (let k = 0; k < 40 && (await msgCount()) <= before; k++) await sleep(100);
await page.keyboard.type("Z");
const mid = await page.$eval(".peer-rich", (el) => el.textContent);
check("光标停在中间时重画后还在原处", mid === "abc1Z23", JSON.stringify(mid));

await browser.close();
console.log(bad ? `\n${bad} 项失败` : "\n全过");
process.exit(bad ? 1 : 0);
