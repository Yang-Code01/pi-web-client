#!/usr/bin/env node
/**
 * 测试里不给「被测的桥」钉死监听端口。
 *
 * 为什么会有这条：Windows 会把成片端口列进保留段（本机 `netsh interface ipv4 show excludedportrange
 * protocol=tcp` 报了 7877–8635 里的七段），`listen` 打在那儿报的不是 EADDRINUSE 而是 **EACCES**。
 * 于是测试先空转二十秒等 healthz，再抛 `fetch failed` —— 看起来像「很慢」，其实是永远过不了。
 * 现在统一用 `tools/free-port.mjs` 的 `freePort()` 让系统挑，要钉死仍可用 `<X>_PORT` 环境变量。
 *
 * 只查这一种形状（宁缺勿滥，避免把 `port: 993` 这种 IMAP 数据、假联系人里的 `port: 17965`
 * 一起算进来）：端口常量、环境变量兜底值、直接 `.listen(N)`、`startBridge({ port: N })`、
 * 给桥塞 `PI_WEB_PORT: "N"`。确实要固定就写 `// port-guard: allow` 并说明原因。
 * `probes/` 不扫：那是手工跑的一次性探针，不是测试套件。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))));
const DIRS = ["bridge/tests", "web/tests"];

/** 整个文件豁免的理由：连的是活着的实例，或者只是把端口当数据。 */
const ALLOW_FILES = new Map([
  ["bridge/tests/e2e.mjs", "不自己起桥，连的是人先开好的实例（7867）"],
  ["bridge/tests/browser.mjs", "调试入口，连活着的实例"],
  ["bridge/tests/model-check.mjs", "调试入口，连活着的实例"],
  ["bridge/tests/dbg.mjs", "调试入口，连活着的实例"],
  ["bridge/tests/dbg2.mjs", "调试入口，连活着的实例"],
  ["bridge/tests/dbg3.mjs", "调试入口，连活着的实例"],
]);

const PATTERNS = [
  [/\b(?:const|let)\s+PORT\s*=\s*\d{2,5}\s*;/, "端口常量写死"],
  [/\b(?:const|let)\s+PORT\s*=\s*Number\(\s*process\.env\.\w+\s*\?\?\s*\d{2,5}\s*\)/, "环境变量兜底值写死端口"],
  [/\.listen\(\s*\d{2,5}/, "直接 listen 固定端口"],
  [/startBridge\(\{[^}]*\bport:\s*\d{2,5}/, "startBridge 里写死 port"],
  [/PI_(?:WEB|PEER|TEST)_PORT\s*:\s*["'`]?\d{2,5}/, "给桥塞写死的 PI_*_PORT"],
];

const hits = [];
let scanned = 0;
for (const dir of DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of fs.readdirSync(abs).filter((f) => f.endsWith(".mjs")).sort()) {
    const rel = `${dir}/${file}`;
    if (ALLOW_FILES.has(rel)) continue;
    scanned += 1;
    const lines = fs.readFileSync(path.join(abs, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes("port-guard: allow")) return;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return; // 注释里的历史账本不算
      for (const [re, why] of PATTERNS) {
        if (re.test(line)) {
          hits.push(`${rel}:${i + 1}  ${why}\n      ${trimmed.slice(0, 110)}`);
          break;
        }
      }
    });
  }
}

if (hits.length === 0) {
  console.log(`port-guard: ok — 扫了 ${scanned} 个测试文件，写的都是 freePort()（${ALLOW_FILES.size} 个文件按理由豁免）`);
  process.exit(0);
}
console.error(`port-guard: ${hits.length} 处给桥钉死了端口，改成 await freePort()（见 tools/free-port.mjs）：\n`);
for (const h of hits) console.error(`  ${h}`);
console.error("\n确实要固定端口，就在行尾写 `// port-guard: allow` 并说明原因。");
process.exit(1);
