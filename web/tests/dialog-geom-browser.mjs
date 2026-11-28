/**
 * 守卫：窗口几何（#755）—— 每扇 `window` 浮层右下角一只抓手，拖完记住、双击复原。
 *
 * 这是这次改动唯一全新的测试缝：esbuild 把 `dialoggeom.ts` 与**真** `styles.css` 打出来，在真 Chromium
 * 里挂假窗。不碰桥、不依赖 `web/dist`，所以拖拽手感（布局 px 换算、夹回视口、`pointer-events` 层次）
 * 都在这里量得到。同目录 `dialog-geom-unit.mjs` 只管「44 个创建点有没有漏接」。
 *
 * 一条硬规矩：断言的期望值全部来自**外面**（拖了多少视觉 px、视口多宽、旧键里塞了什么），
 * 不照抄模块里的算法 —— 否则它只能证明代码跟自己一致。
 *
 * Run: node --experimental-strip-types web/tests/dialog-geom-browser.mjs
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { loadPlaywright } from "../../tools/playwright.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const bundled = await build({
  entryPoints: [here("../src/dialoggeom.ts")],
  bundle: true,
  format: "iife",
  globalName: "DialogGeom",
  platform: "browser",
  write: false,
  logLevel: "silent",
  loader: { ".css": "empty" },
});
const code = bundled.outputFiles[0]?.text ?? "";
assert.ok(code.includes("var DialogGeom"), "esbuild 没产出 dialoggeom 的 bundle");

const cssOut = await build({
  entryPoints: [here("../src/styles.css")],
  bundle: true,
  write: false,
  loader: { ".css": "css" },
  logLevel: "silent",
});
const css = cssOut.outputFiles.map((f) => f.text).join("\n");
assert.ok(css.includes(".win-grip"), "styles.css 里没有 .win-grip");

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.route("http://dialog-geom.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><div id="app"></div></body></html>',
    }),
  );
  await page.goto("http://dialog-geom.test/");
  await page.addStyleTag({ content: css });
  // 面板的「默认尺寸」用 CSS 变量给：真窗口的宽高也来自样式表，`width/height` 的 inline 位置要空着
  // 留给抓手模块（它没拖过时不许写、复原时要摘掉）。
  await page.addStyleTag({
    // 不带 `#app` 前缀：控制式宿主那一段把遮罩挂在 body 上，面板也就不在 `#app` 里。
    // `.sheet-back[hidden]`：真窗口各自带这条（`.scratch-back[hidden]` / `.picker[hidden]`），
    // 而 `.sheet-back` 自己是 `display: grid`、会盖掉 UA 的 `[hidden]` —— 假窗也照抄一份，否则「收起再打开」量不到。
    content:
      ".sheet { width: var(--test-w); height: var(--test-h); max-height: none; } .sheet-back[hidden] { display: none; }",
  });
  await page.addScriptTag({ content: code });

  /**
   * 挂一扇假窗：`back` 是 `position: fixed; inset: 0` 的遮罩，`panel` 是里面那块面板。
   * `width/height` 走 inline，等于「样式表给的默认尺寸」。
   */
  const mount = async (id, opts = {}) => {
    const out = await page.evaluate(
      ({ id, opts }) => {
        const { width = 420, height = 320, min, panelZoom = 1, onBody = false, footer = false } = opts;
        const app = document.getElementById("app");
        app.replaceChildren();
        // 上一扇挂在 body 上的窗不会跟着 `replaceChildren` 走，手动清掉。
        for (const old of document.querySelectorAll("body > .sheet-back")) old.remove();
        const back = document.createElement("div");
        back.className = "sheet-back center";
        const panel = document.createElement("div");
        panel.className = "sheet";
        panel.style.setProperty("--test-w", `${width}px`);
        panel.style.setProperty("--test-h", `${height}px`);
        // 「控制台式宿主」（D463）：遮罩挂 body、面板自己带 zoom —— 两套缩放不相等。
        if (panelZoom !== 1) panel.style.zoom = String(panelZoom);
        if (footer) {
          const foot = document.createElement("div");
          foot.className = "sheet-foot";
          foot.textContent = "footer";
          panel.append(foot);
        }
        back.append(panel);
        (onBody ? document.body : app).append(back);
        const grip = window.DialogGeom.attachWindowGeom(id, { back, panel, min });
        window.__grip = grip;
        return grip ? "grip" : "none";
      },
      { id, opts },
    );
    // 窗口开场有位移入场（`.sheet` 的 `sheet-up`），抓手在前两百毫秒里跟着面板走。
    // 真人不可能在动画没演完时抓住一只正在动的爪子，测试也不必去抢那一帧。
    await page.waitForTimeout(320);
    return out;
  };

  const size = () =>
    page.evaluate(() => {
      const panel = document.querySelector(".sheet");
      const r = panel.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });

  const stored = (id) =>
    page.evaluate((id) => {
      const all = JSON.parse(localStorage.getItem("pi.dialogGeom") ?? "null");
      return all?.[id] ?? null;
    }, id);

  const gripBox = async () => {
    const box = await page.locator(".win-grip").boundingBox();
    assert.ok(box, "页面上没有 .win-grip");
    return box;
  };

  const drag = async (dx, dy) => {
    const g = await gripBox();
    const x = g.x + g.width / 2;
    const y = g.y + g.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 4 });
    await page.mouse.up();
  };

  const clear = () => page.evaluate(() => localStorage.clear());

  // ---------------------------------------------------------------- 1. 拖动改大小 + 落盘
  await clear();
  await mount("settings", { width: 420, height: 320, min: [320, 240] });
  await drag(120, 80);
  let s = await size();
  ok(s.w === 540 && s.h === 400, `拖 (+120,+80) 后面板是 ${s.w}×${s.h}（期望 540×400）`);
  let g = await stored("settings");
  ok(g && g.w === 540 && g.h === 400, `落盘是 ${JSON.stringify(g)}（期望 {w:540,h:400}）`);
  ok(g && g.l === undefined && g.t === undefined, `窗口不记位置（存了 ${JSON.stringify(g)}）`);

  // ---------------------------------------------------------------- 2. 重开还原
  await mount("settings", { width: 420, height: 320, min: [320, 240] });
  s = await size();
  ok(s.w === 540 && s.h === 400, `重开同一扇窗还原成 ${s.w}×${s.h}（期望 540×400）`);

  // ---------------------------------------------------------------- 3. 各记各的
  await mount("notes", { width: 700, height: 500, min: [320, 240] });
  s = await size();
  ok(s.w === 700 && s.h === 500, `另一扇窗用自己的默认尺寸 ${s.w}×${s.h}（期望 700×500）`);
  ok((await stored("notes")) === null, "没拖过的窗一条都不写");
  await drag(60, 40);
  ok((await stored("notes"))?.w === 760, `拖过的窗自己记一条（${JSON.stringify(await stored("notes"))}）`);
  ok((await stored("settings"))?.w === 540, "「设置」那条记忆没被「记录」改掉");

  // ---------------------------------------------------------------- 4. 双击复原
  await mount("settings", { width: 420, height: 320, min: [320, 240] });
  let box = await gripBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  s = await size();
  ok(s.w === 420 && s.h === 320, `双击抓手感复原成样式表尺寸 ${s.w}×${s.h}（期望 420×320）`);
  ok((await stored("settings")) === null, `复原后条目被删（剩 ${JSON.stringify(await stored("settings"))}）`);
  ok((await stored("notes"))?.w === 760, "复原一扇窗不影响另一扇");
  await mount("notes", { width: 700, height: 500, min: [320, 240] });
  s = await size();
  ok(s.w === 760 && s.h === 540, `另一扇窗的大小还在（${s.w}×${s.h}，期望 760×540）`);

  // ---------------------------------------------------------------- 5. 150% 字号：视觉 px → 布局 px
  // 视口得够宽：1280 / 1.5 = 853 < 900 就落进「窄屏不装」那一档了，本来就不该有抓手。
  await page.setViewportSize({ width: 1600, height: 900 });
  await clear();
  await page.evaluate(() => {
    document.getElementById("app").style.zoom = "1.5";
  });
  await mount("settings", { width: 420, height: 320, min: [320, 240] });
  await drag(150, 120);
  g = await stored("settings");
  ok(g && g.w === 520 && g.h === 400, `150% 字号下拖视觉 (+150,+120) 存的是布局 px：${JSON.stringify(g)}（期望 520×400）`);
  await page.evaluate(() => {
    document.getElementById("app").style.zoom = "";
  });
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---------------------------------------------------------------- 5b. 遮罩与面板缩放不相等（控制台式宿主，D463）
  // 遮罩挂 body（不缩放）、面板自己 `zoom: 1.5`：位置要按遮罩那套算、尺寸要按面板那套存。
  await page.evaluate(() => {
    document.getElementById("app").style.zoom = "";
  });
  await clear();
  await mount("settings", { width: 400, height: 300, min: [320, 240], panelZoom: 1.5, onBody: true });
  const consoleGeom = await page.evaluate(() => {
    const panel = document.querySelector(".sheet");
    const grip = document.querySelector(".win-grip");
    const p = panel.getBoundingClientRect();
    const gr = grip.getBoundingClientRect();
    return { dx: Math.round(p.right - gr.right), dy: Math.round(p.bottom - gr.bottom) };
  });
  ok(
    consoleGeom.dx === 0 && consoleGeom.dy === 0,
    `面板缩放 1.5、遮罩 1 时抓手仍贴在面板右下角（差 ${consoleGeom.dx},${consoleGeom.dy}）`,
  );
  await drag(150, 90);
  g = await stored("settings");
  ok(
    g && g.w === 500 && g.h === 360,
    `两个缩放不相等时也按面板 px 存：${JSON.stringify(g)}（期望 400+150/1.5=500 × 300+90/1.5=360）`,
  );

  // ---------------------------------------------------------------- 5c. 入场动画期间（面板带 transform: scale）量到的缩放不许被带进尺寸
  // `mac-window-in` 是 `scale: 0.94 → 1` 的弹簧。缩放若按 `rect ÷ offsetWidth` 推，挂载那一刻正好
  // 量在 0.94 —— 记忆里的 500px 会被写成 532px，而 `apply()` 只跑这一次，要到下次 resize 才纠正。
  await page.evaluate(() => {
    document.getElementById("app").style.zoom = "";
  });
  await clear();
  await page.evaluate(() =>
    localStorage.setItem("pi.dialogGeom", JSON.stringify({ settings: { w: 500, h: 360 } })),
  );
  await page.addStyleTag({
    content: "@keyframes test-zoom-in { from { transform: scale(0.5); } to { transform: scale(1); } } .sheet { animation: test-zoom-in 600ms linear backwards; }",
  });
  await mount("settings", { width: 420, height: 320, min: [320, 240] });
  // 动画演到一半（面板此刻视觉上只有一半大）就量：写进去的必须是 500 / 360 这两个 CSS px。
  await page.waitForTimeout(250);
  const midAnim = await page.evaluate(() => {
    const p = document.querySelector(".sheet");
    return { w: p.style.width, h: p.style.height, visual: Math.round(p.getBoundingClientRect().width) };
  });
  ok(midAnim.w === "500px" && midAnim.h === "360px", `动画中途挂上，inline 尺寸就是记忆值（${midAnim.w} × ${midAnim.h}）`);
  ok(midAnim.visual < 500, `（对照组：面板此刻确实被动画缩小了，视觉宽 ${midAnim.visual}）`);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    for (const tag of document.querySelectorAll("style")) if (tag.textContent.includes("test-zoom-in")) tag.remove();
  });

  // ---------------------------------------------------------------- 5d. 面板「hidden 收起、不摘 DOM」再打开：尺寸与抓手都要回来
  await clear();
  await page.evaluate(() =>
    localStorage.setItem("pi.dialogGeom", JSON.stringify({ settings: { w: 560, h: 400 } })),
  );
  // 先在看得见的状态下挂好、拖一下存盘，再把它 hidden。
  await mount("settings", { width: 420, height: 320, min: [320, 240] });
  await drag(40, 30);
  const reopened = await page.evaluate(async () => {
    const back = document.querySelector(".sheet-back");
    const panel = document.querySelector(".sheet");
    const grip = document.querySelector(".win-grip");
    back.hidden = true;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // 隐藏期间重开：尺寸得重新铺、抓手得重新贴角 —— 全靠 ResizeObserver 那一下，没有别的机会。
    back.hidden = false;
    // 显示出来那一刻入场动画（`sheet-up`，260ms）照样会演：**动画中途**也要贴着 ——
    // 首次挂载那轮 rAF 早就收工了，只靠 ResizeObserver 那一下（量在动画第一帧）会差一个位移。
    await new Promise((r) => setTimeout(r, 100));
    const mid = panel.getBoundingClientRect();
    const midGrip = grip.getBoundingClientRect();
    const midDy = Math.round(mid.bottom - midGrip.bottom);
    await new Promise((r) => setTimeout(r, 220));
    const p = panel.getBoundingClientRect();
    const g = grip.getBoundingClientRect();
    return {
      midDy,
      w: Math.round(p.width),
      h: Math.round(p.height),
      dx: Math.round(p.right - g.right),
      dy: Math.round(p.bottom - g.bottom),
    };
  });
  ok(reopened.w === 600 && reopened.h === 430, `hidden 再显示后尺寸是拖过的 ${reopened.w}×${reopened.h}（期望 560+40 × 400+30）`);
  ok(reopened.dx === 0 && reopened.dy === 0, `hidden 再显示后抓手重新贴角（差 ${reopened.dx},${reopened.dy}）`);
  ok(Math.abs(reopened.midDy) <= 2, `hidden 再显示后，入场动画**中途**抓手也贴着面板（差 ${reopened.midDy}）`);

  // ---------------------------------------------------------------- 5e. 挂上去的时候就是 hidden（内网通选文件浮层 / 随手问起步就是这种）
  await clear();
  await page.evaluate(() =>
    localStorage.setItem("pi.dialogGeom", JSON.stringify({ settings: { w: 600, h: 440 } })),
  );
  const hiddenStart = await page.evaluate(async () => {
    const app = document.getElementById("app");
    app.replaceChildren();
    const back = document.createElement("div");
    back.className = "sheet-back center";
    back.hidden = true;
    const panel = document.createElement("div");
    panel.className = "sheet";
    panel.style.setProperty("--test-w", "320px");
    panel.style.setProperty("--test-h", "240px");
    back.append(panel);
    app.append(back);
    window.DialogGeom.attachWindowGeom("settings", { back, panel, min: [320, 240] });
    // 等到 rAF 的那十几帧全用完（爪子那时还看不见，摆位置是被跳过的）。
    await new Promise((r) => setTimeout(r, 500));
    const before = { w: panel.style.width, left: document.querySelector(".win-grip").style.left };
    back.hidden = false;
    await new Promise((r) => setTimeout(r, 320));
    const p = panel.getBoundingClientRect();
    const g = document.querySelector(".win-grip").getBoundingClientRect();
    return {
      before,
      after: { w: Math.round(p.width), h: Math.round(p.height) },
      dx: Math.round(p.right - g.right),
      dy: Math.round(p.bottom - g.bottom),
    };
  });
  ok(hiddenStart.before.left === "", `隐藏期间没往遮罩上写抓手位置（写的是「${hiddenStart.before.left}」）`);
  ok(hiddenStart.after.w === 600 && hiddenStart.after.h === 440, `起步 hidden 的窗显示后铺上记忆尺寸（${hiddenStart.after.w}×${hiddenStart.after.h}）`);
  ok(hiddenStart.dx === 0 && hiddenStart.dy === 0, `起步 hidden 的窗显示后抓手贴角（差 ${hiddenStart.dx},${hiddenStart.dy}）`);

  // ---------------------------------------------------------------- 6. 越界夹回视口
  await clear();
  await page.evaluate(() =>
    localStorage.setItem("pi.dialogGeom", JSON.stringify({ settings: { w: 5000, h: 5000 } })),
  );
  await mount("settings", { width: 420, height: 320, min: [320, 240] });
  s = await size();
  ok(s.w <= 1280 && s.h <= 800, `存了 5000×5000 也夹回视口：${s.w}×${s.h}`);

  // ---------------------------------------------------------------- 7. 窄屏收起、宽屏装回来
  await clear();
  await page.evaluate(() =>
    localStorage.setItem("pi.dialogGeom", JSON.stringify({ settings: { w: 600, h: 480 } })),
  );
  await page.setViewportSize({ width: 390, height: 700 });
  await mount("settings", { width: 320, height: 400, min: [320, 240] });
  ok(!(await page.locator(".win-grip").isVisible()), "窄屏（390）下抓手看不见");
  ok((await page.locator(".win-grip").getAttribute("tabindex")) === "-1", "窄屏下抓手不进 Tab 序列");
  s = await size();
  ok(s.w === 320 && s.h === 400, `窄屏不套记忆里的尺寸（${s.w}×${s.h}，期望样式表的 320×400）`);
  ok(
    (await page.evaluate(() => JSON.parse(localStorage.getItem("pi.dialogGeom") ?? "{}").settings?.w)) === 600,
    "窄屏一个字节都不写",
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(200);
  ok(await page.locator(".win-grip").isVisible(), "拉宽之后抓手回来了");
  s = await size();
  ok(s.w === 600 && s.h === 480, `拉宽之后用记过的大小（${s.w}×${s.h}，期望 600×480）`);

  // ---------------------------------------------------------------- 8. 旧键搬迁：读一次、不删旧键
  await clear();
  await page.evaluate(() => {
    localStorage.setItem("pi.termGeom", JSON.stringify({ l: 10, t: 20, w: 900, h: 500 }));
    localStorage.setItem("pi.viewerW", "560");
    localStorage.setItem("pi.sheetGeom", JSON.stringify({ l: 0, t: 0, w: 800, h: 600 }));
    localStorage.setItem("pi.slidesGeom", JSON.stringify({ l: 0, t: 0, w: 1000, h: 700 }));
  });
  await mount("settings", { width: 420, height: 320, min: [320, 240] });
  await page.evaluate(() => window.DialogGeom.migrateOldGeom());
  const moved = await page.evaluate(() => ({
    term: JSON.parse(localStorage.getItem("pi.dialogGeom") ?? "{}").term ?? null,
    preview: JSON.parse(localStorage.getItem("pi.dialogGeom") ?? "{}").preview ?? null,
    sheet: JSON.parse(localStorage.getItem("pi.dialogGeom") ?? "{}").sheet ?? null,
    slides: JSON.parse(localStorage.getItem("pi.dialogGeom") ?? "{}").slides ?? null,
    oldStillThere:
      localStorage.getItem("pi.termGeom") !== null && localStorage.getItem("pi.viewerW") === "560",
  }));
  ok(moved.term?.w === 900 && moved.term?.h === 500, `终端几何搬进来了（${JSON.stringify(moved.term)}）`);
  ok(moved.term?.l === 10 && moved.term?.t === 20, "终端的 l/t 一起搬（它是 dock，记位置）");
  ok(moved.preview?.w === 560, `预览宽度搬进来了（${JSON.stringify(moved.preview)}）`);
  ok(moved.sheet?.w === 800 && moved.slides?.w === 1000, "表格与幻灯片也搬进来了");
  ok(moved.oldStillThere, "旧键保留（回滚到旧构建还认得）");

  // ---------------------------------------------------------------- 9. 键盘：方向键调、Enter 复原
  await clear();
  await mount("settings", { width: 420, height: 320, min: [320, 240] });
  await page.locator(".win-grip").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  s = await size();
  ok(s.w === 452, `方向键两次 +16 后宽 ${s.w}（期望 452）`);
  await page.keyboard.press("Shift+ArrowDown");
  s = await size();
  ok(s.h === 384, `Shift+方向键 +64 后高 ${s.h}（期望 384）`);
  ok((await stored("settings"))?.w === 452, `键盘调整也落盘（${JSON.stringify(await stored("settings"))}）`);
  await page.keyboard.press("Enter");
  s = await size();
  ok(s.w === 420 && s.h === 320, `Enter 复原成 ${s.w}×${s.h}（期望 420×320）`);

  // ---------------------------------------------------------------- 10. 焦点在抓手上按 Esc 不被吃
  await page.locator(".win-grip").focus();
  const escReached = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const onEsc = (ev) => {
          document.removeEventListener("keydown", onEsc);
          resolve(ev.defaultPrevented === false);
        };
        document.addEventListener("keydown", onEsc);
        document.activeElement.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      }),
  );
  ok(escReached, "抓手上按 Esc 照旧冒泡（窗口的 Esc 栈要能关掉它）");

  // ---------------------------------------------------------------- 11. 抓手的位置、尺寸与语义
  await mount("settings", { width: 420, height: 320, min: [320, 240] });
  const geom = await page.evaluate(() => {
    const panel = document.querySelector(".sheet").getBoundingClientRect();
    const grip = document.querySelector(".win-grip");
    const r = grip.getBoundingClientRect();
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      dx: Math.round(panel.right - r.right),
      dy: Math.round(panel.bottom - r.bottom),
      role: grip.getAttribute("role"),
      tab: grip.getAttribute("tabindex"),
      label: grip.getAttribute("aria-label") ?? "",
      cursor: getComputedStyle(grip).cursor,
    };
  });
  ok(geom.w === 18 && geom.h === 18, `抓手是 18×18（量到 ${geom.w}×${geom.h}）`);
  ok(geom.dx === 0 && geom.dy === 0, `抓手贴住面板右下角（差 ${geom.dx},${geom.dy}）`);
  ok(geom.role === "separator" && geom.tab === "0", `抓手的语义是 ${geom.role}/${geom.tab}`);
  ok(geom.label.length > 4, `抓手有可读名字：「${geom.label}」`);
  ok(geom.cursor === "nwse-resize", `抓手光标是 ${geom.cursor}`);

  // ---------------------------------------------------------------- 12. 底栏给抓手让出 10px
  await mount("settings", { width: 420, height: 320, min: [320, 240], footer: true });
  const pad = await page.evaluate(() => getComputedStyle(document.querySelector(".sheet-foot")).paddingRight);
  ok(pad === "26px", `底栏右内边距是 ${pad}（期望 26px，原来 16px）`);

  // ---------------------------------------------------------------- 13. 面板自己滚的时候抓手仍钉在角上
  await mount("settings", { width: 420, height: 320, min: [320, 240] });
  const afterScroll = await page.evaluate(() => {
    const panel = document.querySelector(".sheet");
    panel.style.overflowY = "auto";
    const filler = document.createElement("div");
    filler.style.height = "1200px";
    panel.append(filler);
    panel.scrollTop = 400;
    const p = panel.getBoundingClientRect();
    const r = document.querySelector(".win-grip").getBoundingClientRect();
    return { dx: Math.round(p.right - r.right), dy: Math.round(p.bottom - r.bottom) };
  });
  ok(afterScroll.dx === 0 && afterScroll.dy === 0, `面板滚动后抓手仍在角上（差 ${afterScroll.dx},${afterScroll.dy}）`);

  // ---------------------------------------------------------------- 14. 样式表里的高度盖子拖过之后让开
  await clear();
  await page.evaluate(() =>
    localStorage.setItem("pi.dialogGeom", JSON.stringify({ settings: { w: 420, h: 320 } })),
  );
  await mount("settings", { width: 420, height: 320, min: [320, 240] });
  await page.evaluate(() => {
    // 真窗口有 `.sheet { max-height: 78vh }` 这类盖子；留着它往下拖会卡在半路、爪子还跟着手指走。
    document.querySelector(".sheet").style.maxHeight = "240px";
  });
  // 面板被盖子压矮了，抓手要靠 ResizeObserver 挪一次位置（真人操作中间隔着好几帧，这里补上）。
  await page.waitForTimeout(80);
  await drag(0, 120);
  s = await size();
  // 盖子把面板压到 240，往上拖 120 就该到 360 —— 卡在 240 就说明 `max-height` 没让开。
  ok(s.h === 360, `顶着样式表的 max-height 也能拖到 ${s.h}（期望 240+120=360）`);
  ok((await stored("settings"))?.h === 360, `让开盖子之后的尺寸也落盘（${JSON.stringify(await stored("settings"))}）`);

  // ---------------------------------------------------------------- 15. 「最大化」期间不许写 inline 尺寸
  // 内网通那扇最大化靠 `.sheet.peer-sheet.max { width/height: 100% }`：inline 值会盖住它。所以
  // `suspend(true)` 之后连浏览器窗口缩放都不能把它写回去（`apply()` 在那一刻要早退）。
  await clear();
  await page.evaluate(() =>
    localStorage.setItem("pi.dialogGeom", JSON.stringify({ settings: { w: 600, h: 480 } })),
  );
  await mount("settings", { width: 320, height: 400, min: [320, 240] });
  await page.evaluate(() => window.__grip.suspend(true));
  let inline = await page.evaluate(() => {
    const p = document.querySelector(".sheet");
    return { w: p.style.width, h: p.style.height, hidden: document.querySelector(".win-grip").hidden };
  });
  ok(inline.w === "" && inline.h === "", `suspend(true) 摘掉了 inline 尺寸（${JSON.stringify(inline)}）`);
  ok(inline.hidden, "suspend(true) 收起了抓手");
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.waitForTimeout(120);
  inline = await page.evaluate(() => {
    const p = document.querySelector(".sheet");
    return { w: p.style.width, h: p.style.height };
  });
  ok(inline.w === "" && inline.h === "", `缩放窗口也没把 inline 尺寸写回去（${JSON.stringify(inline)}）`);
  await page.evaluate(() => window.__grip.suspend(false));
  s = await size();
  ok(s.w === 600 && s.h === 480, `退出「最大化」回到记过的大小（${s.w}×${s.h}）`);
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---------------------------------------------------------------- 16. 旧键只搬一次（否则「还原」等于没做）
  await clear();
  await page.evaluate(() =>
    localStorage.setItem("pi.termGeom", JSON.stringify({ l: 10, t: 20, w: 900, h: 500 })),
  );
  await page.evaluate(() => window.DialogGeom.migrateOldGeom());
  ok((await stored("term"))?.w === 900, "启动时把旧键搬进来");
  await page.evaluate(() => window.DialogGeom.resetAllWindowGeom());
  ok(
    (await page.evaluate(() => localStorage.getItem("pi.termGeom"))) === null,
    "「还原所有窗口尺寸」连旧键一起删",
  );
  await page.evaluate(() =>
    localStorage.setItem("pi.termGeom", JSON.stringify({ l: 10, t: 20, w: 900, h: 500 })),
  );
  await page.evaluate(() => window.DialogGeom.migrateOldGeom());
  ok((await stored("term")) === null, "搬过一次之后不再搬（旧键又冒出来也不理）");
  await page.evaluate(() => localStorage.removeItem("pi.dialogGeom.migrated"));
  await page.evaluate(() => window.DialogGeom.migrateOldGeom());
  ok((await stored("term"))?.w === 900, "标记不在了才重新搬一次");

  // ---------------------------------------------------------------- 17. 全局还原
  await page.evaluate(() => window.DialogGeom.resetAllWindowGeom());
  ok(
    (await page.evaluate(() => localStorage.getItem("pi.dialogGeom"))) === "{}" ||
      (await page.evaluate(() => JSON.parse(localStorage.getItem("pi.dialogGeom") ?? "{}").settings)) === undefined,
    "「还原所有窗口尺寸」清掉了窗口条目",
  );

  ok(errors.length === 0, `页面无 JS 报错${errors.length ? `：${errors.slice(0, 2).join(" | ")}` : ""}`);
} finally {
  await browser.close();
}

console.log(bad === 0 ? "\n全部通过" : `\n${bad} 条未通过`);
process.exit(bad === 0 ? 0 : 1);
