/**
 * 内网通文件预览的端到端探针：
 *   - .html 按网页渲染（sandbox iframe），不再显示源码；
 *   - md 按文档渲染；csv 按表格看；docx 之类给「用本机程序打开」；
 *   - mp4 用 <video controls> 播；
 *   - /api/peer/file 对 html 回 text/html + CSP sandbox，不再 application/octet-stream。
 *
 * 要两份测试实例（pi-web-client-test-dev 技能起的，口令 test）：
 *   node probes/peer-file-preview.mjs <A 的 bridge 端口> <B 的 bridge 端口> <B 的 peer 端口>
 * 全过退出 0；任何一项红退出 1。
 */
import { loadPlaywright } from "../tools/playwright.mjs";

const [A_PORT, B_PORT, B_PEER] = process.argv.slice(2).map(Number);
if (!A_PORT || !B_PORT || !B_PEER) {
  console.log("用法：node probes/peer-file-preview.mjs <A bridge> <A bridge 也要> …");
  console.log("      node probes/peer-file-preview.mjs 17870 17876 17877");
  process.exit(2);
}
const A = `http://127.0.0.1:${A_PORT}`;
const B = `http://127.0.0.1:${B_PORT}`;
void B;

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
    const res = await fetch(base + p, {
      method: "POST",
      headers: { cookie, "content-type": "application/octet-stream" },
      body: buf,
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  },
});

/** 1 秒 32x32 黑屏 mp4（H.264 baseline，浏览器能直接解码）。 */
const MP4_B64 = `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`;

const ca = await login(A);
const cb = await login(B);
check("两边都登录上", ca.includes("=") && cb.includes("="));
const a = api(A, ca);
const b = api(B, cb);

const aId = (await a.get("/api/peer")).status?.nodeId;
const bId = (await b.get("/api/peer")).status?.nodeId;
check("拿到双方 nodeId", Boolean(aId && bId), `${aId} / ${bId}`);

await a.post("/api/peer/add", { addr: `127.0.0.1:${B_PEER}` });
let met = false;
for (let i = 0; i < 40 && !met; i++) {
  const list = (await a.get("/api/peer/contacts")).contacts ?? [];
  met = list.some((x) => x.nodeId === bId);
  if (!met) await sleep(250);
}
check("A 发现 B", met);
await a.post("/api/peer/friend", { peer: bId, action: "quick", on: true });
await b.post("/api/peer/friend", { peer: aId, action: "quick", on: true });
await a.post("/api/peer/thread", { peer: bId, draft: "" });

const HTML = Buffer.from(
  '<!doctype html><meta charset="utf-8"><title>报告</title><h1 id="t">渲染成功</h1>' +
    '<p style="color:#c00">这是网页，不是源码</p><script>document.getElementById("t").textContent="脚本也跑了";</script>',
);
const MD = Buffer.from("# 周报\n\n**重点**：三件事\n\n| 项 | 数 |\n| --- | --- |\n| 苹果 | 3 |\n");
const CSV = Buffer.from("名称,数量\n苹果,3\n香蕉,5\n");
const DOCX = Buffer.from("PK\u0003\u0004 fake docx (probe)", "latin1");
const MP4 = Buffer.from(MP4_B64, "base64");

// 每次跑用带时间戳的文件名，避免同名重复（历史里会累加）。
const TS = Date.now().toString(36).slice(-5);
const F = {
  html: `report-${TS}.html`,
  md: `note-${TS}.md`,
  csv: `data-${TS}.csv`,
  docx: `memo-${TS}.docx`,
  mp4: `clip-${TS}.mp4`,
};

const upload = (name, buf) => a.raw(`/api/peer/upload?peer=${bId}&name=${encodeURIComponent(name)}`, buf);
const ups = await Promise.all([
  upload(F.html, HTML),
  upload(F.md, MD),
  upload(F.csv, CSV),
  upload(F.docx, DOCX),
  upload(F.mp4, MP4),
]);
check("五个文件都发出去了", ups.every((u) => u.ok), ups.map((u) => u.ok).join(","));

let entries = [];
for (let i = 0; i < 60; i++) {
  entries = (await a.get(`/api/peer/messages?peer=${bId}&limit=50`)).entries ?? [];
  // 历史里本来就有上一次跑的老文件，必须等这一轮的五个名字全到齐。
  const names = new Set(entries.filter((e) => e.file).map((e) => e.file.name));
  if (Object.values(F).every((n) => names.has(n))) break;
  await sleep(250);
}
const byName = (n) => entries.find((e) => e.file?.name === n);
const eHtml = byName(F.html);
check("历史里能查到 report.html", Boolean(eHtml));

// ---- 后端：/api/peer/file 的头
if (eHtml) {
  const res = await fetch(`${A}/api/peer/file?id=${encodeURIComponent(eHtml.id)}`, { headers: { cookie: ca } });
  await res.text();
  const ct = res.headers.get("content-type") ?? "";
  const csp = res.headers.get("content-security-policy") ?? "";
  const cd = res.headers.get("content-disposition") ?? "";
  const nosniff = res.headers.get("x-content-type-options") ?? "";
  check("html 回 text/html", ct.startsWith("text/html"), ct);
  check("html 带 CSP sandbox", csp.includes("sandbox"), csp || "(无)");
  check("html 是 inline 不是 attachment", cd.startsWith("inline"), cd);
  check("html 带 nosniff", nosniff === "nosniff", nosniff || "(无)");
}

// ---- 页面：逐个点开预览
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: ca.split("=")[0], value: ca.split("=").slice(1).join("="), url: A }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${A}/peer`);
// 会话行没有 data-id；两实例之间只有这一个会话，点第一行。
await page.waitForSelector("#list .row", { timeout: 20000 });
await page.click("#list .row");
await page.waitForSelector(".stream .msg", { timeout: 10000 });

const openFile = async (name) => {
  const card = page.locator(".stream .fcard", { hasText: name }).first();
  await card.waitFor({ timeout: 10000 });
  await card.click();
  await page.waitForSelector(".modal.preview", { timeout: 8000 });
};
const closePreview = async () => {
  await page.click(".modal.preview header .icon-btn");
  await page.waitForSelector(".modal.preview", { state: "detached", timeout: 5000 }).catch(() => {});
};

// html：iframe 渲染，不再有 <pre> 源码
await openFile(F.html);
check("html 预览里有 iframe", Boolean(await page.$(".modal.preview iframe")));
check("html 预览里没有源码 <pre>", !(await page.$(".modal.preview pre")));
let frameText = "";
try {
  const h1 = page.frameLocator(".modal.preview iframe").locator("h1");
  await h1.waitFor({ timeout: 8000 });
  frameText = (await h1.textContent()) ?? "";
} catch (err) {
  frameText = `(读不到 iframe：${String(err).slice(0, 80)})`;
}
check("iframe 里真的渲染出了网页（脚本也跑了）", frameText === "脚本也跑了", frameText);
const sandbox = (await page.$eval(".modal.preview iframe", (el) => el.getAttribute("sandbox") ?? "").catch(() => "")) ?? "";
check(
  "iframe 带 sandbox（不给 allow-same-origin）",
  sandbox.includes("allow-scripts") && !sandbox.includes("allow-same-origin"),
  sandbox || "(没有 iframe)",
);
await closePreview();

// md：文档渲染
await openFile(F.md);
// md 是先 fetch 再画的：等它画出来再断言，否则空 DOM 会假失败。
await page.waitForSelector(".modal.preview .md-doc", { timeout: 8000 }).catch(() => {});
const mdH1 = (await page.$eval(".modal.preview .md-doc h1", (el) => el.textContent).catch(() => "")) ?? "";
const mdTable = Boolean(await page.$(".modal.preview .md-doc table"));
check("md 渲染成文档（标题去掉 #）", mdH1 === "周报", mdH1 || "(没有 h1)");
check("md 的表格也渲染出来", mdTable);
check("md 不再显示源码", !(await page.$(".modal.preview pre")));
await closePreview();

// csv：表格
await openFile(F.csv);
await page.waitForSelector(".modal.preview table.csv-grid, .modal.preview .none", { timeout: 8000 }).catch(() => {});
const cells = (await page.$$eval(".modal.preview table.csv-grid td", (ns) => ns.map((n) => n.textContent))) ?? [];
check("csv 渲染成表格", cells.includes("苹果") && cells.includes("3"), cells.slice(0, 6).join(" | "));
check("csv 不再显示源码", !(await page.$(".modal.preview pre")));
await closePreview();

// docx：用本机程序打开
await openFile(F.docx);
const btnTexts = await page.$$eval(".modal.preview button", (ns) => ns.map((n) => n.textContent ?? ""));
check("docx 给出「用本机程序打开」", btnTexts.some((t) => t.includes("用本机程序打开")), btnTexts.join(" | "));
await closePreview();

// mp4：video
await openFile(F.mp4);
check("mp4 用 <video controls> 播", Boolean(await page.$(".modal.preview video[controls]")));
const videoSrc = await page.$eval(".modal.preview video", (el) => el.getAttribute("src") ?? "").catch(() => "");
check("video 的 src 指到 /api/peer/file", videoSrc.includes("/api/peer/file"), videoSrc.slice(0, 80));
await closePreview();

// 大 csv：超过解析器的字节上限就换出口卡 —— 不把整份读进内存再解析（评审意见第 1 条）
const bigName = `big-${TS}.csv`;
const BIG_ROWS = Array.from({ length: 200_000 }, (_, i) => `行${i},${i}`).join("\n");
const BIG = Buffer.from(`名称,数量\n${BIG_ROWS}\n`, "utf8");
check("大 csv 确实超过 2 MB", BIG.length > 2 * 1024 * 1024, `${BIG.length} 字节`);
const upBig = await upload(bigName, BIG);
check("大 csv 发出去了", upBig.ok);
await openFile(bigName);
await page.waitForSelector(".modal.preview .none .btn", { timeout: 8000 }).catch(() => {});
const bigActs = await page.$$eval(".modal.preview button", (ns) => ns.map((n) => n.textContent ?? ""));
check(
  "大 csv 换成出口卡而不是表格",
  bigActs.some((t) => t.includes("用本机程序打开")) && !(await page.$(".modal.preview table.csv-grid")),
  bigActs.join(" | ") || "(没有按钮)",
);
check("大 csv 的卡上说清楚是太大了", ((await page.$eval(".modal.preview .none", (el) => el.textContent ?? "").catch(() => "")) ?? "").includes("太大"), "");
await closePreview();

check("页面没有脚本错误", errors.length === 0, errors.join(" / ").slice(0, 300));

// ---- 收件那一侧：B 的页面（卡片是「对方发来」，多一个下载链接）
const ctxB = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
await ctxB.addCookies([{ name: cb.split("=")[0], value: cb.split("=").slice(1).join("="), url: B }]);
const pageB = await ctxB.newPage();
const errorsB = [];
pageB.on("pageerror", (e) => errorsB.push(String(e)));
await pageB.goto(`${B}/peer`);
await pageB.waitForSelector("#list .row", { timeout: 20000 });
await pageB.click("#list .row");
await pageB.waitForSelector(".stream .msg", { timeout: 10000 });
const cardB = pageB.locator(".stream .fcard", { hasText: F.html }).first();
await cardB.waitFor({ timeout: 10000 });
await cardB.click();
await pageB.waitForSelector(".modal.preview iframe", { timeout: 8000 }).catch(() => {});
check("收件方也能把 html 渲染成网页", Boolean(await pageB.$(".modal.preview iframe")));
await pageB.click(".modal.preview header .icon-btn");
await pageB.waitForTimeout(300);
const cardDocx = pageB.locator(".stream .fcard", { hasText: F.docx }).first();
await cardDocx.click();
await pageB.waitForSelector(".modal.preview .none .btn", { timeout: 8000 }).catch(() => {});
const actsB = await pageB.$$eval(".modal.preview .none .acts > *", (ns) => ns.map((n) => n.textContent ?? ""));
check("收件方的 docx 卡有「用本机程序打开」和「下载」", actsB.length === 2 && actsB.includes("下载"), actsB.join(" | "));
check("收件方页面没有脚本错误", errorsB.length === 0, errorsB.join(" / ").slice(0, 300));

await browser.close();
console.log(bad ? `\n${bad} 项失败` : "\n全过");
process.exit(bad ? 1 : 0);
