import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { VERSION } from "./paths.ts";

/**
 * D190：设置页「本项目更新日志」，和 pi 包里那个 CHANGELOG.md 不是一回事。
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

export async function selfChangelog(maxBytes = 200_000): Promise<SelfChangelog> {
  let text = "";
  try {
    const buf = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"));
    // HTML 注释是给人机看的增量锚点（`<!-- 写到 <SHA> -->`），renderMarkdown 不认，留着会原样
    // 显示在面板里。在这里先抹掉，面板拿到的就是能直接渲染的正文。
    const raw = decoder.decode(buf).replace(/<!--[\s\S]*?-->/g, "");
    // 按字节切：切完从缓冲区解码，尾上一个被切一半的字符由 decoder 变成替换符，再抹掉。
    text =
      Buffer.byteLength(raw, "utf8") > maxBytes
        ? `${decoder.decode(Buffer.from(raw, "utf8").subarray(0, maxBytes)).replace(/\uFFFD+$/, "")}\n\n…（更早的批次略）`
        : raw;
  } catch {
    text = "";
  }
  const { branch, commit } = await readHead();
  return { version: productVersion(), branch, commit, root: ROOT, text };
}
