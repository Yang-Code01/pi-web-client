import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { overlayScript } from "./overlay.mjs";
import { safeFileStem } from "./slug.mjs";
import { createTts } from "./tts.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function preview(value) {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  try {
    const text = JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return String(value);
  }
}

function normalizeViewport(viewport) {
  const width = Math.max(320, Math.floor(Number(viewport?.width) || 1280));
  const height = Math.max(240, Math.floor(Number(viewport?.height) || 800));
  return { width: width - (width % 2), height: height - (height % 2) };
}

/**
 * Record one side (before/after) of a case file.
 *
 * The case file is a normal .mjs module exporting `default async function (h)`
 * and optionally `meta`. Every action goes through `h`, which keeps the red
 * ring/caption overlay and the step timeline in sync with the recording.
 */
export async function recordSide(options) {
  const toolRepoDir = path.resolve(options.toolRepoDir || options.repoDir);
  const outDir = path.resolve(options.outDir);
  const side = options.side || "after";
  const caseFile = path.resolve(options.caseFile);
  const baseUrl = String(options.baseUrl || "").replace(/\/+$/, "");
  const passphrase = options.passphrase || "test";
  const viewport = normalizeViewport(options.viewport);
  const fps = Number(options.fps) || 25;
  const log = options.log || (() => {});
  const rawDir = path.join(outDir, "raw", side);
  const shotsDir = path.join(outDir, "shots");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });

  const tts = options.tts || createTts({
    dir: path.join(outDir, "raw"),
    enabled: options.ttsOptions?.enabled !== false,
    voice: options.ttsOptions?.voice,
    rate: options.ttsOptions?.rate,
    log
  });

  const loaderPath = path.join(toolRepoDir, "tools", "playwright.mjs");
  const { loadPlaywright } = await import(pathToFileURL(loaderPath).href);
  const { chromium } = await loadPlaywright();
  const caseUrl = `${pathToFileURL(caseFile).href}?v=${Date.now()}`;
  const caseModule = await import(caseUrl);
  const moduleMeta = caseModule.meta || null;
  const effectiveMeta =
    options.meta && Object.keys(options.meta).length ? options.meta : moduleMeta || {};
  const run = caseModule.default || caseModule.run;
  if (typeof run !== "function") {
    throw new Error(`用例文件没有导出 default 函数：${caseFile}`);
  }
  const browser = await chromium.launch({ headless: true });
  const t0 = Date.now();
  const context = await browser.newContext({
    viewport,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    deviceScaleFactor: 1,
    bypassCSP: true,
    recordVideo: { dir: rawDir, size: viewport }
  });
  await context.addInitScript({ content: overlayScript() });

  let loginStatus = null;
  let loginError = "";
  try {
    const response = await context.request.post(`${baseUrl}/api/login`, {
      data: { passphrase },
      timeout: 15000
    });
    loginStatus = response.status();
  } catch (error) {
    loginError = error.message;
    log(`login request failed, will use the form: ${error.message}`);
  }

  const page = await context.newPage();
  const video = page.video();
  if (!video) {
    await browser.close();
    throw new Error("Playwright 没有开始录像（recordVideo 未生效）");
  }

  const startedAt = new Date().toISOString();
  const steps = [];
  const cases = [];
  const asserts = [];
  const moments = [];
  const marks = [];
  const errors = [];
  const consoleLog = [];
  const networkLog = [];
  const shots = [];
  const logs = [];
  let activeCase = null;
  let overlayReady = false;
  let failure = null;

  function now() {
    return Math.max(0, (Date.now() - t0) / 1000);
  }

  function note(message) {
    const text = String(message);
    logs.push(text);
    log(text);
  }

  page.on("console", (message) => {
    if (consoleLog.length >= 300) return;
    consoleLog.push({
      type: message.type(),
      text: message.text().slice(0, 1200),
      t: now()
    });
  });
  page.on("pageerror", (error) => {
    errors.push({
      kind: "pageerror",
      message: String(error.message || error),
      stack: String(error.stack || "").slice(0, 3000),
      t: now()
    });
  });
  page.on("requestfailed", (request) => {
    if (networkLog.length >= 300) return;
    networkLog.push({
      method: request.method(),
      url: request.url().slice(0, 1200),
      failure: request.failure()?.errorText || "request failed",
      t: now()
    });
  });
  page.on("response", (response) => {
    if (networkLog.length >= 300) return;
    if (response.status() >= 400) {
      networkLog.push({
        method: response.request().method(),
        url: response.url().slice(0, 1200),
        status: response.status(),
        t: now()
      });
    }
  });

  async function callOverlay(name, args) {
    try {
      return await page.evaluate(
        ([fn, params]) => {
          const api = window.__e2e;
          if (!api || typeof api[fn] !== "function") return null;
          return api[fn](...params);
        },
        [name, args]
      );
    } catch (error) {
      if (/Execution context was destroyed|Target closed|Cannot find context/i.test(error.message)) {
        return null;
      }
      throw error;
    }
  }

  async function ensureOverlay() {
    if (overlayReady) {
      const present = await page.evaluate(() => Boolean(window.__e2e)).catch(() => false);
      if (present) return true;
    }
    try {
      await page.addScriptTag({ content: overlayScript() });
      overlayReady = await page.evaluate(() => Boolean(window.__e2e)).catch(() => false);
    } catch {
      overlayReady = false;
    }
    return overlayReady;
  }

  async function overlay(name, ...args) {
    let result = await callOverlay(name, args);
    if (result === null) {
      const ready = await ensureOverlay();
      if (ready) result = await callOverlay(name, args);
    }
    return result;
  }

  async function waitForApp() {
    const ready = () => {
      return Boolean(
        document.querySelector(".composer textarea") ||
          document.querySelector("button[data-act='new']") ||
          document.querySelector("#composer textarea")
      );
    };
    try {
      await page.waitForFunction(ready, { timeout: 30000 });
      return;
    } catch {
      /* maybe the login form is showing */
    }
    const password = page.locator('input[type="password"]').first();
    if ((await password.count()) > 0 && (await password.isVisible().catch(() => false))) {
      note("页面在登录页，改用表单登录");
      await password.fill(passphrase);
      const enter = page.locator('button:has-text("进入")').first();
      if ((await enter.count()) > 0) await enter.click();
      await page.waitForFunction(ready, { timeout: 30000 });
      return;
    }
    throw new Error(`页面没有就绪：${page.url()}`);
  }

  async function dismissStartupOverlays() {
    const whatsnew = page.locator(".whatsnew-back").first();
    try {
      await whatsnew.waitFor({ state: "visible", timeout: 2500 });
    } catch {
      return;
    }
    note("关闭首次启动的更新日志");
    const ok = page.locator(".whatsnew-foot button.btn.primary").first();
    if ((await ok.count()) > 0) {
      await ok.click({ timeout: 5000 }).catch(() => {});
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
    await sleep(300);
  }

  async function locatorOf(target) {
    if (typeof target === "string") return page.locator(target).first();
    if (target && typeof target.first === "function") return target.first();
    throw new Error("需要 Playwright Locator 或选择器字符串");
  }

  async function boxOf(locator) {
    await locator.scrollIntoViewIfNeeded({ timeout: options.actionTimeout || 15000 });
    const box = await locator.boundingBox();
    if (!box) {
      throw new Error(`目标没有可见区域：${String(locator)}`);
    }
    return box;
  }

  async function startCase(spec = {}) {
    if (activeCase) await endCase();
    const item = {
      id: spec.id || `case-${cases.length + 1}`,
      title: spec.title || "",
      expect: spec.expect || "",
      tStart: now(),
      tEnd: null,
      status: "running",
      steps: [],
      asserts: [],
      errors: []
    };
    cases.push(item);
    activeCase = item;
    await overlay("card", {
      kicker: `用例 ${cases.length}`,
      title: item.title || "用例",
      sub: item.expect
    });
    await sleep(1250);
    await overlay("hideCard");
    note(`case ${item.id}: ${item.title}`);
    return item;
  }

  function caseStatus(item) {
    if (item.errors.length) return "error";
    if (item.asserts.some((assertion) => !assertion.pass)) return "fail";
    return "pass";
  }

  function caseTitle(status) {
    if (status === "pass") return "用例通过";
    if (status === "fail") return "用例未通过";
    return "执行出错";
  }

  async function endCase() {
    if (!activeCase) return null;
    const item = activeCase;
    item.status = caseStatus(item);
    const passed = item.asserts.filter((assertion) => assertion.pass).length;
    const failed = item.asserts.length - passed;
    await overlay("card", {
      kicker: "用例结束",
      title: caseTitle(item.status),
      sub: `${item.title} · 断言 ${passed} 通过 / ${failed} 未通过`
    });
    await sleep(1050);
    await overlay("hideCard");
    item.tEnd = now();
    activeCase = null;
    return item;
  }

  async function step(title, opts = {}) {
    let speech = null;
    if (opts.say) {
      speech = await tts.speak(opts.say);
      if (!speech.ok && !tts.failures.some((item) => item.text === opts.say)) {
        note(`旁白不可用，仅保留字幕：${speech.reason || speech.error || ""}`);
      }
    }
    const t = now();
    const item = {
      index: steps.length + 1,
      title: String(title || ""),
      say: opts.say || "",
      caption: opts.caption || opts.say || String(title || ""),
      audio: speech?.ok ? speech.path : "",
      audioDuration: speech?.ok ? speech.duration : 0,
      t,
      caseId: activeCase?.id || ""
    };
    steps.push(item);
    if (activeCase) activeCase.steps.push(item);
    await overlay("hideAll");
    await overlay("show", { index: item.index, title: item.title, caption: item.caption });
    const fallbackHold = opts.hold == null ? 700 : opts.hold;
    const audioGap = opts.audioGap == null ? 250 : opts.audioGap;
    const holdMs = speech?.ok ? speech.duration * 1000 + audioGap : fallbackHold;
    await sleep(holdMs);
    note(`step ${item.index}: ${item.title}${speech?.ok ? ` (${speech.duration.toFixed(2)}s)` : ""}`);
    return item;
  }

  async function click(target, opts = {}) {
    const locator = await locatorOf(target);
    const box = await boxOf(locator);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await overlay("cursorTo", x, y, { duration: opts.moveMs == null ? 420 : opts.moveMs });
    await overlay("ring", x, y, box.width, box.height, {
      label: opts.label || (opts.button === "right" ? "右键" : "点击")
    });
    await sleep(opts.preClickMs == null ? 550 : opts.preClickMs);
    await locator.click({
      timeout: opts.timeout == null ? 15000 : opts.timeout,
      button: opts.button || "left",
      force: opts.force === true
    });
    await overlay("ripple", x, y);
    marks.push({ kind: "click", t: now(), x, y, label: opts.label || "点击" });
    await sleep(opts.postClickMs == null ? 380 : opts.postClickMs);
    return { x, y, box };
  }

  async function fill(target, text, opts = {}) {
    const locator = await locatorOf(target);
    await click(locator, {
      label: opts.label || "输入",
      preClickMs: opts.preClickMs == null ? 350 : opts.preClickMs,
      postClickMs: 100
    });
    await locator.fill("");
    try {
      await locator.pressSequentially(String(text), {
        delay: opts.delay == null ? 55 : opts.delay,
        timeout: opts.timeout == null ? 20000 : opts.timeout
      });
    } catch (error) {
      note(`逐字输入失败，改为一次填入：${error.message}`);
      await locator.fill(String(text));
    }
    marks.push({ kind: "fill", t: now(), text: String(text).slice(0, 200) });
    await sleep(opts.postTypeMs == null ? 300 : opts.postTypeMs);
    await overlay("clearRing");
  }

  async function press(key, opts = {}) {
    await overlay("key", key, { label: opts.label || "按键" });
    await sleep(opts.prePressMs == null ? 450 : opts.prePressMs);
    await page.keyboard.press(key);
    marks.push({ kind: "press", t: now(), key });
    await sleep(opts.postPressMs == null ? 420 : opts.postPressMs);
    await overlay("clearKey");
  }

  async function scroll(target, deltaY, opts = {}) {
    const locator = target ? await locatorOf(target) : null;
    let x = null;
    let y = null;
    if (locator) {
      const box = await boxOf(locator);
      x = box.x + box.width / 2;
      y = box.y + box.height / 2;
    }
    await overlay("scroll", x, y, deltaY, { duration: opts.hold == null ? 1600 : opts.hold + 300 });
    if (locator) {
      await locator.evaluate((element, delta) => {
        element.scrollBy({ top: delta, behavior: "smooth" });
      }, deltaY);
    } else {
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.mouse.wheel(0, deltaY);
    }
    marks.push({ kind: "scroll", t: now(), deltaY });
    await sleep(opts.hold == null ? 1000 : opts.hold);
    await overlay("clearScroll");
  }

  async function drag(from, to, opts = {}) {
    const fromLoc = await locatorOf(from);
    const toLoc = await locatorOf(to);
    const a = await boxOf(fromLoc);
    const b = await boxOf(toLoc);
    const ax = a.x + a.width / 2;
    const ay = a.y + a.height / 2;
    const bx = b.x + b.width / 2;
    const by = b.y + b.height / 2;
    await overlay("drag", ax, ay, bx, by, { label: opts.label || "拖拽" });
    await sleep(opts.preDragMs == null ? 450 : opts.preDragMs);
    try {
      await fromLoc.dragTo(toLoc, { timeout: opts.timeout == null ? 10000 : opts.timeout });
    } catch (error) {
      note(`HTML5 拖拽失败，改用鼠标事件：${error.message}`);
      await page.mouse.move(ax, ay);
      await page.mouse.down();
      await page.mouse.move(bx, by, { steps: opts.steps || 24 });
      await page.mouse.up();
    }
    marks.push({ kind: "drag", t: now(), from: { x: ax, y: ay }, to: { x: bx, y: by } });
    await sleep(opts.postDragMs == null ? 600 : opts.postDragMs);
    await overlay("clearDrag");
  }

  async function hold(ms, opts = {}) {
    await overlay("wait", opts.label || `等待 ${(ms / 1000).toFixed(1)}s`);
    await sleep(ms);
    await overlay("clearWait");
    marks.push({ kind: "hold", t: now(), ms });
  }

  async function waitFor(target, opts = {}) {
    const locator = await locatorOf(target);
    await overlay("wait", opts.label || "等待加载…");
    await locator.waitFor({
      state: opts.state || "visible",
      timeout: opts.timeout == null ? 20000 : opts.timeout
    });
    await sleep(opts.settle == null ? 250 : opts.settle);
    await overlay("clearWait");
    marks.push({ kind: "wait", t: now() });
  }

  async function expect(desc, actual, expected, opts = {}) {
    const pass = isDeepStrictEqual(actual, expected);
    const item = {
      kind: "assert",
      desc: String(desc || ""),
      actual: preview(actual),
      expected: preview(expected),
      pass,
      critical: opts.critical === true,
      t: now(),
      caseId: activeCase?.id || ""
    };
    asserts.push(item);
    if (activeCase) activeCase.asserts.push(item);
    if (pass) {
      note(`断言通过：${item.desc}`);
    } else {
      note(`断言失败：${item.desc}（实际 ${item.actual}，期望 ${item.expected}）`);
      if (item.critical) {
        const error = new Error(`断言失败：${item.desc}`);
        error.assertion = item;
        throw error;
      }
    }
    return pass;
  }

  function ok(desc) {
    const item = {
      kind: "assert",
      desc: String(desc || ""),
      actual: "ok",
      expected: "ok",
      pass: true,
      critical: false,
      t: now(),
      caseId: activeCase?.id || ""
    };
    asserts.push(item);
    if (activeCase) activeCase.asserts.push(item);
    return true;
  }

  function fail(desc, opts = {}) {
    const item = {
      kind: "assert",
      desc: String(desc || ""),
      actual: "fail",
      expected: "fail",
      pass: false,
      critical: opts.critical === true,
      t: now(),
      caseId: activeCase?.id || ""
    };
    asserts.push(item);
    if (activeCase) activeCase.asserts.push(item);
    note(`标记失败：${item.desc}`);
    if (item.critical) {
      const error = new Error(`标记失败：${item.desc}`);
      error.assertion = item;
      throw error;
    }
    return false;
  }

  async function moment(label, opts = {}) {
    const t = now();
    const slow = Math.max(0.05, Math.min(1, Number(opts.slow) || 0.25));
    const lead = opts.lead == null ? 0.8 : opts.lead;
    const tail = opts.tail == null ? 0.6 : opts.tail;
    moments.push({
      label: String(label || "现象"),
      t,
      start: Math.max(0, t - lead),
      end: t + tail,
      slow
    });
    await overlay("moment", `慢放 ×${slow}`);
    await sleep(opts.hold == null ? 350 : opts.hold);
    note(`moment: ${label} @${t.toFixed(2)}s`);
  }

  async function shot(name) {
    let file = path.join(shotsDir, `${side}-${safeFileStem(name || `shot-${shots.length + 1}`)}.png`);
    let index = 2;
    while (fs.existsSync(file)) {
      file = path.join(
        shotsDir,
        `${side}-${safeFileStem(name || "shot")}-${index}.png`
      );
      index += 1;
    }
    await page.screenshot({ path: file, fullPage: false });
    shots.push({ name: name || "", file, t: now() });
    note(`截图：${file}`);
    return file;
  }

  async function finish() {
    if (activeCase) await endCase();
    const passed = asserts.filter((assertion) => assertion.pass).length;
    const failed = asserts.length - passed;
    await overlay("card", {
      kicker: "录制结束",
      title: options.outroTitle || (failed ? "有未通过项" : "录制完成"),
      sub: `断言 ${passed} 通过 / ${failed} 未通过 · ${cases.length} 条用例`
    });
    await sleep(1400);
    await overlay("hideCard");
  }

  const h = {
    page,
    context,
    browser,
    base: baseUrl,
    side,
    meta: effectiveMeta,
    case: startCase,
    endCase,
    step,
    click,
    fill,
    press,
    scroll,
    drag,
    hold,
    waitFor,
    expect,
    ok,
    fail,
    moment,
    shot,
    sleep,
    now,
    log: note
  };

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await waitForApp();
    await dismissStartupOverlays();
    await page.evaluate(() => document.fonts?.ready ?? true).catch(() => {});
    await sleep(350);
    const ready = await ensureOverlay();
    if (!ready) {
      throw new Error("overlay 注入失败（window.__e2e 不存在）");
    }
    const intro = options.kicker || (side === "before" ? "修改前 / BEFORE" : "修改后 / AFTER");
    const title = effectiveMeta.title || options.title || "pi-web-e2e-test";
    await overlay("card", {
      kicker: intro,
      title,
      sub: effectiveMeta.expect || ""
    });
    await sleep(1500);
    await overlay("hideCard");

    await run(h);
  } catch (error) {
    failure = {
      message: String(error.message || error),
      stack: String(error.stack || "").slice(0, 5000),
      url: (() => { try { return page.url(); } catch { return ""; } })(),
      t: now()
    };
    errors.push({ kind: "case", t: now(), ...failure });
    if (activeCase) {
      activeCase.errors.push(failure);
    }
    note(`用例执行出错：${failure.message}`);
  }

  try {
    await finish();
  } catch (error) {
    note(`片尾卡片失败：${error.message}`);
  }

  const durationRaw = now();
  const rawVideo = path.join(outDir, "raw", `${side}.webm`);
  let videoSaved = false;
  try {
    await context.close();
    await video.saveAs(rawVideo);
    videoSaved = fs.existsSync(rawVideo);
  } catch (error) {
    errors.push({ kind: "video", t: now(), message: error.message, stack: String(error.stack || "") });
    note(`保存视频失败：${error.message}`);
  } finally {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }

  if (cases.length === 0) {
    cases.push({
      id: "run",
      title: effectiveMeta.title || options.title || "整段录制",
      expect: effectiveMeta.expect || "",
      tStart: 0,
      tEnd: durationRaw,
      status: caseStatus({ errors, asserts }),
      steps: steps.slice(),
      asserts: asserts.slice(),
      errors: errors.slice()
    });
  }

  const rawSpec = {
    schema: 1,
    ok: !failure && videoSaved,
    error: failure,
    side,
    title: effectiveMeta.title || options.title || "pi-web-e2e-test",
    reportTitle: options.reportTitle || effectiveMeta.title || options.title || "",
    caseFile,
    baseUrl,
    startedAt,
    endedAt: new Date().toISOString(),
    durationRaw,
    viewport,
    fps,
    login: { status: loginStatus, error: loginError },
    git: options.git || null,
    env: options.env || null,
    tts: {
      enabled: tts.enabled,
      voice: tts.voice,
      rate: tts.rate,
      files: [...tts.used],
      failures: tts.failures.slice()
    },
    steps,
    cases,
    asserts,
    moments,
    marks,
    errors,
    console: consoleLog,
    network: networkLog,
    shots,
    logs,
    meta: effectiveMeta,
    rawVideo,
    videoSaved
  };
  fs.writeFileSync(path.join(outDir, `raw-spec-${side}.json`), JSON.stringify(rawSpec, null, 2));
  return rawSpec;
}
