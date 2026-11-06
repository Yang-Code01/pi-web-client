/**
 * 表单里「（默认：16384）」那个数字是从哪来的：`settingDefaults()` 读 pi 包自带的
 * `schemas/settings.schema.json`，读不到的那几个键由 FALLBACK 表兜底。
 *
 * 要守住四件事：① schema 里的默认值要按点号拍平成表单的 key（`compaction.reserveTokens`）；
 * ② schema 与兜底表都说的时候以 schema 为准（pi 改了默认值，我们的标签要跟着改，不是跟着我们改）；
 * ③ 包不存在 / 没有 schema 时不抛，只给兜底表 —— 默认值标签错了是瑕疵，设置面板
 * 崩了是故障；④ 同一个包只读一次盘（面板每次 settings.get 都会问，不能每次解析 JSON）。
 *
 *   node bridge/tests/settings-defaults.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { settingDefaults } from "../src/settingsdefaults.ts";

// 测试要的是自己造的假包：别让环境里给测试留的接缝把 piPackageDir 顶掉。
delete process.env.PI_WEB_PI_PKG;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-defaults-"));
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name} — ${err.message}`);
  }
};

/** 造一个「像 pi 的」包目录：settingsdefaults 用 dirname×3 从 cli 走到包根。 */
function fakePackage(name, schema) {
  const pkg = path.join(root, name);
  fs.mkdirSync(path.join(pkg, "schemas"), { recursive: true });
  if (schema) fs.writeFileSync(path.join(pkg, "schemas", "settings.schema.json"), JSON.stringify(schema));
  return path.join(pkg, "dist", "cli", "entry.js");
}

const cliWithSchema = fakePackage(
  "with-schema",
  {
    type: "object",
    properties: {
      compaction: {
        type: "object",
        properties: {
          reserveTokens: { type: "integer", default: 16384 },
          keepRecentTokens: { type: "integer", default: 4321 },
        },
      },
      codemode: {
        type: "object",
        properties: { mode: { type: "string", enum: ["on", "only"], default: "only" } },
      },
      images: {
        type: "object",
        properties: { blockImages: { type: "boolean", default: true } },
      },
      retry: { type: "object", properties: { maxRetries: { type: "object", title: "no leaf here" } } },
    },
  },
);

check("schema 的默认值拍平成点号键（含嵌套几层）", () => {
  const d = settingDefaults(cliWithSchema);
  assert.equal(d["compaction.reserveTokens"], 16384);
  assert.equal(d["codemode.mode"], "only");
  assert.equal(d["images.blockImages"], true);
});

check("没有 default 的节点不进结果，也不把 title 当成默认值", () => {
  const d = settingDefaults(cliWithSchema);
  assert.equal("retry.maxRetries" in d, false);
  assert.equal("retry" in d, false);
});

check("README 式的默认值/枚举被如实带出来", () => {
  assert.equal(settingDefaults(cliWithSchema)["compaction.keepRecentTokens"], 4321);
});

check("包没有 schema → 只给兜底表，不抛", () => {
  const d = settingDefaults(fakePackage("no-schema", null));
  assert.equal(d["defaultThinkingLevel"], "medium");
  assert.deepEqual(d["defaultTools"], ["read", "bash", "edit", "write"]);
});

check("路径不存在 / 空串 → 只给兜底表，不抛", () => {
  for (const cli of ["", path.join(root, "nope", "a", "b", "c.js")]) {
    const d = settingDefaults(cli);
    assert.equal(d["defaultThinkingLevel"], "medium");
    assert.equal(d["httpIdleTimeoutMs"], 300000);
    assert.equal(d["websocketConnectTimeoutMs"], 15000);
    assert.deepEqual(d["npmCommand"], ["npm"]);
  }
});

check("schema 与兜底表冲突时 schema 说了算", () => {
  const cli = fakePackage("overrides", {
    properties: { defaultThinkingLevel: { type: "string", default: "low" }, httpIdleTimeoutMs: { default: 1200 } },
  });
  const d = settingDefaults(cli);
  assert.equal(d["defaultThinkingLevel"], "low");
  assert.equal(d["httpIdleTimeoutMs"], 1200);
  // 没被覆盖的兜底项还在
  assert.deepEqual(d["defaultTools"], ["read", "bash", "edit", "write"]);
});

check("同一个包只解析一次（缓存返回同一个对象）", () => {
  const a = settingDefaults(cliWithSchema);
  fs.writeFileSync(
    path.join(path.dirname(path.dirname(path.dirname(cliWithSchema))), "schemas", "settings.schema.json"),
    JSON.stringify({ properties: { compaction: { properties: { reserveTokens: { default: 1 } } } } }),
  );
  assert.equal(settingDefaults(cliWithSchema)["compaction.reserveTokens"], 16384);
  assert.equal(settingDefaults(cliWithSchema), a);
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
