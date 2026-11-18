/**
 * Probe #499: the new-session sheet (D-workspaces layout), its paged list, and the sort controls
 * in the two file entries.
 *
 * Runs a throwaway bridge on its own port with a temp agent dir + temp work dir, so it never
 * touches the real ~/.pi/agent sessions or the real project files.
 *
 * Run: npm --prefix bridge run build && node probes/new-session-sheet.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const PORT = Number(process.env.PI_WEB_PORT ?? 18888);
const ROOT = path.join(REPO, ".scratch/new-session-sheet");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const OTHER = path.join(ROOT, "other");
// 建工作区时会先问 git 工程根：仓库里的目录一律并回「pi-web-client」那一组，
// 所以「真能新建一个」这条要有仓库外的目录才试得出来。
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "ns-sheet-out-"));
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK, OTHER, OUT]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A big directory: 1500 files + 30 folders, plus one nested file for the recursive search.
for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(WORK, `file-${String(i).padStart(4, "0")}.txt`), "x".repeat(64 + i), "utf8");
for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(WORK, `dir-${String(i).padStart(2, "0")}`), { recursive: true });
fs.mkdirSync(path.join(WORK, "docs/a/b"), { recursive: true });
fs.writeFileSync(path.join(WORK, "docs/a/b/设计说明.md"), "# 设计\n", "utf8");
fs.mkdirSync(path.join(WORK, "node_modules"), { recursive: true });
fs.writeFileSync(path.join(WORK, "node_modules/junk.md"), "# junk\n", "utf8");
fs.writeFileSync(path.join(OTHER, "readme.md"), "# other\n", "utf8");

/** One session per directory, so the sheet's left column has two workspaces and one 最近 row. */
function seedSession(sid, cwd, name) {
  const dir = path.join(SESSIONS, `--${sid}--`);
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const rows = [
    { type: "session", version: 3, id: sid, timestamp: at, cwd },
    { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: name }] } },
    { type: "session_info", id: "n1", parentId: "m1", timestamp: at, name },
  ];
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
seedSession("zz-sheet-work", WORK, "主会话");
seedSession("zz-sheet-other", OTHER, "别的目录");

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
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      } catch {}
    }
    if (pids.size) log(`cleared stale bridge on :${port}`);
  } catch {}
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
  assert(false, `timeout waiting for ${label}`);
}

/** "1.2 KB" → bytes, so a sorted column can be checked without trusting the label. */
function kb(text) {
  const m = String(text).trim().match(/^([\d.]+)\s*(B|KB|MB|GB)?$/i);
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  const unit = (m[2] ?? "B").toUpperCase();
  return n * ({ B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit] ?? 1);
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });

  await until(async () => (await page.locator(".session-card").count()) >= 2, 15000, "two cards");
  await page.locator(".session-card", { hasText: "主会话" }).first().click();
  await page.locator(".topbar").waitFor({ timeout: 10000 });

  // ---- 1. ＋ 开新会话：新的布局（左工作区 / 右浏览 / 底下名字与按钮）
  await page.locator(".btn.primary", { hasText: "开新会话" }).first().click();
  await page.locator(".new-sheet").waitFor({ timeout: 10000 });
  const namePlaceholder = await page.locator(".new-sheet .ns-name").getAttribute("placeholder");
  assert(namePlaceholder === "新会话", `name placeholder is 新会话 (got ${namePlaceholder})`);
  const sideRows = await page.$$eval(".new-sheet .ws-new-pick .m-name", (els) => els.map((e) => e.textContent ?? ""));
  assert(sideRows.length >= 2, `left column lists workspaces (got ${sideRows.join(",")})`);
  await page.locator(".new-sheet .dir-path .crumb").first().waitFor({ timeout: 8000 });
  const crumbs = await page.locator(".new-sheet .dir-path").textContent();
  assert(crumbs.includes("work"), `right column is inside the session cwd (got ${crumbs})`);
  // 只挑目录的入口（files=0）：文件连总数都不算，所以这里不多不少就是 30 个 dir-NN + docs + node_modules。
  await until(async () => (await page.locator(".new-sheet .dir-row").count()) >= 30, 15000, "first page");
  const firstPage = await page.locator(".new-sheet .dir-row").count();
  assert(firstPage === 33, `dir-only list = 32 dirs + 上一级 (got ${firstPage})`);
  assert((await page.locator(".new-sheet .file-row").count()) === 0, "a dir-only entry lists no files");
  const foot = await page.locator(".new-sheet .dir-pagecount").textContent();
  const counts = (foot ?? "").match(/已加载 (\d+) \/ (\d+)/);
  assert(counts && counts[1] === "32" && counts[2] === "32", `page foot counts the dirs only (got ${foot})`);
  await page.screenshot({ path: path.join(OUT, "1-sheet.png"), animations: "disabled" });
  log("1 layout ok:", sideRows.join(","), "/", foot);

  // ---- 2. 筛选：只留匹配的，焦点还在框里，弹层高度不动
  const sheetH = (await page.locator(".new-sheet").boundingBox())?.height ?? 0;
  await page.locator(".new-sheet .dir-filter").click();
  await page.locator(".new-sheet .dir-filter").fill("dir-0");
  // dir-00 … dir-09 十个 + 顶上那条固定的「↑ 上一级」
  await until(async () => (await page.locator(".new-sheet .dir-row").count()) === 11, 8000, "filtered");
  const filtered = (await page.$$eval(".new-sheet .dir-row", (els) => els.map((e) => e.textContent ?? ""))).filter((t) => !t.includes("上一级"));
  assert(filtered.length === 10, `"dir-0" matches ten folders (got ${filtered.length})`);
  assert(filtered.every((t) => t.replace("📁 ", "").startsWith("dir-0")), "every row matches the filter");
  const focusOk = await page.evaluate(() => document.activeElement?.classList.contains("dir-filter") ?? false);
  assert(focusOk, "the filter box keeps focus after typing");
  const sheetH2 = (await page.locator(".new-sheet").boundingBox())?.height ?? 0;
  assert(Math.abs(sheetH2 - sheetH) < 2, `sheet height stays put (${sheetH} → ${sheetH2})`);
  log("2 filter ok:", filtered.length);

  // ---- 3. 递归只对列文件的入口有意义：新会话弹层里那颗复选框不出现
  assert(!(await page.locator(".new-sheet .dir-sub").isVisible()), "a dir-only entry hides 包含子目录");
  log("3 sub hidden ok");

  // ---- 4. 排序：表头换成修改时间，列表顺序跟着换（换方向不再重画整块，高度也不动）
  await page.locator(".new-sheet .dir-filter").fill("");
  await until(async () => (await page.locator(".new-sheet .dir-row").count()) >= 30, 8000, "unfiltered");
  const sorts = (await page.$$eval(".new-sheet .dir-sort-key", (els) => els.map((e) => e.textContent.trim()))).join(" / ");
  assert(sorts === "名称 ↑ / 修改时间", `the sheet lists column names, no size column without files (got ${sorts})`);
  await page.locator(".new-sheet .dir-sort-key", { hasText: "修改时间" }).click();
  const dirBtn = ((await page.locator(".new-sheet .dir-sort-key.on").textContent()) ?? "").trim();
  assert(dirBtn === "修改时间 ↓", `switching to 修改时间 starts descending (got ${dirBtn})`);
  await page.locator(".new-sheet .dir-sort-key", { hasText: "修改时间" }).click();
  const dirBtn2 = ((await page.locator(".new-sheet .dir-sort-key.on").textContent()) ?? "").trim();
  assert(dirBtn2 === "修改时间 ↑", `clicking the same column flips it (got ${dirBtn2})`);
  // 换排序不该把列表清空闪一下：旧的一页留着，新的一页到了再整块换。
  await page.evaluate(() => { document.querySelector(".new-sheet .dir-list")?.replaceChildren(); });
  await page.locator(".new-sheet .dir-sort-key", { hasText: "名称" }).click();
  const flash = await page.evaluate(async () => {
    const list = document.querySelector(".new-sheet .dir-list");
    const out = { msg: 0, minRows: 999, frames: 0 };
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 40));
    const key = [...document.querySelectorAll(".new-sheet .dir-sort-key")].find((b) => b.textContent.includes("修改时间"));
    key?.click();
    while (performance.now() - t0 < 900) {
      out.frames++;
      if (/读取中…/.test(list.textContent)) out.msg++;
      const n = list.querySelectorAll(".dir-row").length;
      if (n < out.minRows) out.minRows = n;
      await new Promise((r) => setTimeout(r, 16));
    }
    return out;
  });
  assert(flash.msg === 0, `re-sorting never flashes 读取中… (${flash.msg}/${flash.frames} frames)`);
  assert(flash.minRows > 0, `re-sorting keeps rows on screen (min ${flash.minRows} rows)`);
  const sheetH3 = (await page.locator(".new-sheet").boundingBox())?.height ?? 0;
  assert(Math.abs(sheetH3 - sheetH) < 2, `sorting does not resize the sheet (${sheetH} vs ${sheetH3})`);
  await page.screenshot({ path: path.join(OUT, "2-sorted.png"), animations: "disabled" });
  log("4 sort ok");

  // ---- 5. 打开已有的：这个目录有 1 个会话
  const note = await page.locator(".new-sheet .ws-new-note").textContent();
  assert((note ?? "").includes("1 个会话"), `note counts the sessions here (got ${note})`);
  assert(await page.locator(".new-sheet .sheet-foot .btn", { hasText: "打开已有的" }).isVisible(), "打开已有的 shows up");
  log("5 note ok:", note);

  // ---- 6. API 层的分页 / 排序 / 递归（同一份假树）
  const api = async (q) => (await fetch(`${BASE}/api/dirs?page=1&path=${encodeURIComponent(WORK)}${q}`, { headers: { cookie } })).json();
  const bySize = await api("&sort=size&dir=desc&limit=50");
  const sizes = bySize.entries.filter((e) => e.kind === "file").map((e) => e.size);
  assert(sizes.every((s, i) => i === 0 || sizes[i - 1] >= s), "size desc is monotonic");
  assert(sizes[0] > sizes[sizes.length - 1], "size desc actually differs");
  const byName = await api("&limit=5");
  assert(byName.entries.slice(0, 30).every((e) => e.kind === "dir"), "folders come first");
  const paged = await api("&limit=10&offset=228");
  assert(paged.entries.length === 10 && paged.offset === undefined, "offset paging works");
  assert(paged.total >= 1530, `total is the whole directory (got ${paged.total})`);
  const deep = await api("&q=设计&sub=1");
  assert(deep.entries.some((e) => (e.rel ?? "").includes("docs/a/b")), "sub search returns rel paths");
  assert(!deep.entries.some((e) => (e.rel ?? "").includes("node_modules")), "sub search skips node_modules");
  log("6 api ok:", paged.total, sizes[0]);

  // ---- 7. 文件管理器：排序控件在，默认时间降序，切到大小后是数值序
  // 这个弹层本来就没有 Escape（老版本也没有），走它自己的「关闭」。
  await page.locator(".new-sheet .sheet-head .btn", { hasText: "关闭" }).click();
  await page.locator(".new-sheet").waitFor({ state: "detached", timeout: 5000 });
  // 顺序是共享的（上面在弹层里切到了 mtime ↑），所以先清掉记忆再看文件管理器的「第一次默认」。
  await page.evaluate(() => localStorage.removeItem("pi.web.dirsort.shared"));
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".session-card", { hasText: "主会话" }).first().click();
  await page.locator(".topbar").waitFor({ timeout: 10000 });
  await page.locator(".topbar .icon-btn", { hasText: "文件" }).click();
  await page.locator(".viewer-browse .dirpicker").waitFor({ timeout: 10000 });
  const fmOn = page.locator(".viewer-browse .dir-sort-key.on");
  await fmOn.waitFor({ timeout: 8000 });
  assert(((await fmOn.textContent()) ?? "").trim() === "修改时间 ↓", `file manager defaults to 修改时间 ↓ (got ${await fmOn.textContent()})`);
  await page.locator(".viewer-browse .dir-sort-key", { hasText: "大小" }).click();
  await until(async () => {
    const sizes = await page.$$eval(".viewer-browse .file-row .size", (els) => els.map((e) => e.textContent ?? ""));
    const nums = sizes.slice(0, 12).map(kb).filter((n) => Number.isFinite(n)).slice(0, 12);
    return nums.length > 6 && nums.every((n, i) => i === 0 || nums[i - 1] >= n);
  }, 12000, "size desc in the UI");
  // 递归：包含子目录能找到 docs/a/b 里的文件，行尾带相对路径，且跳过 node_modules
  await page.locator(".viewer-browse .dir-filter").fill("设计");
  await page.locator(".viewer-browse .dir-sub").click();
  await until(async () => (await page.locator(".viewer-browse .file-row").count()) >= 1, 10000, "recursive hit");
  const rel = await page.locator(".viewer-browse .file-row .rel").first().textContent();
  assert((rel ?? "").includes("docs"), `recursive row shows its rel path (got ${rel})`);
  await page.locator(".viewer-browse .dir-filter").fill("junk");
  await until(async () => ((await page.locator(".viewer-browse .dir-pagecount").textContent()) ?? "").includes("/ 0"), 10000, "no node_modules hit");
  const junkRows = (await page.$$eval(".viewer-browse .dir-row", (els) => els.map((e) => e.textContent ?? ""))).filter((t) => !t.includes("上一级"));
  assert(junkRows.length === 0, `node_modules is skipped (got ${junkRows.join(",")})`);
  // 路径框：这个文件排在好几页之后，按名字再问一次桥端就该跳过去（而不是只留一句「这一页里没有」）
  await page.locator(".viewer-browse .dir-filter").fill("");
  await page.waitForTimeout(300); // 让 150ms 的筛选防抖先落地，免得它把下一次跳转冲掉
  await page.locator(".viewer-browse .dir-jump-input").fill(path.join(WORK, "file-1499.txt"));
  await page.locator(".viewer-browse .dir-jump-input").press("Enter");
  await until(async () => (await page.locator(".viewer-browse .file-row.hit").count()) === 1, 10000, "path jump past page one");
  const hitName = await page.locator(".viewer-browse .file-row.hit .nm").textContent();
  assert((hitName ?? "").includes("file-1499.txt"), `the jumped-to row is the one asked for (got ${hitName})`);
  await page.screenshot({ path: path.join(OUT, "3-file-manager.png"), animations: "disabled" });
  log("7 file manager ok:", rel);

  // ---- 7b. 列表版排序也是一排列名（不是下拉框），点一下排、再点一下翻向
  assert((await page.locator(".viewer-browse .dir-sort-pick").count()) === 0, "the list sort is not a <select>");
  const keys = (await page.$$eval(".viewer-browse .dir-sort-key", (els) => els.map((e) => e.textContent.trim()))).join(" / ");
  assert(keys === "名称 / 大小 ↓ / 修改时间", `three clickable column names, the active one carries the arrow (got ${keys})`);
  await page.locator(".viewer-browse .dir-sort-key", { hasText: "名称" }).click();
  await until(async () => ((await page.locator(".viewer-browse .dir-sort-key.on").textContent()) ?? "").includes("名称"), 8000, "name column on");
  const nameCol = (await page.locator(".viewer-browse .dir-sort-key.on").textContent()) ?? "";
  assert(nameCol.includes("↑"), `switching column starts ascending (got ${nameCol})`);
  log("7b list sort chips ok");

  // ---- 8. 附件弹层（控制台）：表头就是排序入口，大小列点一下换方向，数值要真的跟着走
  await page.locator('.viewer .viewer-tools .viewer-btn[title^="关闭"]').click();
  await page.locator(".viewer").waitFor({ state: "detached", timeout: 5000 });
  // 排序是全站共享的一份（文件管理器上一步刚把「大小」存进去），先清掉才看得到控制台自己的默认值
  await page.evaluate(() => localStorage.removeItem("pi.web.dirsort.shared"));
  await page.locator(".composer .btn.ghost", { hasText: "文件" }).first().click();
  await page.locator(".sys-back .dirpicker").waitFor({ timeout: 10000 });
  assert(await page.locator(".sys-back .dir-sub").isVisible(), "the console keeps 包含子目录 (it lists files)");
  // 路径框和筛选框得是同一行、同一个高度（以前 .dir-filter 的外边距把筛选框顶歪、还被拉高 6px）
  const jbox = await page.locator(".sys-back .dir-jump-input").boundingBox();
  const fbox = await page.locator(".sys-back .fc-filter").boundingBox();
  assert(!!jbox && !!fbox && Math.abs(jbox.y - fbox.y) <= 0.6, `path and filter share a top edge (${jbox?.y} vs ${fbox?.y})`);
  assert(!!jbox && !!fbox && Math.abs(jbox.height - fbox.height) <= 0.6, `path and filter are the same height (${jbox?.height} vs ${fbox?.height})`);
  const timeArrow = await page.locator(".sys-back th.fc-col-time .ar").textContent();
  assert((timeArrow ?? "").trim() === "↓", `the console arrives sorted by 修改时间 ↓ (got ${timeArrow})`);
  await page.locator(".sys-back th.fc-col-size").click();
  await until(async () => {
    const nums = (await page.$$eval(".sys-back .fc-table tbody td.fc-col-size", (els) => els.map((e) => e.textContent ?? ""))).map(kb).filter((n) => Number.isFinite(n)).slice(0, 12);
    return nums.length > 6 && nums.every((n, i) => i === 0 || nums[i - 1] >= n);
  }, 10000, "console size desc");
  const sizeArrow = await page.locator(".sys-back th.fc-col-size .ar").textContent();
  assert((sizeArrow ?? "").trim() === "↓", `clicking 大小 sorts by it (got ${sizeArrow})`);
  await page.locator(".sys-back th.fc-col-size").click();
  await until(async () => {
    const nums = (await page.$$eval(".sys-back .fc-table tbody td.fc-col-size", (els) => els.map((e) => e.textContent ?? ""))).map(kb).filter((n) => Number.isFinite(n)).slice(0, 12);
    return nums.length > 6 && nums.every((n, i) => i === 0 || nums[i - 1] <= n);
  }, 10000, "console size asc");
  await page.screenshot({ path: path.join(OUT, "4-console.png"), animations: "disabled" });
  log("8 console ok");

  // ---- 9. 新会话左栏：用当前目录新建工作区，建完还在这个弹层里（不切走、不重开）
  await page.locator(".sys-back .sys-head__actions .btn", { hasText: "关闭" }).click();
  await page.locator(".sys-back").waitFor({ state: "detached", timeout: 8000 });
  await page.locator(".btn.primary", { hasText: "开新会话" }).first().click();
  await page.locator(".new-sheet .ws-new-add").waitFor({ timeout: 8000 });
  const addLabel = ((await page.locator(".new-sheet .ws-new-add").textContent()) ?? "").trim();
  assert(addLabel.includes("用这个目录新建工作区"), `the rail offers 用这个目录新建工作区 (got ${addLabel})`);
  const madeName = path.basename(OUTSIDE);
  await page.locator(".new-sheet .dir-jump-input").fill(OUTSIDE);
  await page.locator(".new-sheet .dir-jump-input").press("Enter");
  await until(async () => ((await page.locator(".new-sheet .ns-where").textContent()) ?? "").includes(madeName), 8000, "browsed to the outside dir");
  const picksBefore = await page.locator(".new-sheet .ws-new-pick").count();
  await page.locator(".new-sheet .ws-new-add").click();
  await until(async () => (await page.locator(".new-sheet .ws-new-pick", { hasText: madeName }).count()) === 1, 12000, "new workspace row");
  // 行的总数不能当断言：同一个工程根下的目录会被并回一组（这里 work / other 都并进 pi-web-client）。
  assert((await page.locator(".new-sheet .ws-new-pick").count()) >= picksBefore, "no row was lost");
  assert(await page.locator(".new-sheet").isVisible(), "the sheet stayed open");
  const wsToast = (await page.locator(".fail-toast").allTextContents()).join(" ");
  assert(wsToast.includes("已新建工作区"), `a toast says it was created (got ${wsToast})`);
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  await page.screenshot({ path: path.join(OUT, "5-ws-add.png"), animations: "disabled" });
  log("9 rail workspace ok");

  assert(errors.length === 0, `no page errors (got ${errors.join(" | ")})`);
  log("all checks passed");
} finally {
  try {
    await browser?.close();
  } catch {}
  try {
    bridge.kill();
  } catch {}
}
