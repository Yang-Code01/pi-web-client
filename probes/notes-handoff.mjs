/**
 * 「交给 agent → 预填到当前会话 / 新开一个会话」到底把什么塞进了哪个输入框。
 *
 * 隔离桥（临时状态目录）+ 真 Chromium：建 A、B 两个会话 → 在 A 里记一条笔记 →
 * 切到 B，从记录面板把这条交给 agent → 读 B 的输入框、再切回 A 读 A 的输入框。
 * 再走一遍「新开一个会话」，以及「填到一半改主意去点别的会话」这条岔路。
 *
 * 跑：node probes/notes-handoff.mjs（先 npm run build:bridge && npm run build:web）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const BRIDGE = path.join(REPO, "bridge", "dist", "index.js");
const DIST = path.join(REPO, "web", "dist");
const PORT = Number(process.env.PI_WEB_PORT ?? 7893);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-handoff-"));
const AGENT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-handoff-agent-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "pi-handoff-work-"));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(120);
  }
  throw new Error(`超时：${what}`);
};

/** 断言：不抛错，把失败留到最后一起算，跑一趟就能看到全貌。 */
const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const child = spawn(process.execPath, [BRIDGE], {
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_AGENT_DIR: AGENT, PI_WEB_ROOT: DIST, PI_WEB_NO_EXT: "1" },
});
child.stderr.on("data", (b) => {
  const line = String(b).trim();
  if (line) log("bridge:", line.slice(0, 200));
});
const stop = () => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
};
process.on("exit", stop);

const composer = (page) => page.evaluate(() => document.querySelector(".composer textarea")?.value ?? "<无输入框>");
const currentTitle = (page) => page.evaluate(() => document.querySelector(".topbar .title")?.textContent ?? "");

let browser;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => {
    try {
      return (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 20000, "healthz");
  const passphrase = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', passphrase);
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector('[data-act="notes"]', { timeout: 20000 });

  const newSession = async (name) => {
    await page.locator('.new-session [data-act="new"]').click();
    await until(async () => page.locator(".sheet.new-sheet").isVisible(), 6000, "new-sheet");
    await page.locator(".sheet.new-sheet input.ns-input").first().fill(name);
    await page.locator(".sheet.new-sheet input.ns-input.mono").first().fill(WORK);
    await page.locator(".sheet.new-sheet .dir-foot .btn.primary").click();
    await until(async () => (await page.locator(".sheet.new-sheet").count()) === 0, 40000, `会话「${name}」建好`);
    await until(async () => (await page.locator(".composer textarea").count()) === 1, 15000, "composer for new session");
    await page.waitForTimeout(400);
  };

  await newSession("会话A");
  log("A current:", await currentTitle(page));

  // 在 A 里记一条
  await page.click('[data-act="notes"]');
  await page.waitForSelector(".notes-sheet", { timeout: 6000 });
  await page.fill(".note-body", "A 里记的一条笔记");
  await page.press(".note-body", "Enter");
  await until(async () => (await page.locator(".note-row").count()) === 1, 8000, "笔记入列");
  const saved = JSON.parse(fs.readFileSync(path.join(STATE, "notes", "bug-notes.json"), "utf8")).notes[0];
  log("note:", JSON.stringify({ title: saved.title, sessionId: saved.sessionId, sessionName: saved.sessionName }));
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".notes-sheet").count()) === 0, 4000, "面板关掉");

  await newSession("会话B");
  log("B current:", await currentTitle(page));

  // ---- 1. 预填到当前会话（B）
  await page.click('[data-act="notes"]');
  await page.waitForSelector(".notes-sheet", { timeout: 6000 });
  await page.locator(".note-row").first().click();
  await page.waitForTimeout(200);
  await page.locator('.note-actions button:has-text("交给 agent")').click();
  await page.waitForSelector(".note-handoff", { timeout: 4000 });
  await page.locator(".note-handoff button", { hasText: "预填到当前会话" }).click();
  await page.waitForTimeout(400);
  log("== 预填到当前会话 → B 输入框 ==");
  const bBox = await composer(page);
  log(JSON.stringify(bBox));
  check("B 的输入框就是选中那条笔记", bBox.startsWith("## A 里记的一条笔记") && bBox.includes("A 里记的一条笔记"), bBox.slice(0, 80));
  check("正文里不带记录时的会话名", !bBox.includes("会话A") && !bBox.includes("会话B"), bBox.split("\n")[1]);
  log("B 当前:", await currentTitle(page));

  // A 的输入框呢？
  const names = await page.locator(".session-card .s-name, .session-card").allTextContents();
  log("会话卡片:", JSON.stringify(names).slice(0, 300));
  const cardA = page.locator(".session-card", { hasText: "会话A" }).first();
  await cardA.click();
  await page.waitForTimeout(900);
  log("== 切回 A 之后 A 的输入框 ==");
  const aBox = await composer(page);
  log(JSON.stringify(aBox));
  check("交到 B 的文字没漏进 A", !aBox.includes("A 里记的一条笔记") || aBox === "A 里记的一条笔记", aBox.slice(0, 60));
  log("A 当前:", await currentTitle(page));

  // 回到 B
  await page.locator(".session-card", { hasText: "会话B" }).first().click();
  await page.waitForTimeout(900);
  log("== 回到 B 的输入框 ==");
  log(JSON.stringify(await composer(page)));

  // ---- 1.5 两条笔记：交给 agent 的必须是左栏选中的那条，不是上一条
  await page.click('[data-act="notes"]');
  await page.waitForSelector(".notes-sheet", { timeout: 6000 });
  await page.click(".notes-new");
  await page.fill(".note-body", "第二条：只该交出这一条");
  await page.press(".note-body", "Enter");
  await until(async () => (await page.locator(".note-row").count()) === 2, 8000, "第二条笔记");
  await page.locator(".note-row", { hasText: "第二条" }).first().click();
  await page.waitForTimeout(250);
  await page.locator('.note-actions button:has-text("交给 agent")').click();
  await page.waitForSelector(".note-handoff", { timeout: 4000 });
  await page.locator(".note-handoff button", { hasText: "预填到当前会话" }).click();
  await page.waitForTimeout(400);
  log("== 选中第二条 → B 的输入框 ==");
  log(JSON.stringify(await composer(page)));

  // ---- 2. 新开一个会话
  await page.click('[data-act="notes"]');
  await page.waitForSelector(".notes-sheet", { timeout: 6000 });
  await page.locator(".note-row", { hasText: "A 里记的一条笔记" }).first().click();
  await page.waitForTimeout(200);
  await page.locator('.note-actions button:has-text("交给 agent")').click();
  await page.waitForSelector(".note-handoff", { timeout: 4000 });
  await page.locator(".note-handoff button", { hasText: "新开一个会话" }).click();
  await until(async () => page.locator(".sheet.new-sheet").isVisible(), 6000, "新开会话面板");
  await page.screenshot({ path: path.join(REPO, ".scratch", "notes-handoff", "1-new-sheet.png") });

  // 岔路：填到一半改主意，关掉面板（取消 = Escape），再点左栏另一个会话
  log("面板上有「取消」:", (await page.locator(".sheet.new-sheet .sheet-head .btn.ghost", { hasText: "取消" }).count()) !== 0);
  await page.locator(".sheet.new-sheet .sheet-head .btn.ghost", { hasText: "取消" }).click();
  await page.waitForTimeout(500);
  log("面板关掉了:", (await page.locator(".sheet.new-sheet").count()) === 0);
  await page.locator(".session-card", { hasText: "会话A" }).first().click();
  await page.waitForTimeout(1200);
  log("== 取消之后切到 A，A 的输入框 ==");
  const aBoxAfterCancel = await composer(page);
  log(JSON.stringify(aBoxAfterCancel));
  check("取消新开会话后再切会话，输入框是空的", aBoxAfterCancel.trim() === "", aBoxAfterCancel.slice(0, 60));
  log("A 当前:", await currentTitle(page));

  // 之后再开一个全新会话：前面没走完的那段文字会不会漏进来？
  await newSession("会话C");
  log("== 之后新开的 C 的输入框（期望空）==");
  const cBox = await composer(page);
  log(JSON.stringify(cBox));
  log("C 当前:", await currentTitle(page));
  check("新开的会话不继承那段没交出去的文字", cBox.trim() === "", cBox.slice(0, 60));
  await page.screenshot({ path: path.join(REPO, ".scratch", "notes-handoff", "2-after.png") });

  // ---- 3. 正路：新开会话并真的建出来，文字要落在这个新会话里
  await page.click('[data-act="notes"]');
  await page.waitForSelector(".notes-sheet", { timeout: 6000 });
  await page.locator(".note-row", { hasText: "A 里记的一条笔记" }).first().click();
  await page.waitForTimeout(200);
  await page.locator('.note-actions button:has-text("交给 agent")').click();
  await page.waitForSelector(".note-handoff", { timeout: 4000 });
  await page.locator(".note-handoff button", { hasText: "新开一个会话" }).click();
  await until(async () => page.locator(".sheet.new-sheet").isVisible(), 6000, "新开会话面板");
  await page.locator(".sheet.new-sheet input.ns-input").first().fill("会话D");
  await page.locator(".sheet.new-sheet input.ns-input.mono").first().fill(WORK);
  await page.locator(".sheet.new-sheet .dir-foot .btn.primary").click();
  await until(async () => (await page.locator(".sheet.new-sheet").count()) === 0, 40000, "会话「会话D」建好");
  await page.waitForTimeout(900);
  const dBox = await composer(page);
  log("== 新开会话（真建出来）→ 新会话的输入框 ==");
  log(JSON.stringify(dBox));
  log("D 当前:", await currentTitle(page));
  check("新会话的输入框拿到那段文字", dBox.startsWith("## A 里记的一条笔记"), dBox.slice(0, 60));
  await page.screenshot({ path: path.join(REPO, ".scratch", "notes-handoff", "3-new-session.png") });

  console.log(failures.length ? `\n${failures.length} 项失败：${failures.join(" / ")}` : "\n全部通过");
  if (failures.length) process.exitCode = 1;
  await ctx.close();
} finally {
  await browser?.close();
  stop();
}
