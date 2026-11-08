/**
 * 设置 → 子代理 → acp_delegate（#215）：在真 Chromium 里关掉它，然后看磁盘。
 *
 *   npm run build:bridge && npm run build:web && node bridge/tests/acp-delegate-ui.mjs
 *
 * 钉的是 #215 的验收：「关掉 acp_delegate 保存后，**另一个**文件（billion-context.json）里
 * `pi.subagents.enabled === false`，而同文件里的 providers 还在」。同时顺带看页面有没有把三件事
 * 说清楚：写的是哪个文件、与 settings.json 不同、对新会话生效。
 *
 * 用桩 pi（PI_BIN），不花模型调用；`BILI_CONFIG_FILE` 指到临时目录，用户真实的
 * ~/.config/billion-context 一个字节都不碰。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.ACPD_UI_PORT ?? 7911);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-acp-ui-"));
const STATE = path.join(ROOT, "state");
const CFG = path.join(ROOT, "billion-context.json");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "acp-ui-pass";
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(STATE, { recursive: true });
// 同文件里的邻居：保存一次就得把它完整带回来，否则「覆盖整份」就是真实事故。
fs.writeFileSync(
  CFG,
  JSON.stringify({ providers: { openrouter: { apiKey: "sk-keep-me" } }, sessions: { compressAt: 0.7 } }, null, 2),
  "utf8",
);

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failed += 1;
    console.error(` FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const env = {
  ...process.env,
  PI_WEB_STATE: STATE,
  PI_WEB_PORT: String(PORT),
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_TUNNEL: "0",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_BIN: FAKE_PI,
  FAKE_PI_LOG: path.join(ROOT, "fake-pi.jsonl"),
  BILI_CONFIG_FILE: CFG,
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { env, stdio: ["ignore", "pipe", "pipe"] });
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

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  pageerror:", e.message));
  await page.goto(BASE);
  await page.waitForSelector(".app", { timeout: 20000 });

  // 没有会话时 composer 不存在；先开一个（桩 pi，不花模型调用），再用 `/settings` 打开设置。
  await page.locator('[data-act="new"]').first().click();
  await page.waitForSelector(".new-sheet", { timeout: 20000 });
  await page.locator(".new-sheet .dir-foot .btn.primary").click();
  await page.waitForSelector(".composer-input textarea", { timeout: 40000 });
  await page.locator(".composer-input textarea").fill("/settings");
  await page.locator(".composer-input textarea").press("Enter");
  await page.waitForSelector(".settings-sheet", { timeout: 20000 });

  await page.locator(".settings-tabs .chip", { hasText: "子代理" }).click();
  await page.waitForSelector(".subagents-sheet", { timeout: 20000 });
  await page.waitForSelector("#subagents-acp .settings-foot", { timeout: 20000 });

  const acp = page.locator("#subagents-acp");
  const text = (await acp.innerText()).trim();
  check("页面上写着这一半的文件路径", text.includes(CFG), CFG);
  check("说清与 settings.json 不是同一个文件", /不是同一个文件/.test(text));
  check("说清对新会话生效", /对新会话生效|还没开始/.test(text), "");

  const enabled = acp.locator("select").first();
  check("enabled 是三态：默认 / 开 / 关", (await enabled.locator("option").count()) === 3);
  check("读到的当前值 = 默认（键不在文件里）", (await enabled.inputValue()) === "");

  // 只点「关」：其余留空 = 不动。
  await enabled.selectOption("false");
  const save = acp.locator(".settings-foot .btn.primary");
  check("改动之后保存可用", await save.isEnabled());
  await save.click();
  await page.waitForFunction(
    () => /已保存/.test(document.querySelector(".settings-note")?.textContent ?? ""),
    null,
    { timeout: 20000 },
  );

  const after = JSON.parse(fs.readFileSync(CFG, "utf8"));
  check("磁盘上 pi.subagents.enabled === false", after?.pi?.subagents?.enabled === false, JSON.stringify(after.pi ?? null));
  check("providers 原样还在", after?.providers?.openrouter?.apiKey === "sk-keep-me");
  check("sessions 原样还在", after?.sessions?.compressAt === 0.7);
  check("只多了 pi.subagents 这一支", Object.keys(after).sort().join(",") === "pi,providers,sessions", Object.keys(after).join(","));

  // 坏 JSON：页面给错误 + 路径，保存不可用，磁盘一字未改。重新读一遍页面来验。
  const broken = "{ this is not json";
  fs.writeFileSync(CFG, broken, "utf8");
  await page.locator("#subagents-acp .settings-foot .btn.ghost").click();
  await page.waitForFunction(
    () => /读不了/.test(document.querySelector("#subagents-acp")?.textContent ?? ""),
    null,
    { timeout: 20000 },
  );
  const badText = (await page.locator("#subagents-acp").innerText()).trim();
  check("坏 JSON 显示错误", /读不了/.test(badText));
  check("坏 JSON 显示路径", badText.includes(CFG));
  check("坏 JSON 时保存不可用", await page.locator("#subagents-acp .settings-foot .btn.primary").isDisabled());
  check("坏 JSON：磁盘一字未改", fs.readFileSync(CFG, "utf8") === broken);

  await page.screenshot({ path: path.join(ROOT, "acp-delegate.png") });
} finally {
  await browser.close();
  bridge.kill();
}

if (failed) {
  console.error(`\n${failed} 项失败`);
  console.error(bridgeLog.slice(-4000));
  process.exitCode = 1;
} else {
  console.log("\n全部通过");
  fs.rmSync(ROOT, { recursive: true, force: true });
}
