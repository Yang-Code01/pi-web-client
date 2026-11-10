/**
 * 本项目跑起来还缺什么（D220）：pi 本体 + 四个 pi 扩展。
 *
 * 网页有一部分功能不在这个仓库里：设置→子代理要读 `pi-subagents` 的会话目录，网页问卷要
 * `@juicesharp/rpiv-ask-user-question` 的 rpc-fallback 对话框格式，执行计划由
 * `@juicesharp/rpiv-todo` 提供，随手问的联网工具由 `pi-web-access` 提供。它们装在 pi 自己的全局目录里，clone 下来 `npm install` 拿不到 ——
 * 于是同一份代码在两个人的机器上表现不同，而缺的那一块往往只是**静默少一个工具**。
 *
 * 这个文件是那份清单的唯一来源：`scripts/bootstrap.mjs` 照着它装，桥按它算状态
 * （`/api/deps`，见 depsstatus.ts）。README「这个项目需要什么」那张表与 `bridge/tests/deps-unit.mjs`
 * 里的版本号是**抄自这里**的：改钉的版本时三处一起改（单测会把 README 那张表对一遍）。
 *
 * 纯数据 + 纯函数，**不 import 任何东西**：脚本要在还没编译过的仓库里 import 它（Node ≥ 22.18
 * 默认就能直接 import `.ts`，只剥类型），编译产物也直接带着它。
 */

/** pi 的最低版本：1.4 起 MCP 是内置扩展，但网页用到的部分按 1.5 验过。 */
export const MIN_PI_VERSION = "1.5.0";

/**
 * 缺了会少哪块功能。**这里是 id，不是文案**：中文只在 `web/src` 里用 `tr()` 写，
 * 命令行那几句在 `scripts/bootstrap.mjs` 自己的表里。
 */
export type PackageId = "subagents" | "questionnaire" | "todo" | "web-access";

export interface RequiredPackage {
  /** `pi install` 认的来源，不带版本：`npm:pi-subagents`。 */
  source: string;
  /** npm 包名，用来跟 `pi list` 的行配对（`@scope/name` 形式）。 */
  name: string;
  /** 钉死的版本；`null` = 不写版本，跟着 latest。 */
  version: string | null;
  /** 缺了少哪块功能（页面按 id 翻文案）。 */
  id: PackageId;
}

export const REQUIRED_PACKAGES: RequiredPackage[] = [
  // 钉住：网页直接读它的会话目录（%TEMP%\pi-subagents-*）与 async JSON 事件，
  // 目录布局变了就静默读不到。
  { source: "npm:pi-subagents", name: "pi-subagents", version: "0.86.0", id: "subagents" },
  // 钉住：网页按它的 rpc-fallback 逐题对话框回填答案（bridge/src/questionnaire.ts），
  // 对话框格式变了就对不上。
  {
    source: "npm:@juicesharp/rpiv-ask-user-question",
    name: "@juicesharp/rpiv-ask-user-question",
    version: "2.15.0",
    id: "questionnaire",
  },
  // 钉住：执行面板读取它持久化的 `todo` 快照（D223）。
  { source: "npm:@juicesharp/rpiv-todo", name: "@juicesharp/rpiv-todo", version: "2.15.0", id: "todo" },
  // 不钉：只用它的工具，不解析它的输出格式。
  { source: "npm:pi-web-access", name: "pi-web-access", version: null, id: "web-access" },
];

/** 可选、但少了就会缺一整块界面的包：不装、不拦人，只把界面灰掉并说原因。 */
export const OPTIONAL_PACKAGES: { name: string; id: "acp" }[] = [{ name: "billion-context", id: "acp" }];

/** `pi install` 的参数：钉了版本就是 `npm:foo@1.2.3`，否则原样。 */
export function installSource(pkg: RequiredPackage): string {
  return pkg.version ? `${pkg.source}@${pkg.version}` : pkg.source;
}

/**
 * `npm:@scope/name@1.2.3` → `npm:@scope/name`。
 *
 * 不能简单按最后一个 `@` 切：`npm:@scope/name` 里那个 `@` 是作用域，不是版本。只有尾巴
 * 长得像版本号（或 `latest` / `next` 这类 tag）才算版本。
 */
export function bareSource(source: string): string {
  const s = source.trim();
  const at = s.lastIndexOf("@");
  if (at <= 0) return s;
  const tail = s.slice(at + 1);
  if (!/^(\d|v\d|\^|~|>=?|<=?|=|latest$|next$)/.test(tail)) return s;
  return s.slice(0, at);
}

/** `v1.2.3` / `1.2` / `1.2.3-beta.1` → `[1,2,3]`；认不出就是 null。 */
export function parseSemver(version: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** 带预发布号吗：`1.5.0-rc.1` 是，`1.5.0` / `1.5.0+build` 不是。 */
function isPrerelease(version: string): boolean {
  return /^v?\d+(?:\.\d+){0,2}-/.test(version.trim());
}

/**
 * 先比 major.minor.patch 三段；三段相同时，带预发布号的算**更旧**（`1.5.0-rc.1` < `1.5.0`，
 * 和 semver 一致）。预发布号之间不再细分。解析不出来的一律当 0 —— 宁可说它太旧，也不静默放行。
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a) ?? [0, 0, 0];
  const pb = parseSemver(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  const preA = isPrerelease(a);
  const preB = isPrerelease(b);
  if (preA === preB) return 0;
  return preA ? -1 : 1;
}

/** pi 版本够不够（null = 根本没找到 pi，也算不够）。 */
export function piTooOld(version: string | null): boolean {
  return !version || compareSemver(version, MIN_PI_VERSION) < 0;
}

export interface DepStatus extends RequiredPackage {
  installed: boolean;
  /** 装着的版本（读它自己的 package.json）；装了但读不出就是 null。 */
  foundVersion: string | null;
  /** 装了，但比钉住的旧 —— 只用于提示“格式可能对不上”，**不**触发升级（已装就不动）。 */
  behind: boolean;
}

/**
 * 一个来源**本身**指向哪个包名，读不到它的 package.json 时用：
 *   `npm:@scope/name@1.2.3` → `@scope/name`；`git:github.com/u/pi-subagents@v1` → `pi-subagents`；
 *   `https://github.com/u/pi-subagents.git` → `pi-subagents`；`..\packages\pi-tui` → `pi-tui`。
 * 不是 npm 的来源只取最后一段路径，所以 git / 本地装的同名包也算「已装」，不会再装一份 npm 版。
 */
export function sourceName(source: string): string {
  const bare = bareSource(source);
  if (/^npm:/i.test(bare)) return bare.slice(4);
  const last = bare.replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? bare;
  return last.replace(/\.git$/i, "");
}

/** `pi list` 的一行（`bridge/src/picli.ts` 的 parsePackages 解出来的形状）。 */
export interface ListedPackage {
  scope: "user" | "project";
  source: string;
  path: string | null;
}

/**
 * 「装没装」的**唯一判据**，脚本和页面都走它（D220）：只看 `pi list` 里的**用户级**包
 * （装到用户全局是这份清单的约定，项目级的只对那一个工程有效），包名优先读它自己的
 * package.json，读不到才按来源猜（`sourceName`）。`readPkg` 由调用方注入，这里不碰磁盘。
 */
export function foundPackages(
  rows: ListedPackage[],
  readPkg: (dir: string) => { name?: string; version?: string } | null,
): { source: string; name: string; version: string | null }[] {
  return rows
    .filter((row) => row.scope === "user")
    .map((row) => {
      const pkg = row.path ? readPkg(row.path) : null;
      return { source: bareSource(row.source), name: pkg?.name ?? sourceName(row.source), version: pkg?.version ?? null };
    });
}

/**
 * 把 `pi list` 里已有的包跟清单对上。配对按包名（大小写不敏感），因为同一个包可能以带版本
 * 或不带版本的来源出现在 settings 里（`npm:foo` 与 `npm:foo@1.2.3` 都算装了）。
 */
export function depStatus(found: { source: string; name: string; version: string | null }[], required = REQUIRED_PACKAGES): DepStatus[] {
  return required.map((pkg) => {
    const want = pkg.name.toLowerCase();
    const row = found.find((f) => (f.name || bareSource(f.source)).toLowerCase() === want);
    const foundVersion = row?.version ?? null;
    return {
      ...pkg,
      installed: !!row,
      foundVersion,
      behind: !!(row && pkg.version && foundVersion && compareSemver(foundVersion, pkg.version) < 0),
    };
  });
}

/** 还差几个（页面徽标与“整备没整备好”都看这个）。 */
export function missingCount(statuses: DepStatus[]): number {
  return statuses.filter((s) => !s.installed).length;
}

/** 给用户复制的那条命令：在仓库根目录跑，它把清单里缺的都补上。 */
export function bootstrapCommand(): string {
  return "node scripts/bootstrap.mjs";
}
