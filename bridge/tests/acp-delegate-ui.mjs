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
import { WebSocket } from "ws";
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
  // 让 /api/deps 认为 billion-context 已装：没装时整片灰掉（那条路径归 deps-ui.mjs 管）。
  FAKE_PI_LIST: "User packages:\n  npm:billion-context\n",
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
  // 设置页要一个会话才有 composer：经 WS 建一个（桩 pi，不花模型调用），再按它的地址打开网页。
  // （原先点「新建」再点 dir-foot 主按钮的流程在新建面板改版后走不通了。）
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
  const seen = [];
  ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  const until = async (pred, ms, what) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const hit = pred();
      if (hit) return hit;
    }
    throw new Error(`等不到 ${what}`);
  };
  await until(() => seen.some((m) => m.type === "hello"), 10000, "hello");
  fs.mkdirSync(path.join(ROOT, "project"), { recursive: true });
  ws.send(JSON.stringify({ type: "create", cwd: path.join(ROOT, "project"), name: "acp-delegate-ui" }));
  const created = await until(() => seen.find((m) => m.type === "session" && m.sessionId), 20000, "create");
  ws.close();
  await page.goto(`${BASE}/#/s/${created.sessionId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".composer textarea", { timeout: 20000 });
  await page.locator(".composer textarea").fill("/settings");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".st-console", { timeout: 20000 });

  await page.locator(".st-nav__item", { hasText: "子代理" }).click();
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

  // #375：已知问题的一键绕法。应用 → 磁盘上只多 compress.neverPreserveRecentTools = []；撤销 → 回到原样。
  const apply = page.locator('#subagents-acp [data-action="thinking-fix-apply"]');
  check("绕法：未应用时有「应用绕法」且可点", (await apply.count()) === 1 && (await apply.isEnabled()));
  await apply.click();
  await page.waitForSelector('#subagents-acp [data-action="thinking-fix-undo"]', { timeout: 20000 });
  const fixed = JSON.parse(fs.readFileSync(CFG, "utf8"));
  check("绕法：磁盘上 compress.neverPreserveRecentTools 是 []", JSON.stringify(fixed.compress) === '{"neverPreserveRecentTools":[]}', JSON.stringify(fixed.compress));
  check("绕法：providers / pi.subagents 原样", fixed?.providers?.openrouter?.apiKey === "sk-keep-me" && fixed?.pi?.subagents?.enabled === false);
  check("绕法：页面显示已应用", /现在：已应用/.test(await page.locator("#subagents-acp").innerText()));
  await page.locator('#subagents-acp [data-action="thinking-fix-undo"]').click();
  await page.waitForSelector('#subagents-acp [data-action="thinking-fix-apply"]', { timeout: 20000 });
  const undone = JSON.parse(fs.readFileSync(CFG, "utf8"));
  check("绕法：撤销后 compress 整支消失", !("compress" in undone), JSON.stringify(undone));

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

  // 文件里的 thinkingLevel 不在面板那七档里：下拉禁用 + 写一句「文件里是 X」，别做成可点却永远不产生 patch。
  const odd = JSON.parse(JSON.stringify(after));
  odd.pi.subagents.thinkingLevel = "turbo";
  fs.writeFileSync(CFG, JSON.stringify(odd, null, 2), "utf8");
  await page.locator("#subagents-acp .settings-foot .btn.ghost").click();
  await page.waitForFunction(() => /turbo/.test(document.querySelector("#subagents-acp")?.textContent ?? ""), null, {
    timeout: 20000,
  });
  const thinkRow = page.locator("#subagents-acp .settings-row", { hasText: "子代理的 thinkingLevel" });
  const thinkSelect = thinkRow.locator("select");
  const thinkText = (await thinkRow.innerText()).trim();
  check("陌生档位：下拉禁用", await thinkSelect.isDisabled(), String(after?.pi?.subagents?.thinkingLevel ?? ""));
  check("陌生档位：hint 写出文件里的值", thinkText.includes("turbo"), thinkText.replace(/\s+/g, " "));
  check("陌生档位：hint 指出出口是编辑 JSON", /编辑 JSON/.test(thinkText));
  check("陌生档位：下拉不显示一个假值", (await thinkSelect.inputValue()) === "");

  // 还能改别的字段，而且保存不会把 thinkingLevel 改写成面板里的档。
  await acp.locator("input.ns-input").first().fill("2");
  const save2 = acp.locator(".settings-foot .btn.primary");
  check("陌生档位：别的字段还能改", await save2.isEnabled());
  await save2.click();
  for (let i = 0; i < 100; i += 1) {
    if (JSON.parse(fs.readFileSync(CFG, "utf8"))?.pi?.subagents?.maxDepth === 2) break;
    await sleep(150);
  }
  const oddAfter = JSON.parse(fs.readFileSync(CFG, "utf8"));
  check("陌生档位：别的字段照常写盘", oddAfter?.pi?.subagents?.maxDepth === 2, JSON.stringify(oddAfter.pi.subagents));
  check("陌生档位：thinkingLevel 原样留着 turbo", oddAfter?.pi?.subagents?.thinkingLevel === "turbo");
  check("陌生档位：没凭空多出键", Object.keys(oddAfter.pi.subagents).sort().join(",") === "enabled,maxDepth,thinkingLevel", Object.keys(oddAfter.pi.subagents).join(","));

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
  // 桥是刚 kill 的，它的桩 pi 子进程可能还占着会话目录（Windows 会 EPERM）：等一下、删不掉就留给系统临时目录。
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.log(`（临时目录没删掉：${err.code ?? err.message}）`);
  }
}
