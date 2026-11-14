/**
 * 参考用例集：pi-web-client 本机管理 / 上下班（12 条）。
 *
 *   node .pi/skills/pi-web-test-html/bin/run-book.mjs --case workclock
 *
 * 只写用例本身：打开哪个分区、点哪个按钮、断言什么、截哪块。驱动（浏览器、登录、
 * 截图落盘、spec.json）在 bin/run-book.mjs，写新用例集照 references/writing-cases.md。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const meta = {
  title: "pi-web-client · 本机管理「上下班」模块 测试书",
  module: "本机管理 / 上下班",
  branch: "feat/workclock",
  pr: "#414",
  decision: "D246",
  output: "上下班模块-测试书",
  order: ["TC-01", "TC-02", "TC-03", "TC-04", "TC-05", "TC-06", "TC-07", "TC-08", "TC-09", "TC-10", "TC-11", "TC-12"],
};

export default async function workclock(h) {
  const { page, ctx, base, openCase, step, ok, fail, shot } = h;

async function closeSheets() {
  for (let i = 0; i < 6; i += 1) {
    // 关闭按钮的字会跟界面语言变（中文界面是「关闭」，英文界面是 Close）。
    const buttons = page.locator(".sheet-head button, .sys-head button").filter({ hasText: /关闭|Close|閉じる/ });
    if ((await buttons.count()) === 0) return;
    await buttons.last().click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function openConsole() {
  if ((await page.locator(".sys-console").count()) === 0) {
    await closeSheets();
    await page.locator('[data-act="look"]').first().click();
    await page.locator('.set-tabs .chip[data-tab="conn"]').click();
    await page.getByRole("button", { name: /本机管理|Machine|マシン管理/ }).first().click();
    await page.locator(".sys-console").waitFor({ timeout: 15_000 });
    // 等首屏各分区把骨架屏换掉再截图（否则截到「正在读取本机信息…」）。
    await page.waitForTimeout(300);
    await page
      .waitForFunction(() => !document.body.innerText.includes("正在读取本机信息"), null, { timeout: 20_000 })
      .catch(() => {});
  }
}

async function openWorkclock() {
  await openConsole();
  // 分区顺序固定：概况 / 网络与 DNS / 端口与服务 / 服务 / 上下班；按索引点，英文界面也认。
  await page.locator(".sys-nav__item").nth(4).click();
  await page.locator(".sys-wk-hero").waitFor({ timeout: 20_000 });
  // 等首屏 load() 落地再截，否则元素会在渲染中被换掉（Element is not attached to the DOM）。
  await page.locator(".sys-wk-hero__digits").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
}

const api = async (p) => (await ctx.request.get(`${base}${p}`)).json();
const apiPost = async (p, data) => ctx.request.post(`${base}${p}`, { data });

function ps(command) {
  return execFileSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8" }).trim();
}

/** 记录器数据目录：从状态接口里读回来，别硬编码。 */
let wkDir = "";
async function workclockDir() {
  if (wkDir) return wkDir;
  const st = await api("/api/sys?section=workclock");
  const scriptPath = st.agent?.scriptPath ?? "";
  wkDir = scriptPath ? path.dirname(scriptPath) : "";
  return wkDir;
}

function seedEvents(events) {
  fs.mkdirSync(wkDir, { recursive: true });
  fs.writeFileSync(path.join(wkDir, "agent.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

function seedLog(events) {
  fs.mkdirSync(wkDir, { recursive: true });
  fs.writeFileSync(path.join(wkDir, "log-events.json"), JSON.stringify(events), "utf8");
}

const at = (dayOffset, h, m) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

const hhmm = (ms) => {  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/**
 * 当日四个事件的时刻。任何时候跑都落在今天、且都在「现在」之前：
 * 白天（今天已过 ≥620 分钟）用「早上班、过了下班点」的真实剧本；凌晨则把
 * 一天的进度压到已经过去的那点时间里，断言不写死 09:04，测试书不必等到下午才能复现。
 */
function todaySchedule() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const span = Math.floor((now.getTime() - start) / 60000);
  const mk = (min) => start + min * 60000;
  if (span >= 620) {
    return { u1: mk(span - 620), l1: mk(span - 443), u2: mk(span - 382), l2: mk(span - 5), past: true };
  }
  const u1 = Math.max(1, Math.min(3, span - 1));
  const l1 = u1 + Math.max(1, Math.floor((span - u1) * 0.35));
  const u2 = l1 + 1;
  const l2 = Math.max(u2 + 1, span - 1);
  return { u1: mk(u1), l1: mk(l1), u2: mk(u2), l2: mk(l2), past: false };
}

async function reload() {
  await page.evaluate(() => location.reload());
  await page.waitForTimeout(1200);
}

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(900);

// ---------------------------------------------------------------- TC-01 入口与空状态
openCase({
  id: "TC-01",
  title: "分区入口与首次打开（空状态）",
  module: "本机管理 / 上下班",
  priority: "P0",
  precondition: "测试环境全新状态目录，从未装过记录器、没有任何解锁记录",
});
{
  let s = step("打开齿轮设置 → 连接与设置 → 本机管理", "控制台打开，左栏出现 5 个分区，上下班显示工时徽标");
  await openConsole();
  const navs = await page.locator(".sys-nav__item").allInnerTexts();
  const navText = navs.map((t) => t.replace(/\s+/g, " ").trim()).join(" | ");
  ok(s, `分区：${navText}`);
  if (navs.length !== 5) fail(s, `分区数应为 5，实际 ${navs.length}`);
  if (!navText.includes("上下班")) fail(s, "左栏没有「上下班」");
  await shot(s, ".sys-console", "nav");

  s = step("点「上下班」分区", "大字显示 --:--:--，副标题「还没有今天的上班记录」，指标卡为空值，记录器显示未安装");
  await openWorkclock();
  const digits = (await page.locator(".sys-wk-hero__digits").innerText()).trim();
  const caption = (await page.locator(".sys-wk-hero__caption").innerText()).trim();
  const agentText = (await page.locator(".sys-wk-agent").innerText()).replace(/\s+/g, " ").trim();
  ok(s, `大字「${digits}」；副标题「${caption}」；记录器「${agentText.slice(0, 40)}」`);
  if (digits !== "--:--:--") fail(s, `大字应是 --:--:--，实际 ${digits}`);
  if (!caption.includes("还没有今天的上班记录")) fail(s, "副标题不对");
  if (!agentText.includes("未安装")) fail(s, "记录器卡片应显示未安装");
  await shot(s, ".sys-wk-grid", "empty-hero");
  await shot(s, ".sys-wk-cols", "empty-cols");
}

// ---------------------------------------------------------------- TC-02 装上记录器
openCase({
  id: "TC-02",
  title: "装上记录器（零 UAC）",
  module: "上下班 / 记录器",
  priority: "P0",
  precondition: "TC-01 的空状态；当前账号非管理员",
});
{
  let s = step("点记录器卡片里的「装上记录器」", "卡片变「运行中」并出现 pid；登录时自启=已注册；按钮变成「重新启动记录器」「停止并移除」");
  await openWorkclock();
  const buttons = page.locator(".sys-wk-actions button");
  await buttons.filter({ hasText: "装上记录器" }).first().click();
  await page.locator(".sys-wk-agent").filter({ hasText: "运行中" }).first().waitFor({ timeout: 60_000 });
  // 状态行在 .sys-wk-agent 里，登录时自启/见过锁屏/最后事件在 5 个 .sys-wk-fact 里，所以读整块面板。
  const card = (await page.locator(".sys-wk-agent").innerText()).replace(/\s+/g, " ").trim();
  const facts = (await page.locator(".sys-wk-facts").innerText()).replace(/\s+/g, " ").trim();
  const acts = (await page.locator(".sys-wk-actions").innerText()).replace(/\s+/g, " ").trim();
  ok(s, `卡片「${card}」；事实「${facts}」；按钮「${acts}」`);
  if (!/pid\s*\d+/i.test(card)) fail(s, "卡片里没有 pid");
  if (!facts.includes("已注册")) fail(s, "登录时自启没变已注册");
  await shot(s, ".sys-wk-cols", "agent-running");

  s = step("用 PowerShell 核对计划任务与记录器进程（页面之外的真状态）", "任务 pi-web-client-workclock 存在、State=Running；记录器进程在跑；agent.jsonl 有第一行");
  const task = ps("if (Get-ScheduledTask -TaskName 'pi-web-client-workclock' -ErrorAction SilentlyContinue) { (Get-ScheduledTask -TaskName 'pi-web-client-workclock').State } else { 'MISSING' }");
  const st = await api("/api/sys?section=workclock");
  const dir = await workclockDir();
  const jsonl = fs.existsSync(path.join(dir, "agent.jsonl")) ? fs.readFileSync(path.join(dir, "agent.jsonl"), "utf8").trim().split(/\r?\n/) : [];
  ok(s, `计划任务 State=${task}；agent.running=${st.agent.running} pid=${st.agent.pid}；agent.jsonl ${jsonl.length} 行：${jsonl[0] ?? "—"}`);
  s.evidence.push(`Get-ScheduledTask → ${task}`, `agent.pid → ${st.agent.pid}`, `agent.jsonl[0] → ${jsonl[0] ?? "（空）"}`);
  if (task !== "Running") fail(s, `计划任务状态 ${task}`);
  if (!st.agent.running) fail(s, "状态接口说没在跑");
  if (jsonl.length === 0) fail(s, "agent.jsonl 是空的（记录器没写初始事件）");
}

// ---------------------------------------------------------------- TC-03 实时解锁（人工）
openCase({
  id: "TC-03",
  title: "实时记录解锁（锁屏 → 解锁）",
  module: "上下班 / 记录器",
  priority: "P0",
  precondition: "TC-02 已装记录器",
  manual: true,
});
{
  let s = step("【人工】按 Win+L 锁屏，停 10 秒后输入密码解锁", "今日明细多出「锁屏」「解锁」两行，来源=事件；「见过锁屏」计数 +1；心跳时间刷新");
  await openWorkclock();
  const before = (await page.locator(".sys-wk-agent").innerText()).replace(/\s+/g, " ").trim();
  ok(s, `操作前记录器卡片：${before}（本用例需人工锁屏解锁，自动化脚本只记录操作前状态）`);
  s.verdict = "人工";
  h.cur.verdict = "人工";
  await shot(s, ".sys-wk-cols", "before-lock");

  s = step("【人工】解锁后再看「今日明细」", "第一行是本次解锁时刻、类型 解锁、来源 事件；下方新增一条锁屏");
  s.actual = "待人工执行后填写";
  s.verdict = "人工";
}

// ---------------------------------------------------------------- TC-04 改工时
openCase({
  id: "TC-04",
  title: "改每天工时（合法值立刻重算 / 非法值拦截）",
  module: "上下班 / 设置",
  priority: "P0",
  precondition: "TC-02；当天已有一条解锁记录",
});
{
  let s = step("把「每天工时」改成 8.5 后点保存", "出现绿色提示「工时改成每天 8.5 小时」；目标下班时刻与倒计时立刻按 8.5 小时重算");
  await openWorkclock();
  const targetBefore = await api("/api/sys?section=workclock").then((st) => st.today.target);
  await page.locator(".sys-wk-input").fill("8.5");
  await page.locator(".sys-wk-form button", { hasText: "保存" }).first().click();
  await page.locator(".sys-banner--ok").first().waitFor({ timeout: 20_000 });
  const toast = (await page.locator(".sys-banner--ok").innerText()).replace(/\s+/g, " ").trim();
  const st = await api("/api/sys?section=workclock");
  ok(s, `提示「${toast}」；settings.hours=${st.settings.hours}；目标 ${new Date(st.today.target).toLocaleString("zh-CN")}`);
  if (st.settings.hours !== 8.5) fail(s, `hours 落盘是 ${st.settings.hours}`);
  if (targetBefore && st.today.target === targetBefore) fail(s, "目标时刻没跟着变");
  await shot(s, ".sys-console", "hours-8.5");

  s = step("把工时改成 99 后点保存", "输入框下方/横幅给出「工时要在 0.5–24 小时之间」，设置不变");
  await page.locator(".sys-wk-input").fill("99");
  await page.locator(".sys-wk-form button", { hasText: "保存" }).first().click();
  await page.locator(".sys-banner--bad").first().waitFor({ timeout: 10_000 });
  const bad = (await page.locator(".sys-banner--bad").innerText()).replace(/\s+/g, " ").trim();
  const after = await api("/api/sys?section=workclock");
  ok(s, `提示「${bad}」；hours 仍是 ${after.settings.hours}`);
  if (after.settings.hours !== 8.5) fail(s, "非法值把设置改掉了");
  await shot(s, ".sys-wk-panel", "hours-invalid");

  s = step("直接请求接口 POST /api/sys/workclock/settings {hours:99}", "HTTP 400 + bad_hours（越界不静默夹到 24）");
  await page.locator(".sys-banner__close").first().click().catch(() => {});
  const resp = await apiPost("/api/sys/workclock/settings", { hours: 99 });
  const body = await resp.json();
  ok(s, `HTTP ${resp.status()} ${JSON.stringify(body)}`);
  s.evidence.push(`POST /api/sys/workclock/settings {"hours":99} → ${resp.status()} ${JSON.stringify(body)}`);
  if (resp.status() !== 400 || body.code !== "bad_hours") fail(s, "接口没拒绝越界值");
}

// ---------------------------------------------------------------- TC-05 算上班的星期
openCase({
  id: "TC-05",
  title: "算上班的星期（休息日不算倒计时）",
  module: "上下班 / 设置",
  priority: "P1",
  precondition: "TC-04；默认周一–周五",
});
{
  let s = step("点「周五」把它从工作日里去掉", "周五 chip 变灰、保存进 workdays；页面出现保存提示；接口里 workdays 不含 5");
  await openWorkclock();
  const chip = page.locator(".sys-wk-chip", { hasText: "周五" }).first();
  const wasOn = (await chip.getAttribute("class"))?.includes("on");
  await chip.click();
  await page.waitForTimeout(1200);
  const st = await api("/api/sys?section=workclock");
  ok(s, `点前 on=${wasOn}；workdays=${JSON.stringify(st.settings.workdays)}`);
  if (st.settings.workdays.includes(5)) fail(s, "周五还在 workdays 里");
  if (wasOn && (await chip.getAttribute("class"))?.includes("on")) fail(s, "chip 没变灰");
  await shot(s, ".sys-wk-panel", "weekday-off");

  s = step("再点一次周五恢复", "workdays 回到 [1,2,3,4,5]，chip 重新点亮");
  await chip.click();
  await page.waitForTimeout(1200);
  const back = await api("/api/sys?section=workclock");
  ok(s, `workdays=${JSON.stringify(back.settings.workdays)}`);
  if (JSON.stringify(back.settings.workdays) !== "[1,2,3,4,5]") fail(s, "没恢复到周一–周五");
}

// ---------------------------------------------------------------- TC-06 今日多次解锁（种子）
openCase({
  id: "TC-06",
  title: "一天多次解锁：第一次为准，明细按时间线排列",
  module: "上下班 / 今日明细",
  priority: "P0",
  precondition: "已卸下记录器（TC-09），直接写入记录器格式的当日 4 条事件：第一次解锁 / 锁屏 / 再次解锁 / 最后一次锁屏（时刻按当天已过去的时间排，不写死钟点）",
});
{
  const sch = todaySchedule();
  const when = sch.past ? "过了下班点" : "还没到下班点";
  const s = step(
    "写入当日 4 条事件后刷新页面",
    `大字显示${sch.past ? "「已下班 +」" : "倒计时"}（${when}）；上班=${hhmm(sch.u1)}、解锁次数 2、明细 4 行按时间线排列（最后一行 ${hhmm(sch.l2)} 锁屏）`,
  );
  const dir = await workclockDir();
  if (!dir) fail(s, "没读到记录器数据目录");
  seedEvents([
    { t: sch.u1, k: "unlock", src: "event" },
    { t: sch.l1, k: "lock", src: "event" },
    { t: sch.u2, k: "unlock", src: "event" },
    { t: sch.l2, k: "lock", src: "event" },
  ]);
  await reload();
  await openWorkclock();
  const st = await api("/api/sys?section=workclock");
  const digits = (await page.locator(".sys-wk-hero__digits").innerText()).trim();
  const events = await page.locator(".sys-wk-event").allInnerTexts();
  const last = events[events.length - 1] ?? "";
  ok(s, `大字「${digits}」；firstUnlock=${new Date(st.today.firstUnlock).toLocaleTimeString("zh-CN")}；unlocks=${st.today.unlocks}；明细 ${events.length} 行，首行 ${(events[0] ?? "").split("\n")[0]}，末行 ${last.split("\n")[0]}`);
  if (sch.past && !digits.startsWith("+")) fail(s, `过了下班点应显示 +，实际 ${digits}`);
  if (!sch.past && !/^\d{2}:\d{2}:\d{2}$/.test(digits)) fail(s, `刚才上班时应显示倒计时，实际 ${digits}`);
  const drift = Math.abs(st.today.target - Date.now() - st.today.remainingMs);
  if (drift > 3000) fail(s, `remaining 与 target−now 差 ${drift}ms，不是同一时刻算出来的`);
  if (Math.abs(st.today.firstUnlock - sch.u1) > 1000) fail(s, `firstUnlock 应是第一次解锁 ${hhmm(sch.u1)}，实际 ${hhmm(st.today.firstUnlock)}`);
  if (st.today.unlocks !== 2) fail(s, `解锁次数应为 2，实际 ${st.today.unlocks}`);
  if (events.length !== 4) fail(s, `明细应为 4 行，实际 ${events.length}`);
  if (events[0] && !events[0].includes(hhmm(sch.u1))) fail(s, `首行应是 ${hhmm(sch.u1)}，实际 ${events[0]}`);
  if (last && !last.includes(hhmm(sch.l2))) fail(s, `末行应是 ${hhmm(sch.l2)}，实际 ${last}`);
  await shot(s, ".sys-wk-grid", "hero-after-seed");
  await shot(s, ".sys-wk-cols", "events");
}

// ---------------------------------------------------------------- TC-07 近 30 天
openCase({
  id: "TC-07",
  title: "近 30 天表：达标 / 未达标 / 休息日 / 来源标签",
  module: "上下班 / 历史",
  priority: "P1",
  precondition: "TC-06 的数据之上再补 29 天：工作日多数满 8.5h、少数早退、周末休息、7 天前的那几天来自日志回填",
});
{
  const s = step("补 29 天事件后刷新", "表格按日期倒序；工作日「已达标/未达标」、周末标休息日、7 天前的一批来源显示「日志」");
  const events = [];
  const logs = [];
  for (let d = 1; d <= 29; d += 1) {
    const day = new Date();
    day.setDate(day.getDate() - d);
    const wd = day.getDay();
    if (wd === 0 || wd === 6) continue;
    const early = d % 6 === 0;
    const unlock = at(-d, 9, 5 + (d % 25));
    const lock = early ? at(-d, 15, 20) : at(-d, 18, 40);
    if (d > 7) {
      logs.push({ t: unlock, k: "unlock" }, { t: lock, k: "lock" });
    } else {
      events.push({ t: unlock, k: "unlock", src: "event" }, { t: lock, k: "lock", src: "event" });
    }
  }
  const sch = todaySchedule();
  const today = [
    { t: sch.u1, k: "unlock", src: "event" },
    { t: sch.l1, k: "lock", src: "event" },
    { t: sch.u2, k: "unlock", src: "event" },
    { t: sch.l2, k: "lock", src: "event" },
  ];
  seedEvents([...today, ...events]);
  seedLog(logs);
  await reload();
  await openWorkclock();
  const st = await api("/api/sys?section=workclock");
  const rows = await page.locator(".sys-wk-table tbody tr").allInnerTexts();
  const rest = rows.filter((t) => t.includes("休息日")).length;
  const logRows = rows.filter((t) => t.includes("日志")).length;
  ok(s, `days=${st.days.length} 行；表格 ${rows.length} 行；休息日 ${rest} 行；来源=日志 ${logRows} 行；覆盖 ${st.coverage.days} 天`);
  if (st.days.length < 20) fail(s, `30 天窗口只有 ${st.days.length} 天有数据`);
  if (logRows === 0) fail(s, "没有一行来自日志回填");
  // 表格很长，把面板���沿对到视窗顶下方 40px，保证第一行（今天）进画面
  await page.evaluate(() => {
    const p = document.querySelector(".sys-pane");
    const t = document.querySelector(".sys-wk-table");
    if (!p || !t) return;
    p.scrollTop += t.getBoundingClientRect().top - p.getBoundingClientRect().top - 40;
  });
  await page.waitForTimeout(200);
  await shot(s, ".sys-main", "table");
  await shot(s, ".sys-wk-table", "table-rows");
}

// ---------------------------------------------------------------- TC-08 公网只读
openCase({
  id: "TC-08",
  title: "公网只读：读得到、写不了",
  module: "上下班 / 接口",
  priority: "P0",
  precondition: "TC-07 的数据；用 cf-connecting-ip 头模拟隧道来源",
});
{
  let s = step("带隧道头读 /api/sys?section=workclock", "HTTP 200 且 public=true（页面会挂公网横幅）");
  const resp = await ctx.request.get(`${base}/api/sys?section=workclock`, { headers: { "cf-connecting-ip": "203.0.113.9" } });
  const body = await resp.json();
  ok(s, `HTTP ${resp.status()} public=${body.public} hours=${body.settings?.hours}`);
  s.evidence.push(`GET /api/sys?section=workclock (cf-connecting-ip) → ${resp.status()} ${JSON.stringify({ public: body.public, hours: body.settings?.hours })}`);
  if (resp.status() !== 200 || body.public !== true) fail(s, "公网读不应被拦");

  s = step("带隧道头依次 POST settings / agent / backfill", "三个写接口一律 403 public_workclock");
  const results = [];
  for (const [p, data] of [
    ["/api/sys/workclock/settings", { hours: 7 }],
    ["/api/sys/workclock/agent", { action: "install" }],
    ["/api/sys/workclock/backfill", undefined],
  ]) {
    const r = await ctx.request.post(`${base}${p}`, { headers: { "cf-connecting-ip": "203.0.113.9" }, data });
    const b = await r.json().catch(() => ({}));
    results.push(`${p} → ${r.status()} ${b.code ?? ""}`);
    if (r.status() !== 403) fail(s, `${p} 应 403，实际 ${r.status()}`);
  }
  ok(s, results.join("；"));
  s.evidence.push(...results);
  if ((await api("/api/sys?section=workclock")).settings.hours !== 8.5) fail(s, "公网的 7 小时竟然写进去了");
}

// ---------------------------------------------------------------- TC-09 卸下记录器
openCase({
  id: "TC-09",
  title: "卸下记录器：任务、进程、自启一起清掉",
  module: "上下班 / 记录器",
  priority: "P0",
  precondition: "TC-02 装着记录器",
});
{
  const s = step("点「卸下」", "卡片回到「未安装 / 未注册」；计划任务被删除；记录器进程退出");
  await openWorkclock();
  const before = (await page.locator(".sys-wk-agent").innerText()).replace(/\s+/g, " ").trim();
  await page.locator(".sys-wk-actions button", { hasText: "停止并移除" }).first().click();
  await page.locator(".sys-wk-agent").filter({ hasText: "未安装" }).first().waitFor({ timeout: 60_000 });
  const task = ps("if (Get-ScheduledTask -TaskName 'pi-web-client-workclock' -ErrorAction SilentlyContinue) { 'STILL-THERE' } else { 'GONE' }");
  const st = await api("/api/sys?section=workclock");
  ok(s, `操作前「${before.slice(0, 30)}…」；任务 ${task}；agent.installed=${st.agent.installed} running=${st.agent.running}`);
  s.evidence.push(`Get-ScheduledTask → ${task}`, `agent.installed → ${st.agent.installed}`);
  if (task !== "GONE") fail(s, "计划任务没删掉");
  if (st.agent.installed || st.agent.running) fail(s, "状态还说是装的");
  await shot(s, ".sys-wk-cols", "uninstalled");
}

// ---------------------------------------------------------------- TC-10 导入历史（人工）
openCase({
  id: "TC-10",
  title: "导入历史：一次 UAC 读 Security 4800/4801",
  module: "上下班 / 回填",
  priority: "P1",
  precondition: "本机非管理员；Security 日志里有最近的锁屏/解锁（4800/4801）",
  manual: true,
});
{
  let s = step("【人工】点「导入历史（需管理员）」并在 UAC 里点「是」", "页面出现「导入 N 条」提示；覆盖条数里的「日志回填」天数增加；老日期的来源变「日志」");
  await openWorkclock();
  ok(s, "脚本只记录操作前状态：UAC 是安全桌面，自动化点不了「是」。");
  s.verdict = "人工";
  h.cur.verdict = "人工";
  await shot(s, ".sys-wk-cols", "backfill-before");

  s = step("【人工】在 UAC 里点「否」再试一次", "页面提示被取消（uac_denied），设置与记录都不变");
  s.actual = "待人工执行后填写";
  s.verdict = "人工";
}

// ---------------------------------------------------------------- TC-11 窄屏
openCase({
  id: "TC-11",
  title: "窄屏布局：头/主体/页脚不穿模",
  module: "上下班 / 布局",
  priority: "P2",
  precondition: "TC-07 的数据",
});
{
  const s = step("依次把窗口缩到 1280×720、900×780、640×900 截图", "仪表盘与指标卡变单列；页脚始终在控制台圆角框内，主体自己滚动");
  await openWorkclock();
  const sizes = [
    [1280, 720, "1280"],
    [900, 780, "900"],
    [640, 900, "640"],
  ];
  for (const [w, h, tag] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    const bad = await page.evaluate(() => {
      const box = (sel) => {
        const e = document.querySelector(sel);
        if (!e || getComputedStyle(e).display === "none") return null;
        const b = e.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom };
      };
      const c = box(".sys-console");
      const foot = box(".sys-foot");
      const main = box(".sys-main");
      const inside = (x) => x && c && x.top >= c.top - 1 && x.bottom <= c.bottom + 1;
      return { ok: inside(foot) && inside(main) && main.bottom <= foot.top + 1, c, foot, main };
    });
    if (!bad.ok) fail(s, `${tag} 宽度下布局越界：${JSON.stringify(bad)}`);
    await shot(s, ".sys-console", `w${tag}`);
  }
  await page.setViewportSize({ width: 1440, height: 940 });
  ok(s, (await page.locator(".sys-wk-grid").count()) > 0 ? "三档宽度都截了，页脚均在框内" : "没渲染出来");
}

// ---------------------------------------------------------------- TC-12 英文界面
openCase({
  id: "TC-12",
  title: "界面语言切英文（文案全部走 i18n）",
  module: "上下班 / i18n",
  priority: "P2",
  precondition: "TC-07 的数据；默认中文界面",
});
{
  let s = step("设置 → 外观 → 语言选 English，再打开上下班", "分区名变 Work clock；仪表盘/指标卡/按钮/表格表头全英文，没有残留中文");
  await closeSheets();
  await page.locator('[data-act="look"]').first().click();
  await page.locator('.set-tabs .chip[data-tab="look"]').click();
  await page.locator('.set-page[data-page="look"] .chips .chip[lang="en"]').first().click();
  await page.waitForTimeout(1500);
  await openWorkclock();
  const nav = (await page.locator(".sys-nav__item").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  const text = await page.locator(".sys-pane").innerText();
  const leftover = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  ok(s, `分区：${nav.join(" | ")}；中文残留 ${leftover.length} 处${leftover.length ? `：${[...new Set(leftover)].slice(0, 6).join("、")}` : ""}`);
  if (!nav.some((t) => /Work clock/i.test(t))) fail(s, "分区名没变英文");
  if (leftover.length > 0) fail(s, `英文界面残留中文：${[...new Set(leftover)].slice(0, 8).join("、")}`);
  await shot(s, ".sys-console", "english");

  s = step("切回简体中文", "分区名恢复「上下班」");
  await closeSheets();
  await page.locator('[data-act="look"]').first().click();
  await page.locator('.set-tabs .chip[data-tab="look"]').click();
  await page.locator('.set-page[data-page="look"] .chips .chip[lang="zh-Hans"]').first().click();
  await page.waitForTimeout(1500);
  await openWorkclock();
  const back = (await page.locator(".sys-nav__item").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  ok(s, `分区：${back.join(" | ")}`);
  if (!back.some((t) => t.includes("上下班"))) fail(s, "没切回中文");
}

  h.sortCases(meta.order);
}
