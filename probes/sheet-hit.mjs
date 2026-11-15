/**
 * Probe：表格编辑的坐标命中（D269）。
 *
 * 用户报障：字号放大后，鼠标点中的格子和实际选中的格子有偏差。这里用真 Chromium + 隔离真桥，
 * 在 125% 界面缩放下点四角的格子、拖列宽/行高、点冻结窗格、点合并标题，并验证 Alt+Enter。
 *
 * Run: npm run build && node probes/sheet-hit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const modp = (p) => pathToFileURL(p).href;
const PORT = Number(process.env.PI_WEB_PORT ?? 7879);
const ROOT = path.join(REPO, ".scratch/sheet-hit-probe");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "zz-sheet-hit";
const SCALE = Number(process.env.PI_TEST_SCALE ?? 1.25);

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK]) fs.mkdirSync(d, { recursive: true });
const { makeFixtures } = await import(modp(path.join(REPO, "bridge/tests/fixtures/make-xlsx.mjs")));
makeFixtures(WORK);

const sessionDir = path.join(SESSIONS, `--${SID}--`);
fs.mkdirSync(sessionDir, { recursive: true });
const at = new Date().toISOString();
const sessionRows = [
  { type: "session", version: 3, id: SID, timestamp: at, cwd: WORK },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "sheet hit probe" }] } },
  { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name: "sheet hit probe" },
];
fs.writeFileSync(path.join(sessionDir, `${SID}.jsonl`), `${sessionRows.map((r) => JSON.stringify(r)).join("\n")}\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(120);
  }
  throw new Error(`timeout waiting for ${label}`);
}

let browser = null;
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(String(b)));
bridge.stderr.on("data", (b) => bridgeOut.push(String(b)));

try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 15000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge");
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
  page.on("pageerror", (e) => console.log("pageerror", e.message));

  const openSession = async () => {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await until(async () => (await page.locator(".session-card").count()) >= 1, 15000, "session card");
    await page.locator(".session-card").first().click();
    await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().waitFor({ timeout: 15000 });
  };
  const openSheet = async (name) => {
    await page.locator(".topbar .icon-btn", { hasText: "文件管理器" }).first().evaluate((el) => el.click());
    const row = page.locator(".file-row", { hasText: name }).first();
    await row.waitFor({ timeout: 20000 });
    await row.evaluate((el) => el.click());
    await page.locator(".sd-cell").first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(300);
  };
  const closeSheet = async () => {
    await page.locator(".sd-close").first().click();
    await until(async () => (await page.locator(".sd").count()) === 0, 5000, "dialog closed");
  };
  const ref = () => page.locator(".sd-fx-ref").inputValue();
  const clickCell = async (r, c, expected, detail = "") => {
    const cell = page.locator(`.sd-cell[data-r="${r}"][data-c="${c}"]`).first();
    const box = await cell.boundingBox();
    if (!box) {
      check(`点 ${expected ?? `${r}:${c}`}`, false, `cell not rendered${detail ? ` (${detail})` : ""}`);
      return;
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(80);
    const got = await ref();
    check(`点 ${expected ?? `${r}:${c}`} 选中 ${expected ?? `${r}:${c}`}`, got === (expected ?? ""), `got ${got}`);
  };

  await openSession();
  await page.evaluate((scale) => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") || "{}");
    localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, scale }));
  }, SCALE);
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 15000, "session card after reload");
  const scale = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1);
  check(`界面字号 ${Math.round(SCALE * 100)}%`, Math.abs(scale - SCALE) < 0.001, String(scale));

  // 1) 125% 下点四个位置的格子：修前 B10→B12、E2→F2、E10→F12。
  await openSheet("plain.xlsx");
  await clickCell(1, 1, "B2");
  await clickCell(9, 1, "B10");
  await clickCell(1, 4, "E2");
  await clickCell(9, 4, "E10");

  // 2) Alt+Enter 留在编辑框里换行。
  await page.locator(".sd-editbtn").click();
  await page.locator('.sd-cell[data-r="1"][data-c="0"]').first().dblclick();
  await page.locator("textarea.sd-edit").waitFor({ timeout: 3000 });
  await page.keyboard.type("a");
  await page.keyboard.press("Alt+Enter");
  await page.waitForTimeout(80);
  const alt = await page.evaluate(() => {
    const ed = document.querySelector("textarea.sd-edit");
    return { open: !!ed, value: ed?.value ?? null };
  });
  check("Alt+Enter 在编辑框里换行", alt.open && alt.value?.endsWith("\n"), JSON.stringify(alt));
  await page.keyboard.press("Escape");

  // 3) 表格 200% + 界面 125%：拖 25px 就只变 25px。
  await page.locator(".sd-zoom-pct[data-k='z100']").click();
  for (let i = 0; i < 10; i++) await page.locator(".sd-zbtn[data-k='zin']").click();
  await page.waitForTimeout(300);
  check("表格缩放到 200%", (await page.locator(".sd-zoom-pct").textContent())?.trim() === "200%", String(await page.locator(".sd-zoom-pct").textContent()));
  const rowCell = page.locator('.sd-cell[data-r="6"][data-c="0"]').first();
  const rowBefore = (await rowCell.boundingBox())?.height ?? 0;
  const rowGrip = await page.locator('.sd-grip-h[data-r="6"]').boundingBox();
  if (rowGrip) {
    const x = rowGrip.x + rowGrip.width / 2;
    const y = rowGrip.y + rowGrip.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 25, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }
  const rowAfter = (await rowCell.boundingBox())?.height ?? 0;
  check("拖行高 25px 只长 25px", Math.abs(rowAfter - rowBefore - 25) <= 2, `${rowBefore} → ${rowAfter}`);
  const colCell = page.locator('.sd-cell[data-r="6"][data-c="0"]').first();
  const colBefore = (await colCell.boundingBox())?.width ?? 0;
  const colGrip = await page.locator('.sd-grip-v[data-c="0"]').boundingBox();
  if (colGrip) {
    const x = colGrip.x + colGrip.width / 2;
    const y = colGrip.y + colGrip.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 25, y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }
  const colAfter = (await colCell.boundingBox())?.width ?? 0;
  check("拖列宽 25px 只宽 25px", Math.abs(colAfter - colBefore - 25) <= 2, `${colBefore} → ${colAfter}`);
  await closeSheet();

  // 3b) 换行行高：表格 200% 时只按字体大小长一倍，不能把 zoom 再乘一遍。
  await openSheet("styled.xlsx");
  const wrapBefore = (await page.locator('.sd-cell[data-r="4"][data-c="6"]').first().boundingBox())?.height ?? 0;
  await page.locator(".sd-zoom-pct[data-k='z100']").click();
  for (let i = 0; i < 10; i++) await page.locator(".sd-zbtn[data-k='zin']").click();
  await page.waitForTimeout(400);
  const wrapAfter = (await page.locator('.sd-cell[data-r="4"][data-c="6"]').first().boundingBox())?.height ?? 0;
  check("换行行高在表格 200% 只按比例长", wrapBefore > 0 && wrapAfter / wrapBefore > 1.7 && wrapAfter / wrapBefore < 2.4, `${wrapBefore} → ${wrapAfter} (${(wrapAfter / wrapBefore).toFixed(2)}×)`);
  await closeSheet();

  // 4) 冻结窗格：滚动后分别点冻结行/冻结列/主区。
  await openSheet("report.xlsx");
  await page.evaluate(() => {
    const v = document.querySelector(".sd-view");
    v.scrollTop = 200;
    v.scrollLeft = 100;
  });
  await page.waitForTimeout(300);
  const clickFrozen = async (r, c, expected) => {
    const box = await page.evaluate(([rr, cc]) => {
      const view = document.querySelector(".sd-view");
      const vr = view.getBoundingClientRect();
      for (const n of document.querySelectorAll(`.sd-cell[data-r="${rr}"][data-c="${cc}"]`)) {
        const b = n.getBoundingClientRect();
        const x = b.left + b.width / 2;
        const y = b.top + b.height / 2;
        if (x > vr.left && x < vr.right && y > vr.top && y < vr.bottom) return { x, y };
      }
      return null;
    }, [r, c]);
    if (!box) {
      check(`冻结表点 ${expected}`, false, "not visible");
      return;
    }
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(80);
    const got = await ref();
    check(`冻结表点 ${expected} 选中 ${expected}`, got === expected, `got ${got}`);
  };
  await clickFrozen(0, 0, "A1");
  await clickFrozen(20, 0, "A21");
  await clickFrozen(20, 10, "K21");
  // 冻结列里按住拖选：pointer 监听挂 root 后，拖动也要一路跟到主区。
  const a21 = await page.locator('.sd-cell[data-r="20"][data-c="0"]').first().boundingBox();
  const a25 = await page.locator('.sd-cell[data-r="24"][data-c="0"]').first().boundingBox();
  if (a21 && a25) {
    await page.mouse.move(a21.x + a21.width / 2, a21.y + a21.height / 2);
    await page.mouse.down();
    await page.mouse.move(a25.x + a25.width / 2, a25.y + a25.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const got = await ref();
    check("冻结列拖选 A21:A25", got === "A21:A25", `got ${got}`);
  }


  // 5) 列宽按表分账：报表改宽后切到明细，明细的 A 列宽度不变；切回来报表还宽着。
  const detailWidth = async () =>
    (await page.locator('.sd-cell[data-r="1"][data-c="0"]').first().boundingBox())?.width ?? 0;
  const reportWidth = async () =>
    (await page.locator('.sd-cell[data-r="5"][data-c="0"]').first().boundingBox())?.width ?? 0;
  await page.locator(".sd-wstab", { hasText: "明细" }).first().click();
  await page.waitForTimeout(250);
  const detailBase = await detailWidth();
  await page.locator(".sd-wstab", { hasText: "报表" }).first().click();
  await page.waitForTimeout(250);
  await page.locator(".sd-editbtn").click();
  const reportBase = await reportWidth();
  const gripA = await page.locator('.sd-grip-v[data-c="0"]').boundingBox();
  if (gripA) {
    const x = gripA.x + gripA.width / 2;
    const y = gripA.y + gripA.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 25, y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(600);
  }
  const reportAfter = await reportWidth();
  check("报表 A 列真的加宽了", reportAfter > reportBase + 20, `${reportBase} → ${reportAfter}`);
  await page.locator(".sd-wstab", { hasText: "明细" }).first().click();
  await page.waitForTimeout(250);
  check("切到明细不继承报表列宽", Math.abs((await detailWidth()) - detailBase) <= 2, `base ${detailBase}`);
  await page.locator(".sd-wstab", { hasText: "报表" }).first().click();
  await page.waitForTimeout(250);
  check("切回报表列宽还在", Math.abs((await reportWidth()) - reportAfter) <= 2, `${reportAfter}`);

  // 6) 有未保存改动时切表被拦住（不能把这张表的 r:c 账写进下一张）。
  await page.locator('.sd-cell[data-r="1"][data-c="0"]').first().dblclick();
  await page.locator("textarea.sd-edit").waitFor({ timeout: 3000 });
  await page.keyboard.press("Control+a");
  await page.keyboard.type("dirty");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  await page.locator(".sd-wstab", { hasText: "明细" }).first().click();
  await page.waitForTimeout(200);
  const activeTab = (await page.locator('.sd-wstab[aria-selected="true"]').textContent())?.trim();
  const status = (await page.locator(".sd-status").textContent()) ?? "";
  check("有未保存改动时切表被拦住", activeTab === "报表" && status.includes("先保存改动"), `${activeTab} / ${status}`);
} catch (err) {
  failures++;
  console.error("ERROR", err);
  console.error(bridgeOut.join("").slice(-4000));
} finally {
  if (browser) await browser.close().catch(() => {});
  bridge.kill("SIGTERM");
}

console.log(failures ? `\n${failures} FAIL` : "\nall ok");
process.exit(failures ? 1 : 0);
