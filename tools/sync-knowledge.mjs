#!/usr/bin/env node
/**
 * 知识库数据导出：把 BuildHub 克隆站（默认 `E:/yqm/vibe-hub-local`）的内容转成客户端能直接
 * `fetch` 的静态文件，落在 `web/public/knowledge/`。
 *
 * 为什么要这一步：站内正文是现成的 HTML 片段 + 一份 1.2 MB 的站点样式表，客户端不会去跑
 * 那个 Next 站点，也不该把 565 条正文塞进 JS bundle。于是：
 *
 * - 正文 → `web/public/knowledge/*.json`，页面打开时一次 fetch，内存建索引；
 * - 站点样式表 → `web/public/knowledge/site.css`，整份搬来但每条选择器都缩进 `.kb-site`
 *   作用域里：站内的 `--bg / --text / --border / --radius` 与客户端同名不同义，不作用域化
 *   会顺着 `:root` 把整个界面染一遍。深色走 `.kb-site[data-kb-dark]`（站内那套
 *   `:root[data-color-mode=dark]` 只认它自己的 html 标签）。
 * - 图片 / 视频 → `web/public/knowledge/assets/`，**转码**成小 webp（`tools/kb-assets.py`，
 *   PIL + ffmpeg）：原目录那 187 MB 的展示墙（5 MB 一张的 HD 截图、10 MB 的 mp4）照搬不了。
 *   视频只留第一帧当封面，`<video>` 换成 `<img>`，`poster` 优先 —— 知识库是阅读页，
 *   不是作品集播放器。
 * - 字体 → 原样拷贝（woff2 本来就只有 116 KB）。
 *
 * 懒加载：`/knowledge/site.css` 在页面第一次打开时才挂 `<link>`，`*.json` 才 fetch。
 *
 * 用法：
 *   node tools/sync-knowledge.mjs                        # 用默认源目录
 *   node tools/sync-knowledge.mjs --src D:/build-hub     # 换一份站点源码
 *   node tools/sync-knowledge.mjs --check                # 只报告会写什么，不转码不落盘
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DEFAULT_SRC = "E:/yqm/vibe-hub-local";
const OUT = path.join(REPO, "web/public/knowledge");

/** 站点 public 里会被正文引用的两类前缀。 */
const ASSET_PREFIXES = ["/assets/", "/fonts/"];
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);

/**
 * 正文里不会出现、但我们要用的包裹类（渲染器自己加的）。
 * 判断「这条 CSS 规则正文用得到吗」时它们算用到；以 `detail- / dh- / vh- / kb-` 打头的也算。
 */
const WRAPPER_CLASSES = new Set([
  "kb-site",
  "kb-poster",
  "detail-body",
  "detail-hero",
  "dh-head",
  "dh-quote",
  "dh-quote-label",
  "dh-quote-text",
  "dh-tagline",
  "dh-summary-lead",
  "dh-summary-separator",
  "alias-row",
  "detail-demo",
  "dh-demo",
  "dh-demo-viewport",
  "dh-demo-inner",
  "vh-raw-section",
  "vh-raw-first",
  "mk",
  "anat-stage",
  "variant-demo",
  "is-style-scene",
]);
const WRAPPER_PREFIX = /^(detail|dh|vh|kb)-/;

const say = (line) => process.stdout.write(`${line}\n`);

function parseArgs(argv) {
  const out = { src: DEFAULT_SRC, out: "", check: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--src") out.src = argv[++i] ?? out.src;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--check") out.check = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

/** 资源唯一名：`<basename>-<sha1(相对路径)[0:8]>[-poster].webp`，同名不同目录的文件不会互相覆盖。 */
function assetName(rel, suffix = "") {
  const base = path
    .basename(rel, path.extname(rel))
    .replace(/[^\w.-]+/g, "-")
    .slice(0, 56);
  const hash = createHash("sha1").update(rel).digest("hex").slice(0, 8);
  return `${base}-${hash}${suffix}.webp`;
}

/** 一次导出里所有资源任务的登记处：相对 public 的源路径 → 输出。 */
function makeAssetBook(publicDir) {
  const jobs = new Map(); // rel → { rel, file, kind }
  const book = {
    jobs,
    /** `/assets/x.png` → `/knowledge/assets/x-1a2b3c4d.webp`，同时登记转码任务。 */
    resolve(url) {
      const rel = url.slice(1);
      const ext = path.extname(rel).toLowerCase();
      if (!ASSET_PREFIXES.some((p) => url.startsWith(p))) return url;
      if (VIDEO_EXT.has(ext)) {
        const file = `assets/${assetName(rel, "-poster")}`;
        jobs.set(rel, { rel, file, kind: "video" });
        return `/knowledge/${file}`;
      }
      if (IMAGE_EXT.has(ext)) {
        const file = `assets/${assetName(rel)}`;
        jobs.set(rel, { rel, file, kind: "image" });
        return `/knowledge/${file}`;
      }
      // woff2 之流：原样拷贝
      jobs.set(rel, { rel, file: rel, kind: "copy" });
      return `/knowledge/${rel}`;
    },
    manifest() {
      return [...jobs.values()].map((job) => ({
        src: path.join(publicDir, job.rel),
        dst: path.join(OUT, job.file),
        kind: job.kind,
      }));
    },
  };
  return book;
}

function collectClasses(html, used) {
  if (typeof html !== "string" || !html) return;
  for (const m of html.matchAll(/\bclass="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
}

/** `<video src=… poster=… style=…>` → `<img class="kb-poster" src="<封面>" style=…>`。 */
function videoToPoster(tag, book) {
  const attr = (name) => {
    const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : "";
  };
  const style = attr("style");
  const cls = attr("class");
  const src = attr("src");
  const poster = attr("poster");
  const target = poster && poster.startsWith("/") ? book.resolve(poster) : src && src.startsWith("/") ? book.resolve(src) : "";
  if (!target) return "";
  const classes = ["kb-poster", ...cls.split(/\s+/).filter(Boolean)].join(" ");
  return `<img class="${classes}" src="${target}" alt="" loading="lazy"${style ? ` style="${style}"` : ""}>`;
}

/**
 * 正文片段：改写资源路径、把 `<video>` 换成封面图、顺手收集用到的类。
 * 只碰 `src/poster/srcset/url()` 这几处，其余标记一路原样带走。
 */
function rewriteHtml(input, book, used) {
  if (typeof input !== "string" || !input) return input;
  collectClasses(input, used);
  const withoutVideo = input.replace(/<video\b[^>]*>(?:[\s\S]*?<\/video>)?/g, (tag) => videoToPoster(tag, book));
  return withoutVideo
    .replace(/\b(src|poster)="(\/[^"]*)"/g, (_m, attr, url) => `${attr}="${book.resolve(url)}"`)
    .replace(/\bsrcset="([^"]*)"/g, (_m, list) => {
      const next = list
        .split(",")
        .map((part) => {
          const [url, ...rest] = part.trim().split(/\s+/);
          return [url.startsWith("/") ? book.resolve(url) : url, ...rest].filter(Boolean).join(" ");
        })
        .join(", ");
      return `srcset="${next}"`;
    })
    .replace(/url\((["']?)(\/[^)"']*)\1\)/g, (_m, q, url) => `url(${q}${book.resolve(url)}${q})`);
}

/** 任意嵌着 HTML 的字段（字符串 / 字符串数组 / 对象）都过一遍。 */
function rewriteDeep(value, book, used) {
  if (typeof value === "string") return rewriteHtml(value, book, used);
  if (Array.isArray(value)) return value.map((v) => rewriteDeep(v, book, used));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteDeep(v, book, used);
    return out;
  }
  return value;
}

/** 只留正文渲染真正会读到的字段，别把站点内部的状态字段带进客户端。 */
function pickTerm(term, book, used) {
  const sections = Array.isArray(term.sections) ? term.sections : [];
  return {
    slug: term.slug,
    name: term.name ?? term.slug,
    en: term.en ?? "",
    quoteLabel: term.quoteLabel ?? "",
    quote: rewriteDeep(term.quote ?? "", book, used),
    summaryLead: rewriteDeep(term.summaryLead ?? "", book, used),
    summaryRest: rewriteDeep(term.summaryRest ?? "", book, used),
    aliases: Array.isArray(term.aliases) ? term.aliases : [],
    demoHtml: rewriteDeep(term.demoHtml ?? "", book, used),
    sections: sections.map((s) => ({
      title: s.title ?? "",
      html: rewriteDeep(s.html ?? "", book, used),
      stageHtml: rewriteDeep(s.stageHtml ?? "", book, used),
      parts: rewriteDeep(s.parts ?? [], book, used),
      variants: rewriteDeep(s.variants ?? [], book, used),
      scenes: rewriteDeep(s.scenes ?? [], book, used),
      references: rewriteDeep(s.references ?? [], book, used),
    })),
    prev: term.prev ?? null,
    next: term.next ?? null,
  };
}

// ---------------------------------------------------------------- 站点样式表

/** 按**括号深度 0** 的逗号切选择器：`:is(.a,.b)` 是一个选择器，不能从中间劈开。 */
function splitSelectors(prelude) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prelude.length; i += 1) {
    const c = prelude[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  out.push(prelude.slice(start));
  return out;
}

const classTokens = (selector) => [...selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]);

/**
 * 把站点样式表整份缩进 `.kb-site`。
 *
 * - `:root` → `.kb-site`；`:root[data-color-mode=dark]` → `.kb-site[data-kb-dark]`；
 * - 其余选择器加 `.kb-site ` 前缀（已在作用域里的不重复加）；
 * - `@media` / `@supports` / `@container` / `@layer` 递归进去；`@font-face` / `@keyframes` 原样保留；
 * - `@charset` / `@import` 与纯元素选择器（html / body / *）丢掉：外壳的排版归客户端管；
 * - 规则一条不删；只有**选择器里的类正文一个都没用到**时，才把它 `url(/assets/…)` 那几条声明
 *   摘掉（展示墙的 187 MB 图就是这么甩掉的），其余声明照留。
 */
function scopeCss(src, used, book) {
  const isUsedClass = (c) => used.has(c) || WRAPPER_CLASSES.has(c) || WRAPPER_PREFIX.test(c);

  const scopeSelector = (sel) => {
    const s = sel.trim();
    if (!s || s.startsWith("@")) return "";
    const mapped = s
      .replace(/:root\[data-color-mode=["']?dark["']?\]/g, ".kb-site[data-kb-dark]")
      .replace(/:root\[data-color-mode=["']?light["']?\]/g, ".kb-site")
      .replace(/:root/g, ".kb-site");
    if (mapped.includes(".kb-site")) return mapped;
    if (/^(html|body|\*)\b/.test(mapped)) return "";
    return `.kb-site ${mapped}`;
  };

  /** 从 `text[from]` 找到与它配对的 `}` 的下标（跳过引号里的内容）。 */
  const matchBrace = (text, from) => {
    let depth = 0;
    for (let i = from; i < text.length; i += 1) {
      const c = text[i];
      if (c === '"' || c === "'") {
        const quote = c;
        i += 1;
        while (i < text.length && text[i] !== quote) {
          if (text[i] === "\\") i += 1;
          i += 1;
        }
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return text.length;
  };

  /** 声明级处理：正文用得到的 url() 照搬（转码后），用不到的整条声明丢掉。 */
  const declarations = (body, relevant) => {
    if (!body.includes("url(")) return body;
    return body
      .split(";")
      .map((decl) => {
        if (!/url\(/.test(decl)) return decl;
        if (!relevant && /url\(["']?\/assets\//.test(decl)) return "";
        return decl.replace(/url\((["']?)(\/[^)"']*)\1\)/g, (_m, q, url) => `url(${q}${book.resolve(url)}${q})`);
      })
      .filter((decl) => decl.trim())
      .join(";");
  };

  const rules = (text) => {
    const buf = [];
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "@") {
        const start = i;
        while (i < text.length && text[i] !== "{" && text[i] !== ";") {
          if (text[i] === '"' || text[i] === "'") {
            const quote = text[i];
            i += 1;
            while (i < text.length && text[i] !== quote) {
              if (text[i] === "\\") i += 1;
              i += 1;
            }
          }
          i += 1;
        }
        const prelude = text.slice(start, i).trim();
        if (text[i] === ";") {
          i += 1; // @charset / @import
          continue;
        }
        const close = matchBrace(text, i);
        const body = text.slice(i + 1, close);
        i = close + 1;
        if (/^@(media|supports|container|layer)/i.test(prelude)) {
          const inner = rules(body);
          if (inner) buf.push(`${prelude}{${inner}}`);
        } else if (/^@font-face/i.test(prelude)) {
          buf.push(`${prelude}{${declarations(body, true)}}`);
        } else {
          buf.push(`${prelude}{${body}}`);
        }
        continue;
      }
      if (c === "{") {
        i += 1; // 不该出现：规则总是先读到 prelude 才见到 '{'
        continue;
      }
      const start = i;
      while (i < text.length && text[i] !== "{") {
        if (text[i] === '"' || text[i] === "'") {
          const quote = text[i];
          i += 1;
          while (i < text.length && text[i] !== quote) {
            if (text[i] === "\\") i += 1;
            i += 1;
          }
        }
        i += 1;
      }
      if (i >= text.length) break;
      const prelude = text.slice(start, i).trim();
      const close = matchBrace(text, i);
      const body = text.slice(i + 1, close);
      i = close + 1;
      if (!prelude) continue;
      const sels = splitSelectors(prelude)
        .map((s) => scopeSelector(s))
        .filter(Boolean);
      if (!sels.length) continue;
      const cls = sels.flatMap((s) => classTokens(s)).filter((c) => c !== "kb-site" && c !== "kb-dark");
      const relevant = cls.length === 0 || cls.some((c) => isUsedClass(c));
      const bodyOut = body.includes("{") ? rules(body) : declarations(body, relevant);
      if (!bodyOut.trim()) continue;
      buf.push(`${sels.join(",")}{${bodyOut}}`);
    }
    return buf.join(" ").replace(/\s+/g, " ").trim();
  };

  return rules(src);
}

// ---------------------------------------------------------------- 主流程

async function readJson(dir, name) {
  const file = path.join(dir, name);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new Error(`读不到 ${file}（--src 指到 BuildHub 源码根了吗？）: ${err?.code ?? err}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} 不是合法 JSON：${err?.message ?? err}`);
  }
}

/** 调 `tools/kb-assets.py` 把登记的资源转成 webp；返回汇总。 */
async function transcode(manifest, check) {
  if (!manifest.length) return { done: 0, failed: [], inBytes: 0, outBytes: 0 };
  if (check) return { done: 0, failed: [], inBytes: 0, outBytes: 0, skipped: manifest.length };
  const tmp = path.join(OUT, ".manifest.json");
  await writeFile(tmp, JSON.stringify({ jobs: manifest }), "utf8");
  try {
    const { stdout } = await run("python", [path.join(HERE, "kb-assets.py"), tmp], {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  } finally {
    await rm(tmp, { force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    say("用法：node tools/sync-knowledge.mjs [--src <BuildHub 源码根>] [--out <目录>] [--check]");
    return;
  }
  const out = args.out ? path.resolve(args.out) : OUT;
  const dataDir = path.join(args.src, "src/data");
  const publicDir = path.join(args.src, "public");
  const cssSrc = path.join(args.src, "src/app/vibehub.css");

  const book = makeAssetBook(publicDir);
  const used = new Set();

  const [terms, enTerms, prompts, skills] = await Promise.all([
    readJson(dataDir, "terms.json"),
    readJson(dataDir, "en-terms.json"),
    readJson(dataDir, "prompts.json"),
    readJson(dataDir, "skills.json"),
  ]);
  const css = await readFile(cssSrc, "utf8");

  const zh = terms.map((t) => pickTerm(t, book, used));
  const en = enTerms.map((t) => pickTerm(t, book, used));
  const promptsOut = rewriteDeep(prompts, book, used);
  const skillsOut = rewriteDeep(skills, book, used);
  const siteCss = scopeCss(css, used, book);

  const counts = {
    terms: zh.length,
    termsEn: en.length,
    prompts: (promptsOut.categories ?? []).reduce((n, c) => n + (c.prompts?.length ?? 0), 0),
    skills: (skillsOut.categories ?? []).reduce((n, c) => n + (c.skills?.length ?? 0), 0),
    classes: used.size,
    images: [...book.jobs.values()].filter((j) => j.kind === "image").length,
    videos: [...book.jobs.values()].filter((j) => j.kind === "video").length,
    copies: [...book.jobs.values()].filter((j) => j.kind === "copy").length,
  };

  const files = [
    ["terms.zh.json", JSON.stringify(zh)],
    ["terms.en.json", JSON.stringify(en)],
    ["prompts.json", JSON.stringify(promptsOut)],
    ["skills.json", JSON.stringify(skillsOut)],
    ["site.css", siteCss],
    [
      "meta.json",
      JSON.stringify({ source: "BuildHub (one-person-lab/build-hub, MIT)", generatedAt: new Date().toISOString(), counts }, null, 2),
    ],
  ];

  const missing = [];
  let srcBytes = 0;
  for (const job of book.jobs.values()) {
    try {
      srcBytes += (await stat(path.join(publicDir, job.rel))).size;
    } catch {
      missing.push(job.rel);
    }
  }

  say(`源：${args.src}`);
  say(`目标：${out}`);
  for (const [name, body] of files) say(`  ${name.padEnd(14)} ${(body.length / 1024).toFixed(0)} KB`);
  say(
    `  正文用到 ${counts.classes} 个类 → 转码 ${counts.images} 张图 + ${counts.videos} 段视频封面，另拷 ${counts.copies} 个文件；源 ${(srcBytes / 1048576).toFixed(1)} MB`,
  );
  for (const rel of missing) say(`    缺：public/${rel}`);

  if (args.check) return;

  await mkdir(out, { recursive: true });
  for (const [name, body] of files) await writeFile(path.join(out, name), body, "utf8");

  const manifest = book.manifest().filter((job) => job.kind !== "copy");
  const result = await transcode(manifest, args.check);
  for (const [src, why] of result.failed ?? []) say(`    转码失败：${path.basename(src)} — ${why}`);
  if (result.done) say(`  转码 ${result.done} 个：${(result.inBytes / 1048576).toFixed(1)} MB → ${(result.outBytes / 1048576).toFixed(1)} MB`);

  for (const job of book.jobs.values()) {
    if (job.kind !== "copy") continue;
    const to = path.join(out, job.file);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(path.join(publicDir, job.rel), to);
  }
  say(`写好 ${files.length} 个文件 + ${book.jobs.size} 个资源。`);
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
