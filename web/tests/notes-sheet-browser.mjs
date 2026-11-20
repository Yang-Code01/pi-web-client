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
  result.metaLabels = qa(".nc-meta .nc-cell").map((c) => c.querySelector(".nc-cell-k")?.textContent ?? "");
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

  // 6b. 改了标题还没到 900ms 就点状态：改动要顺手存掉，不能被状态那一下抹掉脏标记（D347）
  const savesBefore = sent.filter((m) => m.type === "notes.save").length;
  title.value = "状态前刚改的标题";
  fire(title, "input");
  q(".nc-status").click();
  qa(".note-handoff button")[0].click();
  const savesAfter = sent.filter((m) => m.type === "notes.save");
  result.statusFlush = { count: savesAfter.length - savesBefore, title: savesAfter.at(-1)?.title ?? null };

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

  // 13. 全局检索：跨分区搜活记录，点结果回到它所在分区
  q('.nc-nav-item[data-key="bug"]').click();
  const gs = q(".notes-head-search");
  gs.value = "别的分区";
  fire(gs, "input");
  result.g = {
    rows: qa(".nc-row").map((r) => r.querySelector(".nc-row-title").textContent),
    chip: q(".nc-row-kind")?.textContent ?? null,
    navOn: qa(".nc-nav-item.on").length,
    newHidden: q(".notes-head-new").hidden,
    segHidden: q(".nc-seg").hidden,
    listTitle: q(".nc-list-title").textContent,
    headCount: q(".notes-head-sub").textContent,
    clearShown: !q(".nc-gclear").hidden,
    listSearchHidden: q(".nc-search").hidden,
  };
  // 归档了的那条不参与全局检索：直接把 fixture 标成归档
  notes[0].archivedAt = now;
  gs.value = "旧标题";
  fire(gs, "input");
  result.gArchived = qa(".nc-row").length;
  notes[0].archivedAt = null;
  // 正文（按纯文本）也参与匹配：只改 n2 的正文（连带 updatedAt 让摘要缓存失效）
  notes[1].body = "<p>正文里才有的词</p>";
  notes[1].updatedAt = now + 1;
  gs.value = "正文里才有的词";
  fire(gs, "input");
  result.gBody = qa(".nc-row").map((r) => r.dataset.id);
  // Esc 第一下只清搜索，面板留着
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  result.gEsc = { value: gs.value, open: !!document.querySelector(".notes-sheet"), rows: qa(".nc-row").length, listSearchBack: !q(".nc-search").hidden };
  // 点结果 → 切到它所在分区并选中
  gs.value = "别的分区";
  fire(gs, "input");
  q('.nc-row[data-id="n3"]').click();
  result.gJump = {
    kindOn: q('.nc-nav-item[data-key="idea"]').classList.contains("on"),
    query: gs.value,
    title: q(".nc-title")?.value ?? null,
  };

  // 13b. 「AI 出错记录」视图里输入全局检索：中栏交给结果，账本让开；Esc 后回账本
  q('.nc-nav-item[data-key="failures"]').click();
  result.gFailBefore = { console: q(".notes-console").hidden, fail: q(".fail-wrap").hidden };
  gs.value = "别的分区";
  fire(gs, "input");
  result.gFailSearch = {
    consoleBack: !q(".notes-console").hidden,
    failHidden: q(".fail-wrap").hidden,
    rows: qa(".nc-row").length,
    listTitle: q(".nc-list-title")?.textContent ?? null,
  };
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  result.gFailAfterEsc = { console: q(".notes-console").hidden, fail: q(".fail-wrap").hidden, value: gs.value };

  // 13c. 账本里也能记一条、能退回记录列表（用户报障 2026-11-20）：以前进了账本就出不来了
  result.failHead = { back: !q(".notes-head-back").hidden, newShown: !q(".notes-head-new").hidden };
  q(".notes-head-back").click();
  result.failBack = { consoleBack: !q(".notes-console").hidden, failHidden: q(".fail-wrap").hidden, backHidden: q(".notes-head-back").hidden };
  q('.nc-nav-item[data-key="failures"]').click();
  q(".notes-head-new").click();
  result.failNew = {
    consoleBack: !q(".notes-console").hidden,
    failHidden: q(".fail-wrap").hidden,
    focusTitle: document.activeElement === q(".nc-title"),
  };

  // 14. 记忆：分区 + 选中（#514）
  q('.nc-nav-item[data-key="bug"]').click();
  q('.nc-row[data-id="n1"]').click();
  result.memoryStored = JSON.parse(localStorage.getItem("notes.memory") ?? "null");
  sheet.close();
  result.closed = !document.querySelector(".notes-sheet");

  const sheet2 = new Notes.NotesSheet(host);
  sheet2.mount(document.getElementById("app"));
  sheet2.setNotes(notes);
  result.memoryRestored = {
    kindOn: q('.nc-nav-item[data-key="bug"]').classList.contains("on"),
    title: q(".nc-title")?.value ?? null,
    body: q(".nc-body")?.textContent ?? "",
  };

  // 切到归档：选中的那条不在这一堆里 → 只保留分区、清掉选中。
  q('.nc-nav-item[data-key="archived"]').click();
  sheet2.setNotes(notes);
  result.memoryArchived = {
    on: q('.nc-nav-item[data-key="archived"]').classList.contains("on"),
    stored: JSON.parse(localStorage.getItem("notes.memory") ?? "null"),
  };
  sheet2.close();

  const sheet3 = new Notes.NotesSheet(host);
  sheet3.mount(document.getElementById("app"));
  sheet3.setNotes(notes);
  result.memoryReopen = {
    archivedOn: q('.nc-nav-item[data-key="archived"]').classList.contains("on"),
    hasSel: q('.nc-row.on') !== null,
    emptyTitle: q(".nc-empty-title")?.textContent ?? null,
  };
  sheet3.close();

  // 15. 内网通连动（#518）：菜单 / 选人 / 发送 / 确认 / 提交
  const calls = [];
  window.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const path = String(url).split("?")[0];
    calls.push({ url: path, body });
    const reply = (data) => ({ ok: true, status: 200, json: async () => data });
    if (path === "/api/peer") return reply({ enabled: true, running: true, status: { nodeId: "me", online: [{ nodeId: "f1", nickname: "小李", hostname: "pc-li" }] } });
    if (path === "/api/peer/contacts") return reply({ contacts: [
      { nodeId: "me", nickname: "我自己", hostname: "pc-me", online: true },
      { nodeId: "f1", nickname: "小李", hostname: "pc-li", online: true },
      { nodeId: "f2", nickname: "老王", hostname: "pc-wang", online: false },
    ] });
    if (path === "/api/notes/measure") return reply({ shots: [{ name: "a.png", size: 1024, sha256: "a".repeat(64) }] });
    if (path === "/api/peer/sendnote" || path === "/api/peer/sendfile") return reply({ ok: true });
    if (path === "/api/peer/send") return reply({ ok: true, id: "e1" });
    return reply({});
  };
  const waitFor = async (fn) => {
    for (let i = 0; i < 100; i += 1) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 30));
    }
    return null;
  };
  localStorage.removeItem("notes.memory");
  const sheet4 = new Notes.NotesSheet(host);
  sheet4.mount(document.getElementById("app"));
  const peerFeed = [note({ id: "n9", title: "连动这条", body: "<p><strong>粗</strong> 与 <code>码</code></p>", shots: ["/tmp/a.png"] })];
  host.notes = () => peerFeed;
  sheet4.setNotes(peerFeed);
  q('.nc-row[data-id="n9"]').click();
  const linkBtn = qa(".nc-actions .btn").find((b) => b.textContent.startsWith("内网通连动"));
  linkBtn.click();
  await waitFor(() => qa(".note-peer-menu button").length === 2 && qa(".note-peer-menu button")[0].textContent.includes("发送给好友"));
  result.peerMenu = qa(".note-peer-menu .handoff-label").map((s) => s.textContent);

  const pick = async (name) => {
    await waitFor(() => qa(".peer-pick-row").some((r) => r.querySelector(".pp-name")?.textContent === name));
    qa(".peer-pick-row").find((r) => r.querySelector(".pp-name")?.textContent === name).click();
  };
  qa(".note-peer-menu button")[0].click();
  await waitFor(() => qa(".peer-pick-row").length);
  result.pickRows = qa(".peer-pick-row").map((r) => ({ name: r.querySelector(".pp-name")?.textContent, off: r.disabled }));
  result.pickHasMe = qa(".peer-pick-row .pp-name").some((s) => s.textContent === "我自己");
  await pick("小李");
  await waitFor(() => calls.some((c) => c.url === "/api/peer/send") && (q(".notes-hint")?.textContent ?? "").includes("已发送"));
  const sendCall = calls.find((c) => c.url === "/api/peer/send");
  result.peerSend = { text: sendCall?.body?.text, toast: q(".notes-hint")?.textContent };
  result.peerLast = localStorage.getItem("notes.peerLast");

  linkBtn.click();
  await waitFor(() => qa(".note-peer-menu button").length === 2 && qa(".note-peer-menu button")[0].textContent.includes("发送给好友"));
  qa(".note-peer-menu button")[1].click();
  await pick("小李");
  await waitFor(() => q(".peer-confirm"));
  result.confirm = qa(".peer-confirm .pc-row").map((r) => r.textContent);
  q(".peer-confirm .btn.primary").click();
  await waitFor(() => calls.some((c) => c.url === "/api/peer/sendnote") && calls.some((c) => c.url === "/api/peer/sendfile"));
  const noteCall = calls.find((c) => c.url === "/api/peer/sendnote");
  const fileCalls = calls.filter((c) => c.url === "/api/peer/sendfile");
  result.noteSent = {
    title: noteCall?.body?.note?.title,
    shots: noteCall?.body?.note?.shots?.length,
    files: fileCalls.length,
    path: fileCalls[0]?.body?.path,
  };

  q(".notes-head-new").click();
  qa(".nc-actions .btn").find((b) => b.textContent.startsWith("内网通连动")).click();
  await waitFor(() => qa(".note-peer-menu button").length === 2 && qa(".note-peer-menu button")[0].textContent.includes("发送给好友"));
  result.peerBlank = qa(".note-peer-menu button").map((b) => b.disabled);
  sheet4.close();
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
assert.deepEqual(out.g?.rows, ["别的分区"], "全局检索跨分区：bug 分区里也能看到 idea 那条");
assert.ok(out.g?.chip?.includes("想法"), `结果行带分区胶囊，实际 ${out.g?.chip}`);
assert.equal(out.g?.navOn, 0, "搜索时导航空放");
assert.equal(out.g?.newHidden, true, "搜索时藏掉「＋ 记一条」");
assert.equal(out.g?.segHidden, true, "搜索时藏掉分段控件");
assert.equal(out.g?.listTitle, "搜索结果", "列表头切成「搜索结果」");
assert.match(out.g?.headCount ?? "", /全部记录 · 1 条命中/, "头部统计报命中数");
assert.equal(out.g?.clearShown, true, "搜索时列表头有清除按钮");
assert.equal(out.g?.listSearchHidden, true, "搜索时藏起列表内那颗搜索框");
assert.equal(out.gArchived, 0, "归档的记录不进全局检索");
assert.deepEqual(out.gBody, ["n2"], "正文也参与匹配");
assert.equal(out.gEsc?.value, "", "Esc 第一下只清搜索");
assert.equal(out.gEsc?.open, true, "清搜索时面板还开着");
assert.equal(out.gEsc?.listSearchBack, true, "清搜索后列表内搜索框回来");
assert.equal(out.gEsc?.rows, 2, "清搜索后回到原分区原列表");
assert.equal(out.gJump?.kindOn, true, "点结果切到它所在分区");
assert.equal(out.gJump?.query, "", "点结果清空搜索");
assert.equal(out.gJump?.title, "别的分区", "点结果选中那一条")
assert.deepEqual(out.gFailBefore, { console: true, fail: false }, "进 AI 出错账本时列表让位");
assert.deepEqual(out.gFailSearch, { consoleBack: true, failHidden: true, rows: 1, listTitle: "搜索结果" }, "账本视图里搜索也出结果");
assert.deepEqual(out.gFailAfterEsc, { console: true, fail: false, value: "" }, "Esc 清搜索后回到账本");
assert.deepEqual(out.metaLabels, ["状态", "分类", "创建", "改动"], "正文下只剩这四格：issue / commit / 会话 已退场");
assert.deepEqual(out.failHead, { back: true, newShown: true }, "账本里既有返回、也有记一条");
assert.deepEqual(out.statusFlush, { count: 1, title: "状态前刚改的标题" }, "改状态时把没存的标题一并存掉");
assert.deepEqual(out.failBack, { consoleBack: true, failHidden: true, backHidden: true }, "返回按钮回到记录列表，自己藏起来");
assert.deepEqual(out.failNew, { consoleBack: true, failHidden: true, focusTitle: true }, "账本里记一条：切回列表并落在标题上");
assert.deepEqual(out.memoryStored, { kind: "bug", view: "active", sel: "n1" }, "记忆落 notes.memory：分区 + 去向 + 选中");
assert.equal(out.memoryRestored.kindOn, true, "重开回到上次的分区");
assert.equal(out.memoryRestored.title, "旧标题", "重开接回上次选中的记录");
assert.ok(out.memoryRestored.body.includes("要点"), "接回的那条正文也回来了");
assert.equal(out.memoryArchived.on, true, "切到归档后分区是归档");
assert.deepEqual(out.memoryArchived.stored, { kind: "bug", view: "archived", sel: null }, "选中不在这一堆时只清选中、保留分区");
assert.equal(out.memoryReopen.archivedOn, true, "重开仍在归档分区");
assert.equal(out.memoryReopen.hasSel, false, "归档里不会凭空选中一条");
assert.equal(out.memoryReopen.emptyTitle, "归档里的记录不能直接改。", "归档空态照旧");
assert.equal(out.closed, true, "close() 把面板从 DOM 摘掉");
assert.deepEqual(out.peerMenu, ["发送给好友", "提交给好友"], "连动菜单两项");
assert.deepEqual(out.pickRows, [{ name: "小李", off: false }, { name: "老王", off: true }], "选人：在线在前、离线置灰");
assert.equal(out.pickHasMe, false, "选人排除自己");
assert.equal(out.peerSend?.text, "连动这条\n\n**粗** 与 `码`", "发送给好友发的是标题 + Markdown 正文");
assert.equal(out.peerSend?.toast, "已发送给 小李", "发完给回执");
assert.equal(out.peerLast, "f1", "记住上次发给谁");
assert.ok(out.confirm?.some((row) => row.includes("连动这条")), `确认页有标题，实际 ${JSON.stringify(out.confirm)}`);
assert.ok(out.confirm?.some((row) => row.includes("小李 · pc-li")), "确认页有收件人");
assert.ok(out.confirm?.some((row) => row.includes("截图") && row.includes("1 张")), "确认页有截图张数");
assert.deepEqual(out.noteSent, { title: "连动这条", shots: 1, files: 1, path: "/tmp/a.png" }, "提交：note 帧带清单，截图逐张走 sendfile");
assert.deepEqual(out.peerBlank, [true, true], "空记录两项都禁用");
assert.deepEqual(errors, [], `不该有控制台错误：${errors.join(" | ")}`);

console.log("ok notes-sheet-browser: 三栏 / 列表 / 编辑器 / 保存 / 状态 / 折叠 / 搜索");
