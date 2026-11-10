/**
 * #266 本机管理：真界面冒烟 + 公网掩码/同值 DNS 两条接口边界。
 *
 *   npm run build && node bridge/tests/sysmanage-ui.mjs
 *
 * 自带丢弃式 bridge（端口 7893），不碰 7864；只读本机数据，不真的改 DNS / 重启 WinNAT——
 * 两者都会弹 UAC 并动整机网络，留本机手验。截图落在 .scratch/shots/sysmanage-ui.png。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.SYSMANAGE_UI_PORT ?? 7893);
const ROOT = path.join(REPO, ".scratch", "sysmanage-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const OUT = path.join(REPO, ".scratch", "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "sysmanage-ui-pass";

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(AGENT, { recursive: true });

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });

const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

let browser;
const done = (code = 0) => {
  try {
    browser?.close();
  } catch {
    /* ignore */
  }
  try {
    bridge.kill();
  } catch {
    /* ignore */
  }
  const bad = code !== 0 || results.some((r) => !r.ok);
  if (bad) console.error(`\nbridge log tail:\n${bridgeLog.slice(-2000)}`);
  process.exit(bad ? 1 : 0);
};

for (let i = 0; i < 150; i += 1) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {
    /* wait */
  }
  await new Promise((r) => setTimeout(r, 200));
}

browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 940 } });
const login = await ctx.request.post(`${BASE}/api/login`, { data: { passphrase: PASS } });
check("登录自检", login.status() === 200, `HTTP ${login.status()}`);

const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);

const open = page.getByRole("button", { name: "本机管理", exact: true }).first();
check("「pi 设置」旁边有本机管理按钮", (await open.count()) > 0);
await open.click();
await page.locator(".sys-console").waitFor({ timeout: 10_000 });
check("控制台打开", (await page.locator(".sys-console").count()) === 1);
check("四个分区", (await page.locator(".sys-nav__item").count()) === 4, String(await page.locator(".sys-nav__item").count()));

await page.locator(".sys-card").first().waitFor({ timeout: 20_000 });
await page.locator(".sys-adapter").first().waitFor({ timeout: 20_000 });
const hostname = (await page.locator(".sys-title").innerText()).trim();
check("概况显示主机名", hostname.length > 2, hostname);
check("概况有磁盘", (await page.locator(".sys-disk").count()) > 0, String(await page.locator(".sys-disk").count()));
check("概况有网卡", (await page.locator(".sys-adapter").count()) > 0, String(await page.locator(".sys-adapter").count()));

/**
 * 布局不变量：头 / 主体 / 页脚都在控制台圆角框里，主体不压页脚。
 * 与窗口大小无关——窗口小内容区应该自己滚动，不该把页脚挤出框（横幅为空时 grid 行错位就是这样穿模的）。
 */
async function checkLayout(label) {
  const r = await page.evaluate(() => {
    const box = (s) => {
      const e = document.querySelector(s);
      if (!e || getComputedStyle(e).display === "none") return null;
      const b = e.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom };
    };
    return { c: box(".sys-console"), head: box(".sys-head"), main: box(".sys-main"), foot: box(".sys-foot") };
  });
  const within = (x) => x && r.c && x.top >= r.c.top - 1 && x.bottom <= r.c.bottom + 1;
  const ok = within(r.head) && within(r.main) && within(r.foot) && r.main.bottom <= r.foot.top + 1;
  check(`${label}：头/主体/页脚都在控制台框内`, Boolean(ok), JSON.stringify(r));
}
await checkLayout("概况");

await page.getByRole("button", { name: /网络与 DNS/ }).first().click();
await page.locator(".sys-dns").waitFor({ timeout: 20_000 });
check("网卡列表", (await page.locator(".sys-net__list .sys-adapter").count()) > 0);
const adapterText = (await page.locator(".sys-net__list .sys-adapter").first().innerText()).trim();
check(
  "网卡显示掩码/网关/MAC",
  adapterText.includes("掩码") && adapterText.includes("网关") && adapterText.includes("MAC"),
  adapterText.slice(0, 100),
);
check("DNS 预设 >= 6", (await page.locator(".sys-preset").count()) >= 6, String(await page.locator(".sys-preset").count()));
check("DNS 编辑器有应用按钮", (await page.getByRole("button", { name: "应用 DNS" }).count()) === 1);
check("WinNAT 卡片有重启按钮", (await page.locator(".sys-winnat").getByRole("button", { name: /^(重启|启动) WinNAT$/ }).count()) === 1);
await page.locator(".sys-winnat").screenshot({ path: path.join(OUT, "sysmanage-winnat.png") });
await checkLayout("网络与 DNS");
// 矮窗口（笔记本 125% 缩放一类）再验一次：内容放不下时也只该内容区滚动。
await page.setViewportSize({ width: 1280, height: 720 });
await page.waitForTimeout(150);
await checkLayout("网络与 DNS @1280×720");
await page.setViewportSize({ width: 1440, height: 940 });

await page.getByRole("button", { name: /端口与服务/ }).first().click();
await page.locator(".sys-table tbody tr").first().waitFor({ timeout: 20_000 });
check("端口表有行", (await page.locator(".sys-table tbody tr").count()) > 0, String(await page.locator(".sys-table tbody tr").count()));
check("防火墙三档", (await page.locator(".sys-firewall__chip").count()) === 3);

await page.getByRole("button", { name: /^服务/ }).first().click();
await page.locator(".sys-table--services tbody tr").first().waitFor({ timeout: 20_000 });
check("服务表有行", (await page.locator(".sys-table--services tbody tr").count()) > 0);
await page.screenshot({ path: path.join(OUT, "sysmanage-ui.png") });

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Escape 关闭", (await page.locator(".sys-console").count()) === 0);
check("没有 pageerror", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

// 公网：桥端打码，不能只靠前端隐藏。
const pub = await ctx.request.get(`${BASE}/api/sys?section=overview`, {
  headers: { "cf-connecting-ip": "203.0.113.9" },
});
const pubBody = await pub.json();
check("公网 overview 200", pub.status() === 200, `HTTP ${pub.status()}`);
check("公网 public=true", pubBody.public === true);
check("公网主机名打码", typeof pubBody.hostname === "string" && pubBody.hostname.includes("•"), String(pubBody.hostname));
check("公网桥 PID/端口不暴露", pubBody.bridge?.pid === null && pubBody.bridge?.port === null);

const pubWrite = await ctx.request.post(`${BASE}/api/sys/dns`, {
  headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
  data: { guid: "{NOPE}", servers: ["8.8.8.8"] },
});
check("公网 DNS 写 403", pubWrite.status() === 403, `HTTP ${pubWrite.status()}`);

const pubWinnat = await ctx.request.post(`${BASE}/api/sys/winnat/restart`, {
  headers: { "cf-connecting-ip": "203.0.113.9" },
});
check("公网重启 WinNAT 403", pubWinnat.status() === 403, `HTTP ${pubWinnat.status()}`);

// 同值 DNS 必须走 unchanged，不弹 UAC。
const net = await (await ctx.request.get(`${BASE}/api/sys?section=network`)).json();
check("network 带 WinNAT 状态", typeof net.winnat?.status === "string", JSON.stringify(net.winnat));
const target = net.adapters?.find((a) => Array.isArray(a.dns) && a.dns.length);
if (target) {
  const same = await ctx.request.post(`${BASE}/api/sys/dns`, {
    headers: { "content-type": "application/json" },
    data: { guid: target.guid, servers: target.dns },
  });
  const body = await same.json();
  check("同值 DNS → unchanged", same.status() === 200 && body.unchanged === true, JSON.stringify(body).slice(0, 160));
} else {
  console.log("  skip  同值 DNS（当前网卡是 DHCP / 没有 DNS）");
}

done(0);
