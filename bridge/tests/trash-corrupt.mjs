/**
 * 回收站状态文件损坏时的回归测试（fix/audit-critical-high，审计 H5）。
 *
 * 旧行为：`readTrash()` 用 `readJson` 把截断读成 `{items:[]}`，`bin` 之后
 * `writeTrash([...空, ...新])` 就把整份回收站覆盖掉。现在解析失败先留档再空跑。
 *
 *   1. 截断的 trash.json → trashList() 返回空，但原字节在 `.corrupt-*` 里；
 *   2. purge() 在留档成功后不会再写出一份空回收站（文件保持不存在）；
 *   3. 合法文件照常读。
 *
 * 用法：npm run build:bridge && node bridge/tests/trash-corrupt.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "trash-corrupt-"));
process.env.PI_WEB_STATE = path.join(ROOT, "state");
fs.mkdirSync(process.env.PI_WEB_STATE, { recursive: true });

const DIST = process.env.BRIDGE_DIST || path.resolve(here, "..", "dist");
if (!fs.existsSync(path.join(DIST, "sessions.js"))) {
  console.error(`没找到 ${DIST}/sessions.js：先跑 npm run build:bridge`);
  process.exit(2);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (ok, what, extra = "") => {
  if (ok) log(`ok   ${what}`);
  else {
    failed += 1;
    console.error(`FAIL ${what} ${extra}`);
  }
};

const { SessionManager } = await import(pathToFileURL(path.join(DIST, "sessions.js")).href);
const trashFile = path.join(process.env.PI_WEB_STATE, "trash.json");
const backup = () => {
  const names = fs.readdirSync(process.env.PI_WEB_STATE).filter((f) => f.startsWith("trash.json.corrupt-"));
  assert.equal(names.length, 1, `应恰好留档一份，实际 ${names.join(", ") || "无"}`);
  return path.join(process.env.PI_WEB_STATE, names[0]);
};

const original = `{"items":[{"id":"t1","file":"/tmp/a","deletedAt":1},{"id":"t2","file":"/tmp/b"`;
fs.writeFileSync(trashFile, original);

const sessions = new SessionManager("pi", null);
const warn = console.warn;
const warnings = [];
console.warn = (m) => warnings.push(String(m));

check(sessions.trashList().length === 0, "截断的回收站读成空表（而不是崩溃）");
const bak = backup();
check(fs.readFileSync(bak, "utf8") === original, "备份保留原始字节");
check(warnings.some((m) => m.includes("已备份到")), "日志说清了备份位置", warnings.join(" | "));
check(!fs.existsSync(trashFile), "留档后原文件已移走，不会被当成空回收站再写一遍");

sessions.purge(["t1"]);
check(!fs.existsSync(trashFile), "purge 没有写出空回收站（数据在备份里）");

fs.writeFileSync(trashFile, JSON.stringify({ items: [{ id: "t9", file: "/tmp/x", deletedAt: 1 }] }));
const ok = sessions.trashList();
check(ok.length === 0 && fs.existsSync(trashFile), "合法文件照常读（缺失 payload 的条目被清掉）");

console.warn = warn;
fs.rmSync(ROOT, { recursive: true, force: true });
log(failed ? "FAILED" : "OK");
process.exit(failed ? 1 : 0);
