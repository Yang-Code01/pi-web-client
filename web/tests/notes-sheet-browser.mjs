/**
 * #486：`web/src/notesheet.ts` 的三栏骨架 + 列表 / 编辑器接线。
 *
 * `NotesSheet` 全在 DOM 上做事情（`el()`、contenteditable、`localStorage`），unit 测试跑不了，
 * 这里用 esbuild 打包后用 Chromium 载进去，配一个假 host（不连 bridge）点一遍。
 *
 *   node --experimental-strip-types web/tests/notes-sheet-browser.mjs
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { loadPlaywright } from "../../tools/playwright.mjs";

const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/notesheet.ts", import.meta.url))],
  bundle: true,
  format: "iife",
  globalName: "Notes",
  platform: "browser",
  write: false,
  logLevel: "silent",
  // notesheet.ts 会 import "./notes.css"：页面里不需要样式，只要别把 CSS 当成 JS 的输出。
  loader: { ".css": "empty" },
});
// 只有一个输出（CSS 被 empty loader 吃掉了）：write:false 时 path 是 "<stdout>"，别按后缀挑。
const code = bundled.outputFiles[0]?.text ?? "";
assert.ok(code.includes("var Notes"), "esbuild 没产出 JS bundle");

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
// 界面文案跟着浏览器语言走（docs/I18N.md）：不指定 zh-CN，断言中文会在别的机器上假失败。
const context = await browser.newContext({ locale: "zh-CN" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
// 用 route 伪造一个 http 源：`setContent` 停在 about:blank，那里读 localStorage 会 SecurityError。
await page.route("http://notes.test/**", (route) =>
  route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body><div id=app></div></body></html>" }),
);
await page.goto("http://notes.test/");
await page.addScriptTag({ content: code });

const out = await page.evaluate(async () => {
  const now = Date.now();
  const note = (over) => ({
    id: "n1",
    kind: "bug",
    status: "pending",
    title: "旧标题",
    body: "<p>第一段</p><ul><li>要点</li></ul>",
    shots: [],
    sessionId: null,
    sessionName: null,
    issue: "",
    commit: "",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    ...over,
  });
  const notes = [
    note({}),
    note({ id: "n2", status: "done", title: "已处理的那条" }),
    note({ id: "n3", kind: "idea", title: "别的分区" }),
  ];
  const sent = [];
  const host = {
    send: (msg) => sent.push(msg),
    notes: () => notes,
    session: () => ({ id: "s1", name: "会话一" }),
    prefill: () => {},
    newSessionWith: () => {},
  };
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));
  const result = {};

  localStorage.clear();
  const sheet = new Notes.NotesSheet(host);
  sheet.mount(document.getElementById("app"));

  // 1. 三栏骨架
  const consoleEl = q(".notes-console");
  result.columns = [...consoleEl.children].map((c) => c.className);
  // 2. 列表：默认「全部」，行上有字数 / 截图数 / 时间
  result.rows = qa(".nc-row").map((r) => r.querySelector(".nc-row-title").textContent);
  result.segCounts = qa(".nc-seg-item").map((b) => [b.dataset.seg, b.querySelector(".nc-seg-n").textContent]);
  result.rowMeta = qa(".nc-row")[0] ? {
    words: q(".nc-row-words").textContent,
    shots: q(".nc-row-shot").textContent,
    time: q(".nc-row-time").textContent,
  } : null;
  result.banner = q(".nc-banner")?.textContent ?? null;
  // 3. 分区计数（bug 待处理 1 条）
  result.navBugCount = q('.nc-nav-item[data-key="bug"] .nc-nav-n')?.textContent ?? null;

  // 4. 点一行 → 标题 / 正文进编辑器
  q('.nc-row[data-id="n1"]').click();
  result.titleValue = q(".nc-title").value;
  result.bodyHtml = q(".nc-body").innerHTML;
  result.saveBtnHidden = !qa(".nc-actions .btn").some((b) => b.textContent === "保存");

  // 5. 改标题 → 停手自动保存：发 notes.save，正文是净化的 HTML
  const title = q(".nc-title");
  title.value = "改过的标题";
  fire(title, "input");
  result.autoSaving = q(".notes-hint").textContent;
  await new Promise((r) => setTimeout(r, 1100));
  const save = sent.find((m) => m.type === "notes.save");
  result.save = save ? { id: save.id, title: save.title, body: save.body } : null;

  // 6. 状态药丸 → 菜单 → 已处理
  q(".nc-status").click();
  result.statusMenu = qa(".note-handoff .handoff-label").map((b) => b.textContent);
  qa(".note-handoff button")[1].click();
  result.statusMsg = sent.filter((m) => m.type === "notes.status").at(-1) ?? null;

  // 7. 行上的归档按钮 → notes.life
  qa('.nc-row[data-id="n1"] .nc-row-act')[0].click();
  result.lifeMsg = sent.filter((m) => m.type === "notes.life").at(-1) ?? null;

  // 8. 第一栏收成图标条，写进 localStorage；窄条上点一下展开
  q(".nc-nav-fold").click();
  result.navRail = consoleEl.classList.contains("nav-rail");
  result.storedNav = localStorage.getItem("notes.nav");
  // 收起后分区头那颗箭头反过来当展开钮：再点一次就展开。
  q(".nc-nav-fold").click();
  result.navBack = !consoleEl.classList.contains("nav-rail");

  // 9. Ctrl+\ 收起列表（键盘手势），再按一次回来
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", ctrlKey: true, bubbles: true }));
  result.listOff = consoleEl.classList.contains("list-off");
  result.storedList = localStorage.getItem("notes.list");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", ctrlKey: true, bubbles: true }));
  result.listBack = !consoleEl.classList.contains("list-off");

  // 10. 归档分区：只读提示，不摆「记一条」
  q('.nc-nav-item[data-key="archived"]').click();
  result.archivedEmpty = q(".nc-empty-title")?.textContent ?? null;
  result.newHiddenInArchive = q(".notes-head-new").hidden;

  // 11. 搜索
  q('.nc-nav-item[data-key="bug"]').click();
  const search = q(".nc-search");
  search.value = "zzz";
  fire(search, "input");
  result.searchEmpty = q(".nc-empty-list")?.textContent ?? null;

  // 12. 分段控件：切到「已处理」只剩已处理那条，再切回全部
  search.value = "";
  fire(search, "input");
  q('.nc-seg-item[data-seg="done"]').click();
  result.rowsDone = qa(".nc-row").map((r) => r.querySelector(".nc-row-title").textContent);
  q('.nc-seg-item[data-seg="all"]').click();
  result.rowsAll = qa(".nc-row").length;

  // 12b. 新建一条：光标落在标题上
  q(".notes-head-new").click();
  result.newFocus = document.activeElement === q(".nc-title");

  // 13. 导出：不崩、给出提示
  q(".notes-head .btn.ghost").click();
  result.footHint = q(".notes-hint").textContent;

  sheet.close();
  result.closed = !document.querySelector(".notes-sheet");
  return result;
});

await browser.close();

assert.deepEqual(out.columns, ["nc-nav", "nc-list", "nc-doc"], "三栏：分区 / 列表 / 正文");
assert.deepEqual(out.rows, ["旧标题", "已处理的那条"], "默认「全部」：待处理和已处理都在");
assert.deepEqual(out.segCounts, [["all", "2"], ["pending", "1"], ["done", "1"], ["dropped", "0"]], "分段控件的计数");
assert.equal(out.rowMeta?.words, "5 字", "行上显示字数（第一段 + 要点 = 5 个非空白字符）");
assert.equal(out.rowMeta?.shots, "🖼 0", "行上显示截图数");
assert.ok(out.rowMeta?.time, "行上有时间");
assert.match(out.banner ?? "", /这一类还有 1 条待处理/, "顶部黄条报待处理条数");
assert.equal(out.navBugCount, "1", "分区计数 = 待处理的条数");
assert.equal(out.titleValue, "旧标题", "点行后标题进编辑器");
assert.ok(out.bodyHtml.includes("<li>要点</li>"), `正文按 HTML 填进编辑器，实际 ${out.bodyHtml}`);
assert.equal(out.saveBtnHidden, true, "自动保存：不再有保存按钮");
assert.equal(out.autoSaving, "正在写…", "改动后先给「正在写」");
assert.ok(out.save, "点保存要发 notes.save");
assert.equal(out.save.id, "n1", "改已有条目带 id");
assert.equal(out.save.title, "改过的标题", "标题跟着输入走");
assert.match(out.save.body, /<p>/, `正文是 HTML，实际 ${out.save.body}`);
assert.deepEqual(out.statusMenu, ["○ 待处理", "✓ 已处理", "− 已忽略", "📦 归档", "🗑️ 删除"], "状态菜单五项");
assert.equal(out.statusMsg?.status, "done", "点「已处理」发 notes.status");
assert.equal(out.lifeMsg?.life, "archived", "行上归档发 notes.life");
assert.equal(out.navRail, true, "第一栏能收成图标条");
assert.equal(out.storedNav, "rail", "折叠状态落 localStorage");
assert.equal(out.navBack, true, "窄条上点一下展开");
assert.equal(out.listOff, true, "Ctrl+\\ 收起列表");
assert.equal(out.storedList, "closed", "列表折叠状态落 localStorage");
assert.equal(out.listBack, true, "再按一次回来");
assert.equal(out.archivedEmpty, "归档里的记录不能直接改。", "归档分区只读提示");
assert.equal(out.newHiddenInArchive, true, "归档分区不摆「记一条」");
assert.equal(out.searchEmpty, "没有匹配的记录。", "搜索无结果");
assert.deepEqual(out.rowsDone, ["已处理的那条"], "切到「已处理」只剩已处理那条");
assert.equal(out.rowsAll, 2, "切回「全部」两条都在");
assert.equal(out.newFocus, true, "新建一条时光标落在标题上");
assert.ok(out.footHint, "导出要给一句提示");
assert.equal(out.closed, true, "close() 把面板从 DOM 摘掉");
assert.deepEqual(errors, [], `不该有控制台错误：${errors.join(" | ")}`);

console.log("ok notes-sheet-browser: 三栏 / 列表 / 编辑器 / 保存 / 状态 / 折叠 / 搜索");
