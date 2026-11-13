/**
 * 预览里的翻译对照（D241）。
 *
 * 一次翻译 = 一次 `/api/translate/start`。桥把正文按 `^#{1,2}` 切成「节」——节是左右对照的
 * 对齐锚点；节里的围栏代码原样跳过，其余正文按空行打包成 ~4k 字符的块，逐块交给一个**独立**
 * 的 `pi --mode text` 子进程去翻（不占当前对话的上下文，也不改当前会话的文件）。
 *
 * 结果落 `statePath("translate", …)` 缓存。每节记两条：`gen`（最后一次机器输出，同步回原文时
 * 当作基线）和 `out`（当前展示的译文，用户可能手改过）。于是：
 *   - 原文变了 → 只重翻变了的节（`gen` 当旧译文）；换模型 → 整篇重译；
 *   - 同步回原文 → 只把 `out ≠ gen` 的那几节反向译一遍，再用 diff 精确改原文。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import { piChildEnv, readJson, statePath, writeJson } from "./paths.ts";

export type TrLang = "zh" | "en" | "ja" | "ko";
export const TR_LANGS: TrLang[] = ["zh", "en", "ja", "ko"];
export const TR_LANG_NAME = {
  zh: "简体中文",
  en: "英语",
  ja: "日语",
  ko: "韩语",
} satisfies Record<TrLang, string>;

export function isTrLang(v: unknown): v is TrLang {
  return typeof v === "string" && (TR_LANGS as string[]).includes(v);
}

/** 整篇上限：再大就不是「预览里顺手翻一下」的场景了。 */
export const MAX_TRANSLATE_BYTES = 512 * 1024;
/** 一块交给模型的正文字符数。太小慢、太大容易被截断。 */
const CHUNK_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_RETRY = 1;

/* ── 分节 / 分块 ───────────────────────────────────────────────────────── */

/**
 * 按一级、二级标题切节。围栏代码里的 `# 注释` 和 `<!-- # -->` 不算标题。
 * 第一行的标题前若有内容，单独成一节（preamble）。
 */
export function splitSections(text: string): string[] {
  return cutSections(text).map((s) => s.text);
}

export interface Cut {
  text: string;
  /** 标题行的原文；preamble 是 ""。用来在「更新」时把没变的节对回去。 */
  heading: string;
}

export function cutSections(text: string): Cut[] {
  const lines = text.split("\n");
  const out: Cut[] = [];
  let cur: string[] = [];
  let heading = "";
  let fence: string | null = null;
  let inComment = false;

  const flush = () => {
    if (!cur.length) return;
    const t = cur.join("\n");
    if (t.length) out.push({ text: t, heading });
    cur = [];
  };

  for (const line of lines) {
    const t = line.trimStart();
    if (!inComment) {
      const f = /^(`{3,}|~{3,})/.exec(t);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      } else if (f) {
        fence = f[1];
      } else if (t.startsWith("<!--")) {
        if (!t.includes("-->")) inComment = true;
      }
    } else if (t.includes("-->")) {
      inComment = false;
    }

    if (!fence && !inComment && /^#{1,2}[ \t]+\S/.test(line)) {
      flush();
      heading = line.trim();
    }
    cur.push(line);
  }
  flush();
  return out;
}

/** 把切好的节拼回一整篇：节之间补一个空行（节本身收尾的空行已经算在里面）。 */
export function joinSections(sections: string[]): string {
  return sections
    .map((s) => s.replace(/\n+$/, ""))
    .filter((s) => s.length)
    .join("\n\n");
}

export interface CodePart {
  code: boolean;
  text: string;
}

/** 把一节切成「正文 / 围栏代码」交替的段，拼起来与原文逐字节相同。 */
export function splitCode(text: string): CodePart[] {
  const lines = text.split("\n");
  const parts: CodePart[] = [];
  let buf: string[] = [];
  let fence: string | null = null;

  const push = (code: boolean) => {
    if (!buf.length) return;
    parts.push({ code, text: buf.join("\n") });
    buf = [];
  };

  for (const line of lines) {
    const t = line.trimStart();
    const m = /^(`{3,}|~{3,})/.exec(t);
    if (fence) {
      buf.push(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
        fence = null;
        push(true);
      }
      continue;
    }
    if (m) {
      push(false);
      fence = m[1];
      buf.push(line);
      continue;
    }
    buf.push(line);
  }
  push(fence === null ? false : true);
  return parts;
}

/** 按空行切块（块内保留原有换行，块之间用空行隔开）。 */
export function splitBlocks(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map((b) => b.replace(/^\n+|\n+$/g, ""))
    .filter((b) => b.length);
}

/** 把块打包装进不超过 maxChars 的请求里；单个块超长就按行切。 */
export function packChunks(blocks: string[], maxChars = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 0;
  const flush = () => {
    if (!cur.length) return;
    out.push(cur.join("\n\n"));
    cur = [];
    size = 0;
  };

  for (const b of blocks) {
    if (b.length > maxChars) {
      flush();
      let buf: string[] = [];
      let n = 0;
      for (const line of b.split("\n")) {
        if (n + line.length + 1 > maxChars && buf.length) {
          out.push(buf.join("\n"));
          buf = [];
          n = 0;
        }
        buf.push(line);
        n += line.length + 1;
      }
      if (buf.length) out.push(buf.join("\n"));
      continue;
    }
    if (size + b.length + 2 > maxChars) flush();
    cur.push(b);
    size += b.length + 2;
  }
  flush();
  return out;
}

/* ── 输出校验 ──────────────────────────────────────────────────────────── */

const countPipes = (line: string) =>
  line.replace(/`[^`]*`/g, "").split("|").length - 1;

/**
 * 表格是最容易翻坏的结构（多一列、少一行），而且坏了页面直接散掉。
 * 返回 null = 没问题；否则是给人看的差异说明。
 */
export function tableDiff(src: string, out: string): string | null {
  const srcRows = src.split("\n").filter((l) => /^\s*\|/.test(l));
  if (!srcRows.length) return null;
  const outRows = out.split("\n").filter((l) => /^\s*\|/.test(l));
  if (srcRows.length !== outRows.length) {
    return `表格行数 ${srcRows.length} → ${outRows.length}`;
  }
  for (let i = 0; i < srcRows.length; i++) {
    if (countPipes(srcRows[i]) === countPipes(outRows[i])) continue;
    return `表格第 ${i + 1} 行的 | 数量 ${countPipes(srcRows[i])} → ${countPipes(outRows[i])}`;
  }
  return null;
}

/** 去掉模型偶尔套在最外层的 ``` 围栏和「译文：」前缀。 */
export function cleanOut(raw: string): string {
  let s = raw.trim();
  const f = /^(`{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/.exec(s);
  if (f && !f[2].includes("```")) s = f[2].trim();
  s = s.replace(/^(译文|翻译|Translation)[ \t]*[:：][ \t]*\n?/i, "");
  return s.trim();
}

/** 日文源翻成别的语言时，译文里不该再出现假名（出现多半是模型偷懒原样抄了）。 */
function looksUntranslated(lang: TrLang, src: string, out: string): string | null {
  if (lang === "ja") return null;
  const kana = (s: string) => (s.match(/[\u3040-\u30ff]/g) ?? []).length;
  const srcKana = kana(src);
  if (srcKana < 20) return null;
  if (kana(out) > srcKana * 0.8) return "译文几乎照抄了原文";
  return null;
}

/* ── 调模型 ────────────────────────────────────────────────────────────── */

export interface TrRun {
  /** `resolvePi().cli`：bundle 里 cli.js 的绝对路径。 */
  cli: string;
  cwd: string;
  lang: TrLang;
  provider: string;
  model: string;
  /** 模型出现在 fast 目录里 → 加 `-ne` 省掉扩展加载（实测快 12–15 秒）。 */
  fast: boolean;
  timeoutMs?: number;
}

export type TrRunner = (chunk: string, o: TrRun, kind: "forward" | "reverse") => Promise<string>;

const RULES = [
  "你是一个只做翻译的引擎，不做任何解释。",
  "输出必须是可直接替换原文的 Markdown，因此：",
  "1. 只输出译文本身，不要前缀、不要结束语、不要用代码围栏包住整段。",
  "2. 保留 Markdown 结构：标题级别、列表符号与缩进、表格的行数与每行的 `|` 数量、链接、图片、HTML 标签、行内代码。",
  "3. 不要翻译：代码、命令、变量名、类名、消息 ID、文件路径、URL、占位符（如 {番号}）。",
  "4. 单元格里的 <br>、<br/> 原样保留。",
  "5. 原文中已经是目标语言的部分保持不动。",
  "6. 表格外的短标签（如 ID 列表）按原文保留大小写。",
];

const SYS_FORWARD = (lang: TrLang) =>
  [...RULES, `7. 目标语言是${TR_LANG_NAME[lang]}。`].join("\n");

const SYS_REVERSE = (lang: TrLang) =>
  [
    "你是一个只做翻译的引擎，不做任何解释。",
    `把用户给的 Markdown 译文还原成${TR_LANG_NAME[lang]}原文。`,
    "要求：",
    "1. 只输出还原后的 Markdown，不要前缀、不要结束语、不要用代码围栏包住整段。",
    "2. 保留 Markdown 结构：标题级别、列表符号与缩进、表格的行数与每行的 `|` 数量、链接、图片、HTML 标签、行内代码。",
    "3. 代码、命令、变量名、类名、消息 ID、文件路径、URL、占位符（如 {番号}）原样保留。",
    "4. 如果给的原文也一并附上，就以原文为准：只把译文里被改过的地方体现回去，措辞、标点、换行尽量跟原文一致。",
    "5. 输出必须用【原文】的语言写：原文是日文就写日文（假名不能少），是中文就写中文，是英文就写英文。【改后的译文】只用来判断「意思改在哪里」，绝不能整段抄进结果。",
  ].join("\n");

export function translateArgs(o: TrRun, kind: "forward" | "reverse" = "forward"): string[] {
  const args = [
    o.cli,
    "--mode",
    "text",
    "--no-session",
    "--no-tools",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-mcp",
    "--thinking",
    "off",
    "--provider",
    o.provider,
    "--model",
    o.model,
    "--system-prompt",
    kind === "reverse" ? SYS_REVERSE(o.lang) : SYS_FORWARD(o.lang),
  ];
  if (o.fast) args.push("--no-extensions");
  return args;
}

/** 一块正文 → 一次独立的 pi 调用。正文走 stdin（不会被命令行长度限制截断）。 */
export function runPiTranslate(chunk: string, o: TrRun, kind: "forward" | "reverse" = "forward"): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = translateArgs(o, kind);
    const child = spawn(process.execPath, args, {
      cwd: o.cwd,
      env: piChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`模型 ${Math.round((o.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} 秒没有答完`));
    }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.stderr.on("data", (d: string) => {
      err = (err + d).slice(-2000);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        reject(new Error(`pi 退出码 ${code}：${err.trim().split("\n").slice(-3).join(" ")}`));
        return;
      }
      resolve(out);
    });

    const msg =
      kind === "reverse"
        ? "把上面的内容还原成原文，只输出 Markdown。"
        : "翻译上面的内容，只输出译文。";
    child.stdin.write(`${chunk}\n\n${msg}\n`);
    child.stdin.end();
  });
}

/* ── 一节 / 一篇 ──────────────────────────────────────────────────────── */

export interface TrSection {
  /** 节的标题行（preamble 为 ""），更新时用来配对。 */
  heading: string;
  /** 机器最后一次给出的译文。同步回原文的基线。 */
  gen: string;
  /** 当前展示的译文（用户可能改过）。 */
  out: string;
  /** 这一节的原文快照，用来判断「原文变了没有」。 */
  src: string;
}

/** 翻一节：代码段原样拼回，正文分块翻。 */
export async function translateSection(
  text: string,
  o: TrRun,
  run: TrRunner,
  hooks: { onChunk?: () => void } = {},
): Promise<{ out: string; warnings: string[] }> {
  const warnings: string[] = [];
  const parts = splitCode(text);
  const res: string[] = [];

  for (const part of parts) {
    if (part.code) {
      res.push(part.text);
      hooks.onChunk?.();
      continue;
    }
    // 代码段是独立 part，文本 part 的首尾空行要原样留住，否则围栏会粘到上一段上
    // （后果：块的划分和原文对不上，同步时会退化成整节重译）。
    const lead = /^\s*/.exec(part.text)?.[0] ?? "";
    const trail = /\s*$/.exec(part.text)?.[0] ?? "";
    const chunks = packChunks(splitBlocks(part.text));
    const done: string[] = [];
    for (const chunk of chunks) {
      let got = "";
      for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
          got = cleanOut(await run(chunk, o, "forward"));
        } catch (e) {
          warnings.push((e as Error).message);
          break;
        }
        const bad = tableDiff(chunk, got) ?? looksUntranslated(o.lang, chunk, got);
        if (!bad) break;
        if (attempt === MAX_RETRY) {
          warnings.push(`${bad}；这一段保留原文`);
          got = "";
        }
      }
      done.push(got || chunk);
      hooks.onChunk?.();
    }
    res.push(lead + done.join("\n\n") + trail);
  }
  return { out: res.join("\n"), warnings };
}

export interface TranslateHooks {
  onProgress?: (done: number, total: number, note: string) => void;
  /** 每完成一节就回调一次，调用方可以边翻边落盘（页面能看到进度，不用等整篇）。 */
  onSection?: (sections: TrSection[]) => void;
  signal?: { aborted: boolean };
}

/** 只翻想要的节；`keep` 里给出旧节（原文没变就沿用旧译文）。 */
export async function translateDoc(
  text: string,
  o: TrRun,
  run: TrRunner,
  hooks: TranslateHooks & { keep?: Map<string, TrSection> } = {},
): Promise<{ sections: TrSection[]; warnings: string[] }> {
  const cuts = cutSections(text);
  const total = cuts.length;
  const sections: TrSection[] = [];
  const warnings: string[] = [];
  let done = 0;

  for (const cut of cuts) {
    if (hooks.signal?.aborted) throw new Error("已取消");
    const old = hooks.keep?.get(keyOf(cut));
    if (old && old.src === cut.text && old.out) {
      sections.push({ ...old, heading: cut.heading });
      done++;
      hooks.onSection?.(sections);
      hooks.onProgress?.(done, total, cut.heading || "开头");
      continue;
    }
    const { out, warnings: w } = await translateSection(cut.text, o, run, {
      onChunk: () => hooks.onProgress?.(done, total, cut.heading || "开头"),
    });
    warnings.push(...w);
    sections.push({ heading: cut.heading, gen: out, out, src: cut.text });
    done++;
    hooks.onSection?.(sections);
    hooks.onProgress?.(done, total, cut.heading || "开头");
  }
  return { sections, warnings };
}

const keyOf = (c: Cut) => c.heading || "\u0000preamble";

/* ── 同步回原文 ───────────────────────────────────────────────────────── */

export interface SyncEdit {
  /** 原文里要被替换的那一段。 */
  before: string;
  after: string;
}

export interface SyncResult {
  edits: SyncEdit[];
  warnings: string[];
}

export interface ReverseIn {
  /** 原文这一块（机器翻译时的样子）。 */
  src: string;
  /** 机器给的译文基线。 */
  gen: string;
  /** 现在展示的译文（可能被人改过）。 */
  out: string;
}

/** 结果是模型给的但内容不对（不是调用失败）：这种才值得重试一次。 */
class BadOutput extends Error {}

/**
 * 反向写回最常见的翻车：模型把「改后的译文」整段抄回去 —— 看着写成功了，
 * 原文里却混进了译文的语言（中文标题盖到日文原文上）。只校验结构拦不住，
 * 还得看「结果是不是原文那一套字」。
 */
function reverseDrift(src: string, gen: string, out: string, nextOut: string): string | null {
  // 「把译文抄回去」只在原文与基线译文本来就不同时才算错：同语言（或本来就是照抄回原文）时抄了也对。
  if (out.trim() === nextOut.trim() && src.trim() !== gen.trim()) return "模型直接抄了改后的译文";
  const kana = (s: string) => (s.match(/[\u3040-\u30ff]/g) ?? []).length;
  const latin = (s: string) => (s.match(/[A-Za-z]/g) ?? []).length;
  const chars = (s: string) => s.replace(/\s+/g, "").length || 1;
  const srcKana = kana(src);
  if (srcKana >= 3) {
    // 原文是日文：结果必须还是日文。纯汉字或一大片拉丁字母都算跑偏。
    if (kana(out) < Math.max(2, Math.floor(srcKana * 0.3))) return "写回的不是日文（几乎没有假名）";
    return null;
  }
  if (kana(out) > 4) return "写回的是日文，原文不是";
  if (latin(src) / chars(src) > 0.6 && latin(out) / chars(out) < 0.3) return "写回的不是原文的语言（英文字母没了）";
  return null;
}

/** 一块译文 → 原文。把「原文这一块」和「改后的译文这一块」一起给模型，
 * 并要求它只把改过的地方体现回原文：表里改了一个单元格，就只有那一格变，
 * 其余措辞、标点、换行照抄原文 —— 写回去的 diff 才小到能读。 */
export async function reverseBlock(input: ReverseIn, o: TrRun, run: TrRunner): Promise<string> {
  return reverseWithGuard(input, o, run, false);
}

/** 结构对不齐时的退路：整节重译。 */
async function reverseWhole(input: ReverseIn, o: TrRun, run: TrRunner): Promise<string> {
  return reverseWithGuard(input, o, run, true);
}

async function reverseAttempt(input: ReverseIn, o: TrRun, run: TrRunner, extra: string, whole: boolean): Promise<string> {
  const { src, gen: oldOut, out: nextOut } = input;
  const ask = whole
    ? "把改过的地方体现回原文，只输出结果。"
    : "把【改后的译文】里改过的地方体现回【原文】，其余部分照抄【原文】，只输出结果。";
  const body = [
    `【原文】\n${src}`,
    oldOut && oldOut !== nextOut ? `【原译文】\n${oldOut}` : "",
    `【改后的译文】\n${nextOut}`,
    "",
    ask,
  ]
    .filter((s) => s !== "")
    .join("\n\n");
  const text = cleanOut(await run(body + extra, o, "reverse"));
  if (!text.trim()) throw new BadOutput("模型没有给出可用的原文");
  const bad = tableDiff(src, text);
  if (bad) throw new BadOutput(`${bad}；这一块没有写回`);
  const drift = reverseDrift(src, oldOut, text, nextOut);
  if (drift) throw new BadOutput(`${drift}；这一块没有写回`);
  return text;
}

/** 内容不合格就带着理由再问一次；还不行就把错误抛上去（上层保留原文并告警，不写脏东西）。 */
async function reverseWithGuard(input: ReverseIn, o: TrRun, run: TrRunner, whole: boolean): Promise<string> {
  try {
    return await reverseAttempt(input, o, run, "", whole);
  } catch (e) {
    if (!(e instanceof BadOutput)) throw e;
    const extra = `\n\n（上一次的结果被退回：${e.message}。结果必须用【原文】的语言写，不要把【改后的译文】照抄过来。）`;
    return await reverseAttempt(input, o, run, extra, whole);
  }
}


/**
 * 译文 → 原文的改动清单。只处理「译文 ≠ 机器基线」的块；
 * 块对齐不上（人把段落合并/拆开了）就整节重译，并留一条警告。
 */
export async function planSync(
  doc: TrDoc,
  o: TrRun,
  run: TrRunner,
  hooks: { onProgress?: (done: number, total: number) => void } = {},
): Promise<SyncResult> {
  const edits: SyncEdit[] = [];
  const warnings: string[] = [];
  const todo: { sec: TrSection; i: number }[] = [];

  for (const sec of doc.sections) {
    if (sec.out === sec.gen) continue;
    const src = splitBlocks(sec.src);
    const gen = splitBlocks(sec.gen);
    const out = splitBlocks(sec.out);
    if (src.length !== gen.length || gen.length !== out.length) {
      warnings.push(`${sec.heading || "开头"}：段落结构变了，这一节整节重译`);
      edits.push({ before: sec.src, after: await reverseWhole({ src: sec.src, gen: sec.gen, out: sec.out }, o, run) });
      continue;
    }
    for (let i = 0; i < out.length; i++) if (out[i] !== gen[i]) todo.push({ sec, i });
  }

  let done = 0;
  for (const { sec, i } of todo) {
    done++;
    hooks.onProgress?.(done, todo.length);
    try {
      const before = splitBlocks(sec.src)[i];
      const gen = splitBlocks(sec.gen)[i];
      const out = splitBlocks(sec.out)[i];
      edits.push({ before, after: await reverseBlock({ src: before, gen, out }, o, run) });
    } catch (e) {
      warnings.push(`${sec.heading || "开头"}：${(e as Error).message}`);
    }
  }
  return { edits, warnings };
}

/** 把改动清单按顺序落到原文上。`before` 找不到 = 文件在别处被改过，跳过并报出来。 */
export function applySync(
  fileText: string,
  edits: SyncEdit[],
): { text: string; applied: SyncEdit[]; missing: SyncEdit[] } {
  let cur = fileText;
  let cursor = 0;
  const applied: SyncEdit[] = [];
  const missing: SyncEdit[] = [];
  for (const e of edits) {
    const at = cur.indexOf(e.before, cursor);
    if (at < 0) {
      missing.push(e);
      continue;
    }
    cur = cur.slice(0, at) + e.after + cur.slice(at + e.before.length);
    cursor = at + e.after.length;
    applied.push(e);
  }
  return { text: cur, applied, missing };
}

/* ── 缓存 ─────────────────────────────────────────────────────────────── */

export interface TrDoc {
  abs: string;
  lang: TrLang;
  provider: string;
  model: string;
  /** 生成这份译文时原文的 mtime / size，用来判断过期。 */
  mtime: number;
  size: number;
  startedAt: number;
  warnings: string[];
  sections: TrSection[];
}

export function cacheFile(abs: string, lang: TrLang): string {
  const h = createHash("sha1").update(`${abs.toLowerCase()}|${lang}`).digest("hex").slice(0, 16);
  const base = path.basename(abs).replace(/[^\w.\-\u4e00-\u9fff]+/g, "_").slice(0, 40);
  return statePath("translate", `${base}.${h}.json`);
}

/** 缓存文件由我们自己写，但版本可能比代码旧：缺字段一律当作没有。 */
export function readDoc(abs: string, lang: TrLang): TrDoc | null {
  const raw = readJson<TrDoc | null>(cacheFile(abs, lang), null);
  if (!raw || !Array.isArray(raw.sections) || !raw.sections.length) return null;
  const sections = raw.sections.filter((s) => s?.out && s?.src);
  if (!sections.length) return null;
  return { ...raw, sections, warnings: raw.warnings ?? [] };
}

export function writeDoc(doc: TrDoc): void {
  writeJson(cacheFile(doc.abs, doc.lang), doc);
}


/**
 * 默认拿哪个模型翻（D241）：用户没设过就用 `copilot/gpt-6-luna` —— 翻译这种活，便宜快就够。
 * 只存 `provider/id`，找不到这个模型时页面会让人重挑，并把选择写回这里。
 */
export const TR_DEFAULT_MODEL = "copilot/gpt-6-luna";

export interface TrPrefs {
  /** "provider/id"；空串表示「还没设过」，页面按 TR_DEFAULT_MODEL 去解析。 */
  model: string;
}

const PREFS_FILE = (): string => statePath("translate", "prefs.json");

export function readTrPrefs(): TrPrefs {
  const raw = readJson<TrPrefs | null>(PREFS_FILE(), null);
  const model = typeof raw?.model === "string" ? raw.model.trim() : "";
  return { model };
}

/** 只认 `provider/id` 这一种形状：别的写法存进去只会让下次解析不出来。 */
export function writeTrPrefs(patch: { model?: string }): TrPrefs {
  const cur = readTrPrefs();
  const model = typeof patch.model === "string" ? patch.model.trim() : cur.model;
  const ok = /^[^/\s]+\/[^/\s]+$/.test(model);
  const next: TrPrefs = { model: ok ? model : cur.model };
  writeJson(PREFS_FILE(), next);
  return next;
}

// 两份译文/原文都不变时不算变化；同步回原文只关心这台机器。
export const __test = { cutSections, looksUntranslated };
