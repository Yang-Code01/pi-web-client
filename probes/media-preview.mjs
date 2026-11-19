/**
 * Probe (#542): video / audio play in the preview, in a real Chromium.
 *
 *  1. a .webm opens as a <video controls preload=metadata>, does not autoplay, loads its duration,
 *     and seeking is served by a 206 from /raw (Range);
 *  2. a .wav opens as <audio controls>;
 *  3. a file the browser can't decode (garbage .mp4) and a format it never plays (.avi) end on the
 *     fallback card: 用默认程序打开 + 新标签页打开 / 下载;
 *  4. a markdown doc embeds `![](clip.webm)`, a block `<video …>` (only whitelisted attributes
 *     survive: no autoplay, no on*), a `<source>`-only `<video>` and an `<audio>`;
 *  5. a chat bubble never embeds a local media file — it becomes a link that opens the viewer;
 *  6. closing the viewer pauses whatever was playing.
 *
 * Disposable bridge + scripted pi (fake-pi echoes prompts, so chat markdown needs no model).
 * Port 7894 by default (MEDIA_UI_PORT). Needs `npm run build` first.
 *
 *   node probes/media-preview.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync, spawn } from "node:child_process";
import { WebSocket } from "ws";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.MEDIA_UI_PORT ?? 7894);
const ROOT = path.join(REPO, ".scratch", "media-preview");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "media-preview-pass";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** 1 s of 440 Hz, 8 kHz mono 16-bit PCM. */
function wav() {
  const rate = 8000;
  const n = rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, WORK, path.join(WORK, "media"), OUT]) fs.mkdirSync(d, { recursive: true });
fs.copyFileSync(path.join(REPO, "bridge", "tests", "fixtures", "clip.webm"), path.join(WORK, "media", "clip.webm"));
fs.writeFileSync(path.join(WORK, "media", "tone.wav"), wav());
fs.writeFileSync(path.join(WORK, "broken.mp4"), Buffer.from("this is not a video at all ".repeat(40)));
fs.writeFileSync(path.join(WORK, "old.avi"), Buffer.from("RIFF\0\0\0\0AVI LIST".padEnd(512, "\0")));
fs.writeFileSync(
  path.join(WORK, "doc.md"),
  [
    "# 媒体",
    "",
    "内联：![演示](media/clip.webm)",
    "",
    '<video src="media/clip.webm" poster="none.png" loop muted autoplay onplay="window.__pwned=1" style="width:9999px" width="320">',
    "</video>",
    "",
    "<video controls>",
    '  <source src="media/clip.webm" type="video/webm">',
    "</video>",
    "",
    '<audio src="media/tone.wav"></audio>',
    "",
    "结尾段落。",
    "",
  ].join("\n"),
  "utf8",
);

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
  } catch {}
}
killPort(PORT);

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  FAKE_PI_LOG: PI_LOG,
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

let browser = null;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* wait */
    }
    await sleep(200);
  }
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
  const seen = [];
  ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "create", cwd: WORK, name: "media-preview" }));
  let sid = null;
  for (let i = 0; i < 300 && !sid; i++) {
    sid = seen.find((m) => m.type === "session" && m.state?.id)?.state.id ?? null;
    if (!sid) await sleep(100);
  }
  if (!sid) throw new Error(`no session:\n${bridgeOut.join("").slice(-2000)}`);

  browser = await chromium.launch({ headless: !process.env.PW_HEADFUL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  const raw206 = [];
  page.on("response", (r) => {
    if (r.url().includes("/raw/") && r.status() === 206) raw206.push(r.url());
  });
  await page.goto(`${BASE}/#/s/${sid}`, { waitUntil: "networkidle" });
  await page.locator(".topbar .icon-btn", { hasText: "文件" }).waitFor({ timeout: 15000 });

  const open = async (rel) => {
    await page.evaluate((p) => window.dispatchEvent(new CustomEvent("pi-preview", { detail: { path: p } })), path.join(WORK, rel));
    await page.waitForFunction((n) => document.querySelector(".viewer-name")?.textContent === n, path.basename(rel), {
      timeout: 15000,
    });
  };
  const closeViewer = async () => {
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".viewer"), null, { timeout: 5000 }).catch(() => {});
  };

  // ---- 1. video
  await open("media/clip.webm");
  const vid = page.locator(".viewer-body video.viewer-media");
  await vid.waitFor({ timeout: 10000 });
  const meta = await vid.evaluate(
    (v) =>
      new Promise((res) => {
        const done = () =>
          res({ controls: v.controls, preload: v.preload, paused: v.paused, autoplay: v.autoplay, duration: v.duration, src: v.src });
        if (v.readyState >= 1) done();
        else {
          v.addEventListener("loadedmetadata", done, { once: true });
          v.addEventListener("error", done, { once: true });
          setTimeout(done, 8000);
        }
      }),
  );
  check("webm → <video controls preload=metadata>", meta.controls && meta.preload === "metadata", JSON.stringify(meta));
  check("不自动播放", meta.paused && !meta.autoplay);
  check("时长读到了（约 3 秒）", meta.duration > 2.5 && meta.duration < 3.5, String(meta.duration));
  check("src 走 /raw", /\/raw\//.test(meta.src), meta.src);
  const before206 = raw206.length;
  const seeked = await vid.evaluate(
    (v) =>
      new Promise((res) => {
        v.addEventListener("seeked", () => res(v.currentTime), { once: true });
        v.currentTime = 2;
        setTimeout(() => res(-1), 8000);
      }),
  );
  check("能拖进度（seeked 到 2s）", seeked >= 1.9, String(seeked));
  check("浏览器拿到过 206（Range 生效）", raw206.length > 0, `206 次数 ${raw206.length}（拖动前 ${before206}）`);
  const played = await vid.evaluate(async (v) => {
    v.muted = true;
    try {
      await v.play();
    } catch {
      return false;
    }
    return !v.paused;
  });
  check("能播放", played);
  await page.screenshot({ path: path.join(OUT, "1-video.png") });
  const handle = await vid.elementHandle();
  await closeViewer();
  check("关掉 viewer 后视频停了", await handle.evaluate((v) => v.paused));

  // ---- 2. audio
  await open("media/tone.wav");
  const aud = page.locator(".viewer-body audio.viewer-media");
  await aud.waitFor({ timeout: 10000 });
  const adur = await aud.evaluate(
    (a) =>
      new Promise((res) => {
        if (a.readyState >= 1) res(a.duration);
        a.addEventListener("loadedmetadata", () => res(a.duration), { once: true });
        setTimeout(() => res(-1), 8000);
      }),
  );
  check("wav → <audio controls>，时长约 1 秒", adur > 0.9 && adur < 1.1, String(adur));
  await closeViewer();

  // ---- 3. fallbacks
  for (const name of ["broken.mp4", "old.avi"]) {
    await open(name);
    const card = page.locator(".viewer-body .viewer-msg");
    const shown = await page
      .waitForFunction(() => /放不了|不支持/.test(document.querySelector(".viewer-body .viewer-msg")?.textContent ?? ""), null, { timeout: 15000 })
      .then(() => true, () => false);
    const text = shown ? await card.textContent() : "";
    check(`${name} 放不了 → 降级卡片`, shown && /放不了/.test(text ?? ""), text ?? "");
    check(`${name} 卡片有「用默认程序打开」「新标签页打开 / 下载」`, /用默认程序打开/.test(text ?? "") && /新标签页打开 \/ 下载/.test(text ?? ""));
    check(`${name} 不留 <video>`, (await page.locator(".viewer-body video").count()) === 0);
    if (name === "broken.mp4") await page.screenshot({ path: path.join(OUT, "3-fallback.png") });
    await closeViewer();
  }

  // ---- 4. markdown embeds
  await open("doc.md");
  await page.locator(".viewer-body .md-doc").waitFor({ timeout: 10000 });
  const md = await page.evaluate(() => {
    const doc = document.querySelector(".viewer-body .md-doc");
    const vids = [...doc.querySelectorAll("video")];
    return {
      videos: vids.map((v) => ({
        src: v.getAttribute("src"),
        controls: v.controls,
        autoplay: v.autoplay || v.hasAttribute("autoplay"),
        attrs: v.getAttributeNames(),
        loop: v.loop,
        muted: v.muted,
        width: v.width,
        poster: v.getAttribute("poster"),
      })),
      audios: [...doc.querySelectorAll("audio")].map((a) => a.getAttribute("src")),
      leftover: /<\/?(video|audio|source)/.test(doc.textContent ?? ""),
      tail: doc.textContent.includes("结尾段落"),
    };
  });
  check("md 里有 3 个 <video>（内联图语法 + 块标签 + <source>）", md.videos.length === 3, JSON.stringify(md.videos));
  check("md 视频的 src 都走 /raw", md.videos.every((v) => /\/raw\/.+\/media\/clip\.webm$/.test(v.src ?? "")));
  check("md 视频都带 controls、都不 autoplay", md.videos.every((v) => v.controls && !v.autoplay));
  check(
    "白名单外的属性（on* / style / autoplay）不落 DOM",
    md.videos.every((v) => !v.attrs.some((a) => /^on|^style$|^autoplay$/.test(a))),
    JSON.stringify(md.videos.map((v) => v.attrs)),
  );
  const tagged = md.videos[1] ?? {};
  check("块标签的 loop / muted / width 保留", tagged.loop && tagged.muted && tagged.width === 320, JSON.stringify(tagged));
  check("poster 同样走 /raw", /\/raw\/.+\/none\.png$/.test(tagged.poster ?? ""), tagged.poster ?? "");
  check("md 里有 <audio>", md.audios.length === 1 && /\/raw\/.+\/media\/tone\.wav$/.test(md.audios[0] ?? ""), JSON.stringify(md.audios));
  check("标签原文没漏成文字，后面的段落照常渲染", !md.leftover && md.tail);
  check("onplay 没被执行", !(await page.evaluate(() => window.__pwned)));
  await page.screenshot({ path: path.join(OUT, "4-markdown.png") });
  await closeViewer();

  // ---- 5. chat: local media → link, never embedded
  ws.send(JSON.stringify({ type: "prompt", sessionId: sid, text: "看这个 ![片段](media/clip.webm) 和 media/tone.wav" }));
  const bubble = page.locator(".msg", { hasText: "echo:" }).last();
  await bubble.waitFor({ timeout: 15000 });
  const chat = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".msg")];
    return {
      videos: items.reduce((n, m) => n + m.querySelectorAll("video, audio").length, 0),
      text: items.map((m) => m.textContent).join(" | ").slice(-400),
    };
  });
  check("聊天气泡里没有嵌入播放器", chat.videos === 0, chat.text);
  const link = bubble.locator("a", { hasText: "视频" }).first();
  const hasLink = await link.count();
  check("聊天里的 ![](x.webm) 变成「[视频：片段]」链接", hasLink === 1, chat.text);
  if (hasLink) {
    await link.click();
    const opened = await page
      .locator(".viewer-body video.viewer-media")
      .waitFor({ timeout: 10000 })
      .then(() => true, () => false);
    check("点链接 → viewer 里播放", opened);
    await closeViewer();
  }

  // ---- 6. 150% font size: the player stays inside the viewer
  await page.evaluate(() => document.querySelector("#app")?.style.setProperty("--ui-scale", "1.5"));
  await open("media/clip.webm");
  await vid.waitFor({ timeout: 10000 });
  await sleep(500);
  const fit = await page.evaluate(() => {
    const v = document.querySelector(".viewer-body video").getBoundingClientRect();
    const box = document.querySelector(".viewer").getBoundingClientRect();
    return { v: [v.top, v.bottom], box: [box.top, box.bottom], vh: innerHeight };
  });
  check("150% 字号下视频不越出 viewer / 视口", fit.v[1] <= fit.box[1] + 1 && fit.box[1] <= fit.vh + 1, JSON.stringify(fit));
  await page.screenshot({ path: path.join(OUT, "6-scale150.png") });
} catch (e) {
  check("probe ran", false, e?.stack ?? String(e));
} finally {
  await browser?.close().catch(() => {});
  bridge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
