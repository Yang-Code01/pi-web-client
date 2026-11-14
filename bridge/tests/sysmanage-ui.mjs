/**
 * #266 本机管理：真界面冒烟 + 公网掩码/同值 DNS 两条接口边界。
 *
 *   npm run build && node bridge/tests/sysmanage-ui.mjs
 *
 * 自带丢弃式 bridge（端口 7893），不碰 7864；只读本机数据，不真的改 DNS / 重启 WinNAT——
 * 两者都会弹 UAC 并动整机网络，留本机手验。截图落在 .scratch/shots/sysmanage-ui.png。
 * 末尾另开几个放大字号的上下文，验三套控制台都不会被 #app 的 zoom 顶出视口，
 * 本机管理五个分区及概况跳转也不会横向穿出面板。
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
// 上下班分区要看到「已经在走」的倒计时：种一条三小时前的解锁（记录器此刻没装，源标事件）。
const wkDir = path.join(STATE, "workclock");
fs.mkdirSync(wkDir, { recursive: true });
fs.writeFileSync(
  path.join(wkDir, "agent.jsonl"),
  `${JSON.stringify({ t: Date.now() - 3 * 3600_000, k: "unlock", src: "event" })}\n`,
);
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

// D225 之后「本机管理」不在右栏，在齿轮抽屉的「连接与设置」页：先开抽屉、再切页。
await page.locator('[data-act="look"]').first().click();
await page.locator('.set-tabs .chip[data-tab="conn"]').click();
const connPage = page.locator('.set-page[data-page="conn"]');
await connPage.waitFor({ timeout: 10_000 });
const open = connPage.getByRole("button", { name: "本机管理", exact: true }).first();
check("「连接与设置」页有本机管理按钮（pi 设置旁边）", (await open.count()) > 0);
await open.click();
await page.locator(".sys-console").waitFor({ timeout: 10_000 });
check("控制台打开", (await page.locator(".sys-console").count()) === 1);
check("五个分区", (await page.locator(".sys-nav__item").count()) === 5, String(await page.locator(".sys-nav__item").count()));

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
/**
 * 框本身也要留在视口里：`#app` 挂着 `zoom: var(--ui-scale)`，CSS 里写 `96vw / 90vh`
 * 会被再乘一次缩放，1.5 倍字号下 800px 高的控制台变成 1200px，页脚被裁、背后页面从两侧露出。
 * 三套控制台外壳（本机管理 / 设置 / Jira）同构，用遮罩的 content box 夹住就好。
 */
const CONSOLE_KINDS = {
  本机管理: { back: ".sys-back", shell: ".sys-console", head: ".sys-head", main: ".sys-main", foot: ".sys-foot", open: async (page) => {
    await page.locator('[data-act="look"]').first().click();
    await page.locator('.set-tabs .chip[data-tab="conn"]').click();
    await page.locator('.set-page[data-page="conn"]').waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "本机管理", exact: true }).first().click();
    await page.locator(".sys-console").waitFor({ timeout: 10_000 });
    await page.locator(".sys-card").first().waitFor({ timeout: 20_000 });
  } },
  设置: { back: ".st-back", shell: ".st-console", head: ".st-head", main: ".st-main", foot: ".st-foot", open: async (page) => {
    await page.locator('[data-act="look"]').first().click();
    await page.locator('.set-tabs .chip[data-tab="conn"]').click();
    await page.locator('.set-page[data-page="conn"]').waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "pi 设置", exact: true }).first().click();
    await page.locator(".st-console").waitFor({ timeout: 10_000 });
  } },
  Jira: { back: ".jc-back", shell: ".jc-console", head: ".jc-head", main: ".jc-main", foot: ".jc-foot", open: async (page) => {
    await page.locator('[data-act="jira"]').first().click();
    await page.locator(".jc-console").waitFor({ timeout: 10_000 });
  } },
};
async function checkZoomLayout(scale, width, height) {
  const zoomCtx = await browser.newContext({ locale: "zh-CN", viewport: { width, height } });
  await zoomCtx.addInitScript((s) => {
    localStorage.setItem("pi.prefs", JSON.stringify({ scale: s }));
  }, scale);
  const zoomLogin = await zoomCtx.request.post(`${BASE}/api/login`, { data: { passphrase: PASS } });
  check(`字号 ${scale} 登录自检`, zoomLogin.status() === 200, `HTTP ${zoomLogin.status()}`);
  const zoomPage = await zoomCtx.newPage();
  const zoomErrors = [];
  zoomPage.on("pageerror", (e) => zoomErrors.push(String(e)));
  await zoomPage.goto(BASE, { waitUntil: "domcontentloaded" });
  await zoomPage.waitForTimeout(400);
  for (const [name, k] of Object.entries(CONSOLE_KINDS)) {
    await k.open(zoomPage);
    const sel = { back: k.back, shell: k.shell, head: k.head, main: k.main, foot: k.foot };
    const g = await zoomPage.evaluate((sel) => {
      const box = (s) => {
        const e = document.querySelector(s);
        if (!e || getComputedStyle(e).display === "none") return null;
        const b = e.getBoundingClientRect();
        return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1) };
      };
      return {
        vp: { width: innerWidth, height: innerHeight },
        uiScale: getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim(),
        back: box(sel.back), console: box(sel.shell), head: box(sel.head), main: box(sel.main), foot: box(sel.foot),
      };
    }, sel);
    const onScreen = (x) => x && x.left >= -1 && x.top >= -1 && x.right <= g.vp.width + 1 && x.bottom <= g.vp.height + 1;
    const inConsole = (x) => x && g.console && x.top >= g.console.top - 1 && x.bottom <= g.console.bottom + 1;
    check(
      `字号 ${scale} @${width}×${height} ${name}：遮罩/控制台/页脚都在视口内`,
      Boolean(onScreen(g.back) && onScreen(g.console) && onScreen(g.foot) && inConsole(g.head) && inConsole(g.main) && inConsole(g.foot) && g.main.bottom <= g.foot.top + 1),
      JSON.stringify(g),
    );
    if (name === "本机管理") {
      // 外壳没顶出视口还不够：五个分区各自有网格/表格，放大字号后布局 px 变少，
      // 原生 @media 看的是视口宽度（D158），不触发窄版折叠时内容会横向穿出 .sys-pane。
      const nav = zoomPage.locator(".sys-nav__item");
      const SECTIONS = [
        { wait: ".sys-card" },
        { wait: ".sys-dns" },
        { wait: ".sys-table tbody tr" },
        { wait: ".sys-table--services tbody tr" },
        { wait: ".sys-wk-hero" },
      ];
      const paneGeometry = () => zoomPage.evaluate(() => {
        const pane = document.querySelector(".sys-pane");
        const b = pane.getBoundingClientRect();
        const offenders = [...pane.querySelectorAll("*")]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && (r.right > b.right + 1 || r.left < b.left - 1);
          })
          .slice(0, 5)
          .map((e) => `${e.className || e.tagName}@${e.getBoundingClientRect().right.toFixed(1)}`);
        return {
          clientWidth: pane.clientWidth,
          scrollWidth: pane.scrollWidth,
          paneRight: +b.right.toFixed(1),
          offenders,
        };
      });
      for (let i = 0; i < SECTIONS.length; i += 1) {
        const label = (await nav.nth(i).innerText()).trim().replace(/\s+/g, " ");
        await nav.nth(i).click();
        await zoomPage.locator(SECTIONS[i].wait).first().waitFor({ timeout: 20_000 });
        const p = await paneGeometry();
        check(
          `字号 ${scale} @${width}×${height} ${label}：内容不横向穿出面板`,
          p.scrollWidth <= p.clientWidth + 1 && p.offenders.length === 0,
          JSON.stringify(p),
        );
      }
      // 概况里的「查看网络与 DNS」也是一条入口，跳过去后同样不能横向溢出。
      await nav.nth(0).click();
      await zoomPage.locator(".sys-more").first().waitFor({ timeout: 20_000 });
      await zoomPage.locator(".sys-more").first().click();
      await zoomPage.locator(".sys-dns").first().waitFor({ timeout: 20_000 });
      const jump = await paneGeometry();
      check(
        `字号 ${scale} @${width}×${height} 概况跳转网络与 DNS：内容不横向穿出面板`,
        jump.scrollWidth <= jump.clientWidth + 1 && jump.offenders.length === 0,
        JSON.stringify(jump),
      );
    }
    await zoomPage.keyboard.press("Escape");
    await zoomPage.waitForTimeout(150);
  }
  check(`字号 ${scale} 没有 pageerror`, zoomErrors.length === 0, zoomErrors.slice(0, 3).join(" | "));
  await zoomCtx.close();
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

// 上下班：种的那条解锁在 3 小时前，默认 9 小时 → 倒计时该每秒往下走。
await page.getByRole("button", { name: /上下班/ }).first().click();
await page.locator(".sys-wk-hero").waitFor({ timeout: 20_000 });
const digits = page.locator(".sys-wk-hero__digits");
const d1 = (await digits.innerText()).trim();
check("倒计时是 HH:MM:SS", /^\d{2}:\d{2}:\d{2}$/.test(d1), d1);
await page.waitForTimeout(1300);
const d2 = (await digits.innerText()).trim();
check("倒计时每秒在走", d1 !== d2, `${d1} → ${d2}`);
check("七日 chip", (await page.locator(".sys-wk-chip").count()) === 7, String(await page.locator(".sys-wk-chip").count()));
check("今日明细有解锁行", (await page.locator(".sys-wk-event").count()) >= 1);
check("30 天表有行", (await page.locator(".sys-wk-table tbody tr").count()) >= 1);
const agentText = (await page.locator(".sys-wk-agent").innerText()).trim();
check("记录器卡片说未安装", agentText.includes("未安装"), agentText.replace(/\s+/g, " ").slice(0, 80));
const hoursInput = page.locator(".sys-wk-input").first();
check("工时输入默认 9", (await hoursInput.inputValue()).trim() === "9", await hoursInput.inputValue());
await checkLayout("上下班");
await page.locator(".sys-wk-grid").screenshot({ path: path.join(OUT, "sysmanage-workclock.png") });
await page.locator(".sys-main").screenshot({ path: path.join(OUT, "sysmanage-workclock-full.png") });

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

// 上下班：公网只读；装/卸记录器和导入历史都是本机才有的事。
const pubWk = await (await ctx.request.get(`${BASE}/api/sys?section=workclock`, {
  headers: { "cf-connecting-ip": "203.0.113.9" },
})).json();
check("公网 workclock 只读", pubWk.public === true, JSON.stringify(pubWk.public));
const pubAgent = await ctx.request.post(`${BASE}/api/sys/workclock/agent`, {
  headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
  data: { action: "install" },
});
check("公网装记录器 403", pubAgent.status() === 403, `HTTP ${pubAgent.status()}`);
const pubBackfill = await ctx.request.post(`${BASE}/api/sys/workclock/backfill`, {
  headers: { "cf-connecting-ip": "203.0.113.9" },
});
check("公网导入历史 403", pubBackfill.status() === 403, `HTTP ${pubBackfill.status()}`);

// 本机改工时：8.5 落盘、倒计时跟着变短。
const saveHours = await ctx.request.post(`${BASE}/api/sys/workclock/settings`, {
  headers: { "content-type": "application/json" },
  data: { hours: 8.5 },
});
check("改工时为 8.5", saveHours.status() === 200, `HTTP ${saveHours.status()}`);
const afterHours = await (await ctx.request.get(`${BASE}/api/sys?section=workclock`)).json();
check("工时落盘为 8.5", afterHours.settings?.hours === 8.5, String(afterHours.settings?.hours));
check("目标时刻仍从第一次解锁算", afterHours.today?.target === afterHours.today?.firstUnlock + 8.5 * 3600_000, `${afterHours.today?.firstUnlock} + 8.5h`);
const badHours = await ctx.request.post(`${BASE}/api/sys/workclock/settings`, {
  headers: { "content-type": "application/json" },
  data: { hours: 99 },
});
const badBody = await badHours.json();
check("工时 99 被拒或夹到上限", badHours.status() !== 200 || badBody.settings?.hours <= 24, `HTTP ${badHours.status()} ${JSON.stringify(badBody).slice(0, 80)}`);

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

// D123 同一个坑：vw/vh 在 zoom 子树里会被再乘一次，1.5 倍字号下 800px 高的控制台变成 1200px。
await checkZoomLayout(1.5, 2000, 1185);
await checkZoomLayout(1.5, 1280, 720);
await checkZoomLayout(2, 1440, 940);

done(0);
