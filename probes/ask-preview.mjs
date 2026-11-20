/**
 * Probe: 多题问卷里点「在预览里打开」当场就开预览，不等整份问卷提交（ask-preview.ts）。
 *
 * 复现的是 2026-11-20 那次：模型把「要在预览里打开吗？」和「选哪个变体」塞进一份问卷，
 * 用户点了打开 → 什么都没出来、下一题已经在问选哪个。修好之后：
 *   1. 点「在预览里打开」→ viewer 立刻弹出、标题是文件名；问卷还在、跳到第 2 题、提交仍禁用；
 *   2. 「先不看」不开任何东西；
 *   3. 两题答完提交，回给发起方的仍是两条答案（选项原文不被改写）。
 *
 * 自带丢弃式 bridge + 脚本化 pi（同 preview-open.mjs），不花模型 turn、不碰 7864。
 *
 *   npm --prefix web run build && npm --prefix bridge run build && node probes/ask-preview.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { WebSocket } from "ws";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";
import { freePort } from "../tools/free-port.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.ASK_PREVIEW_PORT ?? (await freePort()));
const ROOT = path.join(REPO, ".scratch", "ask-preview");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "ask-preview-pass";
const NAME = "artifacts-console.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, WORK, OUT]) fs.mkdirSync(d, { recursive: true });
// 产物放在会话 cwd 之外的「别的 worktree」：只有绝对路径才找得到它。
const OTHER = path.join(ROOT, "other-worktree", "web", "prototype");
fs.mkdirSync(OTHER, { recursive: true });
const DOC = path.join(OTHER, NAME);
fs.writeFileSync(DOC, "<!doctype html><meta charset=utf-8><h1>三个变体</h1><p>A / B / C</p>\n", "utf8");

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  FAKE_PI_LOG: PI_LOG,
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

const piLog = () =>
  fs.existsSync(PI_LOG) ? fs.readFileSync(PI_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const spawnLine = (sid) => piLog().find((l) => l.t === "argv" && (l.argv ?? []).includes(sid) && l.loopback);

let browser = null;
try {
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
  ws.send(JSON.stringify({ type: "create", cwd: WORK, name: "ask-preview" }));
  let sid = null;
  for (let i = 0; i < 300 && !sid; i++) {
    sid = seen.find((m) => m.type === "session" && m.state?.id)?.state.id ?? null;
    if (!sid) await sleep(100);
  }
  if (!sid) throw new Error(`no session:\n${bridgeOut.join("").slice(-2000)}`);
  for (let i = 0; i < 100 && !spawnLine(sid); i++) await sleep(100);
  const token = spawnLine(sid)?.loopbackToken;
  if (!token) throw new Error("no loopback credential");

  browser = await chromium.launch({ headless: !process.env.PW_HEADFUL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(`${BASE}/#/s/${sid}`, { waitUntil: "networkidle" });
  await page.locator("textarea").first().waitFor({ timeout: 15000 });

  // 截图里的那份问卷，只是题干写的是绝对路径（交付提示词现在要求这么写）。
  const asked = fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token,
      tool: "ask_user_question",
      questions: [
        {
          label: "打开原型",
          prompt: `原型文件 ${DOC.replace(/\\/g, "/")} 已写好，要在预览里打开吗？`,
          options: [
            { label: "在预览里打开（推荐）", description: "在右侧预览面板里看三个变体。" },
            { label: "先不看", description: "只保留路径。" },
          ],
        },
        {
          label: "选变体",
          prompt: "三个变体里，后续实装选哪一个当底板？",
          options: [{ label: "A 设置式分组" }, { label: "B 目录树 + 对照表" }, { label: "C 主从详情" }],
        },
      ],
    }),
  }).then((r) => r.json());

  const panel = page.locator(".ask-slot").first();
  await panel.waitFor({ timeout: 15000 });
  check("问卷到了（2 题）", (await panel.locator(".ask-tab").count()) === 2);

  // ---- 「先不看」：不开任何东西
  await panel.locator(".ask-opt", { hasText: "先不看" }).click();
  await sleep(600);
  check("「先不看」不弹 viewer", (await page.locator(".viewer-name").count()) === 0);

  // ---- 回到第 1 题，改选「在预览里打开」
  await panel.locator(".ask-tab", { hasText: "打开原型" }).click();
  await panel.locator(".ask-opt", { hasText: "在预览里打开" }).click();
  const titled = await page
    .waitForFunction((name) => [...document.querySelectorAll(".viewer-name")].some((n) => n.textContent === name), NAME, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check(`点「在预览里打开」当场弹 viewer（${NAME}），不等提交`, titled);
  const p2 = page.locator(".ask-slot").first();
  check("问卷还在，停在第 2 题", (await p2.locator(".ask-tab.on").textContent())?.includes("选变体") === true);
  const submit = p2.locator(".ask-foot .btn.primary");
  check("提交仍禁用（还差 1 题）", (await submit.isDisabled()) && (await submit.textContent())?.includes("还差 1 题") === true, await submit.textContent());
  // 预览浮窗铺在右缘，以前会整栏盖住「需要你」：第 2 题的选项必须是最上层、点得到。
  const onTop = await page.evaluate(() => {
    const opt = [...document.querySelectorAll(".ask-slot .ask-opt")].find((n) => n.textContent?.includes("A 设置式分组"));
    if (!opt) return "no option";
    const r = opt.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return opt.contains(hit) ? "ok" : `covered by ${hit?.className}`;
  });
  check("第 2 题没被预览盖住（浮窗让出右栏）", onTop === "ok", onTop);
  const viewerBox = await page.locator(".viewer").boundingBox();
  const slotBox = await p2.boundingBox();
  check("预览右缘 ≤ 问卷左缘", Boolean(viewerBox && slotBox && viewerBox.x + viewerBox.width <= slotBox.x + 1), JSON.stringify({ viewerBox, slotBox }));
  await page.screenshot({ path: path.join(OUT, "1-opened-before-submit.png"), animations: "disabled" });

  // ---- 答完第 2 题提交：发起方收到两条答案，第 1 题仍是选项原文
  await p2.locator(".ask-opt", { hasText: "A 设置式分组" }).click();
  await page.locator(".ask-slot .ask-foot .btn.primary").first().click();
  const outcome = await Promise.race([asked, sleep(10000).then(() => null)]);
  const labels = (outcome?.answers ?? []).map((a) => a.label);
  check("提交后两条答案原样回给发起方", labels.length === 2 && labels[0] === "在预览里打开（推荐）" && labels[1] === "A 设置式分组", JSON.stringify(labels));
  await sleep(600);
  const after = await page.locator(".viewer").boundingBox();
  check("答完了：预览回到右缘", (await page.locator(".viewer.beside-ask").count()) === 0 && Boolean(after && Math.abs(after.x + after.width - 1440) <= 1), JSON.stringify(after));
  await page.screenshot({ path: path.join(OUT, "2-answered.png"), animations: "disabled" });

  ws.close();
} catch (err) {
  console.error(bridgeOut.join("").slice(-3000));
  check(`unexpected: ${err?.message ?? String(err)}`, false);
} finally {
  await browser?.close();
  bridge.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed · shots in ${OUT}`);
  if (failed) process.exitCode = 1;
}
