#!/usr/bin/env node
/**
 * pi-web-e2e-test CLI.
 *
 *   node bin/e2e.mjs bug    --case <case.mjs> [--meta meta.json] [--dir repo]
 *   node bin/e2e.mjs change --case <case.mjs> [--meta meta.json] [--dir repo]
 *   node bin/e2e.mjs doctor [--dir repo]
 *
 * The case file is a plain ESM module exporting `meta` and a default async
 * function. Everything the case does goes through the `h` object; the driver
 * records the browser, then finalize turns it into MP4 + VTT + report.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { recordSide } from "../lib/driver.mjs";
import { finalizeRun } from "../lib/finalize.mjs";
import { renderReport } from "../lib/report.mjs";
import { startEnv, stopEnv, listEnv, PASSPHRASE, normalizeBaseUrl } from "../lib/env.mjs";
import {
  mainRoot,
  gitInfo,
  mergeBase,
  createBeforeWorktree,
  removeBeforeWorktree
} from "../lib/worktree.mjs";
import { asciiSlug, safeFileStem, runStamp } from "../lib/slug.mjs";
import { findFfmpeg, ffmpegInfo } from "../lib/ffmpeg.mjs";
import { listTtsVoices } from "../lib/tts.mjs";

const FLAGS = new Set(["keep", "no-tts", "build", "force", "help"]);

function camel(name) {
  return name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function parseArgs(argv) {
  const mode = argv[0] && !argv[0].startsWith("-") ? argv[0] : "";
  const rest = mode ? argv.slice(1) : argv;
  const args = { mode };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new Error(`无法识别的参数：${token}`);
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    let value = eq === -1 ? null : body.slice(eq + 1);
    if (FLAGS.has(key)) {
      if (value != null) throw new Error(`--${key} 不接受值`);
      args[camel(key)] = true;
      continue;
    }
    if (value == null) {
      value = rest[index + 1];
      if (value == null || value.startsWith("--")) {
        throw new Error(`--${key} 需要一个值`);
      }
      index += 1;
    }
    args[camel(key)] = value;
  }
  return args;
}

function usage() {
  return [
    "用法：",
    "  node bin/e2e.mjs bug    --case <用例.mjs> [--meta <meta.json>] [--dir <仓库>]",
    "  node bin/e2e.mjs change --case <用例.mjs> [--meta <meta.json>] [--dir <仓库>] [--before <ref>]",
    "  node bin/e2e.mjs doctor [--dir <仓库>]",
    "",
    "常用参数：",
    "  --out <目录>        指定产物目录（默认主检出 .scratch/e2e/<时间>-<slug>/）",
    "  --title <标题>      报告标题（默认取 meta.title）",
    "  --slug <名字>       报告文件名前缀（默认取 meta.slug / 标题）",
    "  --meta <文件|JSON>  现象/原因/修改方案/覆盖矩阵等报告内容",
    "  --env <URL|ID>      复用已有测试环境；change 模式下作为「修改后」环境",
    "  --before <ref>      change 的修改前基准（默认 git merge-base HEAD main）",
    "  --no-tts            不生成中文旁白，只保留字幕",
    "  --voice <名字>      SAPI 语音（默认 Microsoft Huihui Desktop）",
    "  --tts-rate <数字>   语速，-10..10，默认 -1",
    "  --viewport <WxH>    录制视口，默认 1440x900",
    "  --fps <数字>        帧率，默认 25",
    "  --passphrase <口令> 测试环境口令，默认 test",
    "  --build             启动测试环境时强制构建",
    "  --keep              保留测试环境和修改前 worktree",
    "  --force             产物目录已存在时另起一个后缀目录",
    "",
    "示例：",
    "  node .pi/skills/pi-web-e2e-test/bin/e2e.mjs bug \\",
    "    --case .scratch/e2e/demo/bug.mjs --meta .scratch/e2e/demo/meta.json",
    ""
  ].join("\n");
}

function makeLogger(file) {
  return (message) => {
    const text = String(message ?? "");
    console.log(text);
    if (!file) return;
    try {
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`);
    } catch {
      /* the console still has it */
    }
  };
}

function loadMeta(value) {
  if (!value) return {};
  const text = String(value).trim();
  if (text.startsWith("{")) return JSON.parse(text);
  const file = path.resolve(text);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/i.exec(String(value || "").trim());
  if (!match) return { width: 1440, height: 900 };
  return {
    width: Math.max(320, Math.min(3840, Number(match[1]))),
    height: Math.max(240, Math.min(2160, Number(match[2])))
  };
}

function uniqueDir(base, force) {
  let dir = base;
  let index = 2;
  while (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    if (!force) {
      throw new Error(`产物目录已存在且非空：${dir}\n换一个 --out，或加 --force 另起一个后缀目录。`);
    }
    dir = `${base}-${index}`;
    index += 1;
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function envFromUrlOrId(repoDir, value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    return { id: null, url: normalizeBaseUrl(value), reused: true };
  }
  const found = listEnv(repoDir).instances.find((item) => item.id === value);
  if (!found) throw new Error(`找不到测试环境 ${value}；先运行 env.mjs list 看看。`);
  return { ...found, reused: true };
}

async function startOrReuseEnv({ repoDir, value, name, build, log }) {
  const reused = envFromUrlOrId(repoDir, value);
  if (reused) {
    log(`复用测试环境：${reused.id || "外部 URL"} ${reused.url}`);
    return reused;
  }
  const entry = await startEnv({ repoDir, name, build, log });
  return { ...entry, reused: false };
}

function stopIfOwned(env, repoDir, keep, log) {
  if (!env || env.reused || keep || !env.id) return;
  try {
    const result = stopEnv(env.id, { repoDir });
    log(`已停止测试环境 ${env.id}（退出码 ${result.status ?? "?"}）`);
  } catch (error) {
    log(`停止测试环境 ${env.id} 失败：${error.message}`);
  }
}

async function recordOne(options) {
  const { side, repoDir, toolRepoDir, baseUrl, caseFile, outDir, meta, args, env, log } = options;
  log(`--- ${side}：${baseUrl} ---`);
  const raw = await recordSide({
    repoDir,
    toolRepoDir,
    baseUrl,
    passphrase: args.passphrase || PASSPHRASE,
    caseFile,
    side,
    outDir,
    title: meta.title || args.title || "",
    reportTitle: meta.title || args.title || "",
    meta,
    ttsOptions: {
      enabled: !args.noTts,
      voice: args.voice,
      rate: args.ttsRate == null ? -1 : Number(args.ttsRate)
    },
    viewport: parseViewport(args.viewport),
    fps: Number(args.fps) || 25,
    log,
    git: safeGit(repoDir),
    env: env
      ? {
          id: env.id || null,
          url: env.url,
          branch: env.branch || "",
          head: env.head || "",
          dirty: env.dirty ?? null,
          reused: Boolean(env.reused)
        }
      : null
  });
  log(`--- ${side} 录完：${raw.cases?.length || 0} 条用例，${Number(raw.durationRaw).toFixed(2)}s，ok=${raw.ok} ---`);
  return raw;
}

function safeGit(dir) {
  try {
    return gitInfo(dir);
  } catch {
    return null;
  }
}

function writeErrorReport({ outDir, mode, meta, title, slug, repoDir, error, log, command, caseFile }) {
  const spec = {
    schema: 1,
    title: meta.title || title || "pi-web-e2e-test",
    generatedAt: new Date().toISOString(),
    outDir,
    command: command || "",
    caseFile: caseFile || "",
    meta: {
      ...meta,
      summary: [meta.summary, `运行失败：${error.message}`].filter(Boolean).join("\n\n")
    },
    git: { before: null, after: safeGit(repoDir) },
    env: { before: null, after: null },
    sides: {},
    cases: [],
    summary: {
      before: { total: 0, pass: 0, fail: 0, error: 0, missing: 0 },
      after: { total: 0, pass: 0, fail: 0, error: 0, missing: 0 }
    },
    error: error.message
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
  const html = renderReport({ spec, mode, title: spec.title });
  const file = path.join(outDir, `${slug}${mode === "bug" ? "bug" : "变更"}.html`);
  fs.writeFileSync(file, html);
  log(`错误报告：${file}`);
}

async function runBug(args, context) {
  const { repoDir, toolRepoDir, outDir, meta, title, slug, caseFile, log } = context;
  const name = `e2e-${context.stamp}-${asciiSlug(slug) || "bug"}`;
  const env = await startOrReuseEnv({
    repoDir,
    value: args.env,
    name,
    build: args.build,
    log
  });
  try {
    await recordOne({
      side: "after",
      repoDir,
      toolRepoDir,
      baseUrl: env.url,
      caseFile,
      outDir,
      meta,
      args,
      env,
      log
    });
  } finally {
    stopIfOwned(env, repoDir, args.keep, log);
  }

  const spec = await finalizeRun({
    outDir,
    sides: ["after"],
    fps: Number(args.fps) || 25,
    meta,
    command: context.command,
    caseFile: context.caseFileCopy,
    log
  });
  const html = renderReport({ spec, mode: "bug", title });
  const file = path.join(outDir, `${slug}bug.html`);
  fs.writeFileSync(file, html);
  log(`问题报告：${file}`);
  if (!spec.sides?.after?.video) process.exitCode = 1;
  return { spec, report: file };
}

async function runChange(args, context) {
  const { repoDir, toolRepoDir, outDir, meta, title, slug, caseFile, log } = context;
  const beforeRef = args.before || mergeBase(repoDir, "main");
  const runId = `${context.stamp}-${asciiSlug(slug) || "e2e"}`;
  const envBase = `e2e-${context.stamp}-${asciiSlug(slug) || "e2e"}`;
  let beforeWorktree = null;
  let beforeEnv = null;
  let afterEnv = null;

  log(`修改前基准：${beforeRef}`);
  beforeWorktree = createBeforeWorktree({ repoDir, ref: beforeRef, runId });
  log(`修改前 worktree：${beforeWorktree.dir}`);

  try {
    beforeEnv = await startOrReuseEnv({
      repoDir: beforeWorktree.dir,
      value: null,
      name: `${envBase}-before`,
      build: args.build,
      log
    });
    await recordOne({
      side: "before",
      repoDir: beforeWorktree.dir,
      toolRepoDir,
      baseUrl: beforeEnv.url,
      caseFile,
      outDir,
      meta,
      args,
      env: beforeEnv,
      log
    });
  } finally {
    stopIfOwned(beforeEnv, beforeWorktree.dir, args.keep, log);
    beforeEnv = null;
    if (!args.keep) {
      const removed = removeBeforeWorktree({ dir: beforeWorktree.dir, main: beforeWorktree.main });
      log(`修改前 worktree 清理：${removed.removed ? "已删除" : "未删除"}`);
      beforeWorktree = null;
    } else {
      log(`保留修改前 worktree：${beforeWorktree.dir}`);
    }
  }

  afterEnv = await startOrReuseEnv({
    repoDir,
    value: args.env,
    name: `${envBase}-after`,
    build: args.build,
    log
  });
  try {
    await recordOne({
      side: "after",
      repoDir,
      toolRepoDir,
      baseUrl: afterEnv.url,
      caseFile,
      outDir,
      meta,
      args,
      env: afterEnv,
      log
    });
  } finally {
    stopIfOwned(afterEnv, repoDir, args.keep, log);
  }

  const spec = await finalizeRun({
    outDir,
    sides: ["before", "after"],
    fps: Number(args.fps) || 25,
    meta,
    command: context.command,
    caseFile: context.caseFileCopy,
    log
  });
  const html = renderReport({ spec, mode: "change", title });
  const file = path.join(outDir, `${slug}变更.html`);
  fs.writeFileSync(file, html);
  log(`变更报告：${file}`);

  const failed = (spec.cases || []).some(
    (item) => !item.after || item.after.status !== "pass"
  );
  if (failed || (spec.summary?.after?.total || 0) === 0) process.exitCode = 1;
  return { spec, report: file };
}

async function doctor(args) {
  const repoDir = path.resolve(args.dir || process.cwd());
  let failed = false;
  const line = (ok, label, detail = "") => {
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `：${detail}` : ""}`);
    if (!ok) failed = true;
  };

  line(true, "node", process.version);
  try {
    const main = mainRoot(repoDir);
    line(true, "主检出", main);
    const info = gitInfo(repoDir);
    line(true, "当前代码", `${info.branch || "detached"} @ ${info.head}${info.dirty ? "（有未提交改动）" : ""}`);
  } catch (error) {
    line(false, "git", error.message);
  }

  try {
    const info = ffmpegInfo();
    line(Boolean(info.libx264 && info.aac), "ffmpeg", `${info.version} @ ${info.ffmpeg}`);
  } catch (error) {
    line(false, "ffmpeg", error.message);
  }

  try {
    const loader = path.join(repoDir, "tools", "playwright.mjs");
    const { loadPlaywright } = await import(pathToFileURL(loader).href);
    const { chromium, source } = await loadPlaywright();
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    line(true, "Playwright", source || "已启动 Chromium");
  } catch (error) {
    line(false, "Playwright", error.message);
  }

  try {
    const voices = await listTtsVoices();
    const chinese = voices.filter((voice) => /zh|Chinese|Huihui|Yaoyao/i.test(`${voice.name} ${voice.culture}`));
    if (chinese.length > 0) {
      line(true, "中文 TTS", chinese.map((voice) => `${voice.name} (${voice.culture})`).join(", "));
    } else {
      console.log("! 中文 TTS：没有找到 zh-* 语音，可用 --no-tts 只保留字幕");
    }
  } catch (error) {
    console.log(`! 中文 TTS：${error.message}（可用 --no-tts 只保留字幕）`);
  }

  try {
    const cli = path.join(repoDir, ".pi", "skills", "pi-web-client-test-dev", "bin", "env.mjs");
    line(fs.existsSync(cli), "测试环境 CLI", cli);
    line(true, "运行中的测试环境", `${listEnv(repoDir).instances.length} 个`);
  } catch (error) {
    line(false, "测试环境 CLI", error.message);
  }

  try {
    findFfmpeg();
  } catch {
    /* already reported */
  }

  if (failed) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.mode) {
    console.log(usage());
    if (!args.mode) process.exitCode = 1;
    return;
  }
  if (args.mode === "doctor") {
    await doctor(args);
    return;
  }
  if (args.mode !== "bug" && args.mode !== "change") {
    throw new Error(`未知模式：${args.mode}\n\n${usage()}`);
  }
  if (!args.case) throw new Error("缺少 --case <用例.mjs>");

  const command = [process.execPath, ...process.argv.slice(1)]
    .map((part) => (/[\s"]/.test(String(part)) ? JSON.stringify(String(part)) : String(part)))
    .join(" ");
  let caseFileCopy = "";

  const repoDir = path.resolve(args.dir || process.cwd());
  const toolRepoDir = path.resolve(import.meta.dirname, "../../../..");
  const main = mainRoot(repoDir);
  const caseFile = path.resolve(args.case);
  if (!fs.existsSync(caseFile)) throw new Error(`用例文件不存在：${caseFile}`);
  const meta = loadMeta(args.meta);
  const title = args.title || meta.title || (args.mode === "bug" ? "BUG 复现" : "变更验收");
  const slug =
    safeFileStem(args.slug || meta.slug || meta.title || title) || (args.mode === "bug" ? "bug" : "change");
  const stamp = runStamp();
  const outBase = args.out
    ? path.resolve(args.out)
    : path.join(main, ".scratch", "e2e", `${stamp}-${asciiSlug(slug) || "e2e"}`);
  const outDir = uniqueDir(outBase, args.out ? args.force : true);
  const caseCopyDir = path.join(outDir, "cases");
  fs.mkdirSync(caseCopyDir, { recursive: true });
  caseFileCopy = path.join(caseCopyDir, path.basename(caseFile));
  if (path.resolve(caseFile) !== path.resolve(caseFileCopy)) {
    fs.copyFileSync(caseFile, caseFileCopy);
  }
  const logFile = path.join(outDir, "run.log");
  const log = makeLogger(logFile);
  fs.writeFileSync(logFile, "");

  log(`模式：${args.mode}`);
  log(`仓库：${repoDir}`);
  log(`用例：${caseFile}`);
  log(`用例副本：${caseFileCopy}`);
  log(`命令：${command}`);
  log(`产物：${outDir}`);
  log(`标题：${title}`);
  log(`slug：${slug}`);

  try {
    const context = {
      repoDir,
      toolRepoDir,
      outDir,
      meta,
      title,
      slug,
      caseFile,
      caseFileCopy,
      command,
      log,
      stamp
    };
    const result = args.mode === "bug" ? await runBug(args, context) : await runChange(args, context);
    log(`完成：${result.report}`);
    if (result.spec?.sides) {
      const after = result.spec.sides.after;
      const before = result.spec.sides.before;
      if (before) log(`修改前状态：${before.status}`);
      if (after) log(`修改后状态：${after.status}`);
    }
  } catch (error) {
    log(`失败：${error.stack || error.message}`);
    try {
      writeErrorReport({
        outDir,
        mode: args.mode,
        meta,
        title,
        slug,
        repoDir,
        error,
        log,
        command,
        caseFile: caseFileCopy,
      });
    } catch (reportError) {
      log(`错误报告也写不出来：${reportError.message}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
