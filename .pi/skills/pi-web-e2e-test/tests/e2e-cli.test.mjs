import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { startEnv, stopEnv } from "../lib/env.mjs";
import { findFfmpeg, probeVideo } from "../lib/ffmpeg.mjs";

const SKILL_DIR = path.resolve(import.meta.dirname, "..");
const REPO_DIR = path.resolve(SKILL_DIR, "../../..");
const E2E = path.join(SKILL_DIR, "bin", "e2e.mjs");
const CASE = path.join(SKILL_DIR, "cases", "example.mjs");
const ENABLED = process.env.PI_WEB_E2E_SMOKE === "1";

function runCli(args, label) {
  const result = spawnSync(process.execPath, [E2E, ...args], {
    cwd: REPO_DIR,
    encoding: "utf8",
    timeout: 8 * 60 * 1000,
    windowsHide: true
  });
  if (result.status !== 0) {
    const tail = `${result.stdout || ""}\n${result.stderr || ""}`.trim().slice(-4000);
    assert.fail(`${label} 退出码 ${result.status ?? "?"}\n${tail}`);
  }
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function audioCodec(file) {
  const { ffprobe } = findFfmpeg();
  return execFileSync(
    ffprobe,
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file],
    { encoding: "utf8", windowsHide: true }
  ).trim();
}

function assertSide(spec, side, outDir) {
  const data = spec.sides?.[side];
  assert.ok(data, `spec 缺少 ${side}`);
  assert.equal(data.status, "pass");
  const video = path.join(outDir, data.video);
  assert.ok(fs.existsSync(video), `缺少视频 ${video}`);
  const vtt = path.join(outDir, data.vtt);
  assert.ok(fs.existsSync(vtt), `缺少字幕 ${vtt}`);
  const text = fs.readFileSync(vtt, "utf8");
  assert.match(text, /^WEBVTT/);
  assert.ok((text.match(/-->/g) || []).length >= 1, "VTT 没有 cue");
  assert.ok(data.bytes > 0, "视频体积没有记录");
  return video;
}

test(
  "CLI 端到端：bug 与 change 都能产出视频、字幕和报告",
  { skip: ENABLED ? false : "设置 PI_WEB_E2E_SMOKE=1 才跑（会起真实测试环境，约 2–4 分钟）", timeout: 15 * 60 * 1000 },
  async () => {
    const envName = `e2e-cli-${Date.now()}`;
    const env = await startEnv({
      repoDir: REPO_DIR,
      name: envName,
      build: true,
      log: (line) => console.log(`[env] ${line}`)
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-e2e-smoke-"));
    const bugOut = path.join(root, "bug");
    const changeOut = path.join(root, "change");
    let browser = null;
    try {
      runCli(
        [
          "bug",
          "--case",
          CASE,
          "--dir",
          REPO_DIR,
          "--env",
          env.id,
          "--out",
          bugOut,
          "--slug",
          "cli-smoke",
          "--title",
          "CLI 冒烟",
          "--no-tts"
        ],
        "bug"
      );
      const bugSpec = readJson(path.join(bugOut, "spec.json"));
      assert.equal(bugSpec.schema, 1);
      assert.ok(bugSpec.caseFile, "spec 没记录用例脚本");
      assert.ok(fs.existsSync(path.join(bugOut, bugSpec.caseFile)), "用例脚本没有复制到产物目录");
      assert.ok(bugSpec.command, "spec 没记录运行命令");
      const bugVideo = assertSide(bugSpec, "after", bugOut);
      const bugInfo = await probeVideo(bugVideo);
      assert.equal(bugInfo.video.codec, "h264");
      assert.equal(audioCodec(bugVideo), "aac");
      const bugHtml = fs.readFileSync(path.join(bugOut, "cli-smokebug.html"), "utf8");
      assert.match(bugHtml, /id="symptom"/);
      assert.match(bugHtml, /id="repro"/);
      assert.match(bugHtml, /id="cause"/);
      assert.match(bugHtml, /id="fix"/);
      assert.match(bugHtml, /运行命令/);

      runCli(
        [
          "change",
          "--case",
          CASE,
          "--dir",
          REPO_DIR,
          "--env",
          env.id,
          "--out",
          changeOut,
          "--slug",
          "cli-smoke-change",
          "--title",
          "CLI 变更冒烟",
          "--no-tts"
        ],
        "change"
      );
      const changeSpec = readJson(path.join(changeOut, "spec.json"));
      const beforeVideo = assertSide(changeSpec, "before", changeOut);
      const afterVideo = assertSide(changeSpec, "after", changeOut);
      assert.equal(changeSpec.cases.length, 1);
      assert.equal(changeSpec.cases[0].verdict, "pass");
      assert.equal((await probeVideo(beforeVideo)).video.codec, "h264");
      assert.equal(audioCodec(afterVideo), "aac");
      assert.ok(changeSpec.sides.before.bytes > 0);
      assert.ok(changeSpec.sides.after.bytes > 0);

      const changeHtml = path.join(changeOut, "cli-smoke-change变更.html");
      const html = fs.readFileSync(changeHtml, "utf8");
      assert.match(html, /id="cases"/);
      assert.match(html, /同步播放/);
      assert.match(html, /data-before="/);
      assert.match(html, /data-after="/);

      const { loadPlaywright } = await import(pathToFileURL(path.join(REPO_DIR, "tools", "playwright.mjs")).href);
      const { chromium } = await loadPlaywright();
      browser = await chromium.launch({
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required"]
      });
      const page = await browser.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(pathToFileURL(changeHtml).href);
      await page.waitForSelector("video");
      await page.waitForFunction(() =>
        [...document.querySelectorAll("video")].every((video) => video.readyState >= 2)
      );
      await page.click(".chip");
      await page.click("[data-sync-play]");
      await page.waitForTimeout(500);
      const paused = await page.$$eval("video", (videos) => videos.map((video) => video.paused));
      assert.ok(paused.length >= 2, "报告里没有 before/after 两段视频");
      assert.ok(paused.every((value) => value === false), "点同步播放后仍有视频没有播放");
      await page.$eval('video[data-side="after"]', (video) => video.pause());
      await page.waitForTimeout(300);
      const solo = await page.$$eval("video", (videos) => videos.map((video) => ({ side: video.dataset.side, paused: video.paused })));
      assert.equal(solo.find((item) => item.side === "before").paused, false, "单独暂停 after 后 before 不应被带着暂停");
      assert.equal(solo.find((item) => item.side === "after").paused, true, "单独暂停 after 失败");
      assert.deepEqual(pageErrors, [], `报告脚本报错：${pageErrors.join("; ")}`);
      const active = await page.$$eval(".chip.active", (chips) => chips.length);
      assert.ok(active >= 1, "播放时步骤 chip 没有高亮");
    } finally {
      if (browser) await browser.close().catch(() => {});
      try {
        stopEnv(env.id, { repoDir: REPO_DIR });
      } catch (error) {
        console.log(`[env] 停止失败：${error.message}`);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
