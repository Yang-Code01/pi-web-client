/**
 * #266 本机管理：真界面冒烟 + 公网掩码/同值 DNS 两条接口边界。
 *
 *   npm run build && node bridge/tests/sysmanage-ui.mjs
 *
 * 自带丢弃式 bridge（端口由系统分配），不碰 7864；只读本机数据，不真的改 DNS / 重启 WinNAT——
 * 两者都会弹 UAC 并动整机网络，留本机手验。截图落在 .scratch/shots/sysmanage-ui.png。
 * 末尾另开几个放大字号的上下文，验三套控制台都不会被 #app 的 zoom 顶出视口，
 * 本机管理六个分区及概况跳转也不会横向穿出面板。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";
import { freePort } from "../../tools/free-port.mjs";

const { chromium } = await loadPlaywright();
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.SYSMANAGE_UI_PORT ?? (await freePort()));
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
check("六个分区", (await page.locator(".sys-nav__item").count()) === 6, String(await page.locator(".sys-nav__item").count()));

await page.locator(".sys-card").first().waitFor({ timeout: 20_000 });
await page.locator(".sys-adapter").first().waitFor({ timeout: 20_000 });
const hostname = (await page.locator(".sys-title").innerText()).trim();
check("概况显示主机名", hostname.length > 2, hostname);
check("概况有磁盘", (await page.locator(".sys-disk").count()) > 0, String(await page.locator(".sys-disk").count()));
check("概况有网卡", (await page.locator(".sys-adapter").count()) > 0, String(await page.locator(".sys-adapter").count()));

// 考勤（第六页，D289）：没配置时落在「还没配置」，但「设置」页必须能进去 ——
// 那是唯一的配置入口，点不开就等于这个功能装不上手。
await page.locator(".sys-nav__item").nth(5).click();
await page.locator(".at-page").first().waitFor({ timeout: 20_000 });
check("考勤页能打开", (await page.locator(".at-page").count()) === 1);
check("考勤页四个页签", (await page.locator(".at-tab").count()) === 4, String(await page.locator(".at-tab").count()));
const toSettings = page.getByRole("button", { name: "去设置", exact: true });
// 进页先显示「正在读状态…」，未配置态要等 /api/attendance/state 回来才画。
await toSettings.first().waitFor({ timeout: 10_000 });
check("未配置时给出去设置的出口", (await toSettings.count()) > 0);
await toSettings.first().click();
await page.locator('.at-input[data-field="apiBase"]').waitFor({ timeout: 10_000 });
check("「去设置」真能到设置页", (await page.locator('.at-input[data-field="apiBase"]').count()) === 1);
check("设置页有地址/账号/密码四个输入框", (await page.locator(".at-input").count()) >= 4, String(await page.locator(".at-input").count()));
// 填完四个字段直接点「登录」，中间不点「保存配置」：桥端拿到的必须是表单里这对地址，
// 而登录失败（这里是 127.0.0.1:9，必然拒连）也不能把刚填的东西清空。
await page.locator('.at-input[data-field="apiBase"]').fill("http://127.0.0.1:9/oa");
await page.locator('.at-input[data-field="pageBase"]').fill("http://127.0.0.1:9");
await page.locator('.at-input[data-field="account"]').fill("TS0001");
await page.locator('input[type="password"].at-input').fill("ui-pass-123456");
await page.getByRole("button", { name: "登录", exact: true }).click();
await page.locator(".at-notice__text").first().waitFor({ timeout: 20_000 });
const loginNotice = (await page.locator(".at-notice__text").first().innerText()).trim();
check("直接点「登录」会用表单里的地址（不是「先配好 OA 地址」）", !/先配好 OA 地址/.test(loginNotice), loginNotice);
check("登录失败不清空接口地址", (await page.locator('.at-input[data-field="apiBase"]').inputValue()) === "http://127.0.0.1:9/oa");
check("登录失败不清空账号", (await page.locator('.at-input[data-field="account"]').inputValue()) === "TS0001");
check(
  "登录失败不清空密码",
  (await page.locator('input[type="password"].at-input').inputValue()) === "ui-pass-123456",
  await page.locator('input[type="password"].at-input').inputValue(),
);
// 保存配置成功也会整页重画：账号不能跟着消失，否则人以为没存上。
await page.locator('.at-input[data-field="account"]').fill("TS0002");
await page.getByRole("button", { name: "保存配置", exact: true }).click();
// 等提示条换一句话（成功是「配置已保存」，失败是那一条错误），不认死具体文案。
await page.waitForFunction(
  (prev) => {
    const t = (document.querySelector(".at-notice__text")?.textContent ?? "").trim();
    return t.length > 0 && t !== prev;
  },
  loginNotice,
  { timeout: 20_000 },
);
const saveNotice = (await page.locator(".at-notice__text").first().innerText()).trim();
check("保存配置后提示「配置已保存」", saveNotice === "配置已保存", saveNotice);
check(
  "保存配置后账号还在输入框里",
  (await page.locator('.at-input[data-field="account"]').inputValue()) === "TS0002",
  await page.locator('.at-input[data-field="account"]').inputValue(),
);

// 密码框：登录过一次之后，再打开设置就该看到存着的那个密码，但 input 仍然是 password ——
// 眼睛按钮一按才变 text，再一按收回去。
const OA_PORT = await freePort();
const OA = `http://127.0.0.1:${OA_PORT}`;
// 密码框的选择器两副面孔都认：新版本带 data-field，旧版本只有 type=password。
// 只写前者的话，旧代码上会直接超时撞崩，看不到「哪几条断言红了」。
const pwSel = '.at-input[data-field="password"], input[type="password"].at-input';
const pwBox = page.locator(pwSel).first();
const oaToken = `x.${Buffer.from(JSON.stringify({ sub: "TS0001", exp: 4102444800 })).toString("base64url")}.y`;
const oa = http.createServer((req, res) => {
  const route = new URL(req.url ?? "/", "http://oa.invalid").pathname;
  const login = route === "/in/login/check";
  res.writeHead(login ? 200 : 404, { "content-type": "application/json" });
  res.end(
    login
      ? JSON.stringify({ status: "OK", token: oaToken, user_id: 1001, name: "张三", work_no: "TS0001" })
      : JSON.stringify({ status: "NG", error: "本用例没搭这个接口" }),
  );
});
await new Promise((r) => oa.listen(OA_PORT, "127.0.0.1", r));
await page.locator('.at-input[data-field="apiBase"]').fill(OA);
await page.locator('.at-input[data-field="pageBase"]').fill(OA);
await page.locator('.at-input[data-field="account"]').fill("TS0001");
await pwBox.fill("ui-pass-123456");
await page.getByRole("button", { name: "登录", exact: true }).click();
const loggedIn = await page
  .waitForFunction(() => (document.querySelector(".at-notice__text")?.textContent ?? "").trim() === "登录成功", null, {
    timeout: 20_000,
  })
  .then(() => true)
  .catch(() => false);
check("对着能连通的 OA 能登录成功", loggedIn, (await page.locator(".at-notice__text").first().innerText().catch(() => "")).trim());

// 真正的场景：关掉页面，下次打开考勤时密码就已经在框里（还是点，不是明文）。
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
await page.locator('[data-act="look"]').first().click();
await page.locator('.set-tabs .chip[data-tab="conn"]').click();
const back = page.locator('.set-page[data-page="conn"]');
await back.waitFor({ timeout: 10_000 });
await back.getByRole("button", { name: "本机管理", exact: true }).first().click();
await page.locator(".sys-console").waitFor({ timeout: 20_000 });
await page.locator(".sys-nav__item").nth(5).click();
await page.locator(".at-page").first().waitFor({ timeout: 20_000 });
await page.locator(".at-tab", { hasText: "设置" }).click();
await page.locator(pwSel).first().waitFor({ timeout: 10_000 });
// 密码是异步从桥拿回来的：等它落进框里，别拿「还没到」当「回填坏了」。
const filled = await page
  .waitForFunction(
    (sel) => (document.querySelector(sel)?.value ?? "") === "ui-pass-123456",
    pwSel,
    { timeout: 10_000 },
  )
  .then(() => true)
  .catch(() => false);
check("重开设置页，密码框回填了已存的密码", filled, await pwBox.inputValue().catch(() => ""));
check("回填后 input 仍是 password（不明文摆着）", (await pwBox.getAttribute("type")) === "password", String(await pwBox.getAttribute("type")));
const eye = page.locator(".at-eye");
const hasEye = (await eye.count()) === 1;
// 没有眼睛按钮时不去点它（旧版本就是这样），让后面的断言自己报红，而不是把整个用例撞崩。
const clickEye = async () => {
  if (hasEye) await eye.click();
};
check("密码框旁边有眼睛按钮", hasEye);
check("眼睛按钮默认是「显示密码」", hasEye && (await eye.getAttribute("aria-pressed")) === "false", hasEye ? String(await eye.getAttribute("aria-pressed")) : "没有按钮");
await clickEye();
check("点眼睛变明文可见", (await pwBox.getAttribute("type")) === "text", String(await pwBox.getAttribute("type")));
check("切明文内容不变", (await pwBox.inputValue()) === "ui-pass-123456", await pwBox.inputValue());
check("切明文后眼睛是「隐藏密码」", hasEye && (await eye.getAttribute("aria-pressed")) === "true", hasEye ? String(await eye.getAttribute("aria-pressed")) : "没有按钮");
await clickEye();
check("再点一次收回 password", (await pwBox.getAttribute("type")) === "password", String(await pwBox.getAttribute("type")));
oa.close();
// 提醒页跟 OA 配置无关：没配过也该打得开（它是本地规则）。
await page.locator(".at-tab", { hasText: "提醒" }).click();
await page.locator(".at-week__btn").first().waitFor({ timeout: 10_000 });
check("提醒页没配置也能开", (await page.locator(".at-week__btn").count()) === 7, String(await page.locator(".at-week__btn").count()));
await page.locator(".at-page").screenshot({ path: path.join(OUT, "sysmanage-attendance.png") });
// 回到概况，后面的用例还指望它。
await page.locator(".sys-nav__item").nth(0).click();
await page.locator(".sys-card").first().waitFor({ timeout: 20_000 });

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
      // 外壳没顶出视口还不够：六个分区各自有网格/表格，放大字号后布局 px 变少，
      // 原生 @media 看的是视口宽度（D158），不触发窄版折叠时内容会横向穿出 .sys-pane。
      const nav = zoomPage.locator(".sys-nav__item");
      const SECTIONS = [
        { wait: ".sys-card" },
        { wait: ".sys-dns" },
        { wait: ".sys-table tbody tr" },
        { wait: ".sys-table--services tbody tr" },
        { wait: ".sys-wk-hero" },
        { wait: ".at-page" },
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

// D286 的核心：自启项在、进程没起来时，卡片必须说「没在跑」，不能因为自启项在就报运行中。
// 自启项名带状态目录哈希后缀，跟正式实例（pi-web-client-workclock）不撞；删不干净也只是个死值。
const waitAgent = async (text, ms = 15_000) => {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    last = (await page.locator(".sys-wk-agent").innerText()).trim();
    if (last.includes(text)) return last;
    await page.waitForTimeout(200);
  }
  return last;
};
const wkName = (await (await ctx.request.get(`${BASE}/api/sys?section=workclock`)).json()).agent?.autostartName;
check("自启项名带测试实例后缀", typeof wkName === "string" && wkName.startsWith("pi-web-client-workclock-"), String(wkName));
const regRun = (args) => execFileSync("reg.exe", args, { stdio: "ignore" });
try {
  regRun(["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", wkName, "/t", "REG_SZ", "/d", "powershell.exe -NoProfile -File C:\\nowhere\\workclock-agent.ps1", "/f"]);
  await page.getByRole("button", { name: /^刷新$/ }).click();
  const zombie = await waitAgent("已注册自启，但没在跑");
  check("自启项在、进程没起 → 说没在跑", zombie.includes("已注册自启，但没在跑"), zombie.replace(/\s+/g, " ").slice(0, 120));
  check("没在跑时心跳是 —", /心跳\s*—/.test((await page.locator(".sys-wk-facts").innerText()).replace(/\s+/g, " ")), (await page.locator(".sys-wk-facts").innerText()).replace(/\s+/g, " ").slice(0, 160));
  const agentPanelText = await page.locator(".sys-wk-panel", { has: page.locator(".sys-wk-agent") }).innerText();
  check("没在跑时给出自救提示", agentPanelText.includes("自启项在，但记录器没在跑"), agentPanelText.replace(/\s+/g, " ").slice(0, 200));
} finally {
  regRun(["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", wkName, "/f"]);
}
await page.getByRole("button", { name: /^刷新$/ }).click();
const backToNone = await waitAgent("未安装");
check("删掉自启项回到未安装", backToNone.includes("未安装"), backToNone.replace(/\s+/g, " ").slice(0, 80));
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
