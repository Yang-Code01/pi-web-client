/**
 * Probe: 邮箱面板点一次只能挂载一次外壳。
 *
 * 回归的形态：`MailPanel.render()` 曾经每次重画都整棵重建 `.mc-back` + `.mc-console`，
 * 而一次 open() 会触发三次（open → config 回来 → folders 置 loading），
 * Mac 材质给这两层挂的入场动画就跟着演三遍 —— 用户看到的是「点一下，面板闪三下」。
 *
 * 这里不打字号牌，只盯两个可数的东西：
 *   1. 点一次按钮，`.mc-back` 在 #app 里被插入几次（必须恰好 1）；
 *   2. 那次挂载的 `.mc-console` 身上有没有 `mac-window-in`（首次开场照旧演，但要只有一次）。
 * 之后切一次分区、再 Esc 关闭，确认重画不再重挂、关掉的迟到重画不会把面板重新挂出来。
 *
 * Run: npm --prefix web run build && npm --prefix bridge run build && node probes/mail-panel-single-mount.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const PORT = Number(process.env.PI_WEB_PORT ?? 18891);
const ROOT = path.join(REPO, ".scratch/mail-single-mount");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, OUT]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (cond, msg) => {
  if (cond) log("ok  ", msg);
  else {
    log("FAIL", msg);
    failures.push(msg);
  }
};

function killPort(port) {
  try {
    const out = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: "utf8" });
    const pids = new Set(
      out
        .split("\n")
        .filter((l) => l.includes("LISTENING"))
        .map((l) => l.trim().split(/\s+/).pop())
        .filter(Boolean),
    );
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      } catch {
        /* 已经没了 */
      }
    }
  } catch {
    /* netstat 不可用就算了 */
  }
}
killPort(PORT);

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_AGENT_DIR: AGENT, PI_WEB_TUNNEL: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* 还没好 */
    }
    await sleep(150);
  }
  console.error(bridgeOut.join("").slice(-3000));
  throw new Error(`timeout waiting for ${label}`);
}

let browser = null;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const auth = { cookie, "content-type": "application/json" };

  // 一个连不上的哑账号：有账号才会走「config → folders → messages」这条会重画三次的路。
  const seeded = await fetch(`${BASE}/api/mail/accounts`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      address: "probe@example.com",
      label: "probe",
      auth: "password",
      secret: "x",
      imap: { host: "127.0.0.1", port: 993, secure: true },
      smtp: { host: "127.0.0.1", port: 465, secure: true },
    }),
  });
  if (!seeded.ok) throw new Error(`seed account failed: ${seeded.status} ${await seeded.text()}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });

  const mailBtn = page.locator('[data-act="mail"]:visible, [data-act="pv-mail"]:visible').first();
  await until(() => mailBtn.isVisible(), 15000, "邮箱按钮");

  // 先装观察者：只看 #app 的直接子节点插入里有没有 .mc-back。
  await page.evaluate(() => {
    const host = document.getElementById("app") ?? document.body;
    window.__mc = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || !node.classList?.contains("mc-back")) continue;
          const shell = node.querySelector(".mc-console");
          window.__mc.push({
            t: Math.round(performance.now()),
            anims: shell ? shell.getAnimations().map((a) => a.animationName) : [],
          });
        }
      }
    });
    observer.observe(host, { childList: true });
    window.__mcObserver = observer;
  });

  // ---- 1. 点一次：恰好挂载一次
  await mailBtn.click();
  await until(() => page.locator(".mc-console").isVisible(), 8000, "面板出现");
  await sleep(1600); // 等 config / folders / messages 的迟到重画都落地
  const mounts = await page.evaluate(() => window.__mc.map((m) => ({ ...m })));
  log("挂载记录:", JSON.stringify(mounts));
  check(mounts.length === 1, `点一次只挂载一次外壳（实际 ${mounts.length} 次）`);
  const entered = mounts.filter((m) => m.anims.includes("mac-window-in")).length;
  check(entered === 1 && mounts.length === 1, `入场动画只演一次（带 mac-window-in 的挂载 ${entered} 次）`);

  // ---- 2. 切分区：重画不许重挂
  const navAccount = page.locator(".mc-nav__item").filter({ hasText: "账号" }).first();
  await navAccount.click();
  await sleep(500);
  const afterNav = await page.evaluate(() => window.__mc.length);
  check(afterNav === 1, `切一次分区不重挂外壳（累计 ${afterNav} 次）`);
  await page.screenshot({ path: path.join(OUT, "panel-open.png") });

  // ---- 3. 关闭后迟到重画不许把面板重新挂出来
  const beforeClose = await page.evaluate(() => window.__mc.length);
  await page.keyboard.press("Escape");
  await sleep(700);
  const stillOpen = await page.locator(".mc-back").count();
  const afterClose = await page.evaluate(() => window.__mc.length);
  check(stillOpen === 0, `Esc 之后面板已关闭（残留 ${stillOpen} 个 .mc-back）`);
  check(afterClose === beforeClose, `关闭前后没有新的挂载（${beforeClose} → ${afterClose}）`);
} finally {
  await browser?.close().catch(() => {});
  try {
    bridge.kill();
  } catch {
    /* 已经没了 */
  }
  killPort(PORT);
}

if (failures.length) {
  console.error(`\n${failures.length} 条不通过：\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("\n邮箱面板：一次 open 只挂载一次外壳，重画不重挂，关掉不会自己回来。");
}
