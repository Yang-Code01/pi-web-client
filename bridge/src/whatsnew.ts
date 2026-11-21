import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { VERSION, readJsonChecked, statePath, writeJson } from "./paths.ts";

/**
 * D195：设置页「本项目更新日志」，和 pi 包里那个 CHANGELOG.md 不是一回事。
 *
 * 文件固定是检出根的 `CHANGELOG.md`。模块位置往上两层就是检出根 —— `bridge/src/*.ts`（源码
 * 直跑）和 `bridge/dist/*.js`（构建后）都落在 `<检出>/bridge/`，两种跑法得到同一个根。桥一般
 * 就跑在自己的检出里；换一份 checkout 起桥，读到的就是那一份的日志，这正是「本项目」的意思。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface SelfChangelog {
  /** 检出根 `package.json` 的 version。本项目没有 semver 承诺，这只是个锚点。 */
  version: string;
  /** 当前分支名；detached 时是空串。 */
  branch: string;
  /** 短 SHA；读不到时是空串（比如发行包里没有 .git）。 */
  commit: string;
  /** 检出根的绝对路径：正文里的 `docs/DECISIONS.md` 这类相对链接按它解析，与会话 cwd 无关。 */
  root: string;
  /** `CHANGELOG.md` 原文；没有这个文件时是空串。 */
  text: string;
}

const run = promisify(execFile);
const decoder = new TextDecoder("utf-8");

/** 产品版本 = 检出根 `package.json` 的 version；读不到才退回桥自己的（平时两个都是 0.1.0）。 */
function productVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    /* 退到 VERSION */
  }
  return VERSION;
}

/** git 只用来问「现在在哪」，慢一点无所谓；5 秒缓存免得连点 tab 时反复起进程。 */
let head: { at: number; branch: string; commit: string } | null = null;

async function readHead(): Promise<{ branch: string; commit: string }> {
  if (head && Date.now() - head.at < 5000) return head;
  const opts = { timeout: 3000, windowsHide: true, encoding: "utf8" } as const;
  try {
    // 两条命令：`rev-parse --short` 与 `--abbrev-ref` 不能同一条跑（fatal: Needed a single revision）。
    const [sha, branch] = await Promise.all([
      run("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], opts),
      // detached 时 `branch --show-current` 就是空串，正好是我们对外说的「没有分支」。
      run("git", ["-C", ROOT, "branch", "--show-current"], opts),
    ]);
    head = { at: Date.now(), commit: String(sha.stdout).trim(), branch: String(branch.stdout).trim() };
  } catch {
    head = { at: Date.now(), branch: "", commit: "" };
  }
  return head;
}

/** 检出根 `CHANGELOG.md` 的正文（注释已抹、超出上限的尾部切掉）。读不到就是空串。 */
function changelogText(maxBytes = 200_000): string {
  try {
    const buf = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"));
    // HTML 注释是给人机看的增量锚点（`<!-- 写到 <SHA> -->`），renderMarkdown 不认，留着会原样
    // 显示在面板里。在这里先抹掉，面板拿到的就是能直接渲染的正文。
    const raw = decoder.decode(buf).replace(/<!--[\s\S]*?-->/g, "");
    // 按字节切：切完从缓冲区解码，尾上一个被切一半的字符由 decoder 变成替换符，再抹掉。
    return Buffer.byteLength(raw, "utf8") > maxBytes
      ? `${decoder.decode(Buffer.from(raw, "utf8").subarray(0, maxBytes)).replace(/\uFFFD+$/, "")}\n\n…（更早的批次略）`
      : raw;
  } catch {
    return "";
  }
}

export async function selfChangelog(maxBytes = 200_000): Promise<SelfChangelog> {
  const text = changelogText(maxBytes);
  const { branch, commit } = await readHead();
  return { version: productVersion(), branch, commit, root: ROOT, text };
}

// ---------------------------------------------------------------- 启动时的「本项目更新日志」弹窗（#588 D358）

/** 一批 = 日志里一个 `## ` 小节。`title` 是那一行去掉 `## ` 之后的原文，也就是它的身份。 */
export interface WhatsnewBatch {
  title: string;
  body: string;
}

/** 落在状态目录里的已读：看到哪一批、上次真弹出去是什么时候、以及这个提示开不开。 */
export interface WhatsnewState {
  seenTitle: string;
  lastShownAt: number;
  /** 缺省（undefined）算开 —— 老状态文件里没有这个字段。 */
  enabled?: boolean;
}

/** D358：两次弹出之间至少隔一天。也是「判定机会」本身，不是额外的第二层。 */
export const WHATSNEW_THROTTLE_MS = 24 * 60 * 60 * 1000;

export type WhatsnewDecision =
  /** `older` = 比 `batch` 更早、但同样没看过的那几批（「还有 N 批」展开的就是它们）。 */
  | { status: "ok"; batch: WhatsnewBatch; older: WhatsnewBatch[] }
  /** 没有日志文件，或者里面一批也没有。 */
  | { status: "none" }
  /** 最新一批已经看过了。 */
  | { status: "no-new" }
  /** 有新批次，但离上次弹出不满一天。 */
  | { status: "throttled" }
  /** 设置里关掉了。 */
  | { status: "disabled" };

/**
 * 把日志原文切成批次，**保持文件顺序**（最新在前）。
 *
 * 只认二级标题 `## `：`# ` 是文档大标题，`### ` 是批次内的「新增 / 修复 / 设计决定」分组。
 * HTML 注释在这里再抹一次 —— `selfChangelog()` 已经抹过，但这个函数也给测试与将来的别的调用方用。
 */
export function whatsnewBatches(text: string): WhatsnewBatch[] {
  const out: WhatsnewBatch[] = [];
  let title: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (title !== null) out.push({ title, body: body.join("\n").trim() });
  };
  for (const line of text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const head = /^##\s+(.+?)\s*$/.exec(line);
    if (head) {
      flush();
      title = head[1];
      body = [];
      continue;
    }
    if (title !== null) body.push(line);
  }
  flush();
  return out;
}

/**
 * 该不该弹、弹哪一批。纯函数：没有 IO，`now` 由调用方给。
 *
 * 判定顺序就是「越早否掉越省事」：关掉 → 没日志 → 最新那批看过了 → 不满一天 → 弹。
 */
export function whatsnewDecision(input: {
  text: string;
  state: WhatsnewState;
  now: number;
  throttleMs?: number;
}): WhatsnewDecision {
  const { text, state, now } = input;
  if (state.enabled === false) return { status: "disabled" };
  const batches = whatsnewBatches(text);
  if (!batches.length) return { status: "none" };
  // 已读的那批不在列表里（日志被改写 / 回退 / 状态文件来自另一份检出）：当作没记录。
  const seenAt = state.seenTitle ? batches.findIndex((b) => b.title === state.seenTitle) : -1;
  const unread = seenAt < 0 ? batches.length : seenAt;
  if (!unread) return { status: "no-new" };
  const throttle = input.throttleMs ?? WHATSNEW_THROTTLE_MS;
  if (state.lastShownAt && now - state.lastShownAt < throttle) return { status: "throttled" };
  return { status: "ok", batch: batches[0], older: batches.slice(1, unread) };
}


// ---------------------------------------------------------------- 状态与派发（#588）

/** 「这次启动已经把未读交给了某个页面」—— 只在进程内，重启就清；窗口过了就能再派一次。 */
let claimed: { title: string; at: number } | null = null;

/**
 * 这次派发还作不作数。同一个窗口内只给第一个来领取的页面（多标签、多设备不重复弹）；而窗口就是
 * 那条 24 小时的闸 —— 过了它，「满一天后的下一次连接」才拿得到新的判定机会，桥常驻不重启也有用。
 */
export function claimExpired(claimedAt: number | null, now: number): boolean {
  return claimedAt === null || now - claimedAt >= WHATSNEW_THROTTLE_MS;
}

function whatsnewFile(): string {
  return statePath("whatsnew.json");
}

/**
 * 读已读状态。文件不存在 = 首次运行；**读失败（损坏 / 半截）也当作「没记录」** —— 这是刻意的
 * 降级：坏状态只让他重看一次，而不是永久不弹。写入走 `writeJson` 的 tmp + rename，盘上不会留半份。
 */
export function readWhatsnewState(): WhatsnewState {
  const { value } = readJsonChecked<Partial<WhatsnewState>>(whatsnewFile(), {});
  return {
    seenTitle: typeof value.seenTitle === "string" ? value.seenTitle : "",
    lastShownAt: typeof value.lastShownAt === "number" && Number.isFinite(value.lastShownAt) ? value.lastShownAt : 0,
    enabled: value.enabled === false ? false : undefined,
  };
}

/** 设置页要的两样：上次看到哪批、这个提示开不开（缺省算开）。 */
export function whatsnewStatus(): { seenTitle: string; enabled: boolean } {
  const state = readWhatsnewState();
  return { seenTitle: state.seenTitle, enabled: state.enabled !== false };
}

/**
 * 页面来「领取」未读：同一个进程只发一次（多标签 / 多设备不重复弹），领到就记在内存里等
 * `markWhatsnewSeen` 落盘。**领走不等于看过** —— 只有页面真把 dialog 打开了才 POST `seen`；
 * 页面超时放弃、或这次进程重启，状态没动，下次还有机会。
 */
export function takeWhatsnew(
  now = Date.now(),
  /** 这份状态目录在本次启动**之前**就存在吗？不在就是第一次装，不弹（见 index.ts 的调用处）。 */
  veteran = true,
): (WhatsnewDecision & { root?: string }) | { status: "taken" } {
  if (!veteran) return { status: "none" };
  if (!claimExpired(claimed?.at ?? null, now)) return { status: "taken" };
  const decision = whatsnewDecision({ text: changelogText(), state: readWhatsnewState(), now });
  if (decision.status === "ok") claimed = { title: decision.batch.title, at: now };
  // `root` 只为正文里的相对链接（`docs/DECISIONS.md`）能落到这份检出上，和设置页同一个用法（D195）。
  return { ...decision, root: ROOT };
}

/** 弹窗真的打开了：把「看到哪一批」与「上次弹出时刻」一起写盘。 */
export function markWhatsnewSeen(now = Date.now()): { ok: true; seenTitle: string } | { ok: false; reason: "not-claimed" } {
  if (!claimed) return { ok: false, reason: "not-claimed" };
  const state = readWhatsnewState();
  writeJson(whatsnewFile(), { ...state, seenTitle: claimed.title, lastShownAt: now });
  return { ok: true, seenTitle: claimed.title };
}

/** 设置页的开关。关着时已读一概不前进，重新打开还能看到积压的那几批。 */
export function setWhatsnewPopup(enabled: boolean): { seenTitle: string; enabled: boolean } {
  const state = readWhatsnewState();
  writeJson(whatsnewFile(), { ...state, enabled });
  return { seenTitle: state.seenTitle, enabled };
}
