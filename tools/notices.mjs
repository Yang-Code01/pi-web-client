#!/usr/bin/env node
/**
 * 生成 / 校验 THIRD-PARTY-NOTICES.md。
 *
 * 为什么要这份文件：MIT、BSD-3-Clause、Apache-2.0 都要求「分发时保留版权与许可声明」。
 * 源码分发有各包的 LICENSE 在 node_modules 里，一旦把 `web/dist` 交给别人（或发布 npm 包），
 * 那些声明就只剩这份文件了 —— 它必须跟依赖锁文件对得上，所以由脚本生成、由 typecheck 校验。
 *
 *   node tools/notices.mjs           按四个 package-lock.json 重新生成
 *   node tools/notices.mjs --check   只比对，不一致 exit 1（挂在 npm run typecheck 上）
 *
 * 清单来源是锁文件而不是 package.json：传递依赖也算（它们一样进了产物）。
 * `BUNDLED` 是「真的被打进 web/dist 的那几个」——只放浏览器包，桥端依赖不进去；
 * 改了 web/src 的 import 就顺手核对这张表（漏掉的包会落到第二节，语义仍然正确）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "THIRD-PARTY-NOTICES.md");
/** 构建产物里那段页首声明（以 /*! 开头的许可证注）：只含真正打进 web/dist 的组件，由 vite.config.ts 读进去。 */
const OUT_BANNER = path.join(ROOT, "web", "src", "legal", "bundle-notices.txt");
const WORKSPACES = [".", "web", "bridge", "peer"];
/** 进了浏览器包（web/dist）的运行时依赖。 */
const BUNDLED = ["@xterm/addon-fit", "@xterm/xterm", "highlight.js"];
const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "COPYING", "COPYING.md"];
/** 包内没有 LICENSE 文件、只声明 MIT 时补的正文（与 SPDX 的 MIT 文本一致）。 */
const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;

/** 锁文件里的 name → {name, version, license, copyright, source, dir, workspaces[]}。 */
function collect() {
  const found = new Map();
  for (const ws of WORKSPACES) {
    const lockPath = path.join(ROOT, ws, "package-lock.json");
    if (!fs.existsSync(lockPath)) continue;
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    for (const [key, meta] of Object.entries(lock.packages ?? {})) {
      if (!key.includes("node_modules/")) continue;
      if (meta.dev) continue; // 只在开发 / 构建时用到的，不随产物分发
      const name = meta.name || key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      const version = meta.version ?? "0.0.0";
      const id = `${name}@${version}`;
      const hit = found.get(id);
      if (hit) {
        if (!hit.workspaces.includes(ws)) hit.workspaces.push(ws);
        continue;
      }
      const dir = path.join(ROOT, ws, key);
      found.set(id, { name, version, license: licenseOf(meta), dir, workspaces: [ws], meta: installedMeta(dir, meta) });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function licenseOf(meta) {
  const raw = meta.license;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") return raw.type ?? "";
  return "";
}

/** 锁文件里没有 repository / homepage：从真正的 package.json 补，地址才能写成源码仓而不是 npm 页。 */
function installedMeta(dir, lockMeta) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return { ...lockMeta, ...pkg, license: pkg.license ?? lockMeta.license };
  } catch {
    return lockMeta;
  }
}

function readLicenseText(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^(licen[cs]e|copying)([.\-_]|$)/i.test(f));
  } catch {
    return null;
  }
  // 同一个包带多份许可（`LICENSE.MIT` + `LICENSE.EUPL-1.2`）：文件名点名 MIT 的优先，其余按字典序。
  names.sort((a, b) => (/mit/i.test(b) ? 1 : 0) - (/mit/i.test(a) ? 1 : 0) || a.localeCompare(b));
  for (const file of [...LICENSE_FILES.filter((f) => names.includes(f)), ...names]) {
    const p = path.join(dir, file);
    try {
      if (!fs.statSync(p).isFile()) continue;
      return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").trimEnd();
    } catch {
      /* 没有就试下一个 */
    }
  }
  // 有些包只在 package.json 里写许可（例如 http_ece），没有 LICENSE 文件：如实说明。
  return null;
}

/** 真正的版权行：带年份的那种；许可证正文里「The above copyright notice …」不算。 */
const COPYRIGHT = /^(copyright|©|\(c\))/i;
const COPYRIGHT_WITH_YEAR = /(copyright|©)\s*(\(c\)|©)?\s*\d{4}/i;

function copyrightLines(text) {
  if (!text) return [];
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => (COPYRIGHT.test(l) || COPYRIGHT_WITH_YEAR.test(l)) && !/^the above/i.test(l))
    .filter((l) => l.length <= 200);
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const key = l.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
    if (out.length >= 4) break;
  }
  return out;
}

function sourceUrl(name, meta) {
  const repo = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
  let url = repo || meta.homepage || "";
  url = url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "")
    .replace(/#.*$/, "")
    .trim();
  return url || `https://www.npmjs.com/package/${name}`;
}

function render() {
  const pkgs = collect();
  for (const name of BUNDLED) {
    if (!pkgs.some((p) => p.name === name)) throw new Error(`BUNDLED 里的 ${name} 不在锁文件的运行时依赖里：表过期了`);
  }
  const bundled = pkgs.filter((p) => BUNDLED.includes(p.name));
  const runtime = pkgs.filter((p) => !BUNDLED.includes(p.name));

  const out = [];
  out.push("# 第三方组件许可与版权声明");
  out.push("");
  out.push("本仓库（pi-web-client）以 **Apache-2.0** 发布，全文见 [LICENSE](LICENSE)。");
  out.push("这份文件由 `node tools/notices.mjs` 按四个 `package-lock.json` 生成，**不要手改**；");
  out.push("依赖有增减时重新运行它（`npm run notices`），`npm run typecheck` 会校验是否同步。");
  out.push("");
  out.push("分发本项目的构建产物（尤其是 `web/dist`）时，请把本文件一起带上：");
  out.push("MIT、BSD-3-Clause、Apache-2.0 都要求保留下面这些版权与许可声明。");
  out.push("");

  out.push(`## 一、打包进浏览器产物（web/dist）的组件（${bundled.length} 个）`);
  out.push("");
  for (const p of bundled) {
    out.push(...entry(p));
  }

  out.push(`## 二、桥与 peer 的运行时依赖（npm 安装，不进 web/dist）（${runtime.length} 个）`);
  out.push("");
  for (const p of runtime) {
    out.push(...entry(p));
  }

  out.push("## 三、本仓库");
  out.push("");
  out.push("- **pi-web-client** — Apache-2.0，见 [LICENSE](LICENSE)。");
  out.push("- 桥端调用本机的 LibreOffice（`soffice`）与 PowerPoint（COM）做预览转换，它们不随本项目分发，各自适用其自身许可。");
  out.push("");
  out.push("## 四、商标与说明性使用");
  out.push("");
  out.push("界面里出现的 Apple / macOS / iMessage、Excel / WPS、GitHub、Jira / Atlassian、Microsoft / Outlook、微信");
  out.push("等名称与形态，是各自所有者的商标或作品，本项目仅作**说明性使用**（描述兼容性与操作位置），");
  out.push("不隶属于它们，也未获得其背书。项目自带图标与表情为自绘或直接使用 Unicode 字符。");
  out.push("");
  return { md: out.join("\n"), banner: bundleBanner(bundled) };
}

/**
 * 构建产物页首那段声明。不能指望 esbuild 的 legalComments：这三个包发出来的 ESM 里
 * 根本没有 `/*!` 头（xterm 是压缩过的 UMD，highlight.js 只有一句 eslint-disable），
 * 所以版权行由这里显式生成、由 vite 的 output.banner 拼到每个 chunk 开头。
 */
function bundleBanner(bundled) {
  const lines = [`pi-web-client — bundled third-party notices (web/dist)`];
  for (const p of bundled) {
    const copyright = copyrightLines(readLicenseText(p.dir))[0]?.replace(/[*/\s]+$/, "") ?? "";
    lines.push(`${p.name} ${p.version} — ${p.license}${copyright ? ` — ${copyright}` : ""}`);
  }
  lines.push(`Full texts: THIRD-PARTY-NOTICES.md (repo root; served at GET /api/notices)`);
  return lines.join("\n");
}

function entry(p) {
  const block = [];
  const license = p.license || "未标注";
  block.push(`### ${p.name} ${p.version} — ${license}`);
  block.push("");
  block.push(`- 源码：${sourceUrl(p.name, p.meta)}`);
  if (license.toUpperCase().startsWith("MPL")) {
    block.push("- MPL-2.0：按该许可证要求，源码可从上方地址获取；本项目未修改该组件，仅以依赖形式调用。");
  }
  const text = readLicenseText(p.dir);
  const copyrights = copyrightLines(text);
  if (copyrights.length) block.push(`- 版权：${copyrights.map((c) => c.replace(/^[*/#\s]+/, "")).join("；")}`);
  else if (p.meta.author) {
    const author = typeof p.meta.author === "string" ? p.meta.author : p.meta.author.name ?? "";
    if (author) block.push(`- 作者：${author}`);
  }
  block.push("");
  if (text) {
    block.push("```text");
    block.push(text);
    block.push("```");
  } else if (/^MIT$/i.test(license.trim())) {
    // 包内没有 LICENSE 文件（只在 package.json 里写了 MIT）：附标准正文，版权人取作者字段。
    const author = typeof p.meta.author === "string" ? p.meta.author : p.meta.author?.name ?? "";
    block.push(`_该组件未随包提供许可证文件，据其 \`package.json\` 声明为 MIT；以下为 MIT 标准正文（版权人：${author || "见上方作者行"}）。_`);
    block.push("");
    block.push("```text");
    block.push(author ? `Copyright (c) ${author}` : "Copyright (c) the authors");
    block.push("");
    block.push(MIT_TEXT);
    block.push("```");
  } else {
    block.push(`_该组件未随包提供许可证文件，以上方的 \`license\` 字样（${license}）为准。_`);
  }
  block.push("");
  return block;
}

const { md: expected, banner } = render();
const check = process.argv.includes("--check");
if (check) {
  const problems = [];
  for (const [file, want] of [
    [OUT, expected],
    [OUT_BANNER, banner],
  ]) {
    const actual = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (actual === want) continue;
    const a = actual.split("\n");
    const e = want.split("\n");
    let i = 0;
    while (i < a.length && i < e.length && a[i] === e[i]) i++;
    problems.push(
      [
        `${path.relative(ROOT, file)} 与依赖锁文件不一致（第 ${i + 1} 行起）。`,
        `  文件：${a[i] ?? "(缺失)"}`,
        `  应为：${e[i] ?? "(多余内容)"}`,
      ].join("\n"),
    );
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error("跑 `npm run notices` 重新生成。");
    process.exit(1);
  }
  console.log(`notices 已同步（${expected.length} 字节 / 页首 ${banner.length} 字节）`);
} else {
  fs.mkdirSync(path.dirname(OUT_BANNER), { recursive: true });
  fs.writeFileSync(OUT, expected);
  fs.writeFileSync(OUT_BANNER, banner);
  console.log(`已写出 ${path.relative(ROOT, OUT)}（${(expected.length / 1024).toFixed(1)} KB）与 ${path.relative(ROOT, OUT_BANNER)}`);
}
