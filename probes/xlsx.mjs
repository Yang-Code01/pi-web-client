/**
 * Probe #105：打开 .xlsx → 表格浮窗里的格子 → 拖动 / 缩放 → 关闭 → 重开几何还在。
 *
 * 唯一那条缝（CONTEXT.md）：真 Chromium + 隔离真桥。只断言用户能看见的东西：
 * 格子里的字、窗口的框、请求里的行区间、localStorage。不 import 前端内部模块。
 *
 * 自带桥（7867 + 临时 state / agent / 工作目录），不碰 7864 的正式实例。
 * Run: npm run build:web && npm run build:bridge && node probes/xlsx.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const modp = (p) => pathToFileURL(p).href;

const PORT = Number(process.env.PI_WEB_PORT ?? 7867);
const ROOT = path.join(REPO, ".scratch/xlsx-probe");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const OUT = path.join(REPO, "probes/out/xlsx");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "zz-xlsx-105";

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK, OUT]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假会话：只为了让首页有一张卡、文件管理器从 WORK 起步。不跑模型。
const dir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(dir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "xlsx 骨架验证" }] } },
  { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name: "xlsx 骨架" },
];
fs.writeFileSync(path.join(dir, `${SID}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

const { makeFixtures } = await import(modp(path.join(REPO, "bridge/tests/fixtures/make-xlsx.mjs")));
const made = makeFixtures(WORK);
log("fixture:", made.plain);

function killPort(port) {
  try {
    const pids = new Set();
    const out = execSync("netstat -ano", { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+(\S+)\s+\S+\s+(\d+)$/);
      if (m && Number(m[1]) === port && /:0$/.test(m[2])) pids.add(Number(m[3]));
    }
    for (const pid of pids) {
      try {
        // /T：桥会给每个会话拉 `pi --mode rpc` 子进程，子进程会继承监听 socket，只杀父进程端口仍被占。
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      } catch {}
    }
    if (pids.size) log(`cleared stale bridge on :${port}`);
    // 杀完等端口真的释放：不等的话紧接着 spawn 会 EADDRINUSE，登录落到上一轮的桥上就成假失败。
    for (let i = 0; i < 20; i++) {
      if (!listening(port)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    return pids.size;
  } catch {
    return 0;
  }
}

function listening(port) {
  const out = execSync("netstat -ano", { encoding: "utf8" });
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+(\S+)\s+\S+\s+(\d+)$/);
    if (m && Number(m[1]) === port && /:0$/.test(m[2])) return true;
  }
  return false;
}
killPort(PORT);

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT },
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
    } catch {}
    await sleep(150);
  }
  console.error(bridgeOut.join("").slice(-3000));
  throw new Error(`timeout waiting for ${label}`);
}

let browser = null;
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 15000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => {
    pageErrors.push(e.message);
    log("page error:", e.message);
  });
  const windowRequests = [];
  page.on("request", (r) => {
    if (!r.url().includes("/api/sheet/window")) return;
    try {
      windowRequests.push(JSON.parse(r.postData() ?? "{}"));
    } catch {
      windowRequests.push({ bad: r.postData() });
    }
  });

  const openSession = async () => {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await until(async () => (await page.locator(".session-card").count()) >= 1, 15000, "session card");
    await page.locator(".session-card").first().click();
    await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().waitFor({ timeout: 15000 });
  };

  const openSheet = async (name = "plain.xlsx") => {
    await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().evaluate((el) => el.click());
    const row = page.locator(".file-row", { hasText: name }).first();
    await row.waitFor({ timeout: 20000 });
    await row.evaluate((el) => el.click());
    await page.locator(".sd").first().waitFor({ timeout: 20000 });
    await page.locator(".sd-cell").first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(250);
  };

  const box = () =>
    page.evaluate(() => {
      const el = document.querySelector(".sd");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) };
    });
  const geom = () => page.evaluate(() => JSON.parse(localStorage.getItem("pi.sheetGeom") ?? "null"));
  const cellText = (r, c) =>
    page.evaluate(
      ([rr, cc]) => document.querySelector(`.sd-cell[data-r="${rr}"][data-c="${cc}"]`)?.textContent ?? null,
      [r, c],
    );

  await openSession();
  await openSheet();

  // ---------------------------------------------------------------- 壳与只读
  const title = await page.locator(".sd-name").first().textContent();
  const subtitle = await page.locator(".sd-path").first().textContent();
  check("标题是文件名", title?.trim() === "plain.xlsx", String(title));
  check("副标题是路径", (subtitle ?? "").includes(WORK.replace(/\//g, "\\")) || (subtitle ?? "").includes(WORK), String(subtitle));
  check("没有遮罩", (await page.locator(".sd-back, .sheet-back").count()) === 0);
  check("不是 viewer 面板", (await page.locator(".viewer").count()) === 0);
  check("不抢焦点", await page.evaluate(() => !document.querySelector(".sd")?.contains(document.activeElement)));

  const readonly = await page.evaluate(() => {
    const root = document.querySelector(".sd");
    const cell = document.querySelector(".sd-cell");
    if (!root || !cell) return null;
    const cs = getComputedStyle(cell);
    return {
      fields: root.querySelectorAll("input, textarea, select, [contenteditable='true']").length,
      cursor: cs.cursor,
      select: cs.userSelect,
      editable: cell.isContentEditable,
    };
  });
  check("格子里没有输入控件", readonly?.fields === 0, JSON.stringify(readonly));
  check("格子上不是文本光标", readonly?.cursor === "default", readonly?.cursor);
  check("格子不可选中/不可编辑", readonly?.select === "none" && readonly?.editable === false, JSON.stringify(readonly));

  // ---------------------------------------------------------------- 表头与值
  const colA = await page.locator('.sd-colhead-in [data-c="0"]').first().textContent();
  const colC = await page.locator('.sd-colhead-in [data-c="2"]').first().textContent();
  const rowNo = await page.locator('.sd-rowhead-in [data-r="0"]').first().textContent();
  check("列头 A / C 都在", colA?.trim() === "A" && colC?.trim() === "C", `${colA}/${colC}`);
  check("行号从 1 开始", rowNo?.trim() === "1", String(rowNo));
  check("表头文字", (await cellText(0, 1)) === "产品", String(await cellText(0, 1)));
  check("文本原样", (await cellText(1, 0)) === "华东", String(await cellText(1, 0)));
  check("小数不丢", (await cellText(1, 2)) === "12.5", String(await cellText(1, 2)));
  check("多位小数原样", (await cellText(2, 2)) === "3.14159", String(await cellText(2, 2)));
  check("整数原样", (await cellText(3, 2)) === "45292", String(await cellText(3, 2)));
  check("数字没变成日期", !/\d{4}[-/年]\d{1,2}/.test((await cellText(3, 2)) ?? ""), String(await cellText(3, 2)));
  check("前导零仍是文本", (await cellText(1, 6)) === "001", String(await cellText(1, 6)));
  check("XML 实体已还原", (await cellText(3, 5)) === "华东 & 华南 <测试>", String(await cellText(3, 5)));
  check("内联字符串", (await cellText(5, 5)) === "内联字符串", String(await cellText(5, 5)));
  check("布尔值", (await cellText(4, 7)) === "TRUE", String(await cellText(4, 7)));
  check("错误值原样", (await cellText(2, 7)) === "#DIV/0!", String(await cellText(2, 7)));

  await page.screenshot({ path: path.join(OUT, "01-open.png") });

  // ---------------------------------------------------------------- 按可见范围取数
  await page.evaluate(() => {
    const view = document.querySelector(".sd-view");
    if (view) {
      view.scrollTop = 60 * 28;
      view.dispatchEvent(new Event("scroll"));
    }
  });
  await until(async () => (await cellText(60, 0)) !== null, 5000, "第 61 行");
  const later = await cellText(60, 0);
  check("滚动后显示别的行", later !== null && later !== "华东", String(later));
  await page.screenshot({ path: path.join(OUT, "02-scrolled.png") });

  check("每次窗口请求都带行区间", windowRequests.length > 0 && windowRequests.every((b) => Number.isFinite(b.r0) && Number.isFinite(b.r1)), JSON.stringify(windowRequests.slice(-3)));
  check("请求不是整表", windowRequests.every((b) => b.r1 - b.r0 <= 60), JSON.stringify(windowRequests.map((b) => [b.r0, b.r1])));
  check("请求没有整表字段", windowRequests.every((b) => !("all" in b) && !("rows" in b)));

  // 回到顶部，后面量几何。
  await page.evaluate(() => {
    const view = document.querySelector(".sd-view");
    if (view) {
      view.scrollTop = 0;
      view.dispatchEvent(new Event("scroll"));
    }
  });
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------- 默认几何
  const vw = 1440;
  const vh = 900;
  const def = await box();
  check("默认宽度受视口约束", def.w === Math.min(1180, vw - 48), String(def.w));
  check("默认高度受视口约束", def.h === Math.min(780, vh - 48), String(def.h));
  check("默认居中", Math.abs(def.l - (vw - def.w) / 2) <= 2, JSON.stringify(def));

  const drag = async (sel, dx, dy, yOff = 0) => {
    const r = await page.locator(sel).first().boundingBox();
    if (!r) throw new Error(`no box for ${sel}`);
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2 + yOff;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  };

  // ---------------------------------------------------------------- 拖标题栏
  const b0 = await box();
  await drag(".sd-head", -120, 60);
  const b1 = await box();
  check("拖标题栏移动", Math.abs(b1.l - (b0.l - 120)) <= 2 && Math.abs(b1.t - (b0.t + 60)) <= 2, `${JSON.stringify(b0)} → ${JSON.stringify(b1)}`);
  check("移动后尺寸不变", b1.w === b0.w && b1.h === b0.h);
  check("几何写进 localStorage", (await geom()) !== null, JSON.stringify(await geom()));

  // ---------------------------------------------------------------- 右下角改宽高
  await drag(".sd-resize", -120, -80);
  const b2 = await box();
  check("右下角同时改宽高", b2.w === b1.w - 120 && b2.h === b1.h - 80, `${JSON.stringify(b1)} → ${JSON.stringify(b2)}`);

  // ---------------------------------------------------------------- 顶边只改高
  const b3 = await box();
  await drag(".sd-grip", 0, -60, 1);
  const b4 = await box();
  check("顶边只改高", b4.h === b3.h + 60 && b4.w === b3.w, `${JSON.stringify(b3)} → ${JSON.stringify(b4)}`);
  check("顶边拖动时底边不动", Math.abs(b4.b - b3.b) <= 2 && b4.t < b3.t, `${b3.b}/${b4.b}`);

  // ---------------------------------------------------------------- 拖出视口 clamp
  await drag(".sd-head", -4000, -4000);
  const b5 = await box();
  check("左上拖出被 clamp", b5.l >= 0 && b5.t >= 0, JSON.stringify(b5));
  await drag(".sd-resize", 4000, 4000);
  const b6 = await box();
  check("右下拖出被 clamp", b6.r <= vw + 1 && b6.b <= vh + 1, JSON.stringify(b6));
  await page.screenshot({ path: path.join(OUT, "03-dragged.png") });

  // ---------------------------------------------------------------- 双击复原
  await page.locator(".sd-head").first().dblclick();
  await page.waitForTimeout(200);
  const b7 = await box();
  check("双击标题栏复原默认大小", b7.w === def.w && b7.h === def.h, JSON.stringify(b7));
  check("双击后位置也回默认", Math.abs(b7.l - def.l) <= 2 && Math.abs(b7.t - def.t) <= 2, JSON.stringify(b7));

  // ---------------------------------------------------------------- 关掉重开 / 刷新
  await drag(".sd-head", 90, 40);
  await drag(".sd-resize", -100, -50);
  const kept = await box();
  const stored = await geom();
  check("关闭前几何已存", stored && stored.w === kept.w && stored.h === kept.h, JSON.stringify(stored));

  await page.locator(".sd-close").first().click();
  await until(async () => (await page.locator(".sd").count()) === 0, 5000, "dialog closed");
  check("关闭后浮窗消失", (await page.locator(".sd").count()) === 0);

  await openSheet();
  const b8 = await box();
  check("重开后位置还在", Math.abs(b8.l - kept.l) <= 2 && Math.abs(b8.t - kept.t) <= 2, `${JSON.stringify(kept)} → ${JSON.stringify(b8)}`);
  check("重开后大小还在", b8.w === kept.w && b8.h === kept.h, `${kept.w}x${kept.h} → ${b8.w}x${b8.h}`);
  await page.screenshot({ path: path.join(OUT, "04-reopened.png") });

  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 15000, "session card after reload");
  await page.locator(".session-card").first().click();
  await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().waitFor({ timeout: 15000 });
  await openSheet();
  const b9 = await box();
  check("刷新后位置还在", Math.abs(b9.l - kept.l) <= 2 && Math.abs(b9.t - kept.t) <= 2, `${JSON.stringify(kept)} → ${JSON.stringify(b9)}`);
  check("刷新后大小还在", b9.w === kept.w && b9.h === kept.h, `${kept.w}x${kept.h} → ${b9.w}x${b9.h}`);

  // ---------------------------------------------------------------- CSV / TSV（#113）
  // 先把 xlsx 那扇关掉：文件管理器是在 viewer 里，浮窗留着会与下面的断言撞车。
  const closeSheet = async () => {
    const close = page.locator(".sd-close").first();
    if (await close.count()) await close.click();
    await until(async () => (await page.locator(".sd").count()) === 0, 5000, "sd closed");
  };
  await closeSheet();
  // 浮窗几何已被上面改过，先清掉记忆回到默认尺寸。
  await page.evaluate(() => localStorage.removeItem("pi.sheetGeom"));
  const tab = (name) => page.locator(`.sd-tab[data-tab="${name}"]`).first();
  const srcText = async () => page.locator(".sd-src").first().inputValue();

  await openSheet("utf8.csv");
  check("CSV 开在表格浮窗里", (await page.locator(".sd").count()) === 1);
  check("CSV 有表格 / 源码两个标签页", (await page.locator(".sd-tab").count()) === 2, String(await page.locator(".sd-tab").count()));
  check("CSV 中文表头", (await cellText(0, 0)) === "地区", String(await cellText(0, 0)));
  check("CSV 列数正确", (await page.locator(".sd-col").count()) === 4, String(await page.locator(".sd-col").count()));
  check("CSV 引号里的分号不断列", (await cellText(1, 1)) === "螺丝;M4", String(await cellText(1, 1)));
  check("CSV 转义引号已还原", (await cellText(2, 3)) === '他说 "好"', String(await cellText(2, 3)));
  await page.screenshot({ path: path.join(OUT, "05-csv-grid.png") });

  await tab("source").click();
  const u8src = await srcText();
  check("源码是解码后的原文", u8src.includes('地区;产品;单价;备注') && u8src.includes('华东;"螺丝;M4";12.5'), u8src.slice(0, 60));
  await page.screenshot({ path: path.join(OUT, "06-csv-source.png") });
  await tab("grid").click();
  check("切回表格仍有格子", (await cellText(0, 0)) === "地区");
  await closeSheet();

  await openSheet("bom.csv");
  const bomCell = await cellText(0, 0);
  const bomAll = await page.locator(".sd-cells").textContent();
  check("BOM 不残留在第一格", bomCell === "地区", JSON.stringify(bomCell));
  check("BOM 不残留在整片格子", !(bomAll ?? "").includes("\ufeff"));
  await tab("source").click();
  const bomSrc = await srcText();
  check("BOM 源码开头没有 BOM 字符", !bomSrc.startsWith("\ufeff") && bomSrc.startsWith("地区,产品"), JSON.stringify(bomSrc.slice(0, 12)));
  await closeSheet();

  await openSheet("gbk.csv");
  check("GBK 中文正确", (await cellText(1, 0)) === "华东" && (await cellText(1, 1)) === "螺丝", `${await cellText(1, 0)}/${await cellText(1, 1)}`);
  await tab("source").click();
  const gbkSrc = await srcText();
  check("GBK 源码已解码", gbkSrc.includes("华东;螺丝;12.5;中文备注"), gbkSrc.slice(0, 40));
  await page.locator(".sd-src").first().fill(gbkSrc.replace("螺丝;12.5", "螺丝钉;12.5"));
  await page.locator(".sd-save").first().click();
  await until(async () => ((await page.locator(".sd-save-msg").first().textContent()) ?? "").includes("已保存"), 8000, "csv saved");
  const gbkAfter = fs.readFileSync(made.csv.gbk);
  const gbkText = new TextDecoder("gbk").decode(gbkAfter);
  check("GBK 保存后内容已写入", gbkText.includes("华东;螺丝钉;12.5;中文备注"), gbkText.split("\r\n")[1]);
  check("GBK 保存后仍是 GBK", (() => {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(gbkAfter);
      return false;
    } catch {
      return true;
    }
  })(), `${gbkAfter.length} bytes`);
  check("GBK 保存后分隔符不变", gbkText.split(";").length === 13 && !gbkText.includes("\t"), `${gbkText.split(";").length} 段`);
  await closeSheet();

  await openSheet("big.csv");
  const foot = (await page.locator(".sd-foot").first().textContent()) ?? "";
  check("超 5 万行截断并有提示", /只显示前/.test(foot), foot);
  check("截断后仍能看格子", (await cellText(0, 0)) === "行号", String(await cellText(0, 0)));
  check("截断的文件不提供保存", (await page.locator(".sd-save").count()) === 0);
  await page.screenshot({ path: path.join(OUT, "07-csv-truncated.png") });
  await closeSheet();

  check("没有页面异常", pageErrors.length === 0, pageErrors.join(" | "));
  log(`窗口请求 ${windowRequests.length} 次，示例 ${JSON.stringify(windowRequests.slice(0, 3))}`);
} catch (err) {
  failures++;
  console.error("FAIL 异常:", err?.stack ?? err);
  console.error(bridgeOut.join("").slice(-3000));
} finally {
  if (browser) await browser.close();
  bridge.kill();
  try {
    execSync(`taskkill /PID ${bridge.pid} /T /F`, { stdio: "ignore" });
  } catch {}
}

console.log(failures ? `${failures} 项失败` : "全部通过");
process.exit(failures ? 1 : 0);
