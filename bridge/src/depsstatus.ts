/**
 * `/api/deps` 的内容：pi 够不够新、清单里的三个扩展装没装。
 *
 * 只读、不问网络（`pi list` 是本地的）：页面每次打开设置都敢问一遍，不会被 npm / PyPI 的超时
 * 拖住。真正的“装”不在这里 —— 那是 `scripts/bootstrap.mjs` 在 `npm install` 时做的事，桥只
 * 负责把结果说清楚（并留一个“没跑过 / 跑失败了”的状态给横幅）。
 */
import fs from "node:fs";
import path from "node:path";
import { bareSource, bootstrapCommand, depStatus, MIN_PI_VERSION, OPTIONAL_PACKAGES, piTooOld, type DepStatus } from "./deps.ts";
import { readJson, statePath } from "./paths.ts";
import { runPiCli } from "./picli.ts";

/** `scripts/bootstrap.mjs` 跑完留下的结果（状态目录里的 bootstrap.json）。 */
export interface BootstrapRun {
  at: number;
  ok: boolean;
  /** 第一个失败原因；成功的步骤只进 installed / skipped。 */
  error: string | null;
  installed: string[];
  skipped: string[];
  /** 它当时认到的 pi 版本。 */
  pi: string | null;
}

export interface DepsReport {
  pi: { version: string; min: string; ok: boolean };
  /** 自动补齐是开着的吗（`PI_WEB_NO_AUTOINSTALL=1` 关掉它）。 */
  autoInstall: boolean;
  packages: DepStatus[];
  /** 可选包：没装不拦人，界面自己决定要不要灰掉。 */
  optional: { name: string; feature: string; installed: boolean }[];
  missing: number;
  /** pi 够新且三个都在。 */
  ready: boolean;
  /** 上次 `npm install` 的结果；null = 这个仓库的 postinstall 还没在这台机器上跑过。 */
  bootstrap: BootstrapRun | null;
  /** 缺东西时给用户复制的那条命令。 */
  command: string;
}

export function readBootstrapRun(): BootstrapRun | null {
  const raw = readJson<BootstrapRun | null>(statePath("bootstrap.json"), null);
  return raw && typeof raw.at === "number" ? raw : null;
}

export async function depsReport(cliPath: string, piVersion: string): Promise<DepsReport> {
  const list = await runPiCli(cliPath, { op: "pkg.list" }, () => {}).done;
  const rows = Array.isArray(list.data) ? (list.data as { scope: string; source: string; path: string | null }[]) : [];
  const found = rows.map((row) => {
    const pkg = row.path ? readJson<{ name?: string; version?: string }>(path.join(row.path, "package.json"), {}) : {};
    const source = bareSource(row.source);
    return {
      source,
      name: pkg.name ?? source.replace(/^npm:/, ""),
      version: pkg.version ?? null,
    };
  });
  const packages = depStatus(found);
  const missing = packages.filter((p) => !p.installed).length;
  const piOk = !piTooOld(piVersion);
  return {
    pi: { version: piVersion, min: MIN_PI_VERSION, ok: piOk },
    autoInstall: !process.env.PI_WEB_NO_AUTOINSTALL,
    packages,
    optional: OPTIONAL_PACKAGES.map((pkg) => ({
      ...pkg,
      installed: found.some((f) => f.name.toLowerCase() === pkg.name.toLowerCase()),
    })),
    missing,
    ready: piOk && missing === 0,
    bootstrap: readBootstrapRun(),
    command: bootstrapCommand(),
  };
}

/** 只给测试用：把一份 `pi list` 文本变成状态，不碰真磁盘。 */
export function statusFromList(out: string, readVersion: (dir: string) => string | null): DepStatus[] {
  const rows: { source: string; path: string | null }[] = [];
  let inList = false;
  for (const line of out.split(/\r?\n/)) {
    if (/packages:\s*$/i.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const src = /^ {2}(\S.*)$/.exec(line);
    const loc = /^ {4}(\S.*)$/.exec(line);
    if (loc && rows.length) rows[rows.length - 1].path = loc[1].trim();
    else if (src) rows.push({ source: src[1].trim(), path: null });
  }
  return depStatus(
    rows.map((row) => {
      const source = bareSource(row.source);
      const dir = row.path;
      return { source, name: source.replace(/^npm:/, ""), version: dir && fs.existsSync(dir) ? readVersion(dir) : null };
    }),
  );
}
