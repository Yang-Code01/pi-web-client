/**
 * 「⚡ 总结本轮错误」和它上方那些条抢位置（用户报的：「接管会话」被压掉一半）。
 *
 *   node bridge/tests/fail-cta-ui.mjs
 *
 * 自带丢弃式 bridge + 脚本化 pi（`FAILS` 场景做四颗失败），不花模型 turn，不碰 7864 上那份。
 * 验的是只有真 DOM 说得清的事：
 *   A. 上方什么都没有时，pill 照旧浮在输入框右上（`position: absolute`，挂在 `.row` 里）；
 *   B. 会话被「让回终端」后接管条出现 —— pill 必须并进那条，和「接管会话」并排，两块矩形不相交；
 *   C. 窄屏（420px 并排、340px 换行）下都不压按钮；
 *   D. 这时点 pill，小卡贴着它往上开，且不出视口。
 *
 * 端口默认 7894（7895 / 7896 分别给了 failures-ui 与 lessons-spawn），可用 FAIL_CTA_UI_PORT 改。
 * 截图落在 .scratch/shots/fail-cta-*.png。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.FAIL_CTA_UI_PORT ?? 7894);
const ROOT = path.join(REPO, ".scratch", "fail-cta-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const OUT = path.join(REPO, ".scratch", "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "fail-cta-ui-pass";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(ROOT, { recursive: true, force: true });
for (const dir of [STATE, AGENT, WORK]) fs.mkdirSync(dir, { recursive: true });

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  // 让脚本化的 pi 按真 pi 的布局写一份会话文件：会话让回终端后，桥会 tail 它 —— 测试往文件里
  // 补一条失败的工具调用，就能造出「条在、pill 也在」的真实共存（终端里 pi 继续写的那种情况）。
  FAKE_PI_SESSION: "1",
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  FAKE_PI_LOG: PI_LOG,
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });

const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {
    /* wait */
  }
  await sleep(200);
}

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: PASS }),
});
const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
const seen = [];
ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "create", cwd: WORK, name: "fail-cta-ui" }));
let sessionId = null;
for (let i = 0; i < 300 && !sessionId; i++) {
  const hit = seen.find((m) => m.type === "session" && m.state?.id);
  if (hit) sessionId = hit.state.id;
  else await sleep(200);
}
if (!sessionId) {
  console.error("no session:", bridgeLog.slice(-2000));
  process.exit(1);
}
log("session", sessionId);

const statusWhere = (from) => seen.slice(from).filter((m) => m.type === "pi.status" && m.sessionId === sessionId);

async function turn(text) {
  const from = seen.length;
  ws.send(JSON.stringify({ type: "prompt", sessionId, text }));
  for (let i = 0; i < 300; i++) {
    const st = statusWhere(from);
    if (st.some((m) => m.running === true) && st.at(-1)?.running === false) return;
    await sleep(100);
  }
  throw new Error(`turn timeout: ${text}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => log("pageerror:", e.message));
await page.goto(`${BASE}/#/s/${sessionId}`);
await page.waitForSelector(".composer .perm-btn", { timeout: 20000 });

const cta = page.locator(".fail-cta");
const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `fail-cta-${name}.png`) });
  log("shot", `fail-cta-${name}.png`);
};

/** pill 现在挂在哪、是不是浮着。 */
const where = () =>
  page.evaluate(() => {
    const btn = document.querySelector(".fail-cta");
    if (!btn) return null;
    const style = getComputedStyle(btn);
    const box = btn.getBoundingClientRect();
    return {
      parent: btn.parentElement?.className ?? "",
      inRow: Boolean(btn.closest(".row") && btn.parentElement?.classList.contains("row")),
      position: style.position,
      inline: btn.classList.contains("inline"),
      stacked: btn.classList.contains("stacked"),
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
    };
  });

/** 两块矩形相交面积（px²）。 */
const overlap = (a, b) =>
  page.evaluate(
    ([x, y]) => {
      const w = Math.min(x.right, y.right) - Math.max(x.left, y.left);
      const h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
      return w > 0 && h > 0 ? Math.round(w * h) : 0;
    },
    [a, b],
  );

const rectOf = (sel) =>
  page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
  }, sel);

try {
  // -- A. 一轮跑完有四颗失败，上方什么都没有：pill 还是浮着 --------
  await turn("FAILS now");
  await cta.waitFor({ state: "visible", timeout: 10000 });
  const a = await where();
  check("有失败时 pill 亮起来", Boolean(a), JSON.stringify(a && { parent: a.parent, inline: a.inline }));
  check("上方没条时照旧浮着（absolute，挂在 .row 里）", a?.position === "absolute" && a?.inRow && !a?.inline, JSON.stringify(a?.position));
  await shot("floating");

  // -- B. 让回终端 → 接管条出现，pill 必须并进那条 -------------------
  ws.send(JSON.stringify({ type: "close", sessionId }));
  const claim = page.locator(".takeover .claim-btn");
  await claim.waitFor({ state: "visible", timeout: 20000 });
  // 现在这条会话是「从磁盘预览」：桥每 400ms tail 一次会话文件。像终端里的 pi 那样往文件里补一条
  // 失败的工具调用 —— pill 就会在接管条还在的时候真的亮起来（用户报的正是这个状态）。
  const transcript = path.join(AGENT, "sessions", `${sessionId}.jsonl`);
  const stamp = new Date().toISOString();
  const lines = [
    { type: "message", id: "disk-call", timestamp: stamp, message: { role: "assistant", content: [{ type: "text", text: "我看看那个目录" }, { type: "toolCall", id: "call-disk", name: "bash", arguments: { command: "cd /nope" } }] } },
    { type: "message", id: "disk-result", timestamp: stamp, message: { role: "toolResult", toolCallId: "call-disk", isError: true, content: [{ type: "text", text: "bash: cd: /nope: No such file or directory" }] } },
  ];
  fs.appendFileSync(transcript, `\n${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  await cta.waitFor({ state: "visible", timeout: 15000 });
  const b = await where();
  check("pill 并进了接管条（不再是浮层）", b?.inline && b?.parent.includes("takeover"), JSON.stringify(b && { parent: b.parent, inline: b.inline }));
  const claimBox = await rectOf(".takeover .claim-btn");
  const bBox = await rectOf(".fail-cta");
  check("和「接管会话」不重叠", (await overlap(bBox, claimBox)) === 0, `overlap=${await overlap(bBox, claimBox)}px²`);
  check("在接管按钮左边（同一行）", bBox.right <= claimBox.left + 1, `${Math.round(bBox.right)} ≤ ${Math.round(claimBox.left)}`);
  check("和接管按钮同高（并排，不是错行）", Math.abs(bBox.top - claimBox.top) < 6, `${Math.round(bBox.top)} vs ${Math.round(claimBox.top)}`);
  const bar = await rectOf(".takeover");
  check("两只都在条里（没溢出那块底）", bBox.left >= bar.left && claimBox.right <= bar.right + 1, `pill ${Math.round(bBox.left)}–${Math.round(bBox.right)} / 按钮右 ${Math.round(claimBox.right)} / 条 ${Math.round(bar.left)}–${Math.round(bar.right)}`);
  await shot("takeover");

  // -- C. 窄屏：条允许换行，pill 落下去也不压按钮 ---------------------
  await page.setViewportSize({ width: 420, height: 860 });
  await sleep(300);
  const c1 = await rectOf(".fail-cta");
  const c2 = await rectOf(".takeover .claim-btn");
  check("窄屏下仍然不重叠", (await overlap(c1, c2)) === 0, `overlap=${await overlap(c1, c2)}px²`);
  check("窄屏下 pill 还在条里", (await where())?.parent.includes("takeover"));
  await shot("narrow");

  // 再窄一点：文字列有下限，条真的换行，⚡ 落到文字下面一行
  await page.setViewportSize({ width: 340, height: 860 });
  await sleep(300);
  const wrapPill = await rectOf(".fail-cta");
  const wrapBtn = await rectOf(".takeover .claim-btn");
  const wrapText = await rectOf(".takeover > span");
  check(
    "更窄时条换行，⚡ 落到文字下一行（仍不与按钮相叠）",
    wrapPill.top >= wrapText.bottom - 2 && (await overlap(wrapPill, wrapBtn)) === 0,
    `pill.top=${Math.round(wrapPill.top)} / 文字.bottom=${Math.round(wrapText.bottom)} / 按钮 ${Math.round(wrapBtn.left)}–${Math.round(wrapBtn.right)}`,
  );
  await shot("wrap");

  // -- D. 点开小卡：贴着 pill 往上开，不出视口 ------------------------
  await page.setViewportSize({ width: 1280, height: 860 });
  await sleep(200);
  await cta.click();
  await page.waitForSelector(".fail-menu", { timeout: 5000 });
  await sleep(400); // 等开门动画落定（它带 translateY，量早了两条边都不是最终位）
  const menu = await rectOf(".fail-menu");
  const d = await rectOf(".fail-cta");
  check("小卡在 pill 上方、离它 8px 左右", menu.bottom <= d.top + 1 && d.top - menu.bottom < 20, `${Math.round(d.top - menu.bottom)}px 空隙`);
  check("小卡没跑出视口顶", menu.top > 0, `top=${Math.round(menu.top)}`);
  await shot("menu");

  // -- E. 提问卡在的时候按钮不亮（轮次跑着不打扰）----------------------------
  // 这也是提问卡抢不走按钮的原因：卡只在轮次里出现，而轮次里 `syncFailCta()` 把 `show` 判成 false。
  // （同理适用于扩展块；`renderAsks()` / `fillExt()` 里那两句 `placeFailCta()` 是防御：槽被
  //  `replaceChildren` / `remove()` 连孩子一起删掉时，按钮不悬在已卸掉的节点上。）
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.locator("textarea").click();
  await page.waitForSelector(".fail-menu", { state: "detached", timeout: 5000 }).catch(() => {});
  ws.send(JSON.stringify({ type: "prompt", sessionId, text: "ASK one" }));
  await page.waitForSelector(".ask-slot .ask-opts", { timeout: 20000 });
  check("轮次跑着时按钮藏着：不跟提问卡抢位置", !(await cta.isVisible()), JSON.stringify(await where()));
  await shot("ask");
  await page.locator(".ask-opt").first().click();
  await page.waitForSelector(".ask-slot", { state: "detached", timeout: 20000 });
  for (let i = 0; i < 200; i++) {
    if (statusWhere(0).at(-1)?.running === false) break;
    await sleep(100);
  }
} catch (err) {
  check(`场景跑完（${String(err?.message ?? err).split("\n")[0]}）`, false);
  await shot("failed").catch(() => {});
} finally {
  await browser.close();
  bridge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ok${failed.length ? `, ${failed.length} FAIL` : ""}`);
if (failed.length) {
  console.log(bridgeLog.slice(-2000));
  process.exit(1);
}
