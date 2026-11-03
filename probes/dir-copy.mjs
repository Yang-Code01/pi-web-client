/**
 * Probe: 文件管理器里的「⧉ 复制路径」(D69) — 紧挨着「⌂ 工作目录」，复制的是**下面正在浏览的那个目录**。
 *
 * 工作目录按钮只负责「跳回去」，所以「把当前路径拿走」必须单独一颗；而路径必须是 picker 的实时状态，
 * 不是打开面板那一刻的快照 —— 所以这个探针先切一层目录，再点复制，比对剪贴板。
 *
 * Run: npm run build:web && node probes/dir-copy.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "web/dist");
const ROOT = path.join(REPO, ".scratch/dir-copy");
const STATE = path.join(ROOT, "state");
const WORK = path.join(ROOT, "work");
const PORT = 7897;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

async function launchPlaywright() {
  const cache = path.join(process.env.LOCALAPPDATA ?? "", "npm-cache/_npx");
  const candidates = [process.env.PW_PATH, path.join(REPO, "node_modules/playwright/index.mjs")].filter(Boolean);
  try {
    for (const dir of fs.readdirSync(cache)) candidates.push(path.join(cache, dir, "node_modules/playwright/index.mjs"));
  } catch {
    /* no npx cache */
  }
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      await mod.chromium.launch().then((b) => b.close());
      return mod;
    } catch {
      /* half-installed */
    }
  }
  throw new Error("找不到可用的 playwright");
}

// --- fixture: a directory tree worth browsing ----------------------------------------------------
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "alpha"), { recursive: true });
fs.mkdirSync(path.join(WORK, "beta"), { recursive: true });
fs.writeFileSync(path.join(WORK, "alpha", "notes.md"), "# alpha\n");

const child = spawn(process.execPath, [path.join(REPO, "bridge/dist/index.js")], {
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_ROOT: DIST, PI_WEB_NO_EXT: "1" },
});
const stop = () => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
};
process.on("exit", stop);
for (let i = 0; i < 100; i += 1) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(200);
}
const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
ok(Boolean(cookie), "logged in");

const { chromium } = await launchPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', pass);
  await page.click('button:has-text("进入")');
}
await page.waitForSelector(".new-session", { timeout: 15000 });

// One session whose cwd is the fixture tree, created through the same WS the UI uses.
await page.evaluate(async (cwd) => {
  const ws = new WebSocket(`${location.origin.replace("http", "ws")}/ws`);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.send(JSON.stringify({ type: "create", cwd, name: "复制路径" }));
  await new Promise((r) => {
    ws.addEventListener("message", (ev) => {
      // A malformed frame must not leave the probe hanging until the timeout.
      try {
        if (JSON.parse(ev.data).type === "session") r();
      } catch {
        /* not ours */
      }
    });
    setTimeout(r, 15000);
  });
  ws.close();
}, WORK);
await sleep(2500);
ok((await page.locator(".session-card").count()) >= 1, "the fixture session shows up");

// 打开文件管理器（顶栏 📁）——它只有会话打开时才是可见的。
await page.evaluate(() => {
  const card = document.querySelector(".session-card");
  card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await sleep(1200);
await page.locator('[data-act="files"]').click();
await page.waitForSelector(".dir-row", { timeout: 15000 });

// 1) 两颗按钮相邻，顺序是 工作目录 → 复制路径
const order = await page.evaluate(() => {
  const head = document.querySelector(".dir-head");
  return [...(head?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim() ?? "");
});
ok(order.includes("⌂ 工作目录") && order.includes("⧉ 复制路径"), `both buttons sit on the path row (${JSON.stringify(order)})`);
ok(order.indexOf("⧉ 复制路径") === order.indexOf("⌂ 工作目录") + 1, "复制路径 sits right after 工作目录");

// 2) 切进子目录 alpha，剪贴板拿到的必须是 alpha 的绝对路径
await page.locator(".dir-row", { hasText: /alpha$/ }).first().click();
await sleep(1200);
const listed = await page.locator(".dir-path").innerText();
ok(listed.replace(/\s+/g, "").includes("alpha"), `the picker now lists alpha (${listed.replace(/\s+/g, "")})`);

await page.locator('[data-act="dir-copy"]').click();
await sleep(400);
const copied = await page.evaluate(() => navigator.clipboard.readText());
const expect = path.join(WORK, "alpha");
ok(copied === expect, `clipboard got the browsed directory (${JSON.stringify(copied)} vs ${JSON.stringify(expect)})`);
const label = await page.locator('[data-act="dir-copy"]').innerText();
ok(/已复制/.test(label), `the button confirms (${label})`);

// 3) 盘符列表（此电脑）没有路径可复制 → 按钮禁用
await page.locator(".crumb.root").first().click();
await sleep(900);
ok(await page.locator('[data-act="dir-copy"]').isDisabled(), "on 此电脑 the copy button is disabled");

await browser.close();
stop();
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
